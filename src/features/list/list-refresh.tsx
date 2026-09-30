"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/hooks/use-action";
import { cn } from "@/lib/cn";
import { refreshListAction } from "./actions";

/** Re-run Plenty's list reasoning now (it also runs automatically). */
export function ListRefreshButton() {
  const { pending, run } = useAction();
  return (
    <Button variant="ghost" size="sm" onClick={() => run(() => refreshListAction(), { success: "List is up to date" })} disabled={pending} aria-label="Update list">
      <RefreshCw className={cn(pending && "animate-spin")} /> <span className="hidden sm:inline">Update</span>
    </Button>
  );
}
