/**
 * 通知の送り先。
 * - Expo Push: 端末のプッシュ通知(アプリ側で EAS のプロジェクト設定とトークン登録が必要)
 * - Azure Communication Services: メール
 * - Log: 開発用(送らずにログに出す。宛先のメールアドレスは伏せる)
 */
import { EmailClient } from "@azure/communication-email";
import type { NotificationPayload } from "@zairyu/shared";

export interface PushResult {
  ok: boolean;
  /** 端末からアプリが消された等で、以後使えないトークン */
  invalidTokens: string[];
  error?: string;
}

export interface Notifier {
  push(tokens: string[], payload: NotificationPayload): Promise<PushResult>;
  email(to: string, payload: NotificationPayload): Promise<{ ok: boolean; error?: string }>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export class ExpoPushNotifier implements Pick<Notifier, "push"> {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async push(tokens: string[], payload: NotificationPayload): Promise<PushResult> {
    const res = await this.fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(tokens.map((to) => ({ to, title: payload.title, body: payload.body, sound: "default", data: { kind: payload.kind } }))),
    });
    if (!res.ok) return { ok: false, invalidTokens: [], error: `expo_http_${res.status}` };
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const tickets = json.data ?? [];
    const invalidTokens = tokens.filter((_, i) => tickets[i]?.details?.error === "DeviceNotRegistered");
    const failed = tickets.filter((t) => t.status !== "ok" && t.details?.error !== "DeviceNotRegistered");
    return failed.length > 0
      ? { ok: false, invalidTokens, error: `expo_${failed[0]?.details?.error ?? "error"}` }
      : { ok: true, invalidTokens };
  }
}

export class AcsEmailNotifier implements Pick<Notifier, "email"> {
  private readonly client: EmailClient;
  constructor(
    connectionString: string,
    private readonly senderAddress: string,
  ) {
    this.client = new EmailClient(connectionString);
  }

  async email(to: string, payload: NotificationPayload) {
    const poller = await this.client.beginSend({
      senderAddress: this.senderAddress,
      content: { subject: `【在留カード管理】${payload.title}`, plainText: `${payload.body}\n\n(このメールは送信専用です)` },
      recipients: { to: [{ address: to }] },
    });
    const r = await poller.pollUntilDone();
    return r.status === "Succeeded" ? { ok: true } : { ok: false, error: `acs_${r.status}` };
  }
}

export class LogNotifier implements Notifier {
  readonly sent: { channel: "push" | "email"; to: string; payload: NotificationPayload }[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}
  async push(tokens: string[], payload: NotificationPayload): Promise<PushResult> {
    for (const t of tokens) this.sent.push({ channel: "push", to: t, payload });
    this.log(`[push] ${tokens.length} 台: ${payload.title}`);
    return { ok: true, invalidTokens: [] };
  }
  async email(to: string, payload: NotificationPayload) {
    this.sent.push({ channel: "email", to, payload });
    this.log(`[email] ${to.replace(/^(.).*(@.*)$/, "$1***$2")}: ${payload.title}`);
    return { ok: true };
  }
}

/** 環境変数から通知の送り先を作る。未設定のチャネルはログに出すだけ */
export function notifierFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): Notifier {
  const logger = new LogNotifier(log);
  const push = env.NOTIFY_PUSH === "expo" ? new ExpoPushNotifier() : logger;
  const email =
    env.ACS_CONNECTION_STRING && env.ACS_SENDER_ADDRESS ? new AcsEmailNotifier(env.ACS_CONNECTION_STRING, env.ACS_SENDER_ADDRESS) : logger;
  return { push: (t, p) => push.push(t, p), email: (to, p) => email.email(to, p) };
}
