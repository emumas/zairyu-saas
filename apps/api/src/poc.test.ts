import { concatBytes, encodeTlv } from "@zairyu/zairyu-ic";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const caller = createCallerFactory(appRouter)({ requestId: "test", services: null, accessToken: null, ip: null });
const a = (s: string) => new TextEncoder().encode(s);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

const input = {
  format: "gen2" as const,
  kind: "residence" as const,
  files: {
    "df1/ef01": b64(encodeTlv(0xc2, a("AB12345678CD"))),
    "df1/ef02": b64(concatBytes(encodeTlv(0xc5, a("20310331")), encodeTlv(0xcc, a("1")), encodeTlv(0xcd, a("20290620")))),
    "df2/ef02": b64(encodeTlv(0xd8, a("0"))),
    "df3/ef01": b64(concatBytes(Uint8Array.of(0xdc, 0x00, 0xdd, 0x00), new Uint8Array(10))),
  },
};

describe("poc.verifyIcRead", () => {
  afterEach(() => {
    delete process.env.ZAIRYU_ENABLE_POC;
  });

  it("無効時は NOT_FOUND", async () => {
    await expect(caller.poc.verifyIcRead(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("EF を解釈して返す(署名なしは absent)", async () => {
    process.env.ZAIRYU_ENABLE_POC = "1";
    const out = await caller.poc.verifyIcRead(input);
    expect(out.signature).toEqual({ status: "absent" });
    expect(out.cardNumber).toBe("AB12345678CD");
    expect(out.faceItems).toMatchObject({ cardValidUntil: "2031-03-31", workRestriction: "1", stayExpiry: "2029-06-20" });
    expect(out.back).toMatchObject({ renewalApplying: false });
  });

  it("不正な base64 は弾く", async () => {
    process.env.ZAIRYU_ENABLE_POC = "1";
    await expect(caller.poc.verifyIcRead({ ...input, files: { "df1/ef01": "@@@" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
