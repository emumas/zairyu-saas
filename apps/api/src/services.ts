import { createDb } from "@zairyu/db";
import { createVaultFromEnv } from "@zairyu/vault";
import { AuthService } from "./auth/service.js";
import { createLocalSecretBox } from "./auth/secretBox.js";
import type { Config } from "./config.js";
import { RateLimiter } from "./rateLimit.js";
import type { Services } from "./trpc.js";

export function createServices(config: Config, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): Services | null {
  if (!config.databaseUrl) return null;
  const { db } = createDb(config.databaseUrl);
  return {
    db,
    config,
    now,
    auth: new AuthService(db, config, createLocalSecretBox(config.secretBoxKey), now),
    // IP あたり 1 分 20 回まで(ログイン・TOTP・リフレッシュの合計)
    authRateLimiter: new RateLimiter(20, 60_000, now),
    // 鍵の提供元が未設定なら、カード番号・画像を扱う API だけ使えない(認証等は使える)
    vault: env.VAULT_KEY_PROVIDER ? createVaultFromEnv(db, env) : null,
  };
}
