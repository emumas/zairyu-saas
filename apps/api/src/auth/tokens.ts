/**
 * トークン
 * - アクセストークン: JWT(HS256)、15 分。ロールは毎リクエスト DB から引き直すので、ここでは ID だけ持つ
 * - 目的別トークン: TOTP 入力・初期設定の間だけ使う JWT(5 分)
 * - リフレッシュトークン: "<テナントID>.<乱数>" の不透明な文字列。DB には SHA-256 だけを保存する
 */
import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "zairyu-api";
const AUDIENCE = "zairyu";

export type TokenType = "access" | "totp_challenge" | "totp_setup";

export interface TokenClaims {
  userId: string;
  tenantId: string;
  type: TokenType;
}

export async function signToken(secret: Uint8Array, claims: TokenClaims, ttlSec: number, nowSec: number): Promise<string> {
  return new SignJWT({ tid: claims.tenantId, typ: claims.type })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSec)
    .sign(secret);
}

/** 検証に失敗したら null(理由は呼び出し側に出さない) */
export async function verifyToken(
  secret: Uint8Array,
  token: string,
  expected: TokenType,
  nowSec: number,
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      currentDate: new Date(nowSec * 1000),
    });
    if (payload.typ !== expected || typeof payload.sub !== "string" || typeof payload.tid !== "string") return null;
    return { userId: payload.sub, tenantId: payload.tid, type: expected };
  } catch {
    return null;
  }
}

export function newRefreshToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(32).toString("base64url")}`;
}

export function parseRefreshToken(token: string): { tenantId: string; hash: Buffer } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  return { tenantId: m[1]!, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
