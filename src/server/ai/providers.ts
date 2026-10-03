import "server-only";
import { env } from "@/server/env";
import { AnthropicProvider } from "./anthropic";
import { LocalProvider } from "./local";
import type { AIProvider } from "./types";

/**
 * The provider instances. Nothing outside `src/server/ai` imports this file
 * (a test checks): the rest of the app reaches the outside AI service only
 * through `./consent`, which asks permission first.
 */

const local = new LocalProvider();
let anthropic: AnthropicProvider | null = null;

export function localProvider(): AIProvider {
  return local;
}

/** Whether an outside AI service is set up on this server. Says nothing about permission. */
export function externalConfigured(): boolean {
  const e = env();
  return e.AI_PROVIDER !== "local" && Boolean(e.ANTHROPIC_API_KEY);
}

/** The outside provider, with no permission check. Only `./consent` may call this. */
export function unguardedExternalProvider(): AIProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "local" || !e.ANTHROPIC_API_KEY) return null;
  anthropic ??= new AnthropicProvider(e.ANTHROPIC_API_KEY, e.ANTHROPIC_MODEL);
  return anthropic;
}
