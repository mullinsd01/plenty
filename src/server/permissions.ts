import "server-only";
import { can, refusalMessage, type Capability } from "@/lib/members/permissions";
import type { HouseholdContext } from "@/server/auth/context";
import { AppError } from "@/server/errors";

/** Refuse, in plain words, unless the signed-in member's role allows this. */
export function requireCapability(ctx: HouseholdContext, capability: Capability): void {
  if (!can(ctx.role, capability)) throw new AppError("forbidden", refusalMessage(capability));
}
