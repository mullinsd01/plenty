import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_DISCLOSURE, AI_NEVER_SENT, AI_PURPOSES, EXTERNAL_AI_PROVIDER, decideExternalAi, denialMessage } from "@/lib/ai/consent";
import { preferencesSchema } from "@/validation/household";

const yes = { configured: true, entitled: true, consent: { allowed: true, at: new Date() } };

describe("when Plenty may send something to an outside AI service", () => {
  it("only when it is set up, the plan includes it and the household said yes", () => {
    expect(decideExternalAi(yes)).toEqual({ allowed: true });
  });

  it("is a no without a recorded yes, even if the flag is set", () => {
    expect(decideExternalAi({ ...yes, consent: { allowed: false, at: null } })).toEqual({ allowed: false, reason: "no_consent" });
    expect(decideExternalAi({ ...yes, consent: { allowed: true, at: null } })).toEqual({ allowed: false, reason: "no_consent" });
    expect(decideExternalAi({ ...yes, consent: { allowed: false, at: new Date() } })).toEqual({ allowed: false, reason: "no_consent" });
  });

  it("is a no on a plan without it, whatever the household said", () => {
    expect(decideExternalAi({ ...yes, entitled: false })).toEqual({ allowed: false, reason: "plan" });
  });

  it("is a no when nothing is set up", () => {
    expect(decideExternalAi({ ...yes, configured: false })).toEqual({ allowed: false, reason: "not_configured" });
  });

  it("every denial says what the person can do, and names the provider only where relevant", () => {
    for (const purpose of AI_PURPOSES) {
      expect(denialMessage("no_consent", purpose)).toMatch(/Settings → Privacy & data/);
      expect(denialMessage("plan", purpose)).toMatch(/Plenty Plus/);
      expect(denialMessage("not_configured", purpose)).toMatch(/own server/);
    }
  });
});

describe("the consent wording", () => {
  it("lists what each feature sends, and never claims what the provider does with it", () => {
    for (const purpose of AI_PURPOSES) expect(AI_DISCLOSURE[purpose].sent.length).toBeGreaterThan(0);
    // Only features that exist are offered for consent (photo recognition isn't built yet).
    expect(AI_PURPOSES.filter((p) => AI_DISCLOSURE[p].live)).toEqual(["receipt", "recipes", "photo"]);
    const all = JSON.stringify([AI_DISCLOSURE, AI_NEVER_SENT, EXTERNAL_AI_PROVIDER]).toLowerCase();
    for (const claim of ["not retain", "doesn't retain", "never stored", "deleted immediately", "not used for training", "zero retention"]) {
      expect(all).not.toContain(claim);
    }
    expect(EXTERNAL_AI_PROVIDER.termsUrl).toMatch(/^https:\/\//);
  });

  it("says names and emails are never sent", () => {
    expect(AI_NEVER_SENT.join(" ")).toMatch(/name, email/i);
  });
});

describe("the general preferences form can't change the AI answer", () => {
  it("drops allowAiProcessing and the consent record", () => {
    const parsed = preferencesSchema.parse({ allowAiProcessing: true, aiConsentAt: new Date().toISOString(), aiConsentBy: "x", receiptImageRetention: "keep", diets: [] });
    expect(parsed).toEqual({ diets: [] });
  });
});

/** Every file under src, so a new path to the outside provider can't appear without this test noticing. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("there is no way around the consent check", () => {
  const root = path.resolve(__dirname, "../../src");
  const aiDir = path.join(root, "server", "ai") + path.sep;

  /** Where an import in `file` points, as an absolute path without extension (or the package name). */
  const resolveImport = (file: string, spec: string): string =>
    spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : spec;
  const importsOf = (file: string): string[] =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => resolveImport(file, m[1]));

  it("nothing outside src/server/ai imports the provider classes, the SDK or the unguarded provider", () => {
    const forbidden = [path.join(aiDir, "providers"), path.join(aiDir, "anthropic"), path.join(aiDir, "local"), "@anthropic-ai/sdk"];
    const offenders = sourceFiles(root)
      .filter((f) => !f.startsWith(aiDir))
      .filter((f) => importsOf(f).some((target) => forbidden.some((bad) => target === bad || target.startsWith(`${bad}/`))))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("inside src/server/ai only the consent module reaches the unguarded provider", () => {
    const users = sourceFiles(aiDir)
      .filter((f) => readFileSync(f, "utf8").includes("unguardedExternalProvider"))
      .map((f) => path.basename(f))
      .sort();
    expect(users).toEqual(["consent.ts", "providers.ts"]);
  });

  it("the old unguarded entry point is gone", () => {
    const index = readFileSync(path.join(aiDir, "index.ts"), "utf8");
    expect(index).not.toMatch(/export function getProvider/);
  });
});
