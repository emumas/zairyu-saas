/**
 * ログイン状態(1-2 アプリ側)。
 * - リフレッシュトークンは SecureStore(iOS キーチェーン / Android Keystore、この端末のみ)に保存
 * - アクセストークンはメモリのみ
 * - 起動時と、バックグラウンドから 30 秒以上たって戻ったときは生体認証(端末のパスコードも可)で再ロック
 */
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { api, publicApi, setAccessToken, setRefreshHandler } from "../api";

const REFRESH_KEY = "zairyu.refreshToken";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const RELOCK_AFTER_MS = 30_000;
const DEVICE_NAME = `${Platform.OS} ${String(Platform.Version)}`.slice(0, 100);

export type Me = Awaited<ReturnType<typeof api.me.get.query>>;

type State = { status: "loading" } | { status: "signedOut" } | { status: "locked" } | { status: "signedIn"; me: Me };

export type LoginStep =
  | { kind: "done" }
  | { kind: "totp"; challengeToken: string }
  | { kind: "totpSetup"; setupToken: string };

interface Session {
  state: State;
  login(email: string, password: string): Promise<LoginStep>;
  verifyTotp(challengeToken: string, code: string): Promise<void>;
  beginTotpSetup(setupToken: string): Promise<{ secret: string; otpauthUri: string }>;
  confirmTotpSetup(setupToken: string, code: string): Promise<void>;
  unlock(): Promise<{ ok: boolean; message?: string }>;
  logout(): Promise<void>;
  can(permission: string): boolean;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider の内側で使ってください");
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const refreshing = useRef<Promise<string | null> | null>(null);
  const backgroundAt = useRef<number | null>(null);

  const clearLocal = useCallback(async () => {
    setAccessToken(null);
    await SecureStore.deleteItemAsync(REFRESH_KEY, STORE_OPTIONS).catch(() => {});
  }, []);

  /** リフレッシュトークンで新しいトークンを得る(同時に呼ばれても 1 回だけ) */
  const doRefresh = useCallback(async (): Promise<string | null> => {
    refreshing.current ??= (async () => {
      try {
        const token = await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS);
        if (!token) return null;
        const r = await publicApi.auth.refresh.mutate({ refreshToken: token });
        await SecureStore.setItemAsync(REFRESH_KEY, r.refreshToken, STORE_OPTIONS);
        setAccessToken(r.accessToken);
        return r.accessToken;
      } catch (e) {
        // 失効・盗用検知などで使えなくなったトークンは消す(通信エラーのときは残す)
        if ((e as { data?: { code?: string } }).data?.code === "UNAUTHORIZED") {
          await clearLocal();
          setState({ status: "signedOut" });
        }
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [clearLocal]);

  const completeLogin = useCallback(async (tokens: { accessToken: string; refreshToken: string }) => {
    await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken, STORE_OPTIONS);
    setAccessToken(tokens.accessToken);
    const me = await api.me.get.query();
    setState({ status: "signedIn", me });
  }, []);

  useEffect(() => {
    setRefreshHandler(doRefresh);
    SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS).then(
      (t) => setState({ status: t ? "locked" : "signedOut" }),
      () => setState({ status: "signedOut" }),
    );
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        const away = backgroundAt.current === null ? 0 : Date.now() - backgroundAt.current;
        backgroundAt.current = null;
        if (away >= RELOCK_AFTER_MS) {
          setAccessToken(null);
          setState((cur) => (cur.status === "signedIn" ? { status: "locked" } : cur));
        }
      } else {
        backgroundAt.current ??= Date.now();
      }
    });
    return () => {
      sub.remove();
      setRefreshHandler(null);
    };
  }, [doRefresh]);

  const value = useMemo<Session>(
    () => ({
      state,
      async login(email, password) {
        const r = await publicApi.auth.login.mutate({ email, password, deviceName: DEVICE_NAME });
        if (r.status === "ok") {
          await completeLogin(r);
          return { kind: "done" };
        }
        if (r.status === "totp_required") return { kind: "totp", challengeToken: r.challengeToken };
        return { kind: "totpSetup", setupToken: r.setupToken };
      },
      async verifyTotp(challengeToken, code) {
        await completeLogin(await publicApi.auth.verifyTotp.mutate({ challengeToken, code, deviceName: DEVICE_NAME }));
      },
      beginTotpSetup: (setupToken) => publicApi.auth.beginTotpSetup.mutate({ setupToken }),
      async confirmTotpSetup(setupToken, code) {
        await completeLogin(await publicApi.auth.confirmTotpSetup.mutate({ setupToken, code, deviceName: DEVICE_NAME }));
      },
      async unlock() {
        const hasSecurity = (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE;
        if (hasSecurity) {
          const r = await LocalAuthentication.authenticateAsync({
            promptMessage: "在留カード管理のロックを解除",
            cancelLabel: "キャンセル",
            disableDeviceFallback: false,
          });
          if (!r.success) return { ok: false, message: "認証できませんでした" };
        }
        // 端末に画面ロックが設定されていない場合は生体認証を求められない(案内のみ)
        const token = await doRefresh();
        if (!token) return { ok: false, message: "もう一度ログインしてください" };
        try {
          setState({ status: "signedIn", me: await api.me.get.query() });
          return hasSecurity ? { ok: true } : { ok: true, message: "端末に画面ロックを設定することをおすすめします" };
        } catch {
          return { ok: false, message: "サーバーに接続できません" };
        }
      },
      async logout() {
        const token = await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTIONS).catch(() => null);
        if (token) await publicApi.auth.logout.mutate({ refreshToken: token }).catch(() => {});
        await clearLocal();
        setState({ status: "signedOut" });
      },
      can: (p) => state.status === "signedIn" && state.me.permissions.includes(p),
    }),
    [state, completeLogin, doRefresh, clearLocal],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
