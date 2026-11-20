/** 共通の画面部品 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({ kind = "primary", busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "secondary" | "danger"; busy?: boolean }) {
  return (
    <button className={`btn btn-${kind}`} disabled={props.disabled || busy} {...props}>
      {busy ? "処理中…" : children}
    </button>
  );
}

export function Field({ label, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {error && <small className="error">{error}</small>}
    </label>
  );
}

export function Message({ text, tone = "danger" }: { text: string | null | undefined; tone?: "danger" | "warn" | "ok" }) {
  return text ? <p className={`msg msg-${tone}`}>{text}</p> : null;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          <div>{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export const fmtDateTime = (d: Date | string | null) => (d ? new Date(d).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—");
