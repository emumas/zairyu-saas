import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, otpauthUri, totpCode, totpStep, verifyTotp } from "./totp.js";

// RFC 6238 Appendix B(SHA-1、8 桁)
const RFC_SECRET = Buffer.from("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it.each(RFC_VECTORS)("RFC 6238: T=%i → %s", (t, code) => {
    expect(totpCode(RFC_SECRET, totpStep(t * 1000), 8)).toBe(code);
  });

  it("6 桁のコードを前後 1 ステップまで受け付ける", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
  });

  it("使用済みのステップは再利用できない", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it("形式が違うコードは拒否", () => {
    expect(verifyTotp(RFC_SECRET, "12345", 0, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", 0, null)).toBeNull();
  });

  it("base32 の往復(RFC 4648 の例)", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode(base32Encode(RFC_SECRET)).equals(RFC_SECRET)).toBe(true);
  });

  it("otpauth URI", () => {
    const uri = otpauthUri(RFC_SECRET, "a@example.com", "在留カード管理");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${base32Encode(RFC_SECRET)}`);
  });
});
