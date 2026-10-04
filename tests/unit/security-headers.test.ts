import { afterEach, describe, expect, it, vi } from "vitest";

async function headersFor(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const { default: config } = await import("../../next.config");
  const rules = await config.headers!();
  return Object.fromEntries(rules[0].headers.map((h) => [h.key.toLowerCase(), h.value]));
}

afterEach(() => vi.unstubAllEnvs());

describe("response security headers", () => {
  it("never allow Plenty to be framed in production", async () => {
    const h = await headersFor("production");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).not.toMatch(/github\.dev|vscode/);
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  it("only let an editor preview frame it while developing", async () => {
    const h = await headersFor("development");
    expect(h["x-frame-options"]).toBeUndefined();
    expect(h["content-security-policy"]).toContain("https://*.github.dev");
    expect(h["content-security-policy"]).not.toContain("'none'");
  });
});
