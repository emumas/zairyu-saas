/** パスワードのハッシュ(argon2id。パラメータは OWASP Password Storage Cheat Sheet の推奨値) */
import { hash, verify } from "@node-rs/argon2";

const OPTIONS = {
  algorithm: 2, // Argon2id(@node-rs/argon2 の const enum Algorithm.Argon2id)
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`パスワードは ${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH} 文字にしてください`);
  }
  return hash(password, OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/**
 * パスワードを検証する。ユーザーが存在しない(hashed が null)場合もダミーのハッシュで同じだけ計算し、
 * 応答時間からユーザーの有無が分からないようにする
 */
export async function verifyPassword(hashed: string | null, password: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  if (!hashed) {
    dummyHash ??= hash("dummy-password-for-timing", OPTIONS);
    await verify(await dummyHash, password);
    return false;
  }
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}
