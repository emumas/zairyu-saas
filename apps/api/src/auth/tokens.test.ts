import { expect, it } from "vitest";
import { newRefreshToken, parseRefreshToken, signToken, verifyToken } from "./tokens.js";

const secret = new TextEncoder().encode("x".repeat(32));
const claims = { userId: "11111111-1111-1111-1111-111111111111", tenantId: "22222222-2222-2222-2222-222222222222" };

it("署名して検証できる", async () => {
  const t = await signToken(secret, { ...claims, type: "access" }, 900, 1000);
  expect(await verifyToken(secret, t, "access", 1500)).toEqual({ ...claims, type: "access" });
});

it("期限切れ・種類違い・鍵違いは null", async () => {
  const t = await signToken(secret, { ...claims, type: "totp_challenge" }, 300, 1000);
  expect(await verifyToken(secret, t, "totp_challenge", 1301)).toBeNull();
  expect(await verifyToken(secret, t, "access", 1100)).toBeNull();
  expect(await verifyToken(new TextEncoder().encode("y".repeat(32)), t, "totp_challenge", 1100)).toBeNull();
});

it("alg=none などの改ざんトークンは null", async () => {
  const t = await signToken(secret, { ...claims, type: "access" }, 900, 1000);
  const [, payload] = t.split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.`;
  expect(await verifyToken(secret, none, "access", 1100)).toBeNull();
});

it("リフレッシュトークンはテナント ID とハッシュに分解できる", () => {
  const t = newRefreshToken(claims.tenantId);
  const p = parseRefreshToken(t);
  expect(p?.tenantId).toBe(claims.tenantId);
  expect(p?.hash.length).toBe(32);
  expect(parseRefreshToken("garbage")).toBeNull();
});
