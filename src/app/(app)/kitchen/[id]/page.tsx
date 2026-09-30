import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BasisLabel } from "@/components/food/confidence";
import { LevelMeter } from "@/components/food/level";
import { Card, SectionTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { ItemDetailActions } from "@/features/kitchen/item-detail-actions";
import { formatLongDate, toDateString } from "@/lib/dates";
import { STORAGE_LOCATION_LABELS } from "@/lib/domain";
import { capitalize, formatMoney, timeAgo, remainingPhrase } from "@/lib/format";
import { formatDuration } from "@/lib/prediction/labels";
import { formatBase, type BaseUnit } from "@/lib/units";
import { requireHousehold } from "@/server/auth/context";
import { getInventoryItem } from "@/server/services/inventory";

export const metadata: Metadata = { title: "Item" };

const EVENT_LABELS: Record<string, string> = {
  added: "Added",
  adjusted: "Level updated",
  used: "Used in a meal",
  finished: "Finished",
  wasted: "Thrown out",
  expired: "Went off",
  removed: "Removed",
  restored: "Restored",
  moved: "Moved",
  edited: "Details edited",
};

const ACTOR_LABELS: Record<string, string> = {
  user: "",
  receipt: "from a receipt",
  meal: "by a meal you cooked",
  inference: "inferred by Plenty",
  system: "",
};

export default async function KitchenItemPage({ params }: PageProps<"/kitchen/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const ctx = await requireHousehold();
  const data = await getInventoryItem(ctx, id);
  if (!data) notFound();
  const { item, events, history, status, otherBatches } = data;
  const probablyUsedUp = item.estimatedFraction <= 0.03;
  const active = status === "active";

  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader
        back={{ href: "/kitchen", label: "Kitchen" }}
        title={item.name}
        subtitle={`${item.quantityLabel} · ${STORAGE_LOCATION_LABELS[item.location]} · bought ${timeAgo(item.purchasedAt)}`}
      />

      {!active && (
        <div className="mb-6 rounded-2xl bg-subtle px-4 py-3 text-[14px] text-ink-2">
          This item is no longer in your kitchen ({status === "finished" ? "finished" : status === "wasted" ? "thrown out" : status}).
        </div>
      )}

      {active && (
        <Card className="mb-8 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink-3">How much is left</p>
              <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">
                {item.countable && item.remainingCount !== null ? `${item.remainingCount} of ${item.quantity}` : item.levelLabel}
              </p>
            </div>
            <LevelMeter fraction={item.estimatedFraction} className="h-2 w-28" />
          </div>
          {probablyUsedUp && (
            <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
              By Plenty&apos;s estimate this one is used up. Tap <span className="font-medium text-ink-2">Finished</span> if that&apos;s right, or
              update how much is left.
            </p>
          )}
          {item.prediction && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[15px] font-medium">
                {otherBatches > 0
                  ? `Counting the other ${otherBatches === 1 ? "one" : otherBatches} you have: ${remainingPhrase(item.prediction.label).charAt(0).toLowerCase()}${remainingPhrase(item.prediction.label).slice(1)}`
                  : remainingPhrase(item.prediction.label)}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{item.prediction.reason}</p>
              <BasisLabel basis={item.prediction.basis} confidence={item.prediction.confidence} className="mt-2" />
            </div>
          )}
          {item.useSoon.status !== "unknown" && item.useSoon.status !== "ok" && (
            <div className="mt-4 border-t border-line pt-4">
              <Pill tone={item.useSoon.status === "expired" ? "alert" : "soon"}>{item.useSoon.label}</Pill>
            </div>
          )}
          <div className="mt-5">
            <ItemDetailActions item={item} />
          </div>
        </Card>
      )}

      <section className="mb-8">
        <SectionTitle>Details</SectionTitle>
        <Card className="divide-y divide-line text-[14px]">
          <Row label="Amount">{item.quantityLabel}</Row>
          <Row label="Kept in">{STORAGE_LOCATION_LABELS[item.location]}</Row>
          <Row label="Bought">{formatLongDate(toDateString(new Date(item.purchasedAt), ctx.household.timezone))}</Row>
          <Row label={item.expiryIsActual ? "Use by" : "Likely good until"}>
            {item.expiresOn ? formatLongDate(item.expiresOn) : "Keeps a long time"}
            {!item.expiryIsActual && item.expiresOn && <span className="ml-1 text-ink-4">(estimate)</span>}
          </Row>
          {item.price !== null && <Row label="Paid">{formatMoney(item.price, ctx.household.currency)}</Row>}
          <Row label="Added from">{item.source === "receipt" ? "A receipt" : item.source === "shopping_list" ? "Your shopping list" : "Added by hand"}</Row>
          {item.notes && <Row label="Notes">{item.notes}</Row>}
        </Card>
      </section>

      {history.length > 0 && (
        <section className="mb-8">
          <SectionTitle>How your household uses it</SectionTitle>
          <Card className="divide-y divide-line">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px]">
                <span className="text-ink-2">
                  {formatBase(h.amountUsedBase + h.amountWastedBase, h.baseUnit as BaseUnit)} lasted {formatDuration(h.durationDays)}
                  {h.amountWastedBase > 0 && (
                    <span className="text-soon"> · {formatBase(h.amountWastedBase, h.baseUnit as BaseUnit)} thrown out</span>
                  )}
                </span>
                <span className="shrink-0 text-[12px] text-ink-4">{timeAgo(h.endedAt)}</span>
              </div>
            ))}
          </Card>
          <p className="mt-2 text-[12px] text-ink-4">Each time you finish one, Plenty&apos;s predictions for your household get sharper.</p>
        </section>
      )}

      <section>
        <SectionTitle>Activity</SectionTitle>
        <Card>
          <ol className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px]">
                <span>
                  {EVENT_LABELS[e.type] ?? capitalize(e.type)}
                  {ACTOR_LABELS[e.actor] && <span className="text-ink-3"> {ACTOR_LABELS[e.actor]}</span>}
                  {e.note && <span className="text-ink-3"> · {e.note}</span>}
                </span>
                <span className="shrink-0 text-[12px] text-ink-4">{timeAgo(e.occurredAt)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="text-ink-3">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}
