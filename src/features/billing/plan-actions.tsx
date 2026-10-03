"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { postForUrl, requestNativeRestore } from "./billing-api";

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
 * Restore purchases, inside the iOS and Android apps. The app owns the store
 * and sends what it finds to Plenty to verify, so this asks the app to do
 * that. It never claims a result it can't see.
 */
export function RestorePurchasesButton({ store }: { store: "the App Store" | "Google Play" | "the store" }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          const result = requestNativeRestore();
          setMessage(
            result === "requested"
              ? `Asked ${store} to check for your purchases. If one is found, your plan will update here.`
              : "Restore purchases runs from the Plenty app. Open Plenty on your phone and try again.",
          );
        }}
      >
        <RotateCcw aria-hidden />
        Restore purchases
      </Button>
      <div aria-live="polite" role="status">
        {message && <p className="mt-2 text-[13px] text-ink-3">{message}</p>}
      </div>
    </div>
  );
}
