import { hex, type RsaPublicKey } from "@zairyu/zairyu-ic";
import { getRandomBytes } from "expo-crypto";

export const randomBytes = (n: number): Uint8Array => getRandomBytes(n);

/**
 * 特定在留カードの配送鍵(公開鍵)。仕様書に値がなく未入手(SPEC_NOTES.md 4章 B)。
 * 入手後に EXPO_PUBLIC_TOKUTEI_DELIVERY_KEY_N / _E(16進)で与える。
 */
export function tokuteiDeliveryKey(): RsaPublicKey | undefined {
  const n = process.env.EXPO_PUBLIC_TOKUTEI_DELIVERY_KEY_N;
  const e = process.env.EXPO_PUBLIC_TOKUTEI_DELIVERY_KEY_E;
  return n && e ? { modulus: hex(n), exponent: hex(e) } : undefined;
}
