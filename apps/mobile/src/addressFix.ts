/**
 * 端末で読み取った住所の地名の読み違いを、サーバーの郵便番号データで直す(自社の API だけ。外部には送らない)。
 * 通信に失敗したら読み取ったままの住所を返す(読み取りを止めない)
 */
import { api } from "./api";

export async function correctAddress(address: string | null): Promise<{ address: string | null; changed: boolean; postalCode: string | null }> {
  if (!address?.trim()) return { address, changed: false, postalCode: null };
  try {
    return await api.postal.correct.query({ address: address.trim() });
  } catch {
    return { address, changed: false, postalCode: null };
  }
}
