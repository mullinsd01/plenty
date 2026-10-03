"use client";

import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import type { BillingPeriod } from "@/lib/billing/plans";
import type { ComparisonModel, PlanAction, PlanCardModel } from "@/lib/billing/plan-view";
import { ActionError, PortalButton, StoreLink, useBillingRedirect } from "./plan-actions";

const PERIOD_OPTIONS: Array<{ value: BillingPeriod; label: string }> = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Yearly" },
];

/** A two-way radio group: Tab reaches it once, the arrow keys move and choose, as people expect of radio buttons. */
function PeriodToggle({ value, onChange }: { value: BillingPeriod; onChange: (value: BillingPeriod) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="radiogroup" aria-label="How often you pay" className="inline-flex w-full rounded-[12px] bg-subtle p-1 sm:w-auto">
      {PERIOD_OPTIONS.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = (i + step + PERIOD_OPTIONS.length) % PERIOD_OPTIONS.length;
              onChange(PERIOD_OPTIONS[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              "h-8 flex-1 whitespace-nowrap rounded-[9px] px-4 text-[13px] font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2",
              on ? "bg-surface text-ink shadow-[0_1px_3px_rgb(0_0_0/0.08)]" : "text-ink-3 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Free, Plus and Family side by side. Everything in a card comes from the
 * model (which comes from `PLANS`); nothing is chosen for the person: the
 * period starts on monthly and no plan is pre-selected.
 */
export function PlanComparison({ model }: { model: ComparisonModel }) {
  const [period, setPeriod] = useState<BillingPeriod>(model.defaultPeriod);
  const [active, setActive] = useState<string | null>(null);
  const checkout = useBillingRedirect("/api/billing/checkout");

  return (
    <div>
      {model.showPrices && (
        <div className="mb-4">
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      )}
      {model.notice && <p className="mb-4 rounded-xl bg-subtle px-4 py-3 text-[14px] text-ink-2">{model.notice}</p>}
      <ul className="grid gap-4 md:grid-cols-3">
        {model.cards.map((card) => (
          <PlanCard
            key={card.id}
            card={card}
            period={period}
            showPrices={model.showPrices}
            busy={checkout.busy}
            starting={checkout.busy && active === card.id}
            error={active === card.id ? checkout.error : null}
            onCheckout={(plan, p) => {
              setActive(plan);
              void checkout.go({ plan, period: p });
            }}
          />
        ))}
      </ul>
      <p className="mt-4 text-[13px] text-ink-3">{model.keepNote}</p>
      <p className="mt-1 text-[13px] text-ink-3">{model.proNote}</p>
    </div>
  );
}

function PlanCard({
  card,
  period,
  showPrices,
  busy,
  starting,
  error,
  onCheckout,
}: {
  card: PlanCardModel;
  period: BillingPeriod;
  showPrices: boolean;
  busy: boolean;
  starting: boolean;
  error: string | null;
  onCheckout: (plan: "plus" | "family", period: BillingPeriod) => void;
}) {
  const price = card.price[period];
  const action = card.actions[period];
  const disclosure = card.disclosure[period];
  const headingId = `plan-${card.id}`;
  const disclosureId = `plan-${card.id}-terms`;
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border bg-surface p-5 shadow-card",
        card.current ? "border-brand ring-1 ring-brand/25" : "border-line",
      )}
    >
      <article aria-labelledby={headingId} className="flex flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <h3 id={headingId} className="text-[17px] font-semibold tracking-[-0.01em]">
            {card.name}
          </h3>
          {card.current && <Pill tone="brand">Your plan</Pill>}
        </div>
        <p className="mt-1 text-[13px] text-ink-3">{card.tagline}</p>
        {price && (showPrices || card.id === "free") && (
          <p className="mt-4 flex items-baseline gap-1.5">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">{price.amount}</span>
            {price.per && <span className="text-[14px] text-ink-3">{price.per}</span>}
          </p>
        )}
        {price?.saving && <p className="mt-1.5 text-[13px] font-medium text-fresh">{price.saving}</p>}
        <ul className="mt-4 space-y-2 text-[14px] text-ink-2">
          {card.highlights.map((line) => (
            <li key={line} className="flex gap-2">
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fresh" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-5">
          <CardAction
            action={action}
            shortName={card.shortName}
            describedBy={disclosure ? disclosureId : undefined}
            busy={busy}
            starting={starting}
            onCheckout={onCheckout}
          />
          {disclosure && (
            <p id={disclosureId} className="mt-3 text-[12px] leading-relaxed text-ink-3">
              {disclosure}
            </p>
          )}
          <ActionError message={error} />
        </div>
      </article>
    </li>
  );
}

function CardAction({
  action,
  shortName,
  describedBy,
  busy,
  starting,
  onCheckout,
}: {
  action: PlanAction;
  shortName: string;
  describedBy?: string;
  busy: boolean;
  starting: boolean;
  onCheckout: (plan: "plus" | "family", period: BillingPeriod) => void;
}) {
  switch (action.kind) {
    case "checkout":
      return (
        <Button
          type="button"
          block
          loading={starting}
          disabled={busy && !starting}
          aria-describedby={describedBy}
          onClick={() => onCheckout(action.plan, action.period)}
        >
          Subscribe to {shortName}
        </Button>
      );
    case "portal":
      return <PortalButton block label={action.label} />;
    case "store_link":
      return <StoreLink block href={action.url} label={action.label} />;
    case "pending":
    case "text":
      return <p className="text-[13px] font-medium text-ink-2">{action.text}</p>;
    case "current":
    case "store":
    case "none":
      return null;
  }
}
