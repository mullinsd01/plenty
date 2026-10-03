import { afterEach, describe, expect, it, vi } from "vitest";

async function contactWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { legalContact } = await import("@/server/legal");
  return legalContact();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const unset = { LEGAL_ENTITY_NAME: undefined, SUPPORT_EMAIL: undefined, PRIVACY_CONTACT_EMAIL: undefined };

describe("who the public pages say runs Plenty", () => {
  it("in production, leaves out anything that isn't set, and invents nothing", async () => {
    const c = await contactWith({ NODE_ENV: "production", ...unset });
    expect(c).toEqual({ entityName: null, supportEmail: null, privacyEmail: null, missing: [] });
  });

  it("in development, shows clearly marked placeholders so a missing setting is noticed", async () => {
    const c = await contactWith({ NODE_ENV: "development", ...unset });
    expect(c.entityName).toBe("[set LEGAL_ENTITY_NAME]");
    expect(c.supportEmail).toBe("[set SUPPORT_EMAIL]");
    expect(c.privacyEmail).toBe("[set PRIVACY_CONTACT_EMAIL]");
    expect(c.missing).toEqual(["LEGAL_ENTITY_NAME", "SUPPORT_EMAIL", "PRIVACY_CONTACT_EMAIL"]);
  });

  it("uses what's set, and sends privacy requests to the support address when there's no separate one", async () => {
    const c = await contactWith({ NODE_ENV: "production", LEGAL_ENTITY_NAME: "Example Pty Ltd", SUPPORT_EMAIL: "help@example.com", PRIVACY_CONTACT_EMAIL: undefined });
    expect(c).toEqual({ entityName: "Example Pty Ltd", supportEmail: "help@example.com", privacyEmail: "help@example.com", missing: [] });
    const d = await contactWith({ NODE_ENV: "production", LEGAL_ENTITY_NAME: "Example Pty Ltd", SUPPORT_EMAIL: "help@example.com", PRIVACY_CONTACT_EMAIL: "privacy@example.com" });
    expect(d.privacyEmail).toBe("privacy@example.com");
  });

  it("rejects a malformed email at start-up rather than printing it on a legal page", async () => {
    vi.resetModules();
    vi.stubEnv("SUPPORT_EMAIL", "not-an-email");
    const { env } = await import("@/server/env");
    expect(() => env()).toThrow(/SUPPORT_EMAIL/);
  });
});
