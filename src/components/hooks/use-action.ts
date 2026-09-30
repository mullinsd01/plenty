"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/result";

/**
 * Run a server action with consistent UX: pending state, a friendly toast on
 * failure (never a stack trace), an optional success toast, and a redirect to
 * sign-in if the session expired.
 */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const run = useCallback(
    <T,>(
      action: () => Promise<ActionResult<T>>,
      opts: {
        success?: string | ((data: T) => string | undefined);
        onSuccess?: (data: T) => void;
        onError?: (error: string) => void;
        /** Optimistic UI update — runs inside the action's transition so it holds until the server responds. */
        optimistic?: () => void;
      } = {},
    ) => {
      startTransition(async () => {
        opts.optimistic?.();
        let res: ActionResult<T>;
        try {
          res = await action();
        } catch {
          toast.error("Couldn't reach Plenty. Check your connection and try again.");
          opts.onError?.("network");
          return;
        }
        if (!res) return;
        if (!res.ok) {
          if (res.code === "unauthenticated") {
            toast.error(res.error);
            router.push("/login");
            return;
          }
          toast.error(res.error);
          opts.onError?.(res.error);
          return;
        }
        const message = typeof opts.success === "function" ? opts.success(res.data) : (opts.success ?? res.message);
        if (message) toast.success(message);
        opts.onSuccess?.(res.data);
      });
    },
    [router],
  );

  return { pending, run };
}
