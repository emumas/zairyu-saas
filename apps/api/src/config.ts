/** 環境変数から設定を読む。秘密情報は環境変数 / Key Vault から与え、リポジトリに置かない */
import { randomBytes } from "node:crypto";
import { z } from "zod";

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "32 バイトの鍵を base64 で指定してください");

const schema = z.object({
  DATABASE_URL: z.string().optional(),
  /** アクセストークン(JWT HS256)の署名鍵。32 文字以上 */
  AUTH_JWT_SECRET: z.string().min(32),
  /** TOTP 秘密鍵の暗号化鍵(AES-256-GCM)。1-4 で Key Vault の鍵に置き換える */
  AUTH_SECRET_BOX_KEY: base64Key32,
  /** TOTP の発行者名(認証アプリに表示) */
  AUTH_TOTP_ISSUER: z.string().default("在留カード管理"),
  /** Web 管理画面の URL(招待リンクに使う) */
  WEB_BASE_URL: z.string().default("http://localhost:5173"),
  /** 端末から見た API の URL(画像 URL の組み立てに使う) */
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
});

export interface Config {
  databaseUrl: string | undefined;
  jwtSecret: Uint8Array;
  secretBoxKey: Buffer;
  totpIssuer: string;
  publicBaseUrl: string;
  webBaseUrl: string;
  /** 招待リンクの有効期間 */
  invitationTtlSec: number;
  /** 画像 URL の有効期間 */
  imageUrlTtlSec: number;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  purposeTokenTtlSec: number;
  /** ログイン失敗でロックするまでの回数とロック時間 */
  maxFailedLogins: number;
  lockoutSec: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // DB を使わない起動(フェーズ0 の PoC 等)では認証を使わないので、鍵が無ければ使い捨ての値で埋める
  const filled = env.DATABASE_URL
    ? env
    : {
        ...env,
        AUTH_JWT_SECRET: env.AUTH_JWT_SECRET ?? randomBytes(32).toString("hex"),
        AUTH_SECRET_BOX_KEY: env.AUTH_SECRET_BOX_KEY ?? randomBytes(32).toString("base64"),
      };
  const e = schema.parse(filled);
  return {
    databaseUrl: e.DATABASE_URL,
    jwtSecret: new TextEncoder().encode(e.AUTH_JWT_SECRET),
    secretBoxKey: Buffer.from(e.AUTH_SECRET_BOX_KEY, "base64"),
    totpIssuer: e.AUTH_TOTP_ISSUER,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    webBaseUrl: e.WEB_BASE_URL.replace(/\/$/, ""),
    invitationTtlSec: 72 * 60 * 60,
    imageUrlTtlSec: 120,
    accessTokenTtlSec: 15 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    purposeTokenTtlSec: 5 * 60,
    maxFailedLogins: 10,
    lockoutSec: 15 * 60,
  };
}
