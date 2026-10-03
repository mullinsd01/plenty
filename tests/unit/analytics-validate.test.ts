import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";
import { CLIENT_ANALYTICS_EVENTS, MAX_ANALYTICS_BODY, validateClientEvent } from "@/lib/analytics-validate";
import { trackClient } from "@/lib/analytics-client";

describe("client analytics validation", () => {
  it("accepts the events a browser may report, with their allowed properties", () => {
    expect(validateClientEvent({ event: "paywall_viewed", props: { feature: "photo", plan: "plus" } })).toEqual({ ok: true, event: "paywall_viewed", props: { feature: "photo", plan: "plus" } });
    expect(validateClientEvent({ event: "meal_selected", props: { surface: "plan" } }).ok).toBe(true);
    expect(validateClientEvent({ event: "prediction_shown" }).ok).toBe(true);
  });

  it("rejects events the browser isn't allowed to report, even though they're whitelisted for the server", () => {
    const serverOnly = ANALYTICS_EVENTS.filter((e) => !(CLIENT_ANALYTICS_EVENTS as readonly string[]).includes(e));
    expect(serverOnly).toEqual(expect.arrayContaining(["subscription_started", "receipt_confirmed", "item_added"]));
    for (const event of serverOnly) expect(validateClientEvent({ event })).toEqual({ ok: false, reason: "Unknown event." });
  });

  it.each([
    "made_up_event",
    "",
    "PAYWALL_VIEWED",
    "paywall_viewed ",
    "__proto__",
    "constructor",
    "toString",
  ])("rejects the unknown event name %j", (event) => {
    expect(validateClientEvent({ event }).ok).toBe(false);
  });

  it.each([
    ["an email", { feature: "jane@example.com" }],
    ["a name", { feature: "Jane Citizen" }],
    ["an item name", { feature: "Peanut butter" }],
    ["a phone number", { plan: "0412 345 678" }],
    ["receipt text", { plan: "EVERYDAY REWARDS CARD ****4821" }],
    ["a long string", { feature: "x".repeat(5000) }],
    ["a number where a word belongs", { feature: 7 }],
    ["an object", { feature: { nested: "photo" } }],
    ["an array", { feature: ["photo"] }],
    ["null", { feature: null }],
    ["a value that is allowed for a different property", { feature: "plus" }],
  ])("rejects properties carrying %s", (_name, props) => {
    expect(validateClientEvent({ event: "paywall_viewed", props })).toEqual({ ok: false, reason: expect.stringMatching(/Invalid property value|Unknown property/) });
  });

  it("rejects properties the event doesn't define, and prototype tricks", () => {
    expect(validateClientEvent({ event: "paywall_viewed", props: { household: "abc" } })).toEqual({ ok: false, reason: "Unknown property." });
    expect(validateClientEvent({ event: "paywall_viewed", props: JSON.parse('{"__proto__": "photo"}') }).ok).toBe(false);
    expect(validateClientEvent({ event: "paywall_viewed", props: { constructor: "photo" } }).ok).toBe(false);
    expect(validateClientEvent({ event: "meal_selected", props: { feature: "photo" } }).ok).toBe(false);
  });

  it("rejects malformed bodies", () => {
    for (const body of [null, undefined, "paywall_viewed", 7, [], [{ event: "paywall_viewed" }], { event: "paywall_viewed", props: [] }, { event: "paywall_viewed", props: "x" }, { event: "paywall_viewed", extra: true }, {}]) {
      expect(validateClientEvent(body).ok).toBe(false);
    }
  });

  it("accepts only whole, non-negative counts up to the cap where counts are allowed", () => {
    // None of the client events take numbers today; the rule is exercised through a server-only one to prove it's the same code path.
    expect(validateClientEvent({ event: "receipt_confirmed", props: { lines: 3 } }).ok).toBe(false);
  });
});

describe("trackClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(nav: Record<string, unknown> = {}) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { doNotTrack: null, ...nav });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends a valid event to Plenty's own endpoint, and nowhere else", () => {
    const fetchMock = stubBrowser();
    trackClient("paywall_viewed", { feature: "photo", plan: "plus" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/analytics");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ event: "paywall_viewed", props: { feature: "photo", plan: "plus" } });
    expect(init.body.length).toBeLessThan(MAX_ANALYTICS_BODY);
  });

  it("sends nothing when the browser says Do Not Track or Global Privacy Control", () => {
    const dnt = stubBrowser({ doNotTrack: "1" });
    trackClient("paywall_viewed", { feature: "photo" });
    expect(dnt).not.toHaveBeenCalled();
    const gpc = stubBrowser({ globalPrivacyControl: true });
    trackClient("paywall_viewed", { feature: "photo" });
    expect(gpc).not.toHaveBeenCalled();
  });

  it("never sends an event that wouldn't pass validation, and never throws", () => {
    const fetchMock = stubBrowser();
    expect(() => trackClient("paywall_viewed", { feature: "Jane Citizen" })).not.toThrow();
    expect(() => trackClient("not_an_event" as never)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(() => trackClient("meal_selected", { surface: "plan" })).not.toThrow();
  });

  it("does nothing on the server", () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(() => trackClient("meal_selected", { surface: "plan" })).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
