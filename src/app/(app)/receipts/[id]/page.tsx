import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ProcessingView } from "@/features/receipts/processing-view";
import { ReceiptFailedActions } from "@/features/receipts/failed-actions";
import { ReviewView } from "@/features/receipts/review-view";
import { formatLongDate, toDateString } from "@/lib/dates";
import { STORAGE_LOCATION_LABELS } from "@/lib/domain";
import { formatMoney } from "@/lib/format";
import { formatQuantity } from "@/lib/units";
import { requireHousehold } from "@/server/auth/context";
import { getReceiptReview } from "@/server/services/receipts";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: PageProps<"/receipts/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const ctx = await requireHousehold();
  const review = await getReceiptReview(ctx, id);
  if (!review || review.status === "discarded") notFound();
  const today = toDateString(new Date(), ctx.household.timezone);
  const back = { href: "/receipts", label: "Receipts" };

  if (review.status === "processing" || review.status === "uploaded") {
    return (
      <div className="mx-auto max-w-3xl animate-fade-in">
        <PageHeader back={back} title="Reading your receipt" subtitle="Hang tight — this usually takes a few seconds." />
        <ProcessingView receiptId={review.id} />
      </div>
    );
  }

  if (review.status === "failed") {
    return (
      <div className="mx-auto max-w-2xl animate-fade-in">
        <PageHeader back={back} title="We couldn't read that one" />
        <Card className="p-6">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-alert" />
            <p className="text-[15px] leading-relaxed text-ink-2">{review.errorMessage ?? "Something went wrong reading this receipt."}</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button asChild variant="brand">
              <Link href="/receipts/new">
                <ScanLine /> Try another photo
              </Link>
            </Button>
            <ReceiptFailedActions receiptId={review.id} />
          </div>
        </Card>
        {review.hasImage && <ReceiptImage id={review.id} />}
      </div>
    );
  }

  if (review.status === "needs_review") {
    return (
      <div className="mx-auto max-w-3xl animate-fade-in">
        <PageHeader
          back={back}
          title="Check your receipt"
          subtitle={`${review.items.filter((i) => i.status !== "ignored").length} items found. Fix anything that's off, then add them to your kitchen.`}
        />
        <ReviewView review={review} currency={ctx.household.currency} today={today} />
        {review.hasImage && <ReceiptImage id={review.id} />}
      </div>
    );
  }

  const accepted = review.items.filter((i) => i.status === "accepted");
  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        back={back}
        title={review.storeName ?? "Receipt"}
        subtitle={[review.purchasedOn ? formatLongDate(review.purchasedOn) : null, formatMoney(review.total, review.currency ?? ctx.household.currency)].filter(Boolean).join(" · ")}
      />
      <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Added to your kitchen</p>
      <Card className="divide-y divide-line">
        {accepted.map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium">{i.name}</p>
              <p className="text-[12px] text-ink-3">
                {formatQuantity(i.quantity, i.unit)} · {STORAGE_LOCATION_LABELS[i.location]} <span className="ml-1 font-mono text-[11px] text-ink-4">{i.rawText}</span>
              </p>
            </div>
            {i.totalPrice !== null && <span className="tabular text-[14px] text-ink-2">{i.totalPrice.toFixed(2)}</span>}
          </div>
        ))}
      </Card>
      {review.hasImage && <ReceiptImage id={review.id} />}
    </div>
  );
}

function ReceiptImage({ id }: { id: string }) {
  return (
    <details className="mt-8">
      <summary className="cursor-pointer text-[13px] font-semibold text-ink-3">Show the photo</summary>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/receipts/${id}/image`} alt="Receipt photo" loading="lazy" className="mt-3 max-h-[80vh] w-auto rounded-xl border border-line object-contain" />
    </details>
  );
}
