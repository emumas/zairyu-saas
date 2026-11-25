/** 職種照合(テスト運用)が有効か。設定で切り替えたら refreshJobMatching() で読み直す */
import { useEffect, useState } from "react";
import { api } from "./api";

const listeners = new Set<(v: boolean) => void>();
let cached: boolean | null = null;

export function refreshJobMatching(value?: boolean) {
  const apply = (v: boolean) => {
    cached = v;
    listeners.forEach((l) => l(v));
  };
  if (value !== undefined) return apply(value);
  api.jobs.enabled.query().then((r) => apply(r.enabled), () => apply(false));
}

export function useJobMatchingEnabled(): boolean {
  const [v, setV] = useState(cached ?? false);
  useEffect(() => {
    listeners.add(setV);
    if (cached === null) refreshJobMatching();
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
