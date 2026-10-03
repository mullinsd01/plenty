import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FoodRulesForm } from "@/features/members/members-panel";
import { SettingsCard } from "@/features/settings/forms";
import { can } from "@/lib/members/permissions";
import { requireHousehold } from "@/server/auth/context";
import { getMemberFoodRules, listMembers } from "@/server/services/members";

export const metadata: Metadata = { title: "Food rules" };

export default async function PersonFoodRulesPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params;
  const ctx = await requireHousehold();
  const members = await listMembers(ctx);
  const person = members.find((m) => m.id === memberId);
  if (!person) notFound();
  // Your own, or — for an owner — a child's or a profile without an account. The database enforces this too.
  const allowed = person.isYou || (can(ctx.role, "manage_members") && (!person.hasAccount || person.role === "child"));
  if (!allowed) notFound();
  const rules = await getMemberFoodRules(ctx, person.id);
  const who = person.isYou ? "you" : person.name;
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader
        back={{ href: "/settings/household", label: "Household & sharing" }}
        title={person.isYou ? "Your food rules" : `${person.name}'s food rules`}
        subtitle="Used when Plenty suggests meals for the household."
      />
      <SettingsCard
        title="Who can see this"
        description={
          person.isYou
            ? "Only you. Plenty combines everyone's rules when it suggests meals, without saying whose they are — so nobody has to share their allergies to be kept in mind."
            : `Only you and other owners. Plenty combines everyone's rules when it suggests meals, without saying whose they are.`
        }
      >
        <FoodRulesForm memberId={person.id} name={who} initial={rules} />
      </SettingsCard>
    </div>
  );
}
