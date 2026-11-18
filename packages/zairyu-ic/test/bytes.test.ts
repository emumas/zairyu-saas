import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { padIso, toBase64, unpadIso } from "../src/bytes.js";

it("toBase64 は Buffer と一致する", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 7004]) {
    const d = new Uint8Array(randomBytes(n));
    expect(toBase64(d)).toBe(Buffer.from(d).toString("base64"));
  }
});

it("ISO パディングの付与と除去", () => {
  const d = Uint8Array.of(1, 2, 3);
  expect([...padIso(d, 8)]).toEqual([1, 2, 3, 0x80, 0, 0, 0, 0]);
  expect([...unpadIso(padIso(d, 8))]).toEqual([1, 2, 3]);
  expect(padIso(new Uint8Array(8), 8).length).toBe(16);
  expect(() => unpadIso(Uint8Array.of(1, 2, 0))).toThrow();
});
