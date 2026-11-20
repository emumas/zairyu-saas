/**
 * 信頼する発行者(入管庁)の証明書。仕様書に記載がなく未入手(SPEC_NOTES.md 4章 A)。
 * 環境変数 ZAIRYU_TRUSTED_ISSUERS(DER/PEM ファイルのパス、カンマ区切り)で与える。
 * 未設定なら署名検証の issuerTrusted は null(未確認)になる
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

let cache: X509Certificate[] | undefined;

export function trustedIssuers(env: NodeJS.ProcessEnv = process.env): X509Certificate[] {
  cache ??= (env.ZAIRYU_TRUSTED_ISSUERS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new X509Certificate(readFileSync(p)));
  return cache;
}
