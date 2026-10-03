import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AiConsentControl } from "@/features/privacy/ai-consent";
import { AnalyticsToggle, ReceiptRetentionControl } from "@/features/privacy/privacy-controls";
import { DeleteAccountControl } from "@/features/privacy/delete-account";
import { ChildrenText, DataGroups, DeletionText, ProcessorList, VisibilityRules } from "@/features/privacy/policy-sections";
import { DangerZone, ExportButton, SettingsCard } from "@/features/settings/forms";
import { ROLE_LABELS, can, isRestricted } from "@/lib/members/permissions";
import { processorsFor } from "@/lib/privacy-content";
import { requireHousehold } from "@/server/auth/context";
import { getPreferences } from "@/server/services/household";
import { listMembers } from "@/server/services/members";
import { householdSubscriptionNotice, planAccountDeletion } from "@/server/services/account-deletion";
import { getAiConsentView, getAnalyticsOptOut, processorConfig } from "@/server/services/privacy";
import { RETENTION_LABELS, RETENTION_POLICIES, isRetentionPolicy } from "@/server/services/receipt-privacy";

export const metadata: Metadata = { title: "Privacy & data" };

function SectionHeading({ id, children, note }: { id: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="mb-3 mt-10">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        {children}
      </h2>
      {note && <p className="mt-1 text-[14px] text-ink-3">{note}</p>}
    </div>
  );
}

export default async function PrivacySettingsPage() {
  const ctx = await requireHousehold();
  const [prefs, members, aiView, optedOut, deletionPlan, subscription] = await Promise.all([
    getPreferences(ctx),
    listMembers(ctx),
    getAiConsentView(ctx),
    getAnalyticsOptOut(ctx.user),
    planAccountDeletion(ctx.user.id),
    householdSubscriptionNotice(ctx.household.id),
  ]);
  const canChange = can(ctx.role, "change_settings");
  // A child account has choices of its own (analytics, its own account); the household's AI, photo and export settings are the adults'.
  const restricted = isRestricted(ctx.role);
  const retention = isRetentionPolicy(prefs.receiptImageRetention) ? prefs.receiptImageRetention : "after_review";
  const processors = processorsFor(processorConfig());
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Privacy & data"
        subtitle="What Plenty keeps, who handles it, and what you can change. Nothing here is sold, and no advertisers or data brokers are involved."
      />
      <nav aria-label="On this page" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium text-ink-3">
        <a href="#choices" className="hover:text-ink">Your choices</a>
        <a href="#collected" className="hover:text-ink">What Plenty keeps</a>
        <a href="#who" className="hover:text-ink">Who handles it</a>
        <a href="#visibility" className="hover:text-ink">Who sees what</a>
        <a href="#delete" className="hover:text-ink">Deleting</a>
      </nav>

      <SectionHeading id="choices">Your choices</SectionHeading>
      <div className="space-y-5">
        {restricted ? (
          <p className="rounded-2xl bg-subtle px-4 py-3 text-[14px] text-ink-2">
            The household&apos;s AI, receipt-photo and data-download settings are looked after by the adults. Below is what you can choose for yourself.
          </p>
        ) : (
          <>
            <SettingsCard title="AI-assisted features" description="Off unless you turn it on. Plenty works fully without it.">
              <AiConsentControl view={aiView} />
            </SettingsCard>
            <SettingsCard title="Receipt photos" description="After a receipt is checked, Plenty only needs the items. How long should it keep the photo?">
              <ReceiptRetentionControl
                initial={retention}
                canChange={canChange}
                options={RETENTION_POLICIES.map((value) => ({ value, ...RETENTION_LABELS[value] }))}
              />
              <p className="mt-3 text-[13px] text-ink-3">A photo you never check is deleted after 14 days. Deleting a photo never removes the items you added from it.</p>
            </SettingsCard>
          </>
        )}
        <SettingsCard title="Usage analytics">
          <AnalyticsToggle optedOut={optedOut} />
        </SettingsCard>
        {!restricted && (
          <SettingsCard title="Your data" description="A complete copy of your household's data as JSON. Receipt photos aren't included in the file; open a receipt to see or save its photo.">
            {can(ctx.role, "export_data") ? <ExportButton /> : <p className="text-[14px] text-ink-3">An owner or member of the household can download the data.</p>}
          </SettingsCard>
        )}
      </div>

      <SectionHeading id="collected" note="Plenty keeps only what it needs to do its job. Tap a heading for the detail.">
        What Plenty keeps, and why
      </SectionHeading>
      <DataGroups />

      <SectionHeading id="who" note="Only the companies this Plenty is actually set up to use are listed.">
        Who handles your data
      </SectionHeading>
      <ProcessorList processors={processors} />

      <SectionHeading id="visibility" note={`You're signed in as ${ROLE_LABELS[ctx.role].toLowerCase()} of ${ctx.household.name}.`}>
        Who sees what in your household
      </SectionHeading>
      <VisibilityRules />
      <h3 className="mb-2 mt-6 text-[15px] font-semibold">Children</h3>
      <ChildrenText />

      <SectionHeading id="delete" note="Deleting is permanent. Plenty can't bring anything back, so each option says exactly what goes.">
        Deleting your data
      </SectionHeading>
      <div className="mb-5">
        <DeletionText />
      </div>
      <div className="space-y-5">
        {!restricted && (
          <SettingsCard title="Delete this household" description="Removes the household and everything in it, for everyone who uses it.">
            <DangerZone
              householdName={ctx.household.name}
              isOwner={ctx.role === "owner"}
              memberCount={members.length}
              isDemo={ctx.household.isDemo}
              subscription={ctx.role === "owner" ? subscription : null}
            />
          </SettingsCard>
        )}
        <SettingsCard title="Delete my account" description="Removes your sign-in and any household you're the only person with an account in.">
          <DeleteAccountControl plan={deletionPlan} isDemo={ctx.user.isDemo} />
        </SettingsCard>
      </div>

      <p className="mt-10 border-t border-line pt-5 text-[13px] text-ink-3">
        The full <Link href="/privacy" className="font-medium text-ink underline underline-offset-2">Privacy Policy</Link>,{" "}
        <Link href="/terms" className="font-medium text-ink underline underline-offset-2">Terms</Link> and{" "}
        <Link href="/support" className="font-medium text-ink underline underline-offset-2">Support</Link> are public pages.
      </p>
    </div>
  );
}
