import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { AddPersonButton, PERSON_COLORS, PeopleList, type PersonRow } from "@/features/members/members-panel";
import { DangerZone, HouseholdForm, InviteLink, SettingsCard } from "@/features/settings/forms";
import { cheapestPlanWith } from "@/lib/billing/plans";
import { can } from "@/lib/members/permissions";
import { requireHousehold } from "@/server/auth/context";
import { checkRoomForMember } from "@/server/billing/limits";
import { env } from "@/server/env";
import { getActiveInvitation } from "@/server/services/household";
import { listMembers } from "@/server/services/members";

export const metadata: Metadata = { title: "Household & sharing" };

export default async function HouseholdSettingsPage() {
  const ctx = await requireHousehold();
  const [members, invite, room] = await Promise.all([listMembers(ctx), getActiveInvitation(ctx), checkRoomForMember(ctx)]);
  const { household } = ctx;
  const isOwner = can(ctx.role, "manage_members");
  const max = ctx.plan.entitlements.max_household_members;
  const people: PersonRow[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    color: m.color,
    hasAccount: m.hasAccount,
    isYou: m.isYou,
    email: m.email,
    // Your own rules; an owner can also look after a child's or a profile without an account.
    canEditRules: m.isYou || (isOwner && (!m.hasAccount || m.role === "child")),
  }));
  const upgradePlan =
    cheapestPlanWith((e) => e.max_household_members === null || (max !== null && (e.max_household_members ?? Infinity) > max)) ?? "family";
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Household & sharing" />
      <SettingsCard title="Your household">
        <HouseholdForm
          initial={{
            name: household.name,
            adults: household.adults,
            children: household.children,
            timezone: household.timezone,
            currency: household.currency,
          }}
        />
      </SettingsCard>
      <SettingsCard
        title="Who's in it"
        description="Everyone shares the kitchen, shopping list and meal plan. Food can belong to the household or to one person, and anyone can keep their own things private on plans that include it."
      >
        <PeopleList people={people} isOwner={isOwner} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-[13px] text-ink-3">
            {members.length} {members.length === 1 ? "person" : "people"}
            {max !== null ? ` of ${max} on ${ctx.plan.plan === "free" ? "the free plan" : "your plan"}` : ""}
          </p>
          <AddPersonButton
            allowed={isOwner}
            limitNote={room.ok ? null : room.message}
            upgradePlan={upgradePlan}
            nextColor={PERSON_COLORS[members.length % PERSON_COLORS.length]}
          />
        </div>
        {!isOwner && <p className="mt-3 text-[13px] text-ink-3">Only an owner can add or remove people and change roles.</p>}
      </SettingsCard>
      {isOwner && (
        <SettingsCard
          title="Invite someone"
          description="Send a link to anyone you live with. They get their own account and see what the household shares."
        >
          {!room.ok && (
            <UpgradeNote plan={upgradePlan} className="mb-4">
              {room.message}
            </UpgradeNote>
          )}
          <InviteLink
            initial={invite ? { code: invite.code, expiresAt: invite.expiresAt.toISOString() } : null}
            appUrl={env().APP_URL}
            isDemo={household.isDemo}
          />
        </SettingsCard>
      )}
      <SettingsCard title="Leave or delete">
        <DangerZone householdName={household.name} isOwner={isOwner} memberCount={members.length} isDemo={household.isDemo} />
      </SettingsCard>
    </div>
  );
}
