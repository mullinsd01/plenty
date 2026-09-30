import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ReceiptText, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { formatShortDate } from "@/lib/dates";
import { formatMoney, pluralize, timeAgo } from "@/lib/format";
import { requireHousehold } from "@/server/auth/context";
import { listReceipts } from "@/server/services/receipts";

export const metadata: Metadata = { title: "Receipts" };

const STATUS: Record<string, { label: string; tone: "brand" | "neutral" | "alert" | "fresh" }> = {
  processing: { label: "Reading…", tone: "neutral" },
  uploaded: { label: "Reading…", tone: "neutral" },
  needs_review: { label: "Ready to check", tone: "brand" },
  failed: { label: "Couldn't read", tone: "alert" },
  confirmed: { label: "In your kitchen", tone: "fresh" },
};

export default async function ReceiptsPage() {
  const ctx = await requireHousehold();
  const receipts = await listReceipts(ctx);
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Receipts"
        subtitle="Every shop you've scanned. Plenty learns your rhythm from these."
        actions={
          <Button asChild variant="brand" size="sm">
            <Link href="/receipts/new">
              <ScanLine /> Scan
            </Link>
          </Button>
        }
      />
      {receipts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ReceiptText />}
            title="No receipts yet"
            action={
              <Button asChild variant="brand">
                <Link href="/receipts/new">
                  <ScanLine /> Scan your first receipt
                </Link>
              </Button>
            }
          >
            Scan a receipt after your next shop and Plenty will update your kitchen for you.
          </EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {receipts.map((r) => {
            const s = STATUS[r.status] ?? STATUS.processing;
            return (
              <Link key={r.id} href={`/receipts/${r.id}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-subtle/60">
                <span className="flex size-10 items-center justify-center rounded-xl bg-subtle text-ink-3">
                  <ReceiptText className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">{r.storeName ?? "Receipt"}</p>
                  <p className="text-[13px] text-ink-3">
                    {[r.purchasedOn ? formatShortDate(r.purchasedOn) : `Uploaded ${timeAgo(r.createdAt)}`, r.itemCount ? pluralize(r.itemCount, "item") : null, formatMoney(r.total, r.currency ?? ctx.household.currency)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Pill tone={s.tone} size="sm">
                  {s.label}
                </Pill>
                <ArrowRight className="size-4 shrink-0 text-ink-4" />
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
