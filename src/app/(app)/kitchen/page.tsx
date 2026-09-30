import type { Metadata } from "next";
import Link from "next/link";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { KitchenView } from "@/features/kitchen/kitchen-view";
import { requireHousehold } from "@/server/auth/context";
import { getInventory, recentlyFinished } from "@/server/services/inventory";

export const metadata: Metadata = { title: "Kitchen" };

export default async function KitchenPage() {
  const ctx = await requireHousehold();
  const [inventory, finished] = await Promise.all([getInventory(ctx), recentlyFinished(ctx)]);
  const lowCount = inventory.items.filter((i) => i.estimatedFraction <= 0.3).length;
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Kitchen"
        subtitle={
          inventory.items.length === 0
            ? "Everything you have, kept up to date for you."
            : `${inventory.items.length} things${lowCount ? ` · ${lowCount} running low` : ""} · levels are Plenty's estimate until you correct them`
        }
        actions={
          <Button asChild variant="secondary" size="sm" className="hidden sm:inline-flex">
            <Link href="/receipts/new">
              <ScanLine /> Scan receipt
            </Link>
          </Button>
        }
      />
      <KitchenView items={inventory.items} finished={finished} />
    </div>
  );
}
