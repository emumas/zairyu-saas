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
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, {
      alertMessage: "在留カードを端末の背面(iPhone は上部)にかざしてください",
    });
    let maxTransceiveLength: number | null = null;
    if (Platform.OS === "android") {
      // 大きな EF の読出しで既定のタイムアウトを超えないよう延ばす
      await NfcManager.setTimeout(5000);
      maxTransceiveLength = await NfcManager.getMaxTransceiveLength();
    }
    const transceive: Transceive = async (apdu) => {
      count++;
      const res = await NfcManager.isoDepHandler.transceive(Array.from(apdu));
      return Uint8Array.from(res);
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
