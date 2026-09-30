import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { DangerZone, HouseholdForm, InviteLink, MembersList, SettingsCard } from "@/features/settings/forms";
import { requireHousehold } from "@/server/auth/context";
import { env } from "@/server/env";
import { getActiveInvitation, listMembers } from "@/server/services/household";

export const metadata: Metadata = { title: "Household & sharing" };

export default async function HouseholdSettingsPage() {
  const ctx = await requireHousehold();
  const [members, invite] = await Promise.all([listMembers(ctx), getActiveInvitation(ctx)]);
  const { household } = ctx;
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Household & sharing" />
      <SettingsCard title="Your household">
        <HouseholdForm initial={{ name: household.name, adults: household.adults, children: household.children, timezone: household.timezone, currency: household.currency }} />
      </SettingsCard>
      <SettingsCard title="Who's in it" description="Everyone shares the kitchen, shopping list and meal plan. Anything anyone updates, everyone sees.">
        <MembersList members={members} canManage={ctx.role === "owner"} />
      </SettingsCard>
      <SettingsCard title="Invite someone" description="Send a link to anyone you live with.">
        <InviteLink
          initial={invite ? { code: invite.code, expiresAt: invite.expiresAt.toISOString() } : null}
          appUrl={env().APP_URL}
          isDemo={household.isDemo}
        />
      </SettingsCard>
      <SettingsCard title="Leave or delete">
        <DangerZone householdName={household.name} isOwner={ctx.role === "owner"} memberCount={members.length} isDemo={household.isDemo} />
      </SettingsCard>
    </div>
  );
}
