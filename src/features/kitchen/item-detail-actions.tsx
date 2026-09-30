"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InventoryItemView } from "@/server/services/inventory";
import { ItemSheet, useUndoableFinish } from "./item-sheet";

export function ItemDetailActions({ item }: { item: InventoryItemView }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { finish, pending } = useUndoableFinish();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => setOpen(true)}>
        <SlidersHorizontal /> Update
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => finish(item, "consumed", () => router.push("/kitchen"))}>
        <Check /> Finished
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => finish(item, "wasted", () => router.push("/kitchen"))}>
        Threw it out
      </Button>
      <ItemSheet item={item} open={open} onOpenChange={setOpen} />
    </div>
  );
}
