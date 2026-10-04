"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { postForUrl, requestNativeRestore } from "./billing-api";
import { buyFromStore, purchasesPlugin, restoreFromStore } from "./native-purchases";

/**
 * Posts to a billing route and sends the browser to the address it returns
 * (Stripe Checkout or the billing portal). A failure keeps the person here
 * with the server's plain-language message, as a toast and as text that
 * assistive technology announces.
 */
export function useBillingRedirect(path: "/api/billing/checkout" | "/api/billing/portal") {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coming back with the browser's Back button restores this page as it was, still "busy".
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  async function go(body?: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await postForUrl(path, body));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setError(message);
      toast.error(message);
      setBusy(false);
    }
  }
  return { busy, error, go };
}

/** Always mounted so a screen reader hears an error when it appears. */
export function ActionError({ message }: { message: string | null }) {
  return (
    <div aria-live="polite" role="status">
      {message && <p className="mt-2 text-[13px] font-medium text-alert">{message}</p>}
    </div>
  );
}

/** Opens the web billing portal: payment method, plan changes, invoices, cancelling. */
export function PortalButton({
  label,
  variant = "secondary",
  size = "md",
  block,
}: {
  label: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  block?: boolean;
}) {
  const { busy, error, go } = useBillingRedirect("/api/billing/portal");
  return (
    <div className={block ? "w-full" : undefined}>
      <Button type="button" variant={variant} size={size} block={block} loading={busy} onClick={() => go()}>
        {label}
        <ExternalLink aria-hidden />
      </Button>
      <ActionError message={error} />
    </div>
  );
}

/** A link to the store's own subscription settings (Apple ID or Google Play). */
export function StoreLink({
  href,
  label,
  variant = "secondary",
  block,
}: {
  href: string;
  label: string;
  variant?: ButtonProps["variant"];
  block?: boolean;
}) {
  return (
    <Button asChild variant={variant} block={block}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/**
 * Subscribe through Apple's purchase sheet, inside the iPhone app. The sheet and the payment are Apple's; Plenty then
 * checks the purchase with Apple before the household gets its plan. If Apple took the payment but linking fails, the
 * person is told to restore, which finishes the job without charging again.
 */
export function StoreSubscribeButton({ productId, label, describedBy }: { productId: string; label: string; describedBy?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await buyFromStore(productId);
      if (result.kind === "linked") {
        toast.success(result.message);
        router.refresh();
      } else if (result.kind === "cancelled") {
        setNote("No problem. Nothing was charged.");
      } else {
        setNote(result.message);
        if (result.kind === "unlinked") router.refresh();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Nothing has been charged. Please try again.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button type="button" block loading={busy} aria-describedby={describedBy} onClick={subscribe}>
        {label}
      </Button>
      <ActionError message={error} />
      <div aria-live="polite" role="status">
        {note && <p className="mt-2 text-[13px] text-ink-3">{note}</p>}
      </div>
    </div>
  );
}

/**
 * Restore purchases, inside the iOS and Android apps. The app owns the store and gives Plenty what it finds to verify,
 * so this asks the app, then reports exactly what Plenty said. It never claims a result it can't see.
 */
export function RestorePurchasesButton({ store }: { store: "the App Store" | "Google Play" | "the store" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setMessage(null);
    setError(null);
    if (!purchasesPlugin()) {
      // An older shell that still answers the legacy hook.
      const result = requestNativeRestore();
      setMessage(
        result === "requested"
          ? `Asked ${store} to check for your purchases. If one is found, your plan will update here.`
          : "Restore purchases runs from the Plenty app. Open Plenty on your phone and try again.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await restoreFromStore();
      setMessage(result.message);
      if (result.outcome === "linked") router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't restore that. Nothing has changed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="secondary" loading={busy} onClick={restore}>
        <RotateCcw aria-hidden />
        Restore purchases
      </Button>
      <ActionError message={error} />
      <div aria-live="polite" role="status">
        {message && <p className="mt-2 text-[13px] text-ink-3">{message}</p>}
      </div>
    </div>
  );
}
