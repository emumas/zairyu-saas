/**
 * 信頼する発行者(出入国在留管理庁 ZairyuCard CA)の証明書。
 * apps/api/trust/*.der を既定で読み込み、環境変数 ZAIRYU_TRUSTED_ISSUERS(DER/PEM のパス、カンマ区切り)で追加できる。
 * 発行者の判定はカードの証明書と同じ鍵種別の証明書だけで行う(packages/zairyu-ic/src/verify.ts)
 */
import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** src/ からも dist/ からも apps/api/trust を指す */
const TRUST_DIR = fileURLToPath(new URL("../trust/", import.meta.url));

let cache: X509Certificate[] | undefined;

export function bundledIssuerPaths(): string[] {
  try {
    return readdirSync(TRUST_DIR)
      .filter((f) => f.endsWith(".der") || f.endsWith(".pem") || f.endsWith(".crt"))
      .sort()
      .map((f) => `${TRUST_DIR}${f}`);
  } catch {
    return [];
  }
}

export function trustedIssuers(env: NodeJS.ProcessEnv = process.env): X509Certificate[] {
  cache ??= [
    ...bundledIssuerPaths(),
    ...(env.ZAIRYU_TRUSTED_ISSUERS ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ].map((p) => new X509Certificate(readFileSync(p)));
  return cache;
}
