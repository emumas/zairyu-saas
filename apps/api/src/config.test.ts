import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { loadConfig } from "./config.js";

it("DB なし(PoC)なら鍵は不要", () => {
  expect(loadConfig({}).databaseUrl).toBeUndefined();
});

it("DB を使うなら鍵が必須", () => {
  expect(() => loadConfig({ DATABASE_URL: "postgres://x" })).toThrow();
  const c = loadConfig({
    DATABASE_URL: "postgres://x",
    AUTH_JWT_SECRET: "s".repeat(32),
    AUTH_SECRET_BOX_KEY: randomBytes(32).toString("base64"),
  });
  expect(c.secretBoxKey.length).toBe(32);
});

it("短い鍵は拒否", () => {
  expect(() => loadConfig({ DATABASE_URL: "x", AUTH_JWT_SECRET: "short", AUTH_SECRET_BOX_KEY: randomBytes(16).toString("base64") })).toThrow();
});
