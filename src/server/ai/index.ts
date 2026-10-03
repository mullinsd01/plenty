import "server-only";
import { EXTERNAL_AI_PROVIDER } from "@/lib/ai/consent";
import { env } from "@/server/env";
import { externalConfigured, localProvider } from "./providers";
import type { AIProvider } from "./types";

export * from "./types";
export { AiPermissionError, providerFor, requireExternalProvider, resolveAiAccess, type AiAccess, type ChosenProvider } from "./consent";

/**
 * There is deliberately no function here that returns the outside provider
 * without asking: see `./consent`. The on-device reader needs no permission.
 */
export function getLocalProvider(): AIProvider {
  return localProvider();
}

/** Whether an outside AI service is set up on this server. This says nothing about permission to use it. */
export function aiStatus(): { externalConfigured: boolean; model: string | null; providerName: string | null } {
  const configured = externalConfigured();
  return { externalConfigured: configured, model: configured ? env().ANTHROPIC_MODEL : null, providerName: configured ? EXTERNAL_AI_PROVIDER.name : null };
}
