import { X509Certificate, constants, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { concatBytes, padNulls } from "../src/bytes.js";
import type { SignatureParts } from "../src/parse.js";
import { certSignatureFamily, trimDer, verifyCardSignature } from "../src/verify.js";
import { rsaRawSign } from "../src/testing.js";
import { makeCertAndKey } from "../src/testing.js";

const rsa = makeCertAndKey("rsa");
const otherEc = makeCertAndKey("ec");
const ec = makeCertAndKey("ec");
const data = new TextEncoder().encode("signed-data");
const otherIssuer = new X509Certificate(readFileSync(new URL("./fixtures/test-other.der", import.meta.url)));

const rsaParts = (checkCode: Uint8Array, signedData = data): SignatureParts => ({
  algorithm: "rsa-pkcs1v15-sha256",
  checkCode,
  certificate: padNulls(rsa.certDer, 1200), // 旧様式は 1200 バイト固定長
  signedData,
});
const ecParts = (checkCode: Uint8Array, signedData = data): SignatureParts => ({
  algorithm: "ecdsa-p384-sha256",
  checkCode,
  certificate: ec.certDer,
  signedData,
});

describe("旧様式 RSA", () => {
  it("生ハッシュ形式の署名を検証できる(0x00 埋めの証明書も読める)", () => {
    expect(verifyCardSignature(rsaParts(rsaRawSign(rsa.key, data)))).toEqual({
      status: "valid",
      issuerTrusted: null,
      certificateValidAt: true,
      matched: "spec",
      hashFormat: "raw",
    });
  });

  it("DigestInfo 付きの署名も検証でき、形式を返す", () => {
    expect(verifyCardSignature(rsaParts(sign("sha256", data, rsa.key)))).toMatchObject({ status: "valid", hashFormat: "digestInfo" });
  });

  it("仕様どおりの対象で一致しなければ別解釈を試し、一致したものを返す", () => {
    const alt = new TextEncoder().encode("exact-data");
    const parts = { ...rsaParts(rsaRawSign(rsa.key, alt)), alternatives: [{ label: "x", data: data }, { label: "exact", data: alt }] };
    expect(verifyCardSignature(parts)).toMatchObject({ status: "valid", matched: "exact" });
  });

  it("データが改ざんされていれば digest_mismatch", () => {
    const tampered = Uint8Array.from(data);
    tampered[0]! ^= 1;
    expect(verifyCardSignature(rsaParts(rsaRawSign(rsa.key, data), tampered))).toMatchObject({ status: "invalid", reason: "digest_mismatch" });
  });

  it("別の鍵の署名は decrypt_failed", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verifyCardSignature(rsaParts(rsaRawSign(other.privateKey, data)))).toMatchObject({ status: "invalid" });
  });

  it("ハッシュ以外が署名されていれば unexpected_format", () => {
    const sig = privateEncrypt({ key: rsa.key, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(20, 1));
    expect(verifyCardSignature(rsaParts(sig))).toMatchObject({ status: "invalid", reason: "unexpected_format", detail: expect.stringContaining("recovered=20B") });
  });
});

describe("第2世代・特定 ECDSA P-384", () => {
  it("r||s 形式の署名を検証できる", () => {
    const sig = sign("sha256", data, { key: ec.key, dsaEncoding: "ieee-p1363" });
    expect(sig.length).toBe(96);
    expect(verifyCardSignature(ecParts(sig))).toMatchObject({ status: "valid" });
  });

  it("改ざんで signature_invalid", () => {
    const sig = sign("sha256", data, { key: ec.key, dsaEncoding: "ieee-p1363" });
    expect(verifyCardSignature(ecParts(sig, Uint8Array.from(concatBytes(data, Uint8Array.of(0)))))).toEqual({ status: "invalid", reason: "signature_invalid" });
  });

  it("鍵種別が合わなければ key_type_mismatch", () => {
    expect(verifyCardSignature({ ...ecParts(new Uint8Array(96)), certificate: rsa.certDer })).toEqual({
      status: "invalid",
      reason: "key_type_mismatch",
    });
  });
});

