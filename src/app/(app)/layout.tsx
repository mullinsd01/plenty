import { AppShell } from "@/components/layout/app-shell";
import { PeopleProvider } from "@/features/members/people-context";
import { requireHousehold } from "@/server/auth/context";
import { listMemberOptions } from "@/server/services/members";
import { countUnreadNotifications } from "@/server/services/notifications";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireHousehold();
  const [unread, members] = await Promise.all([countUnreadNotifications(ctx).catch(() => 0), listMemberOptions(ctx).catch(() => [])]);
  return (
    <AppShell
      user={{ displayName: ctx.user.displayName, email: ctx.user.email, isDemo: ctx.user.isDemo }}
      household={{ name: ctx.household.name }}
      unreadCount={unread}
      role={ctx.role}
    >
      <PeopleProvider members={members} role={ctx.role} canPrivate={ctx.plan.entitlements.member_ownership === "full"}>
        {children}
      </PeopleProvider>
    </AppShell>
  );
}
