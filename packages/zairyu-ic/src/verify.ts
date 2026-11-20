/**
 * 在留カード IC の電子署名(チェックコード)検証。サーバー専用(node:crypto)。
 *
 * - 旧様式(仕様書 Ver1.5 3.4.3): RSA 2048 / PKCS#1 v1.5。公開鍵で復号した結果はパディング + SHA-256 ハッシュ
 *   (DigestInfo なし)。署名対象は 券面(表)イメージ(7000)||顔画像(3000) の値。
 * - 第2世代・特定(3.4.3): ECDSA secp384r1 / SHA-256。チェックコードは r||s(96 バイト)。
 *   署名対象は 券面記載事項(53)||顔画像(3000)||氏名イメージ(2500)。
 *
 * 公開鍵はカード内の証明書(DB / DD)から取り出す。発行者(入管庁 ZairyuCard CA)の証明書は trustedIssuers で与える。
 * 発行者の判定は、カードの証明書の署名方式(RSA / ECDSA)と同じ鍵種別の発行者証明書だけで行う:
 * - 同じ種別の発行者証明書を持っていれば、そのいずれかで検証できなければ issuerTrusted=false(偽造の疑い)
 * - 同じ種別の発行者証明書を 1 つも持っていなければ issuerTrusted=null(未確認)
 *   (例: RSA の CA だけを持っている間に、第2世代の ECDSA で署名された証明書を誤って偽造扱いしないため)
 */
import {
  X509Certificate,
  constants,
  createHash,
  publicDecrypt,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { SignatureParts } from "./parse.js";

export type SignatureFailureReason =
  | "certificate_invalid" // 証明書として読めない
  | "key_type_mismatch" // 様式と鍵種別が合わない
  | "decrypt_failed" // RSA: 鍵が違う・パディング不正
  | "unexpected_format" // RSA: 復号結果がハッシュ長でない
  | "digest_mismatch" // RSA: データと署名が一致しない
  | "signature_invalid"; // ECDSA: 検証失敗

export type SignatureVerification =
  | {
      status: "valid";
      /** 証明書が信頼する発行者で検証できたか。null は発行者未設定で未確認 */
      issuerTrusted: boolean | null;
      certificateValidAt: boolean;
      /** 一致した署名対象データの解釈("spec" は仕様書どおり) */
      matched: string;
      /** RSA: 復号結果の形式 */
      hashFormat?: "raw" | "digestInfo";
    }
  | { status: "invalid"; reason: SignatureFailureReason; detail?: string }
  /** 年少者のカード等で署名が記録されていない */
  | { status: "absent" };

export interface VerifyOptions {
  trustedIssuers?: readonly X509Certificate[];
  /** 証明書の有効期間の判定時刻(既定は現在) */
  at?: Date;
}

export function verifyCardSignature(
  signature: SignatureParts | null,
  options: VerifyOptions = {},
): SignatureVerification {
  if (!signature) return { status: "absent" };
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(trimDer(signature.certificate));
  } catch {
    return { status: "invalid", reason: "certificate_invalid" };
  }
  const key = cert.publicKey;
  const candidates = [{ label: "spec", data: signature.signedData }, ...(signature.alternatives ?? [])];
  let matched: string | null = null;
  let hashFormat: "raw" | "digestInfo" | undefined;
  if (signature.algorithm === "rsa-pkcs1v15-sha256") {
    const r = recoverRsaHash(key, signature.checkCode);
    if ("reason" in r) return { status: "invalid", ...r };
    hashFormat = r.format;
    for (const c of candidates) {
      if (timingSafeEqual(createHash("sha256").update(c.data).digest(), r.hash)) {
        matched = c.label;
        break;
      }
    }
    if (!matched) return { status: "invalid", reason: "digest_mismatch", detail: `hash=${r.format}` };
  } else {
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "secp384r1") {
      return { status: "invalid", reason: "key_type_mismatch" };
    }
    if (signature.checkCode.length !== 96) {
      return { status: "invalid", reason: "signature_invalid", detail: `checkCode=${signature.checkCode.length}B` };
    }
    for (const c of candidates) {
      if (cryptoVerify("sha256", c.data, { key, dsaEncoding: "ieee-p1363" }, signature.checkCode)) {
        matched = c.label;
        break;
      }
    }
    if (!matched) return { status: "invalid", reason: "signature_invalid" };
  }

  const family = certSignatureFamily(cert.raw);
  const issuers = (options.trustedIssuers ?? []).filter((i) => i.publicKey.asymmetricKeyType === family);
  const issuerTrusted = issuers.length === 0 ? null : issuers.some((i) => cert.checkIssued(i) && cert.verify(i.publicKey));
  const at = (options.at ?? new Date()).getTime();
  const certificateValidAt = at >= Date.parse(cert.validFrom) && at <= Date.parse(cert.validTo);
  return { status: "valid", issuerTrusted, certificateValidAt, matched, ...(hashFormat ? { hashFormat } : {}) };
}

