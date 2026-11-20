/**
 * Web 管理画面の API クライアント。
 * - x-zairyu-client: web を付けると、リフレッシュトークンは HttpOnly Cookie で扱われる(JavaScript からは読めない)
 * - アクセストークンはメモリだけに持ち、401 なら 1 回だけ Cookie でリフレッシュして再送する
 */
import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "api/router";

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;
let refreshing: Promise<string | null> | null = null;

export function setAccessToken(t: string | null) {
  accessToken = t;
}
export function setSignedOutHandler(fn: (() => void) | null) {
  onSignedOut = fn;
}

const WEB_HEADER = { "x-zairyu-client": "web" };

export const publicApi = createTRPCClient<AppRouter>({
  links: [httpLink({ url: "/trpc", headers: WEB_HEADER, fetch: (i, init) => fetch(i, { ...init, credentials: "same-origin" }) })],
});

/** Cookie のリフレッシュトークンで新しいアクセストークンを得る(同時に呼ばれても 1 回) */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= publicApi.auth.refresh
    .mutate({})
    .then((r) => {
      accessToken = r.accessToken;
      return r.accessToken;
    })
    .catch(() => {
      accessToken = null;
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const withToken = (t: string | null): RequestInit => ({
    ...init,
    credentials: "same-origin",
    headers: { ...(init?.headers as Record<string, string> | undefined), ...WEB_HEADER, ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  });
  let res = await fetch(input, withToken(accessToken));
  if (res.status === 401) {
    const t = await refreshAccessToken();
    if (t) res = await fetch(input, withToken(t));
    else onSignedOut?.();
  }
  return res;
};

export const api = createTRPCClient<AppRouter>({ links: [httpLink({ url: "/trpc", fetch: authFetch })] });

export function messageOf(e: unknown, fallback = "通信に失敗しました。時間をおいて再度お試しください"): string {
  const m = (e as { message?: string } | null)?.message;
  if (!m || /fetch|network|JSON/i.test(m)) return fallback;
  return m;
}