describe("証明書", () => {
  it("信頼する発行者を渡すと issuerTrusted を判定する", () => {
    const sig = sign("sha256", data, { key: ec.key, dsaEncoding: "ieee-p1363" });
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [ec.cert] })).toMatchObject({ issuerTrusted: true });
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [otherEc.cert] })).toMatchObject({ issuerTrusted: false });
  });

  it("旧様式(RSA): 信頼する発行者で検証できれば true、別の RSA の発行者だけなら false(偽造の疑い)", () => {
    const parts = rsaParts(rsaRawSign(rsa.key, data));
    expect(verifyCardSignature(parts, { trustedIssuers: [rsa.cert] })).toMatchObject({ status: "valid", issuerTrusted: true });
    expect(verifyCardSignature(parts, { trustedIssuers: [otherIssuer] })).toMatchObject({ status: "valid", issuerTrusted: false });
    // ECDSA の CA だけなら RSA の証明書は判定しない
    expect(verifyCardSignature(parts, { trustedIssuers: [ec.cert] })).toMatchObject({ status: "valid", issuerTrusted: null });
  });

  it("同じ鍵種別の発行者証明書が無ければ未確認(null)。あれば、それで検証できないと false", () => {
    const sig = sign("sha256", data, { key: ec.key, dsaEncoding: "ieee-p1363" });
    // RSA の CA だけを持っている: ECDSA で署名された証明書は判定しない
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [rsa.cert] })).toMatchObject({ status: "valid", issuerTrusted: null });
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [rsa.cert, otherEc.cert] })).toMatchObject({ issuerTrusted: false });
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [rsa.cert, otherEc.cert, ec.cert] })).toMatchObject({ issuerTrusted: true });
  });

  it("証明書の署名方式を判別する", () => {
    expect(certSignatureFamily(ec.certDer)).toBe("ec");
    expect(certSignatureFamily(rsa.certDer)).toBe("rsa");
  });

  it("有効期間外を判定する", () => {
    const sig = sign("sha256", data, { key: ec.key, dsaEncoding: "ieee-p1363" });
    expect(verifyCardSignature(ecParts(sig), { at: new Date("2200-01-01") })).toMatchObject({ certificateValidAt: false });
  });

  it("壊れた証明書は certificate_invalid", () => {
    expect(verifyCardSignature({ ...ecParts(new Uint8Array(96)), certificate: ec.certDer.subarray(0, 40) })).toEqual({
      status: "invalid",
      reason: "certificate_invalid",
    });
  });

  it("署名なしは absent", () => {
    expect(verifyCardSignature(null)).toEqual({ status: "absent" });
  });

  it("trimDer は後ろの 0x00 埋めを除く", () => {
    expect(trimDer(padNulls(rsa.certDer, 1200)).length).toBe(rsa.certDer.length);
  });
});

describe("実カードの形(旧様式、2026-11-20 に Galaxy S23 で確認)", () => {
  it("TLV は実データ長・EF の残りは 0x00、署名は DigestInfo 付きでも検証できる", async () => {
    const { parseCardRead } = await import("../src/parse.js");
    const { encodeTlv } = await import("../src/tlv.js");
    const front = new Uint8Array(3354).fill(7);
    const face = new Uint8Array(2214).fill(9);
    const signedData = concatBytes(padNulls(front, 7000), padNulls(face, 3000));
    const checkCode = sign("sha256", signedData, rsa.key); // DigestInfo 付き
    const files = {
      "df1/ef01": padNulls(encodeTlv(0xd0, front), 7004),
      "df1/ef02": padNulls(encodeTlv(0xd1, face), 3004),
      "df3/ef01": padNulls(concatBytes(encodeTlv(0xda, checkCode), encodeTlv(0xdb, rsa.certDer)), 1464),
    };
    const parsed = parseCardRead({ format: "legacy", kind: "residence", files });
    expect(parsed.images.front?.length).toBe(3354);
    expect(verifyCardSignature(parsed.signature)).toMatchObject({ status: "valid", matched: "spec", hashFormat: "digestInfo" });
  });
});
