/**
 * API クライアント。
 * - api: ログイン後の業務 API。アクセストークンを付け、401 なら 1 回だけリフレッシュして再送する
 * - publicApi: ログイン・リフレッシュ等(トークンなし)
 */
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "api/router";

/** 開発用 API の URL(例: http://192.168.0.10:3000)。実機からは PC の LAN IP を指定する */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

let accessToken: string | null = null;
let refresh: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

/** セッション側から、アクセストークンの再取得方法を登録する */
export function setRefreshHandler(fn: (() => Promise<string | null>) | null) {
  refresh = fn;
}

const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const withToken = (token: string | null): RequestInit => ({
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let res = await fetch(input, withToken(accessToken));
  if (res.status === 401 && refresh) {
    const token = await refresh();
    if (token) res = await fetch(input, withToken(token));
  }
  return res;
};

export const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${API_URL}/trpc`, fetch: authFetch })],
});

export const publicApi = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${API_URL}/trpc` })],
});

/** tRPC のエラーから利用者向けのメッセージを取り出す(サーバーのメッセージは日本語) */
export function messageOf(e: unknown, fallback = "通信に失敗しました。電波の状態と API の起動を確認してください"): string {
  const m = (e as { message?: string } | null)?.message;
  if (!m || /fetch|network|JSON/i.test(m)) return fallback;
  return m;
}
