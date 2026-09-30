import type { Metadata } from "next";
import Link from "next/link";
import { Leaf, Pencil, Sprout } from "lucide-react";
import { BasisLabel } from "@/components/food/confidence";
import { Card, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { ForgetMealButton, ProductControls } from "@/features/insights/insight-controls";
import { cn } from "@/lib/cn";
import { formatShortDate } from "@/lib/dates";
import { formatMoney, pluralize } from "@/lib/format";
import { requireHousehold } from "@/server/auth/context";
import { getHouseholdMemory } from "@/server/services/memory";

export const metadata: Metadata = { title: "What Plenty knows" };

export default async function InsightsPage() {
  const ctx = await requireHousehold();
  const m = await getHouseholdMemory(ctx);
  const learned = m.products.filter((p) => p.basis === "history");
  const estimates = m.products.filter((p) => p.basis === "estimate");
  const maxWeek = Math.max(1, ...m.spend.weeks.map((w) => w.total), m.preferences.weeklyBudget ?? 0);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader
        title="What Plenty knows"
        subtitle="Everything Plenty has learned about your household — and why it suggests what it does. Change anything that's wrong."
      />

      {m.products.length === 0 && m.summary.receipts === 0 ? (
        <Card className="mb-10 p-5">
          <p className="text-[17px] font-semibold tracking-[-0.01em]">Nothing learned yet — that&apos;s normal</p>
          <p className="mt-1 text-[14px] leading-relaxed text-ink-3">
            Plenty starts with sensible estimates for a household your size, then learns your real pace from your receipts and
            the things you finish. Everything it learns shows up here, and you can correct any of it.
          </p>
          <Link href="/receipts/new" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand-ink hover:underline">
            Scan your first receipt
          </Link>
        </Card>
      ) : (
        <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={m.summary.learnedProducts} label="things learned from your history" />
          <Stat value={m.summary.estimatedProducts} label="still on Plenty's estimates" />
          <Stat value={m.summary.observations} label="times you've finished something" />
          <Stat value={m.summary.receipts} label="receipts scanned" />
        </div>
      )}

      <section className="mb-10">
        <SectionTitle>Your shopping rhythm</SectionTitle>
        <Card className="p-5">
          <p className="text-[17px] font-semibold tracking-[-0.01em]">
            {m.rhythm.label ?? (m.rhythm.basis === "preference" ? `You shop about every ${m.rhythm.intervalDays} days` : "Plenty is still learning when you shop")}
          </p>
          <p className="mt-1 text-[14px] text-ink-3">
            {m.rhythm.basis === "preference"
              ? "Based on the shopping day you set."
              : m.rhythm.basis === "history"
                ? `Worked out from your receipts. Next shop probably ${formatShortDate(m.rhythm.nextShop)}.`
                : "Scan a few receipts and Plenty will work out your usual shopping day."}
          </p>
          {(m.typicalShop.medianItems || m.typicalShop.medianSpend) && (
            <p className="mt-3 text-[14px] text-ink-2">
              A typical shop is {m.typicalShop.medianItems ? pluralize(m.typicalShop.medianItems, "item") : ""}
              {m.typicalShop.medianSpend ? ` and about ${formatMoney(m.typicalShop.medianSpend, m.currency)}` : ""}.
            </p>
          )}
          <Link href="/settings/shopping" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink">
            <Pencil className="size-3.5" /> Set your shopping day
          </Link>
        </Card>
      </section>

      {m.spend.weeks.some((w) => w.total > 0) && (
        <section className="mb-10">
          <SectionTitle>Spending</SectionTitle>
          <Card className="p-5">
            <p className="text-[17px] font-semibold tracking-[-0.01em]">
              {m.spend.averageWeekly !== null ? `About ${formatMoney(m.spend.averageWeekly, m.currency)} a week` : "Not enough receipts yet"}
            </p>
            {m.spend.label && <p className="mt-1 text-[14px] text-ink-3">{m.spend.label}</p>}
            <div
              className="relative mt-5 flex h-32 items-end gap-2"
              role="img"
              aria-label={`Weekly grocery spend for the last ${m.spend.weeks.length} weeks: ${m.spend.weeks
                .map((w) => `${formatShortDate(w.weekStart)} ${formatMoney(w.total, m.currency)}`)
                .join(", ")}`}
            >
              {m.preferences.weeklyBudget !== null && (
                <div
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-4/60"
                  style={{ bottom: `${(m.preferences.weeklyBudget / maxWeek) * 100}%` }}
                  aria-hidden
                >
                  <span className="absolute -top-4 right-0 text-[10px] font-medium text-ink-4">Budget</span>
                </div>
              )}
              {m.spend.weeks.map((w) => {
                const over = m.preferences.weeklyBudget !== null && w.total > m.preferences.weeklyBudget;
                return (
                  <div key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end">
                    <div
                      className={cn("w-full max-w-10 rounded-t-md", w.total === 0 ? "bg-line" : over ? "bg-soon" : "bg-navy/75")}
                      style={{ height: w.total === 0 ? "2px" : `${Math.max(4, (w.total / maxWeek) * 100)}%` }}
                      title={`Week of ${formatShortDate(w.weekStart)}: ${formatMoney(w.total, m.currency)}`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-2 text-[10px] text-ink-4">
              {m.spend.weeks.map((w) => (
                <span key={w.weekStart} className="flex-1 text-center">
                  {formatShortDate(w.weekStart).split(" ").slice(1).join(" ")}
                </span>
              ))}
            </div>
            {m.preferences.weeklyBudget !== null && (
              <p className="mt-3 text-[13px] text-ink-3">
                Your budget is {formatMoney(m.preferences.weeklyBudget, m.currency)} a week
                {m.spend.overBudgetWeeks > 0 ? ` · over in ${pluralize(m.spend.overBudgetWeeks, "week")}` : ""}.
              </p>
            )}
          </Card>
        </section>
      )}

      {m.waste.length > 0 && (
        <section className="mb-10">
          <SectionTitle>Food that tends to go to waste</SectionTitle>
          <Card className="divide-y divide-line">
            {m.waste.map((w) => (
              <div key={w.productId} className="flex gap-3 px-4 py-4">
                <Leaf className={cn("mt-0.5 size-4 shrink-0", w.severity === "high" ? "text-alert" : "text-soon")} />
                <div>
                  <p className="text-[15px] font-medium">{w.message}</p>
                  <p className="mt-0.5 text-[13px] text-ink-3">{w.suggestion} Plenty now suggests a smaller amount on your list.</p>
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section className="mb-10">
        <SectionTitle>How fast things go</SectionTitle>
        {m.products.length === 0 ? (
          <Card>
            <EmptyState icon={<Sprout />} title="Nothing learned yet" compact>
              Each time you mark something finished — or buy it again — Plenty learns how fast your household gets through it.
            </EmptyState>
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {[...learned, ...estimates].map((p) => (
              <div key={p.productId} className="flex items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                    {p.name}
                    {p.isStaple && (
                      <Pill size="sm" tone="fresh">
                        Staple
                      </Pill>
                    )}
                    {p.paused && (
                      <Pill size="sm" tone="neutral">
                        Not predicted
                      </Pill>
                    )}
                  </p>
                  <p className="text-[13px] text-ink-2">{[p.paceLabel, p.purchaseLabel].filter(Boolean).join(" · ") || "Plenty is still learning this one"}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <BasisLabel basis={p.basis} confidence={p.confidence} />
                    {p.observations > 0 && <span className="text-[12px] text-ink-4">· {pluralize(p.observations, "observation")}</span>}
                  </div>
                </div>
                <ProductControls productId={p.productId} name={p.name} isStaple={p.isStaple} stapleOverride={p.stapleOverride} paused={p.paused} />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-10">
        <SectionTitle>Meals</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="p-4">
            <p className="mb-2 text-[13px] font-semibold text-ink-2">Household favourites</p>
            {m.meals.favourites.length === 0 ? (
              <p className="text-[14px] text-ink-3">Like or save meals and Plenty will lean towards them.</p>
            ) : (
              <ul className="space-y-1">
                {m.meals.favourites.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 text-[14px]">
                    <Link href={`/meals/recipes/${f.id}`} className="truncate hover:underline">
                      {f.name}
                    </Link>
                    <span className="flex items-center gap-1">
                      {f.timesCooked > 0 && <span className="text-[12px] text-ink-4">{f.timesCooked}×</span>}
                      <ForgetMealButton mealId={f.id} name={f.name} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <p className="mb-2 text-[13px] font-semibold text-ink-2">Not for you</p>
            {m.meals.disliked.length === 0 && m.meals.notes.length === 0 ? (
              <p className="text-[14px] text-ink-3">Meals you dislike or keep swapping out show up here.</p>
            ) : (
              <>
                {m.meals.notes.map((n) => (
                  <p key={n} className="mb-2 text-[14px] text-ink-2">
                    {n}
                  </p>
                ))}
                <ul className="space-y-1">
                  {m.meals.disliked.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-[14px]">
                      <span className="truncate text-ink-3 line-through decoration-ink-4">{d.name}</span>
                      <ForgetMealButton mealId={d.id} name={d.name} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle action={<Link href="/settings/food" className="text-[13px] font-medium text-ink-3 hover:text-ink">Edit</Link>}>
          What you told Plenty
        </SectionTitle>
        <Card className="divide-y divide-line text-[14px]">
          <PrefRow label="Allergies" values={m.preferences.allergies} empty="None" />
          <PrefRow label="Dietary requirements" values={m.preferences.diets} empty="None" />
          <PrefRow label="Rather not see" values={m.preferences.dislikes} empty="Nothing" />
          <PrefRow label="Favourite cuisines" values={m.preferences.cuisines} empty="Not set" />
        </Card>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
      <p className="text-[26px] font-semibold tabular tracking-[-0.03em]">{value}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{label}</p>
    </div>
  );
}

function PrefRow({ label, values, empty }: { label: string; values: string[]; empty: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="text-right font-medium capitalize">{values.length ? values.join(", ") : <span className="normal-case text-ink-4">{empty}</span>}</span>
    </div>
  );
}
