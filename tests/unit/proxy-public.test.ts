import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";

const request = (path: string, cookie?: string) => new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe("public pages don't need a session", () => {
  it.each(["/", "/privacy", "/terms", "/support", "/delete-account", "/account-deleted", "/account-deleted?cancel=apple", "/login", "/signup", "/forgot-password", "/join/ABC123"])(
    "lets a signed-out visitor open %s",
    (path) => {
      const res = proxy(request(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it.each(["/home", "/kitchen", "/receipts/abc", "/settings", "/settings/privacy", "/settings/account", "/onboarding"])("still sends a signed-out visitor from %s to sign in", (path) => {
    const res = proxy(request(path));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(path);
  });

  it("lets a signed-in visitor through to the app", () => {
    expect(proxy(request("/settings/privacy", "plenty_session=abc")).headers.get("location")).toBeNull();
  });

  it("runs on the public pages (and so can't be what blocks them), but not on the API", () => {
    const [matcher] = config.matcher;
    const re = new RegExp(`^${matcher}$`);
    for (const path of ["/privacy", "/terms", "/support", "/delete-account"]) expect(re.test(path)).toBe(true);
    expect(re.test("/api/analytics")).toBe(false);
  });
});
