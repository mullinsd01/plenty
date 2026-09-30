import { AppShell } from "@/components/layout/app-shell";
import { requireHousehold } from "@/server/auth/context";
import { countUnreadNotifications } from "@/server/services/notifications";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireHousehold();
  const unread = await countUnreadNotifications(ctx).catch(() => 0);
  return (
    <AppShell
      user={{ displayName: ctx.user.displayName, email: ctx.user.email, isDemo: ctx.user.isDemo }}
      household={{ name: ctx.household.name }}
      unreadCount={unread}
    >
      {children}
    </AppShell>
  );
}
