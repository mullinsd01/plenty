import "server-only";
import { env } from "@/server/env";
import { AnthropicProvider } from "./anthropic";
import { LocalProvider } from "./local";
import type { AIProvider } from "./types";

export * from "./types";

let anthropic: AnthropicProvider | null = null;
const local = new LocalProvider();

function anthropicProvider(): AnthropicProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "local" || !e.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new AnthropicProvider(e.ANTHROPIC_API_KEY, e.ANTHROPIC_MODEL);
  return anthropic;
}

/**
 * The provider to use for this household. Households can opt out of sending
 * data to an external AI service in Settings → Privacy; then everything runs
 * on Plenty's own server.
 */
export function getProvider(allowExternalAi: boolean): AIProvider {
  if (!allowExternalAi) return local;
  return anthropicProvider() ?? local;
}

export function getLocalProvider(): AIProvider {
  return local;
}

export function aiStatus(): { externalConfigured: boolean; model: string | null } {
  const provider = anthropicProvider();
  return { externalConfigured: provider !== null, model: provider ? env().ANTHROPIC_MODEL : null };
}
