import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { ArrowRight, ChefHat, Clock, ReceiptText, ScanLine, ShoppingBasket, Sprout, TriangleAlert } from "lucide-react";
import { BasisLabel } from "@/components/food/confidence";
import { MealArt } from "@/components/food/meal-art";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { AddToListButton, CheckInList, PastDateCard, PlanTonightButton, TonightActions } from "@/features/home/home-client";
import { cn } from "@/lib/cn";
import { formatMoney, pluralize, remainingPhrase } from "@/lib/format";
import { requireHousehold } from "@/server/auth/context";
import { getDashboard } from "@/server/services/dashboard";
import { getMealPlan } from "@/server/services/meals";
import { refreshNotifications } from "@/server/services/notification-jobs";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const ctx = await requireHousehold();
  const [d, plan] = await Promise.all([getDashboard(ctx), getMealPlan(ctx)]);
  after(() => refreshNotifications(ctx));

  const tonight = plan.days.find((day) => day.date === plan.today)?.item ?? null;
  const upcoming = plan.days.filter((day) => day.date !== plan.today && day.item?.status === "planned").slice(0, 3);
  const kitchenEmpty = d.kitchenCount === 0;
  const allClear = d.runningLow.length === 0 && d.useSoon.length === 0 && d.checkIns.length === 0 && !d.pastDate;

  return (
    <div className="animate-fade-in">
      <header className="mb-7 pt-2 sm:mb-9">
        <p className="text-[15px] font-medium text-ink-3">{d.todayLabel}</p>
        <h1 className="mt-1 text-balance text-[30px] font-semibold leading-tight tracking-[-0.035em] sm:text-[36px]">
          {d.greeting}, {d.firstName}
        </h1>
      </header>

      {d.receiptsNeedingReview.length > 0 && (
        <div className="mb-5 space-y-2">
          {d.receiptsNeedingReview.map((r) => (
            <Link
              key={r.id}
              href={`/receipts/${r.id}`}
              className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-card transition hover:border-line-strong"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-brand-soft text-brand-ink">
                <ReceiptText className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold">
                  {r.status === "processing" ? "Reading your receipt…" : "Your receipt is ready to check"}
                </span>
                <span className="block truncate text-[13px] text-ink-3">
                  {r.status === "processing" ? "This usually takes a few seconds." : `${r.store ?? "Receipt"} · confirm it to update your kitchen`}
                </span>
              </span>
              <ArrowRight className="size-4 text-ink-4" />
            </Link>
          ))}
        </div>
      )}

      {(d.checkIns.length > 0 || d.pastDate) && (
        <div className="mb-6 space-y-2">
          {d.checkIns.length > 0 && <CheckInList items={d.checkIns} />}
          {d.pastDate && <PastDateCard itemIds={d.pastDate.itemIds} summary={d.pastDate.summary} />}
        </div>
      )}

      {kitchenEmpty && !d.hasAnyReceipt ? (
        <WelcomeCard />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-10">
          <div className="space-y-8">
            <section aria-labelledby="running-low">
              <SectionTitle id="running-low" action={<Link href="/kitchen" className="text-[13px] font-medium text-ink-3 hover:text-ink">Kitchen</Link>}>
                Running low
              </SectionTitle>
              {d.runningLow.length === 0 ? (
                <QuietCard>{allClear ? "Nothing's about to run out. Plenty is keeping an eye on things." : "Nothing's about to run out."}</QuietCard>
              ) : (
                <Card className="divide-y divide-line">
                  {d.runningLow.map((item) => (
                    <div key={item.productId} className="flex items-center gap-3 px-4 py-3.5">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full",
                          item.daysRemaining <= 1 ? "bg-alert" : item.daysRemaining <= 3 ? "bg-soon" : "bg-ink-4",
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">{item.name}</p>
                        <p className="text-[13px] text-ink-3">
                          {remainingPhrase(item.label)}
                          <span className="mx-1.5 text-ink-4">·</span>
                          <BasisLabel basis={item.basis} confidence={item.confidence} className="align-middle text-[12px]" />
                        </p>
                      </div>
                      <AddToListButton name={item.name} onList={item.onList} />
                    </div>
                  ))}
                </Card>
              )}
            </section>

            {d.useSoon.length > 0 && (
              <section aria-labelledby="use-soon">
                <SectionTitle
                  id="use-soon"
                  action={
                    <Link href="/meals/cook" className="text-[13px] font-medium text-ink-3 hover:text-ink">
                      Find a meal
                    </Link>
                  }
                >
                  Use soon
                </SectionTitle>
                <Card className="divide-y divide-line">
                  {d.useSoon.map((item) => (
                    <Link key={item.itemId} href={`/kitchen/${item.itemId}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-subtle/60">
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-full",
                          item.status === "expired" ? "bg-alert-soft text-alert" : "bg-soon-soft text-soon",
                        )}
                      >
                        {item.status === "expired" ? <TriangleAlert className="size-4" /> : <Clock className="size-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">
                          {item.name}
                          {item.count > 1 && <span className="ml-1.5 text-[13px] font-medium text-ink-3">×{item.count}</span>}
                        </p>
                        <p className="text-[13px] text-ink-3">{item.count > 1 ? `Oldest: ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}` : item.label}</p>
                      </div>
                    </Link>
                  ))}
                </Card>
              </section>
            )}

            <section aria-labelledby="tonight">
              <SectionTitle id="tonight" action={<Link href="/meals" className="text-[13px] font-medium text-ink-3 hover:text-ink">Meal plan</Link>}>
                Tonight
              </SectionTitle>
              {tonight && tonight.status === "planned" ? (
                <Card className="p-4 sm:p-5">
                  <div className="flex gap-4">
                    <MealArt mainIngredient={tonight.meal.mainIngredient} name={tonight.meal.name} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.01em]">{tonight.meal.name}</h3>
                      <p className="mt-0.5 text-[13px] text-ink-3">
                        {tonight.meal.timeMinutes} min · {tonight.meal.difficultyLabel}
                      </p>
                      <p className="mt-2 text-[14px] text-ink-2">
                        {tonight.meal.missingCount === 0
                          ? "You already have everything."
                          : `Uses ${pluralize(tonight.meal.haveCount, "ingredient")} you already have · missing ${tonight.meal.missingCount}.`}
                      </p>
                      {tonight.reason && <p className="mt-1 text-[13px] text-fresh">{tonight.reason}</p>}
                    </div>
                  </div>
                  <div className="mt-4">
                    <TonightActions planItemId={tonight.id} mealId={tonight.meal.id} />
                  </div>
                </Card>
              ) : tonight && tonight.status === "cooked" ? (
                <QuietCard>
                  You made {tonight.meal.name.toLowerCase()} tonight. Plenty took the ingredients out of your kitchen.
                </QuietCard>
              ) : (
                <Card className="p-5">
                  <p className="text-[15px] font-semibold">Nothing planned for tonight</p>
                  <p className="mt-1 text-[14px] text-ink-3">Plenty will pick something that uses what you already have.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <PlanTonightButton />
                    <Button asChild size="sm" variant="secondary">
                      <Link href="/meals/cook">What can I make?</Link>
                    </Button>
                  </div>
                </Card>
              )}
              {upcoming.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {upcoming.map((day) => (
                    <Link
                      key={day.date}
                      href={`/meals/recipes/${day.item!.meal.id}`}
                      className="inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] transition hover:border-line-strong"
                    >
                      <span className="font-semibold text-ink-2">{day.label}</span>
                      <span className="truncate text-ink-3">{day.item!.meal.name}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-8">
            <section aria-labelledby="next-shop">
              <SectionTitle id="next-shop">Next shop</SectionTitle>
              <Link href="/list" className="group block">
                <Card className="flex items-center gap-4 p-4 transition group-hover:border-line-strong">
                  <span className="flex size-11 items-center justify-center rounded-2xl bg-subtle text-ink-2">
                    <ShoppingBasket className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold tracking-[-0.01em]">
                      {d.nextShop.itemCount === 0 ? "Nothing needed yet" : pluralize(d.nextShop.itemCount, "item")}
                    </p>
                    <p className="text-[13px] text-ink-3">
                      {d.nextShop.dateLabel && d.nextShop.basis !== "default" ? `Probably ${d.nextShop.dateLabel.toLowerCase()}` : "Your smart list"}
                      {d.nextShop.checkedCount > 0 && ` · ${d.nextShop.checkedCount} in the trolley`}
                    </p>
                  </div>
                  <ArrowRight className="size-4 text-ink-4 transition group-hover:translate-x-0.5" />
                </Card>
              </Link>
            </section>

            <section aria-labelledby="recent-receipt">
              <SectionTitle id="recent-receipt" action={<Link href="/receipts" className="text-[13px] font-medium text-ink-3 hover:text-ink">All receipts</Link>}>
                Recent receipt
              </SectionTitle>
              {d.recentReceipt ? (
                <Link href={`/receipts/${d.recentReceipt.id}`} className="group block">
                  <Card className="flex items-center gap-4 p-4 transition group-hover:border-line-strong">
                    <span className="flex size-11 items-center justify-center rounded-2xl bg-subtle text-ink-2">
                      <ReceiptText className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold">{d.recentReceipt.store ?? "Receipt"}</p>
                      <p className="text-[13px] text-ink-3">
                        {[d.recentReceipt.dateLabel, pluralize(d.recentReceipt.itemCount, "item"), formatMoney(d.recentReceipt.total, d.recentReceipt.currency ?? ctx.household.currency)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </Card>
                </Link>
              ) : (
                <Card className="p-4">
                  <p className="text-[14px] text-ink-2">Scan your next receipt and Plenty will fill in your kitchen for you.</p>
                  <Button asChild variant="brand" size="sm" className="mt-3">
                    <Link href="/receipts/new">
                      <ScanLine /> Scan a receipt
                    </Link>
                  </Button>
                </Card>
              )}
            </section>

            {d.insights.length > 0 && (
              <section aria-labelledby="insights">
                <SectionTitle
                  id="insights"
                  action={
                    <Link href="/insights" className="text-[13px] font-medium text-ink-3 hover:text-ink">
                      See all
                    </Link>
                  }
                >
                  Plenty has noticed
                </SectionTitle>
                <Card className="divide-y divide-line">
                  {d.insights.map((text) => (
                    <div key={text} className="flex gap-3 px-4 py-3.5">
                      <Sprout className="mt-0.5 size-4 shrink-0 text-fresh" />
                      <p className="text-[14px] leading-relaxed text-ink-2">{text}</p>
                    </div>
                  ))}
                </Card>
              </section>
            )}

            <Link
              href="/meals/cook"
              className="group flex items-center gap-4 rounded-2xl bg-primary p-5 text-on-primary shadow-raised transition hover:bg-primary-hover"
            >
              <ChefHat className="size-6 shrink-0 opacity-80" />
              <div className="flex-1">
                <p className="text-[15px] font-semibold">What can I make right now?</p>
                <p className="text-[13px] opacity-70">Meals from what&apos;s already in your kitchen.</p>
              </div>
              <ArrowRight className="size-4 opacity-70 transition group-hover:translate-x-0.5" />
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
}

function QuietCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-line-strong px-4 py-4 text-[14px] text-ink-3">{children}</div>;
}

function WelcomeCard() {
  return (
    <Card className="overflow-hidden">
      <div className="p-6 sm:p-8">
        <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-brand-ink">Let&apos;s fill your kitchen</p>
        <h2 className="mt-2 max-w-md text-balance text-[24px] font-semibold leading-tight tracking-[-0.025em]">
          Scan your latest receipt and Plenty will do the rest.
        </h2>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ink-3">
          It reads the receipt, tidies up the names, works out where things live and when they&apos;ll likely run out. You just
          confirm.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild variant="brand" size="lg">
            <Link href="/receipts/new">
              <ScanLine /> Scan a receipt
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/kitchen?add=1">Add things by hand</Link>
          </Button>
        </div>
      </div>
      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
        {[
          ["Knows what you have", "Every receipt updates your kitchen automatically."],
          ["Learns your pace", "Tap “finished” and Plenty learns how fast things go."],
          ["Plans around it", "Meals that use what's there — and a list of only what's missing."],
        ].map(([title, body]) => (
          <div key={title} className="bg-surface p-5">
            <p className="text-[14px] font-semibold">{title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
