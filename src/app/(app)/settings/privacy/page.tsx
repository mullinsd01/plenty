import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { AiProcessingToggle, DangerZone, ExportButton, SettingsCard } from "@/features/settings/forms";
import { aiStatus } from "@/server/ai";
import { requireHousehold } from "@/server/auth/context";
import { getPreferences } from "@/server/services/household";
import { listMembers } from "@/server/services/members";

export const metadata: Metadata = { title: "Privacy & data" };

export default async function PrivacySettingsPage() {
  const ctx = await requireHousehold();
  const [p, members] = await Promise.all([getPreferences(ctx), listMembers(ctx)]);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Privacy & data" />
      <SettingsCard title="AI processing">
        <AiProcessingToggle allowed={p.allowAiProcessing} externalConfigured={aiStatus().externalConfigured} />
      </SettingsCard>
      <SettingsCard title="What Plenty stores">
        <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <li>Your kitchen, shopping list, meal plans and the receipts you scan (photos are stored privately and only visible to your household).</li>
          <li>When things were bought, finished or thrown out — this is how Plenty learns your household&apos;s pace.</li>
          <li>Your food preferences and how you&apos;ve rated meals.</li>
          <li>Nothing is sold or shared. Every household&apos;s data is isolated at the database level.</li>
        </ul>
      </SettingsCard>
      <SettingsCard title="Export" description="A complete copy of your household's data as JSON.">
        <ExportButton />
      </SettingsCard>
      <SettingsCard title="Delete" description="Remove your household's data permanently. To delete your whole account, go to Account.">
        <DangerZone householdName={ctx.household.name} isOwner={ctx.role === "owner"} memberCount={members.length} isDemo={ctx.household.isDemo} />
      </SettingsCard>
    </div>
  );
}
