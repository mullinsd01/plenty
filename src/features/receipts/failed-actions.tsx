"use client";

import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/hooks/use-action";
import { discardReceiptAction, retryReceiptAction } from "./actions";

export function ReceiptFailedActions({ receiptId }: { receiptId: string }) {
  const router = useRouter();
  const retry = useAction();
  const discard = useAction();
  return (
    <>
      <Button variant="secondary" loading={retry.pending} onClick={() => retry.run(() => retryReceiptAction(receiptId), { onSuccess: () => router.refresh() })}>
        <RefreshCw /> Try reading it again
      </Button>
      <Button variant="ghost" loading={discard.pending} onClick={() => discard.run(() => discardReceiptAction(receiptId), { onSuccess: () => router.push("/receipts") })}>
        Discard
      </Button>
    </>
  );
}
