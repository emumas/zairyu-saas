import { readFileSync } from "node:fs";
import { X509Certificate, constants, createHash, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkCardCertificate, verifyCheckCode } from "../src/verify.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const front = new TextEncoder().encode("front-image-bytes");
const face = new TextEncoder().encode("face-image-bytes");
const data = Buffer.concat([front, face]);

/** 生ハッシュを PKCS#1 v1.5(type 1)で署名したもの */
const rawSig = privateEncrypt(
  { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
  createHash("sha256").update(data).digest(),
);
/** 標準の RSASSA-PKCS1-v1_5 + SHA-256(DigestInfo 付き) */
const digestInfoSig = sign("sha256", data, privateKey);

describe("verifyCheckCode", () => {
  it("生ハッシュ形式の署名を検証できる", () => {
    expect(verifyCheckCode({ frontImage: front, faceImage: face, checkCode: rawSig, publicKey })).toEqual({ ok: true });
  });

  it("DigestInfo 形式の署名を検証できる", () => {
    expect(verifyCheckCode({ frontImage: front, faceImage: face, checkCode: digestInfoSig, publicKey })).toEqual({
      ok: true,
    });
  });

  it("画像が改ざんされていれば digest_mismatch", () => {
    const tampered = Uint8Array.from(face);
    tampered[0]! ^= 1;
    expect(verifyCheckCode({ frontImage: front, faceImage: tampered, checkCode: rawSig, publicKey })).toEqual({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("連結順が逆なら一致しない", () => {
    expect(verifyCheckCode({ frontImage: face, faceImage: front, checkCode: rawSig, publicKey }).ok).toBe(false);
  });

  it("別の鍵では復号できない", () => {
    expect(
      verifyCheckCode({ frontImage: front, faceImage: face, checkCode: rawSig, publicKey: other.publicKey }),
    ).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("署名値が壊れていれば失敗", () => {
    const broken = Buffer.from(rawSig);
    broken[10]! ^= 0xff;
    expect(verifyCheckCode({ frontImage: front, faceImage: face, checkCode: broken, publicKey }).ok).toBe(false);
  });

  it("ハッシュ以外のデータが署名されていれば unexpected_format", () => {
    const sig = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(20, 1));
    expect(verifyCheckCode({ frontImage: front, faceImage: face, checkCode: sig, publicKey })).toEqual({
      ok: false,
      reason: "unexpected_format",
    });
  });
});

describe("checkCardCertificate", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const issuer = new X509Certificate(fixture("test-issuer.der"));
  const otherIssuer = new X509Certificate(fixture("test-other.der"));
  const card = fixture("test-card.der");
  const validAt = new Date(Date.parse(new X509Certificate(card).validFrom) + 86_400_000);

  it("信頼する発行者が発行した証明書なら公開鍵を返す", () => {
    const r = checkCardCertificate({ certificateDer: card, trustedIssuers: [otherIssuer, issuer], at: validAt });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.publicKey.asymmetricKeyType).toBe("rsa");
  });

  it("発行者が信頼リストにない", () => {
    expect(checkCardCertificate({ certificateDer: card, trustedIssuers: [otherIssuer], at: validAt })).toEqual({
      ok: false,
      reason: "certificate_untrusted",
    });
  });

  it("有効期間外", () => {
    expect(
      checkCardCertificate({ certificateDer: card, trustedIssuers: [issuer], at: new Date("2200-01-01T00:00:00Z") }),
    ).toEqual({ ok: false, reason: "certificate_expired" });
  });

  it("DER として壊れている", () => {
    expect(checkCardCertificate({ certificateDer: card.subarray(0, 50), trustedIssuers: [issuer] }).ok).toBe(false);
  });
});
