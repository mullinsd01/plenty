import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { NotificationList } from "@/features/notifications/notification-list";
import { requireHousehold } from "@/server/auth/context";
import { listNotifications, refreshNotifications } from "@/server/services/notifications";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireHousehold();
  await refreshNotifications(ctx);
  const items = await listNotifications(ctx);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader
        title="Notifications"
        subtitle={
          <>
            Only the useful stuff.{" "}
            <Link href="/settings/notifications" className="font-medium text-ink-2 hover:underline">
              Choose what you get
            </Link>
          </>
        }
      />
      <NotificationList items={items} />
    </div>
  );
}
