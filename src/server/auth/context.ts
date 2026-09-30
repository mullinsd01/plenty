import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { householdMembers, households, profiles } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { getCurrentSession } from "./session";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isDemo: boolean;
  activeHouseholdId: string | null;
}

export interface HouseholdInfo {
  id: string;
  name: string;
  adults: number;
  children: number;
  currency: string;
  timezone: string;
  onboardedAt: Date | null;
  isDemo: boolean;
}

/** Everything a household-scoped request needs: who is asking, for which household. */
export interface HouseholdContext {
  user: AuthUser;
  household: HouseholdInfo;
  role: "owner" | "member";
}

/** The signed-in user (with profile), or null. Cached per request. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const current = await getCurrentSession();
  if (!current) return null;
  const [profile] = await systemDb
    .select({ displayName: profiles.displayName, activeHouseholdId: profiles.activeHouseholdId })
    .from(profiles)
    .where(eq(profiles.userId, current.user.id))
    .limit(1);
  return {
    id: current.user.id,
    email: current.user.email,
    isDemo: current.user.isDemo,
    displayName: profile?.displayName ?? current.user.email.split("@")[0],
    activeHouseholdId: profile?.activeHouseholdId ?? null,
  };
});

/**
 * The user's active household. Falls back to their earliest membership when
 * the active one is missing (e.g. they left it). Cached per request.
 */
export const getHouseholdContext = cache(async (): Promise<HouseholdContext | null> => {
  const user = await getAuthUser();
  if (!user) return null;
  const memberships = await systemDb
    .select({
      role: householdMembers.role,
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
  const active = memberships.find((m) => m.id === user.activeHouseholdId) ?? memberships[0];
  const { role, ...household } = active;
  return { user, household, role };
});

/** For pages: redirect to sign-in when there's no session. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  return user;
}

/** For app pages: require a session and a fully onboarded household. */
export async function requireHousehold(): Promise<HouseholdContext> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  const ctx = await getHouseholdContext();
  if (!ctx || !ctx.household.onboardedAt) redirect("/onboarding");
  return ctx;
}

/** For server actions and route handlers: throw instead of redirecting. */
export async function householdForAction(): Promise<HouseholdContext> {
  const ctx = await getHouseholdContext();
  if (!ctx) {
    const user = await getAuthUser();
    if (!user) throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
    throw new AppError("forbidden", "Set up your household first.");
  }
  return ctx;
}

export async function userForAction(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
  return user;
}
