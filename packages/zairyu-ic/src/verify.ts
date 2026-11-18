/**
 * 在留カード IC の電子署名(チェックコード)検証。サーバー専用(node:crypto)。
 *
 * - 旧様式(仕様書 Ver1.5 3.4.3): RSA 2048 / PKCS#1 v1.5。公開鍵で復号した結果はパディング + SHA-256 ハッシュ
 *   (DigestInfo なし)。署名対象は 券面(表)イメージ(7000)||顔画像(3000) の値。
 * - 第2世代・特定(3.4.3): ECDSA secp384r1 / SHA-256。チェックコードは r||s(96 バイト)。
 *   署名対象は 券面記載事項(53)||顔画像(3000)||氏名イメージ(2500)。
 *
 * 公開鍵はカード内の証明書(DB / DD)から取り出す。発行者(入管庁)の証明書は仕様書に記載がないため
 * trustedIssuers で外から与える。与えない場合は issuerTrusted=null(未確認)で返す。
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
    }
  | { status: "invalid"; reason: SignatureFailureReason }
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
  const result =
    signature.algorithm === "rsa-pkcs1v15-sha256"
      ? verifyRsa(key, signature.signedData, signature.checkCode)
      : verifyEcdsa(key, signature.signedData, signature.checkCode);
  if (result) return { status: "invalid", reason: result };

  const issuers = options.trustedIssuers ?? [];
  const issuerTrusted =
    issuers.length === 0 ? null : issuers.some((i) => cert.checkIssued(i) && cert.verify(i.publicKey));
  const at = (options.at ?? new Date()).getTime();
  const certificateValidAt = at >= Date.parse(cert.validFrom) && at <= Date.parse(cert.validTo);
  return { status: "valid", issuerTrusted, certificateValidAt };
}

function verifyRsa(key: KeyObject, data: Uint8Array, checkCode: Uint8Array): SignatureFailureReason | null {
  if (key.asymmetricKeyType !== "rsa") return "key_type_mismatch";
  let recovered: Buffer;
  try {
    recovered = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, checkCode);
  } catch {
    return "decrypt_failed";
  }
  if (recovered.length !== 32) return "unexpected_format";
  const digest = createHash("sha256").update(data).digest();
  return timingSafeEqual(digest, recovered) ? null : "digest_mismatch";
}

function verifyEcdsa(key: KeyObject, data: Uint8Array, checkCode: Uint8Array): SignatureFailureReason | null {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "secp384r1") {
    return "key_type_mismatch";
  }
  if (checkCode.length !== 96) return "signature_invalid";
  const ok = cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, checkCode);
  return ok ? null : "signature_invalid";
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
