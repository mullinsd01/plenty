import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { DeleteAccountControl } from "@/features/privacy/delete-account";
import { EmailForm, PasswordForm, ProfileForm, SettingsCard, SignOutEverywhere } from "@/features/settings/forms";
import { requireHousehold } from "@/server/auth/context";
import { planAccountDeletion } from "@/server/services/account-deletion";

export const metadata: Metadata = { title: "Account" };

export default async function AccountSettingsPage() {
  const { user } = await requireHousehold();
  const deletionPlan = await planAccountDeletion(user.id);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Account" />
      {user.isDemo && <p className="rounded-2xl bg-info-soft px-4 py-3 text-[14px] text-info">You&apos;re exploring the shared demo household, so account details can&apos;t be changed.</p>}
      <SettingsCard title="Your name">
        <ProfileForm name={user.displayName} isDemo={user.isDemo} />
      </SettingsCard>
      <SettingsCard title="Email">
        <EmailForm email={user.email} isDemo={user.isDemo} />
      </SettingsCard>
      <SettingsCard title="Password">
        <PasswordForm isDemo={user.isDemo} />
      </SettingsCard>
      {!user.isDemo && (
        <SettingsCard title="Sessions" description="Signed in somewhere you shouldn't be? This signs you out everywhere, including here.">
          <SignOutEverywhere />
        </SettingsCard>
      )}
      <SettingsCard title="Delete account" description="Permanently delete your account, and any household you're the only person with an account in. This can't be undone.">
        <DeleteAccountControl plan={deletionPlan} isDemo={user.isDemo} />
      </SettingsCard>
    </div>
  );
}
