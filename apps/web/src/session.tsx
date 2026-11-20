/** ログイン状態。ページを開いたときは Cookie でリフレッシュを試み、成功すればログイン済みにする */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, publicApi, refreshAccessToken, setAccessToken, setSignedOutHandler } from "./api";

export type Me = Awaited<ReturnType<typeof api.me.get.query>>;
type State = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; me: Me };
export type LoginStep = { kind: "done" } | { kind: "totp"; challengeToken: string } | { kind: "totpSetup"; setupToken: string };

interface Session {
  state: State;
  me: Me | null;
  can(p: string): boolean;
  login(email: string, password: string): Promise<LoginStep>;
  verifyTotp(challengeToken: string, code: string): Promise<void>;
  beginTotpSetup(setupToken: string): Promise<{ secret: string; otpauthUri: string }>;
  confirmTotpSetup(setupToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider の内側で使ってください");
  return s;
}

const DEVICE = "Web ブラウザ";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const loadMe = useCallback(async () => setState({ status: "signedIn", me: await api.me.get.query() }), []);
  const complete = useCallback(
    async (r: { accessToken: string }) => {
      setAccessToken(r.accessToken);
      await loadMe();
    },
    [loadMe],
  );

  useEffect(() => {
    setSignedOutHandler(() => setState({ status: "signedOut" }));
    refreshAccessToken().then(
      (t) => (t ? loadMe().catch(() => setState({ status: "signedOut" })) : setState({ status: "signedOut" })),
      () => setState({ status: "signedOut" }),
    );
    return () => setSignedOutHandler(null);
  }, [loadMe]);

  const value = useMemo<Session>(() => {
    const me = state.status === "signedIn" ? state.me : null;
    return {
      state,
      me,
      can: (p) => !!me?.permissions.includes(p),
      async login(email, password) {
        const r = await publicApi.auth.login.mutate({ email, password, deviceName: DEVICE });
        if (r.status === "ok") {
          await complete(r);
          return { kind: "done" };
        }
        return r.status === "totp_required" ? { kind: "totp", challengeToken: r.challengeToken } : { kind: "totpSetup", setupToken: r.setupToken };
      },
      verifyTotp: async (challengeToken, code) => complete(await publicApi.auth.verifyTotp.mutate({ challengeToken, code, deviceName: DEVICE })),
      beginTotpSetup: (setupToken) => publicApi.auth.beginTotpSetup.mutate({ setupToken }),
      confirmTotpSetup: async (setupToken, code) => complete(await publicApi.auth.confirmTotpSetup.mutate({ setupToken, code, deviceName: DEVICE })),
      async logout() {
        await publicApi.auth.logout.mutate({}).catch(() => {});
        setAccessToken(null);
        setState({ status: "signedOut" });
      },
    };
  }, [state, complete]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
