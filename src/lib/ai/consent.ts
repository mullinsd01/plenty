/**
 * When Plenty may send something to an outside AI service.
 *
 * Plenty never does by default. It happens only when all three are true:
 *   1. an AI service is set up on this server,
 *   2. the household's plan includes it (`receipt_extraction: "advanced"`), and
 *   3. someone in the household (an owner or a member) has said yes, which is
 *      recorded with who and when, and can be withdrawn at any time.
 *
 * Anything else stays on Plenty's own server (on-device OCR and the built-in
 * recipe collection). This file is the pure decision and the plain-language
 * wording; `src/server/ai/consent.ts` applies it.
 */

export const AI_PURPOSES = ["receipt", "recipes", "photo"] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/**
 * The one outside AI provider Plenty can be configured with. Named here (not
 * in the UI) so the wording and the code can't drift apart. Plenty makes no
 * claim about what the provider does with data: it links to the provider's own
 * terms, which are the authority on that.
 */
export const EXTERNAL_AI_PROVIDER = {
  name: "Anthropic",
  product: "Claude",
  termsUrl: "https://www.anthropic.com/legal",
} as const;

export interface AiAccessInputs {
  /** An outside AI service is set up on this server. */
  configured: boolean;
  /** The household's plan includes AI-assisted features. */
  entitled: boolean;
  /** The household's stored answer. */
  consent: { allowed: boolean; at: Date | string | null };
}

export type AiDenial = "not_configured" | "plan" | "no_consent";
export type AiDecision = { allowed: true } | { allowed: false; reason: AiDenial };

/** Fails closed: every missing piece is a "no", and a "yes" without a recorded time doesn't count. */
export function decideExternalAi(input: AiAccessInputs): AiDecision {
  if (!input.configured) return { allowed: false, reason: "not_configured" };
  if (!input.entitled) return { allowed: false, reason: "plan" };
  if (!input.consent.allowed || !input.consent.at) return { allowed: false, reason: "no_consent" };
  return { allowed: true };
}

/** What each use sends and doesn't, in the words shown to people. Kept next to the code that sends it. */
export const AI_DISCLOSURE: Record<AiPurpose, { feature: string; sent: string[] }> = {
  receipt: {
    feature: "reading your receipt photos",
    sent: [
      "The receipt photo you upload (with its camera details removed)",
      "Today's date, your household's currency and the shops you chose in your preferences, so dates and prices are read correctly",
    ],
  },
  recipes: {
    feature: "writing new recipe ideas",
    sent: [
      "The names and amounts of the food in your kitchen, and use-by dates",
      "Your household's diets, allergies, dislikes and favourite cuisines",
      "The names of meals you've already rejected, so they aren't repeated",
    ],
  },
  photo: {
    feature: "recognising groceries in a photo",
    sent: ["The grocery photo you take"],
  },
};

/** What is never sent, whichever feature is used. */
export const AI_NEVER_SENT = [
  "Your name, email address or password",
  "The names or details of the people in your household",
  "Your shopping list, notes, receipts you didn't upload, or anything else in your account",
  "Payment details",
] as const;

/** A plain-language reason for a "no", for the person who asked. Says what they can do about it. */
export function denialMessage(reason: AiDenial, purpose: AiPurpose = "receipt"): string {
  const what = AI_DISCLOSURE[purpose].feature;
  switch (reason) {
    case "not_configured":
      return `No AI service is set up here, so Plenty is ${what} on its own server instead.`;
    case "plan":
      return `AI-assisted ${what} is part of Plenty Plus. Until then Plenty does it on its own server, and nothing is sent to ${EXTERNAL_AI_PROVIDER.name}.`;
    case "no_consent":
      return `Plenty hasn't been given permission to send anything to ${EXTERNAL_AI_PROVIDER.name}. You can turn that on in Settings → Privacy & data. Until then Plenty does this on its own server.`;
  }
}
