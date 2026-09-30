"use client";

import { MoreHorizontal, Pause, Play, RotateCcw, Star, StarOff, X } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useAction } from "@/components/hooks/use-action";
import { forgetMealAction, resetLearningAction, setPredictionsPausedAction, setStapleOverrideAction } from "./actions";

/** Per-product controls: staple on/off, pause predictions, forget what was learned. */
export function ProductControls({
  productId,
  name,
  isStaple,
  stapleOverride,
  paused,
}: {
  productId: string;
  name: string;
  isStaple: boolean;
  stapleOverride: boolean | null;
  paused: boolean;
}) {
  const { pending, run } = useAction();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={`Options for ${name}`}
          className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink disabled:opacity-50"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent>
        {isStaple ? (
          <MenuItem onSelect={() => run(() => setStapleOverrideAction(productId, false))}>
            <StarOff /> Not a staple
          </MenuItem>
        ) : (
          <MenuItem onSelect={() => run(() => setStapleOverrideAction(productId, true))}>
            <Star /> Always keep this stocked
          </MenuItem>
        )}
        {stapleOverride !== null && (
          <MenuItem onSelect={() => run(() => setStapleOverrideAction(productId, null))}>
            <RotateCcw /> Let Plenty decide if it&apos;s a staple
          </MenuItem>
        )}
        {paused ? (
          <MenuItem onSelect={() => run(() => setPredictionsPausedAction(productId, false))}>
            <Play /> Predict when it runs out
          </MenuItem>
        ) : (
          <MenuItem onSelect={() => run(() => setPredictionsPausedAction(productId, true))}>
            <Pause /> Stop predicting this
          </MenuItem>
        )}
        <MenuItem destructive onSelect={() => run(() => resetLearningAction(productId))}>
          <RotateCcw /> Forget what Plenty learned
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function ForgetMealButton({ mealId, name }: { mealId: string; name: string }) {
  const { pending, run } = useAction();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => forgetMealAction(mealId))}
      aria-label={`Forget ${name}`}
      className="flex size-8 items-center justify-center rounded-full text-ink-4 hover:bg-subtle hover:text-ink disabled:opacity-50"
    >
      <X className="size-4" />
    </button>
  );
}
