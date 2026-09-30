import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { NotificationSettingsForm } from "@/features/settings/forms";
import { requireHousehold } from "@/server/auth/context";
import { getNotificationSettings } from "@/server/services/household";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationSettingsPage() {
  const ctx = await requireHousehold();
  const s = await getNotificationSettings(ctx);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/settings", label: "Settings" }} title="Notifications" subtitle="Plenty only nudges you about things that are genuinely useful." />
      <NotificationSettingsForm
        initial={{
          runningLow: s.runningLow,
          useSoon: s.useSoon,
          mealPlanReady: s.mealPlanReady,
          shoppingReminder: s.shoppingReminder,
          checkIns: s.checkIns,
          insights: s.insights,
          emailDigest: s.emailDigest,
          dailyLimit: s.dailyLimit,
          quietStartHour: s.quietStartHour,
          quietEndHour: s.quietEndHour,
        }}
      />
    </div>
  );
}
