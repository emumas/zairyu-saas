/**
 * 在留カード IC の電子署名(チェックコード)検証。サーバー専用(node:crypto)。
 *
 * 署名対象: 券面(表)イメージと顔画像を連結したデータの SHA-256。
 * 方式: RSA PKCS#1 v1.5。公開鍵で復号した結果を計算したハッシュと比較する。
 *
 * TODO(0-2): 仕様書で次を確定させ、SPEC_NOTES.md と合わせて固める
 *  - 連結するのが TLV の値部のみか、タグ・長さを含むか(現状は呼び出し側が渡したバイト列をそのまま連結)
 *  - 復号結果が生のハッシュ(32バイト)か DigestInfo 付きか(現状は両方受け付ける)
 *  - 証明書チェーン(入管庁の信頼する発行者証明書)と失効の扱い
 */
import { X509Certificate, createHash, publicDecrypt, timingSafeEqual, constants, type KeyObject } from "node:crypto";

/** DigestInfo(SHA-256)の DER プレフィックス(RFC 8017 9.2 注記) */
const SHA256_DIGEST_INFO_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

export type VerifyFailureReason =
  | "decrypt_failed" // 鍵が違う・パディング不正(改ざん・偽造の疑い)
  | "unexpected_format" // 復号できたがハッシュ形式でない
  | "digest_mismatch" // データが署名と一致しない(改ざんの疑い)
  | "certificate_untrusted" // 証明書が信頼する発行者で検証できない
  | "certificate_expired";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export interface CheckCodeInput {
  /** 券面(表)イメージ */
  frontImage: Uint8Array;
  /** 顔画像 */
  faceImage: Uint8Array;
  /** チェックコード(RSA 署名値) */
  checkCode: Uint8Array;
  /** 署名検証用の公開鍵 */
  publicKey: KeyObject;
}

export function computeSignedDigest(frontImage: Uint8Array, faceImage: Uint8Array): Buffer {
  return createHash("sha256").update(frontImage).update(faceImage).digest();
}

export function verifyCheckCode(input: CheckCodeInput): VerifyResult {
  let recovered: Buffer;
  try {
    recovered = publicDecrypt({ key: input.publicKey, padding: constants.RSA_PKCS1_PADDING }, input.checkCode);
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }

  let signedDigest: Buffer;
  if (recovered.length === 32) {
    signedDigest = recovered;
  } else if (
    recovered.length === SHA256_DIGEST_INFO_PREFIX.length + 32 &&
    Buffer.from(SHA256_DIGEST_INFO_PREFIX).equals(recovered.subarray(0, SHA256_DIGEST_INFO_PREFIX.length))
  ) {
    signedDigest = recovered.subarray(SHA256_DIGEST_INFO_PREFIX.length);
  } else {
    return { ok: false, reason: "unexpected_format" };
  }

  const actual = computeSignedDigest(input.frontImage, input.faceImage);
  return timingSafeEqual(actual, signedDigest) ? { ok: true } : { ok: false, reason: "digest_mismatch" };
}

export interface CertificateCheckInput {
  /** カードから読み出した公開鍵証明書(DER) */
  certificateDer: Uint8Array;
  /** 信頼する発行者証明書(サーバーで一元管理) */
  trustedIssuers: readonly X509Certificate[];
  /** 判定時刻(既定は現在) */
  at?: Date;
}

export type CertificateCheckResult =
  | { ok: true; publicKey: KeyObject; certificate: X509Certificate }
  | { ok: false; reason: Extract<VerifyFailureReason, "certificate_untrusted" | "certificate_expired"> };

/**
 * カードの証明書を信頼する発行者で検証し、署名検証用の公開鍵を返す。
 * 有効期間はカード発行時点で有効だったかが本来の論点のため、at で判定時刻を渡せるようにしている。
 */
export function checkCardCertificate(input: CertificateCheckInput): CertificateCheckResult {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(input.certificateDer);
  } catch {
    return { ok: false, reason: "certificate_untrusted" };
  }
  const issuer = input.trustedIssuers.find((i) => cert.checkIssued(i) && cert.verify(i.publicKey));
  if (!issuer) return { ok: false, reason: "certificate_untrusted" };
  const at = (input.at ?? new Date()).getTime();
  if (at < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo)) {
    return { ok: false, reason: "certificate_expired" };
  }
  return { ok: true, publicKey: cert.publicKey, certificate: cert };
}
