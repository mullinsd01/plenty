import { describe, expect, it } from "vitest";
import { signUpFormSchema } from "@/validation/auth";

const base = { name: "Robin", email: "robin@example.com", password: "correct-horse-battery" };

describe("sign-up confirmation", () => {
  it("needs the box ticked: unticked, missing or anything else is refused with a plain message", () => {
    for (const terms of [null, undefined, "", "off", "true", "yes"]) {
      const parsed = signUpFormSchema.safeParse({ ...base, terms });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0].message).toMatch(/18 or over/);
    }
  });
  it("accepts a ticked box (the browser sends 'on')", () => {
    expect(signUpFormSchema.safeParse({ ...base, terms: "on" }).success).toBe(true);
  });
});
