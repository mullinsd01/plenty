import "server-only";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { hourInTimeZone, toDateString, weekdayOf, zonedDateTimeToInstant } from "@/lib/dates";
import type { NotificationType } from "@/lib/domain";
import { wasteInsights } from "@/lib/insights";
import type { HouseholdContext, HouseholdInfo } from "@/server/auth/context";
import { systemDb, withSystem, type Queryable } from "@/server/db/client";
import { householdMembers, households, notificationSettings, notifications, shoppingListItems, users } from "@/server/db/schema";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "@/server/email/mailer";
import { env } from "@/server/env";
import { toItemView } from "./inventory";
import { computeLiveState } from "./learning";
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
}

type HouseholdRow = Pick<HouseholdInfo, "id" | "name" | "adults" | "children" | "timezone" | "currency">;

/** Work out which nudges are genuinely useful for this household right now. Pure reads. */
async function candidatesFor(db: Queryable, household: HouseholdRow, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const today = toDateString(now, household.timezone);
  const live = await computeLiveState(db, household, now);

  for (const p of live.predictions.values()) {
    if (p.paused) continue;
    const name = p.product.name.toLowerCase();
    const snoozed = p.items.some((i) => i.checkInSnoozedUntil && i.checkInSnoozedUntil > now);
    if (p.prediction.needsCheckIn && !snoozed) {
      out.push({
        type: "check_in",
        title: `Did you finish the ${name}?`,
        body: "One tap on your home screen keeps Plenty's predictions accurate.",
        link: "/home",
        dedupeKey: `check_in:${p.productId}:${today}`,
        priority: 0,
        setting: "checkIns",
      });
    } else if (p.prediction.daysRemaining <= 1.5 && (p.prediction.basis === "history" || p.prediction.confidence !== "low")) {
      out.push({
        type: "running_low",
        title: `You're probably running low on ${name}.`,
        body: `${p.prediction.label.charAt(0).toUpperCase()}${p.prediction.label.slice(1)} left. ${p.prediction.reason}`,
        link: "/list",
        dedupeKey: `running_low:${p.productId}:${toDateString(p.prediction.runOutAt, household.timezone)}`,
        priority: 1,
        setting: "runningLow",
      });
    }
  }

  for (const item of live.activeItems) {
    const view = toItemView(item, live, household);
    if (view.estimatedFraction < 0.1 || !view.perishable) continue;
    const s = view.useSoon;
    if ((s.status === "today" || (s.status === "soon" && (s.daysUntilExpiry ?? 9) <= 1)) && s.atRiskOfWaste) {
      out.push({
        type: "use_soon",
        title: `Don't forget to use your ${view.name.toLowerCase()}.`,
        body: s.status === "today" ? "It's best used today. Plenty can suggest a meal that uses it." : "It's likely to go off tomorrow. Plenty can suggest a meal that uses it.",
        link: "/meals/cook",
        dedupeKey: `use_soon:${item.id}:${view.expiresOn ?? today}`,
        priority: 2,
        setting: "useSoon",
      });
    }
  }

  const rhythm = await loadShoppingRhythm(db, household, now);
  if (rhythm.nextShopDate === today && rhythm.basis !== "default") {
    const list = await getOrCreateActiveList(db, household.id);
    const [open] = await db
      .select({ n: count() })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNull(shoppingListItems.checkedAt), isNull(shoppingListItems.purchasedAt)));
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
      });
    }
  }

  if (weekdayOf(today) === 1) {
    const insights = wasteInsights(
      [...live.statsRows.values()]
        .filter((s) => live.index.byId.has(s.productId))
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
export async function generateNotificationsForHousehold(db: Queryable, household: HouseholdRow, now: Date): Promise<number> {
  const candidates = await candidatesFor(db, household, now);
  if (candidates.length === 0) return 0;
  const members = await db
    .select({ userId: householdMembers.userId, email: users.email, settings: notificationSettings })
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
    const s = member.settings;
    const quietStart = s?.quietStartHour ?? 21;
    const quietEnd = s?.quietEndHour ?? 7;
    const quiet = quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
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
        if (s?.emailDigest) {
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

/** Run for the signed-in household (called opportunistically after page loads). */
export async function refreshNotifications(ctx: HouseholdContext, now = new Date()): Promise<void> {
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

