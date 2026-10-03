import { CircleAlert, Info, CircleCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { paymentAttentionText, planFacts, statusPill, usageRows, type UsageRow } from "@/lib/billing/plan-view";
import type { BillingOverview } from "@/server/billing/service";
import type { CheckoutReturn } from "@/server/billing/plan-page";
import { PortalButton, RestorePurchasesButton, StoreLink } from "./plan-actions";

const NOTICE_TONES = {
  soon: "border-soon/30 bg-soon-soft",
  info: "border-info/25 bg-info-soft",
  fresh: "border-fresh/30 bg-fresh-soft",
  neutral: "border-line bg-subtle",
} as const;

function Notice({
  tone,
  title,
  children,
  action,
  icon: Icon = Info,
}: {
  tone: keyof typeof NOTICE_TONES;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  icon?: typeof Info;
}) {
  return (
    <div
      className={cn("flex flex-col gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between", NOTICE_TONES[tone])}
    >
      <div className="flex min-w-0 gap-3">
        <Icon aria-hidden className="mt-0.5 size-[18px] shrink-0 text-ink-2" />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink">{title}</p>
          {children && <div className="mt-0.5 text-[14px] text-ink-2">{children}</div>}
        </div>
      </div>
      {action && <div className="shrink-0 pl-[30px] sm:pl-0">{action}</div>}
    </div>
  );
}

/** What happened when the person came back from Checkout. */
export function CheckoutReturnNotice({ checkout }: { checkout: CheckoutReturn }) {
  return (
    <div role="status">
      <Notice
        tone={checkout.status === "success" ? "fresh" : checkout.status === "pending" ? "info" : "neutral"}
        title={checkout.status === "cancelled" ? "Checkout cancelled" : checkout.status === "success" ? "You're all set" : "Thank you"}
        icon={checkout.status === "success" ? CircleCheck : Info}
      >
        {checkout.message}
      </Notice>
    </div>
  );
}

/** The plan in force, the one honest sentence about it, and the one place to manage it. */
export function CurrentPlanCard({ overview: o }: { overview: BillingOverview }) {
  const pill = statusPill(o);
  const facts = planFacts(o);
  const m = o.management;
  const portalOpen = !!m && m.canManage && m.kind === "web_portal" && m.portal;
  const storeUrl = m && m.canManage ? m.url : null;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Current plan</p>
          <h2 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{o.planName}</h2>
        </div>
        {o.reason !== "no_subscription" && <Pill tone={pill.tone}>{pill.label}</Pill>}
      </div>
      <p className="mt-3 text-pretty text-[15px] text-ink-2">{o.summary}</p>

      {facts.length > 0 && (
        <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-line pt-4 sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-[12px] font-medium text-ink-3">{f.label}</dt>
              <dd className="mt-0.5 text-[14px] font-medium text-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(o.needsPaymentAttention || o.pendingChange) && (
        <div className="mt-5 space-y-3">
          {o.needsPaymentAttention && (
            <Notice
              tone="soon"
              title="Your payment needs attention"
              icon={CircleAlert}
              action={
                portalOpen ? (
                  <PortalButton label="Update payment method" />
                ) : storeUrl ? (
                  <StoreLink href={storeUrl} label={m!.label} />
                ) : undefined
              }
            >
              {paymentAttentionText(o)}
            </Notice>
          )}
          {o.pendingChange && (
            <Notice tone="info" title="A change is booked">
              {o.pendingChange.description}
            </Notice>
          )}
        </div>
      )}

      {m && (
        <div className="mt-5 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {!(portalOpen || storeUrl) && <p className="text-[14px] font-semibold text-ink">{m.label}</p>}
            <p className="text-[14px] text-ink-3">{m.text}</p>
            {!m.canManage && m.kind !== "operator" && (
              <p className="mt-1 text-[13px] text-ink-3">Only a household owner can change this.</p>
            )}
          </div>
          {portalOpen ? <PortalButton label={m.label} /> : storeUrl ? <StoreLink href={storeUrl} label={m.label} /> : null}
        </div>
      )}
    </Card>
  );
}

function UsageMeter({ row }: { row: UsageRow }) {
  const labelId = `usage-${row.key}`;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-[14px] font-medium">
          {row.label}
        </span>
        <span className="text-[14px] tabular-nums text-ink-2">{row.value}</span>
      </div>
      {row.fraction !== null && row.limit !== null && (
        <div
          role="meter"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={row.limit}
          aria-valuenow={Math.min(row.used, row.limit)}
          aria-valuetext={row.value}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", row.tone === "ok" ? "bg-fresh" : "bg-soon")}
            style={{ width: `${Math.max(Math.round(row.fraction * 100), row.used > 0 ? 4 : 0)}%` }}
          />
        </div>
      )}
      {row.note && <p className="mt-1 text-[12px] text-ink-3">{row.note}</p>}
    </li>
  );
}

export function UsageCard({ overview: o }: { overview: BillingOverview }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">What you&apos;re using</h2>
      <p className="mt-1 text-[14px] text-ink-3">
        Limits only ever stop you adding more. Finishing, removing and the shopping list always work.
      </p>
      <ul className="mt-5 space-y-5">
        {usageRows(o).map((row) => (
          <UsageMeter key={row.key} row={row} />
        ))}
      </ul>
      {o.overLimit.over && o.overLimit.message && (
        <div className="mt-5">
          <Notice tone="info" title="You're over this plan's limit, and nothing has been lost">
            {o.overLimit.message}
          </Notice>
        </div>
      )}
    </Card>
  );
}

/** Restore purchases: a control in the apps, an explanation on the web. */
export function RestoreCard({ overview: o }: { overview: BillingOverview }) {
  const platform = o.purchase.platform;
  if (platform === "web") {
    return (
      <Card className="p-5 sm:p-6">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Subscribed in the iOS or Android app?</h2>
        <p className="mt-1 text-[14px] text-ink-3">
          Subscriptions bought through the App Store or Google Play are restored from this page inside the Plenty app, and managed in that
          store. Ones started on the web are managed here.
        </p>
      </Card>
    );
  }
  const store =
    o.purchase.store.provider === "apple" ? "the App Store" : o.purchase.store.provider === "google" ? "Google Play" : "the store";
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="min-w-0">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Restore purchases</h2>
        <p className="mt-1 text-[14px] text-ink-3">
          Already subscribed on another phone or before reinstalling? Restore your purchase from {store} to link it to this household.
        </p>
      </div>
      <RestorePurchasesButton store={store} />
    </Card>
  );
}
