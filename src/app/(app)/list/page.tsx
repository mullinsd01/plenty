import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ListRefreshButton } from "@/features/list/list-refresh";
import { ListView } from "@/features/list/list-view";
import { relativeDayLabel, toDateString } from "@/lib/dates";
import { requireHousehold } from "@/server/auth/context";
import { getShoppingList } from "@/server/services/shopping";

export const metadata: Metadata = { title: "Shopping list" };

export default async function ListPage() {
  const ctx = await requireHousehold();
  const list = await getShoppingList(ctx);
  const toBuy = list.items.filter((i) => !i.checked).length;
  const today = toDateString(new Date(), ctx.household.timezone);
  const shopLine =
    list.rhythm.basis === "default"
      ? "Plenty adds what's running low and what your meals need"
      : `next shop probably ${relativeDayLabel(list.rhythm.nextShopDate, today).toLowerCase()}`;
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        title="Shopping list"
        subtitle={`${toBuy === 0 ? "Nothing to get" : `${toBuy} to get`} · ${shopLine}`}
        actions={<ListRefreshButton />}
      />
      <ListView items={list.items} />
    </div>
  );
}
