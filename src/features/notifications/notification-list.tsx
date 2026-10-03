"use client";

import Link from "next/link";
import { Bell, CalendarDays, ChefHat, Clock, CreditCard, HandHeart, Leaf, ReceiptText, ShoppingBasket, Sprout, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { NotificationView } from "@/server/services/notifications";
import { dismissNotificationAction, markAllReadAction } from "./actions";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  running_low: Clock,
  use_soon: Leaf,
  meal_plan_ready: CalendarDays,
  shopping_reminder: ShoppingBasket,
  receipt_ready: ReceiptText,
  check_in: ChefHat,
  insight: Sprout,
  household: Users,
  request: HandHeart,
  billing: CreditCard,
};

export function NotificationList({ items }: { items: NotificationView[] }) {
  const readAll = useAction();
  const dismiss = useAction();
  const unread = items.filter((i) => !i.read).length;
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Bell />} title="You're all caught up">
          Plenty only nudges you when it&apos;s genuinely useful — like when something&apos;s about to run out or needs using.
        </EmptyState>
      </Card>
    );
  }
  return (
    <div>
      {unread > 0 && (
        <div className="mb-3 flex justify-end">
          <Button variant="ghost" size="sm" loading={readAll.pending} onClick={() => readAll.run(() => markAllReadAction())}>
            Mark all as read
          </Button>
        </div>
      )}
      <Card className="divide-y divide-line">
        {items.map((n) => {
          const Icon = ICONS[n.type] ?? Bell;
          const body = (
            <div className="flex min-w-0 flex-1 gap-3">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", n.read ? "bg-subtle text-ink-3" : "bg-brand-soft text-brand-ink")}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[15px]", n.read ? "font-medium text-ink-2" : "font-semibold")}>{n.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{n.body}</p>
                <p className="mt-1 text-[12px] text-ink-4">{timeAgo(n.createdAt)}</p>
              </div>
            </div>
          );
          return (
            <div key={n.id} className="flex items-start gap-2 px-4 py-3.5">
              {n.link ? (
                <Link href={n.link} className="flex min-w-0 flex-1">
                  {body}
                </Link>
              ) : (
                body
              )}
              <button
                type="button"
                aria-label="Dismiss"
                disabled={dismiss.pending}
                onClick={() => dismiss.run(() => dismissNotificationAction(n.id))}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
