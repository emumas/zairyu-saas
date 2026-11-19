import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createLocalSecretBox } from "./secretBox.js";

const box = createLocalSecretBox(randomBytes(32));

it("暗号化して復号できる", () => {
  const plain = Buffer.from("secret");
  expect(box.open(box.seal(plain, "a"), "a").equals(plain)).toBe(true);
});

it("AAD が違えば復号できない(別ユーザーの行に移しても使えない)", () => {
  expect(() => box.open(box.seal(Buffer.from("secret"), "user-1"), "user-2")).toThrow();
});

it("改ざんされていれば復号できない", () => {
  const sealed = box.seal(Buffer.from("secret"), "a");
  sealed[sealed.length - 1]! ^= 1;
  expect(() => box.open(sealed, "a")).toThrow();
});

it("同じ平文でも毎回違う暗号文になる", () => {
  expect(box.seal(Buffer.from("x"), "a").equals(box.seal(Buffer.from("x"), "a"))).toBe(false);
});
