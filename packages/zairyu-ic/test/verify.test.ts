import { X509Certificate, constants, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { concatBytes, padNulls } from "../src/bytes.js";
import type { SignatureParts } from "../src/parse.js";
import { trimDer, verifyCardSignature } from "../src/verify.js";
import { rsaRawSign } from "./fixtures.js";
import { makeCertAndKey } from "./helpers.js";

const rsa = makeCertAndKey("rsa");
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
    });
  });

  it("DigestInfo 付きの署名は仕様と異なるため unexpected_format", () => {
    expect(verifyCardSignature(rsaParts(sign("sha256", data, rsa.key)))).toEqual({ status: "invalid", reason: "unexpected_format" });
  });

  it("データが改ざんされていれば digest_mismatch", () => {
    const tampered = Uint8Array.from(data);
    tampered[0]! ^= 1;
    expect(verifyCardSignature(rsaParts(rsaRawSign(rsa.key, data), tampered))).toEqual({ status: "invalid", reason: "digest_mismatch" });
  });

  it("別の鍵の署名は decrypt_failed", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verifyCardSignature(rsaParts(rsaRawSign(other.privateKey, data)))).toMatchObject({ status: "invalid" });
  });

  it("ハッシュ以外が署名されていれば unexpected_format", () => {
    const sig = privateEncrypt({ key: rsa.key, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(20, 1));
    expect(verifyCardSignature(rsaParts(sig))).toEqual({ status: "invalid", reason: "unexpected_format" });
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
    expect(verifyCardSignature(ecParts(sig), { trustedIssuers: [otherIssuer] })).toMatchObject({ issuerTrusted: false });
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
