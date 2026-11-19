/**
 * react-native-nfc-manager を zairyu-ic の Transceive につなぐ。
 * iOS: Core NFC の ISO 7816(select-identifiers に AID の記載が必要。app.json 参照)
 * Android: IsoDep
 */
import type { Transceive } from "@zairyu/zairyu-ic";
import { Platform } from "react-native";
import NfcManager, { NfcTech } from "react-native-nfc-manager";

export interface NfcSessionInfo {
  /** Android: IsoDep.getMaxTransceiveLength。iOS は取得できないため null */
  maxTransceiveLength: number | null;
  /** 送受信した APDU の数(計測用) */
  apduCount: () => number;
}

/**
 * 診断用の送受信記録。コマンドのヘッダ(CLA INS P1 P2)と応答の SW・長さだけを残し、
 * データ部(カード番号の暗号文や個人情報)は記録しない。
 */
export interface TraceEntry {
  header: string;
  sw: string | null;
  responseLength: number | null;
  error?: string;
}

let lastTrace: TraceEntry[] = [];
let lastMaxTransceiveLength: number | null = null;

export function getLastTrace(): { entries: TraceEntry[]; maxTransceiveLength: number | null } {
  return { entries: lastTrace, maxTransceiveLength: lastMaxTransceiveLength };
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/** SM 応答のオーバーヘッド(86 L 01 + パディング + SW)を見込んだ余裕 */
const SM_OVERHEAD = 64;

export function maxReadLengthFor(info: NfcSessionInfo): number | undefined {
  return info.maxTransceiveLength ? info.maxTransceiveLength - SM_OVERHEAD : undefined;
}

export async function isNfcAvailable(): Promise<boolean> {
  if (!(await NfcManager.isSupported())) return false;
  await NfcManager.start();
  return Platform.OS === "ios" ? true : NfcManager.isEnabled();
}

/**
 * カードを待ち受け、見つかったら fn に APDU 送受信関数を渡す。
 * 終了時(成功・失敗とも)にセッションを閉じる。
 */
export async function withIsoDep<T>(fn: (transceive: Transceive, info: NfcSessionInfo) => Promise<T>): Promise<T> {
  await NfcManager.start();
  let count = 0;
  lastTrace = [];
  lastMaxTransceiveLength = null;
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, {
      alertMessage: "在留カードを端末の背面(iPhone は上部)にかざしてください",
    });
    let maxTransceiveLength: number | null = null;
    if (Platform.OS === "android") {
      // 大きな EF の読出しで既定のタイムアウトを超えないよう延ばす
      await NfcManager.setTimeout(5000);
      maxTransceiveLength = await NfcManager.getMaxTransceiveLength();
      lastMaxTransceiveLength = maxTransceiveLength;
    }
    const transceive: Transceive = async (apdu) => {
      count++;
      const entry: TraceEntry = {
        header: Array.from(apdu.subarray(0, 4), hex2).join(" "),
        sw: null,
        responseLength: null,
      };
      lastTrace.push(entry);
      try {
        const res = await NfcManager.isoDepHandler.transceive(Array.from(apdu));
        entry.responseLength = res.length;
        if (res.length >= 2) entry.sw = hex2(res[res.length - 2]!) + hex2(res[res.length - 1]!);
        return Uint8Array.from(res);
      } catch (e) {
        entry.error = String(e instanceof Error ? e.message : e).slice(0, 120);
        throw e;
      }
    };
    const result = await fn(transceive, { maxTransceiveLength, apduCount: () => count });
    if (Platform.OS === "ios") await NfcManager.setAlertMessageIOS("読み取りが完了しました");
    return result;
  } catch (e) {
    if (Platform.OS === "ios") await NfcManager.invalidateSessionWithErrorIOS("読み取りに失敗しました").catch(() => {});
    throw e;
  } finally {
    await NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
