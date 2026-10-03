import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { planFlags, type PlanFlags } from "@/lib/billing/plans";
import type { Role } from "@/lib/members/permissions";
import { resolveHouseholdPlan, type HouseholdPlan } from "@/server/billing/entitlements";
import { systemDb } from "@/server/db/client";
import { householdMembers, households } from "@/server/db/schema";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isDemo: boolean;
  activeHouseholdId: string | null;
}

/** What the plan switches on for learning and shopping (see `planFlags`). */
export interface HouseholdInfo extends PlanFlags {
  id: string;
  name: string;
  adults: number;
  children: number;
  currency: string;
  timezone: string;
  onboardedAt: Date | null;
  isDemo: boolean;
}

/** The signed-in person's place in the household. */
export interface MemberInfo {
  id: string;
  role: Role;
  displayName: string;
}

/** Everything a household-scoped request needs: who is asking, for which household, and on what plan. */
export interface HouseholdContext {
  user: AuthUser;
  household: HouseholdInfo;
  member: MemberInfo;
  role: Role;
  plan: HouseholdPlan;
}

/**
 * Build the context for a user in one of their households (their active one
 * by default, else their earliest). Used by requests, scripts and tests, so
 * it doesn't depend on Next.js.
 */
export async function buildHouseholdContext(user: AuthUser, householdId?: string): Promise<HouseholdContext | null> {
  const memberships = await systemDb
    .select({
      role: householdMembers.role,
      memberId: householdMembers.id,
      memberName: householdMembers.displayName,
      id: households.id,
      name: households.name,
      adults: households.adults,
      children: households.children,
      currency: households.currency,
      timezone: households.timezone,
      onboardedAt: households.onboardedAt,
      isDemo: households.isDemo,
    })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.userId, user.id), isNull(households.deletedAt)))
    .orderBy(asc(householdMembers.joinedAt));
  if (memberships.length === 0) return null;
  const wanted = householdId ?? user.activeHouseholdId;
  const active = memberships.find((m) => m.id === wanted) ?? memberships[0];
  const { role, memberId, memberName, ...base } = active;
  const plan = await resolveHouseholdPlan(base.id);
  const household = {
    ...base,
    ...planFlags(plan.entitlements),
  };
  return { user, household, role, member: { id: memberId, role, displayName: memberName ?? user.displayName }, plan };
}