/** DigestInfo(SHA-256)の DER プレフィックス(RFC 8017 9.2 注記) */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from("3031300d060960864801650304020105000420", "hex");

/**
 * チェックコードを公開鍵で復号し、ハッシュ値を取り出す。
 * 仕様書(図3-4)はパディング‖ハッシュ値(DigestInfo なし)だが、実カード(旧様式、2026-11-20)は DigestInfo 付きだった。
 * カードの発行時期で違う可能性があるため両方を受け付け、形式を返す
 */
function recoverRsaHash(
  key: KeyObject,
  checkCode: Uint8Array,
): { hash: Buffer; format: "raw" | "digestInfo" } | { reason: SignatureFailureReason; detail?: string } {
  if (key.asymmetricKeyType !== "rsa") return { reason: "key_type_mismatch" };
  let recovered: Buffer;
  try {
    recovered = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, checkCode);
  } catch {
    return { reason: "decrypt_failed", detail: `checkCode=${checkCode.length}B` };
  }
  if (recovered.length === 32) return { hash: recovered, format: "raw" };
  if (recovered.length === 51 && recovered.subarray(0, 19).equals(SHA256_DIGEST_INFO_PREFIX)) {
    return { hash: recovered.subarray(19), format: "digestInfo" };
  }
  // ハッシュ値以外の形式。診断用に長さと先頭 19 バイト(DigestInfo 等の構造部分)だけ返す
  return {
    reason: "unexpected_format",
    detail: `recovered=${recovered.length}B head=${recovered.subarray(0, 19).toString("hex").toUpperCase()}`,
  };
}

/**
 * DER の SEQUENCE ヘッダから全体長を求め、後ろの 0x00 埋めを除く。
 * 旧様式の公開鍵証明書(DB)は 1200 バイト固定長で、証明書の後ろが 0x00 で埋まっている場合がある。
 */
export function trimDer(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30 || der.length < 2) return der;
  const l = der[1]!;
  if (l < 0x80) return der.subarray(0, Math.min(der.length, 2 + l));
  const n = l & 0x7f;
  if (n === 0 || n > 3 || der.length < 2 + n) return der;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + der[2 + i]!;
  return der.subarray(0, Math.min(der.length, 2 + n + len));
}

// 署名アルゴリズムの OID(DER)
const OID_ECDSA_WITH_SHA = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03]); // ecdsa-with-SHA224/256/384/512 の共通部分
const OID_RSA_PKCS1 = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01]); // 1.2.840.113549.1.1.x

/**
 * 証明書が RSA と ECDSA のどちらで署名されているか(発行者の鍵種別)。
 * 公開鍵の OID(rsaEncryption = ...1.1.1 / id-ecPublicKey)と区別するため、署名アルゴリズムの OID だけを見る
 */
export function certSignatureFamily(der: Uint8Array): "rsa" | "ec" | null {
  const b = Buffer.from(der);
  if (b.includes(OID_ECDSA_WITH_SHA)) return "ec";
  for (let i = b.indexOf(OID_RSA_PKCS1); i >= 0; i = b.indexOf(OID_RSA_PKCS1, i + 1)) {
    const last = b[i + OID_RSA_PKCS1.length];
    // 1.1.5(sha1)/ 1.1.11〜13(sha256/384/512)/ 1.1.10(PSS)。1.1.1 は公開鍵の種別なので除く
    if (last !== undefined && [5, 10, 11, 12, 13, 14].includes(last)) return "rsa";
  }
  return null;
}
