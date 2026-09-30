"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "./button";

/** Friendly error UI for route error boundaries. Never shows stack traces. */
export function ErrorView({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-alert-soft text-alert">
        <RefreshCw className="size-5" />
      </div>
      <h1 className="text-xl font-semibold tracking-[-0.02em]">{offline ? "You're offline" : "That didn't load"}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-3">
        {offline
          ? "Plenty needs a connection to load this. Check your internet and try again."
          : "Something went wrong on our side. It's usually temporary — try again in a moment."}
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Button asChild variant="secondary">
          <Link href="/home">Go home</Link>
        </Button>
      </div>
      {error.digest && <p className="mt-6 text-xs text-ink-4">Reference: {error.digest}</p>}
    </div>
  );
}
