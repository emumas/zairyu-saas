import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const caller = createCallerFactory(appRouter)({ requestId: "test" });

describe("appRouter", () => {
  it("health", async () => {
    expect(await caller.health()).toEqual({ status: "ok" });
  });

  it("validateCardNumber は正規化して判定する", async () => {
    expect(await caller.validateCardNumber({ cardNumber: "ａｂ1234 5678cd" })).toEqual({
      normalized: "AB12345678CD",
      valid: true,
    });
    expect((await caller.validateCardNumber({ cardNumber: "AB123" })).valid).toBe(false);
  });
});
