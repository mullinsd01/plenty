import "server-only";
import { and, count, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { hourInTimeZone, toDateString, weekdayOf, zonedDateTimeToInstant } from "@/lib/dates";
import type { NotificationType } from "@/lib/domain";
import { wasteInsights } from "@/lib/insights";
import { planFlags } from "@/lib/billing/plans";
import { isPrivateScope, learningKey, scopeOwner } from "@/lib/members/scope";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { resolveHouseholdPlan, type HouseholdPlan } from "@/server/billing/entitlements";
import { systemDb, withSystem, type Queryable } from "@/server/db/client";
import { householdMembers, households, notificationSettings, notifications, profiles, shoppingListItems, users } from "@/server/db/schema";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "@/server/email/mailer";
import { env } from "@/server/env";
import { toItemView } from "./inventory";
import { computeLiveState, householdNameFor, itemScope } from "./learning";
import { getOrCreateActiveList, loadShoppingRhythm } from "./shopping";

/**
 * Notification generation: works out which nudges are genuinely useful and
 * creates them per member (run after page loads and by the scheduled job).
 */

interface Candidate {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  dedupeKey: string;
  /** Lower is more important. */
  priority: number;
  setting: "runningLow" | "useSoon" | "mealPlanReady" | "shoppingReminder" | "checkIns" | "insights";
  /** Who should see it: one member (a private or personal item), or null for the household's adults. */
  audienceMemberId: string | null;
}

type HouseholdRow = Pick<HouseholdInfo, "id" | "name" | "adults" | "children" | "timezone" | "currency">;

interface Person {
  userId: string | null;
  role: string;
  name: string;
}

/** Everyone in the household, by member id. */
async function loadPeople(db: Queryable, householdId: string): Promise<Map<string, Person>> {
  const rows = await db
    .select({
      id: householdMembers.id,
      userId: householdMembers.userId,
      role: householdMembers.role,
      displayName: householdMembers.displayName,
      profileName: profiles.displayName,
    })
    .from(householdMembers)
    .leftJoin(profiles, eq(profiles.userId, householdMembers.userId))
    .where(eq(householdMembers.householdId, householdId));
  return new Map(rows.map((r) => [r.id, { userId: r.userId, role: r.role, name: r.displayName ?? r.profileName ?? "Someone" }]));
}

/**
 * Who a nudge about a scope is for. A private item is the owner's alone; a person's shared item goes to them
 * (or, when they have no account, to the household's adults); everything else is the household's.
 */
function audienceFor(scope: string, people: Map<string, Person>): string | null {
  const owner = scopeOwner(scope);
  if (!owner) return null;
  if (isPrivateScope(scope)) return owner;
  return people.get(owner)?.userId ? owner : null;
}

/** Work out which nudges are genuinely useful for this household right now. Pure reads. */
async function candidatesFor(db: Queryable, household: HouseholdRow, plan: HouseholdPlan, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const today = toDateString(now, household.timezone);
  const learning = {
    ...household,
    ...planFlags(plan.entitlements),
  };
  const live = await computeLiveState(db, learning, now);
  const people = await loadPeople(db, household.id);

  // Predictions (and so smart low-stock alerts) are part of the paid plans; expiry reminders are for everyone.
  for (const p of plan.entitlements.consumption_predictions ? live.predictions.values() : []) {
    if (p.paused) continue;
    const audience = audienceFor(p.scope, people);
    const owner = p.ownerMemberId ? people.get(p.ownerMemberId) : undefined;
    // Said to the owner it's "you"; said to the household about a profile without an account it's their name.
    const called = inSentence(householdNameFor(p));
    const name = audience === null && owner ? `${owner.name}'s ${called}` : called;
    const key = learningKey(p.productId, p.scope);
    const snoozed = p.items.some((i) => i.checkInSnoozedUntil && i.checkInSnoozedUntil > now);
    if (p.prediction.needsCheckIn && !snoozed) {
      out.push({
        type: "check_in",
        title: audience === null && owner ? `Did ${owner.name} finish the ${called}?` : `Did you finish the ${name}?`,
        body: "One tap on your home screen keeps Plenty's predictions accurate.",
        link: "/home",
        dedupeKey: `check_in:${key}:${today}`,
        priority: 0,
        setting: "checkIns",
        audienceMemberId: audience,
      });
    } else if (
      plan.entitlements.smart_replenishment &&
      p.prediction.daysRemaining <= 1.5 &&
      (p.prediction.basis === "history" || p.prediction.confidence !== "low")
    ) {
      out.push({
        type: "running_low",
        title: audience === null && owner ? `${name.charAt(0).toUpperCase()}${name.slice(1)} is probably running low.` : `You're probably running low on ${name}.`,
        body: `${p.prediction.label.charAt(0).toUpperCase()}${p.prediction.label.slice(1)} left. ${p.prediction.reason}`,
        link: "/list",
        dedupeKey: `running_low:${key}:${toDateString(p.prediction.runOutAt, household.timezone)}`,
        priority: 1,
        setting: "runningLow",
        audienceMemberId: audience,
      });
    }
  }

  // One nudge per product (the most urgent pack), not one per pack or receipt line.
  const useSoon = new Map<string, { urgent: boolean; candidate: Candidate }>();
  for (const item of live.activeItems) {
    const view = toItemView(item, live, household);
    if (view.estimatedFraction < 0.1 || !view.perishable) continue;
    const s = view.useSoon;
    if ((s.status === "today" || (s.status === "soon" && (s.daysUntilExpiry ?? 9) <= 1)) && s.atRiskOfWaste) {
      const scope = itemScope(live, item);
      const audience = audienceFor(scope, people);
      const key = `${item.productId ? `p:${item.productId}` : `n:${view.name.toLowerCase()}`}@${scope}`;
      const urgent = s.status === "today";
      const seen = useSoon.get(key);
      if (seen && (seen.urgent || !urgent)) continue;
      useSoon.set(key, {
        urgent,
        candidate: {
          type: "use_soon",
          title: `Don't forget to use your ${view.name.toLowerCase()}.`,
          body: urgent ? "It's best used today. Plenty can suggest a meal that uses it." : "It's likely to go off tomorrow. Plenty can suggest a meal that uses it.",
          link: "/meals/cook",
          dedupeKey: `use_soon:${key}:${view.expiresOn ?? today}`,
          priority: 2,
          setting: "useSoon",
          audienceMemberId: audience,
        },
      });
    }
  }
  for (const { candidate } of useSoon.values()) out.push(candidate);

  const rhythm = await loadShoppingRhythm(db, household, now);
  if (rhythm.nextShopDate === today && rhythm.basis !== "default") {
    const list = await getOrCreateActiveList(db, household.id);
    const [open] = await db
      .select({ n: count() })
      .from(shoppingListItems)
      .where(
        and(
          eq(shoppingListItems.listId, list.id),
          isNull(shoppingListItems.checkedAt),
          isNull(shoppingListItems.purchasedAt),
          // Only what everyone can see: someone's private items aren't the household's business.
          eq(shoppingListItems.visibility, "household"),
          // Only what's showing on the list: items the household dismissed don't count.
          or(isNull(shoppingListItems.dismissedUntil), lte(shoppingListItems.dismissedUntil, now)),
        ),
      );
    const n = Number(open?.n ?? 0);
    if (n >= 3) {
      out.push({
        type: "shopping_reminder",
        title: "Shopping today?",
        body: `Your list has ${n} things on it, including what you'll need for this week's meals.`,
        link: "/list",
        dedupeKey: `shopping:${today}`,
        priority: 3,
        setting: "shoppingReminder",
        audienceMemberId: null,
      });
    }
  }

  if (weekdayOf(today) === 1 && plan.entitlements.household_analytics) {
    const insights = wasteInsights(
      [...live.statsRows.values()]
        // The household's patterns only: nothing learned from someone's private items.
        .filter((s) => !isPrivateScope(s.scope) && live.index.byId.has(s.productId))
        .map((s) => ({
          productId: s.productId,
          name: live.index.byId.get(s.productId)!.name,
          wasteRatio: s.wasteRatio,
          wasteEvents: s.wasteEvents,
          purchaseCount: s.purchaseCount,
        })),
    );
    const top = insights[0];
    if (top) {
      out.push({
        type: "insight",
        title: top.message,
        body: top.suggestion,
        link: "/insights",
        dedupeKey: `insight:waste:${top.productId}:${today}`,
        priority: 4,
        setting: "insights",
        audienceMemberId: null,
      });
    }
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * Create notifications for every member of a household, respecting each
 * member's preferences, daily limit and quiet hours. Idempotent via dedupe
 * keys, so it's safe to run as often as you like.
 */
/** "Whole milk" reads as "the whole milk" mid-sentence; "Pepsi Max" keeps its capitals. */
function inSentence(name: string): string {
  return /[A-Z]/.test(name.slice(1)) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

export async function generateNotificationsForHousehold(db: Queryable, household: HouseholdRow, now: Date): Promise<number> {
  // One run per household at a time (page loads, the notifications page and the scheduled
  // job can overlap): otherwise two runs both count what's been sent today and both fill
  // the daily limit. Held until the calling transaction ends.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`notifications:${household.id}`}))`);
  const plan = await resolveHouseholdPlan(household.id, now, db);
  const candidates = await candidatesFor(db, household, plan, now);
  if (candidates.length === 0) return 0;
  const members = await db
    .select({ memberId: householdMembers.id, role: householdMembers.role, userId: users.id, email: users.email, settings: notificationSettings })
    .from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .leftJoin(
      notificationSettings,
      and(eq(notificationSettings.userId, householdMembers.userId), eq(notificationSettings.householdId, householdMembers.householdId)),
    )
    .where(eq(householdMembers.householdId, household.id));

  const hour = hourInTimeZone(now, household.timezone);
  const startOfDay = zonedDateTimeToInstant(toDateString(now, household.timezone), 0, household.timezone);
  let created = 0;
  for (const member of members) {
    // Restricted members don't get household nudges (they'd mention shopping, money and receipts).
    if (member.role === "child") continue;
    const s = member.settings;
    // Defaults only apply without a settings row; a cleared hour means "No quiet hours".
    const quietStart = s ? s.quietStartHour : 21;
    const quietEnd = s ? s.quietEndHour : 7;
    const quiet =
      quietStart !== null &&
      quietEnd !== null &&
      (quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd);
    if (quiet) continue;
    const limit = s?.dailyLimit ?? 3;
    const [sent] = await db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, member.userId),
          eq(notifications.householdId, household.id),
          gte(notifications.createdAt, startOfDay),
          sql`${notifications.type} not in ('receipt_ready', 'meal_plan_ready', 'household')`,
        ),
      );
    let remaining = limit - Number(sent?.n ?? 0);
    for (const c of candidates) {
      if (remaining <= 0) break;
      if (c.audienceMemberId !== null && c.audienceMemberId !== member.memberId) continue;
      if (s && s[c.setting] === false) continue;
      const inserted = await db
        .insert(notifications)
        .values({
          householdId: household.id,
          userId: member.userId,
          type: c.type,
          title: c.title,
          body: c.body,
          link: c.link,
          dedupeKey: c.dedupeKey,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (inserted.length > 0) {
        remaining -= 1;
        created += 1;
        if (s?.emailDigest && plan.entitlements.advanced_notifications) {
          await sendEmail({
            to: member.email,
            subject: c.title,
            text: `${c.title}\n\n${c.body}\n\n${env().APP_URL}${c.link}`,
            html: emailLayout(c.title, `<p>${escapeHtml(c.body)}</p>${emailButton(`${env().APP_URL}${c.link}`, "Open Plenty")}`),
          });
          await db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, inserted[0].id));
        }
      }
    }
  }
  return created;
}

/** Opportunistic runs per household at most this often (the scheduled job covers the rest). */
const REFRESH_EVERY_MS = 5 * 60_000;
const lastRefresh = new Map<string, number>();

/**
 * Run for the signed-in household (called opportunistically after page loads,
 * throttled). `force` runs regardless — for the notifications page itself.
 */
export async function refreshNotifications(ctx: HouseholdContext, now = new Date(), opts: { force?: boolean } = {}): Promise<void> {
  const last = lastRefresh.get(ctx.household.id);
  if (!opts.force && last !== undefined && now.getTime() - last < REFRESH_EVERY_MS) return;
  lastRefresh.set(ctx.household.id, now.getTime());
  try {
    await withSystem((tx) => generateNotificationsForHousehold(tx, ctx.household, now));
  } catch (err) {
    console.error("[notifications] refresh failed:", err instanceof Error ? err.message : err);
  }
}

/** Scheduled job: every onboarded household. */
export async function generateAllNotifications(now = new Date()): Promise<{ households: number; created: number }> {
  const rows = await systemDb
    .select({
      id: households.id,
      name: households.name,
      adults: households.adults,
      children: households.children,
      timezone: households.timezone,
      currency: households.currency,
    })
    .from(households)
    .where(and(isNull(households.deletedAt), sql`${households.onboardedAt} is not null`));
  let created = 0;
  for (const household of rows) {
    try {
      created += await withSystem((tx) => generateNotificationsForHousehold(tx, household, now));
    } catch (err) {
      console.error(`[notifications] household ${household.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { households: rows.length, created };
}

