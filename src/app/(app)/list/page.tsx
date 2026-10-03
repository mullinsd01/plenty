import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ListRefreshButton } from "@/features/list/list-refresh";
import { ListView, type ListAccess } from "@/features/list/list-view";
import { RecurringButton } from "@/features/list/recurring-sheet";
import { can } from "@/lib/members/permissions";
import { relativeDayLabel, toDateString } from "@/lib/dates";
import { requireHousehold } from "@/server/auth/context";
import { listMemberOptions } from "@/server/services/members";
import { listRecurring } from "@/server/services/recurring";
import { getShoppingList } from "@/server/services/shopping";

export const metadata: Metadata = { title: "Shopping list" };

export default async function ListPage() {
  const ctx = await requireHousehold();
  const [list, members, recurring] = await Promise.all([getShoppingList(ctx), listMemberOptions(ctx), listRecurring(ctx)]);
  const access: ListAccess = {
    canEdit: can(ctx.role, "edit_shopping_list"),
    canComplete: can(ctx.role, "complete_shop"),
    canPrivate: ctx.plan.entitlements.member_ownership === "full",
    canRepeat: ctx.plan.entitlements.recurring_purchases,
  };
  const toBuy = list.items.filter((i) => !i.checked).length;
  const today = toDateString(new Date(), ctx.household.timezone);
  const shopLine =
    list.rhythm.basis === "default"
      ? "Plenty adds what's running low and what your meals need"
      : `next shop probably ${relativeDayLabel(list.rhythm.nextShopDate, today).toLowerCase()}`;
  const subtitle = access.canEdit
    ? `${toBuy === 0 ? "Nothing to get" : `${toBuy} to get`} · ${shopLine}`
    : `${toBuy === 0 ? "Nothing on it yet" : `${toBuy} to get`} · ask for anything you'd like`;
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        title="Shopping list"
        subtitle={subtitle}
        actions={
          access.canEdit ? (
            <>
              <RecurringButton
                recurring={recurring}
                members={members}
                canUse={access.canRepeat}
                canPrivate={access.canPrivate}
                restricted={!access.canEdit}
              />
              <ListRefreshButton />
            </>
          ) : undefined
        }
      />
      <ListView items={list.items} members={members} access={access} />
    </div>
  );
}
