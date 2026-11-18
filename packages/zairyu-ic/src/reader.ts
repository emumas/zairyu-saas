/**
 * 在留カード IC の読み出しシーケンス(各仕様書 3.5 / 別添2)。
 * NFC ライブラリに依存しないよう、APDU の送受信関数 transceive を受け取る。
 * 端末側ではここで得た EF の中身(復号済み)をそのままサーバーへ送り、署名検証と解釈はサーバーで行う。
 *
 * ログ・例外メッセージに在留カード等番号や読み出したデータを含めないこと(CLAUDE.md ルール2)。
 */
import { Apdu, splitResponse, SW, unwrapSmData } from "./apdu.js";
import { ascii } from "./bytes.js";
import type { RsaPublicKey } from "./crypto/rsaOaep.js";
import { buildMutualAuthData, buildSetSessionKeyData, completeMutualAuth } from "./keyExchange.js";
import { createSm, type SecureMessaging } from "./sm.js";
import { AID, CARD_TYPE, GEN2_EF_ID, GEN2_EF_SIZE, READ_P1, TAG, type CardFormat, type CardKind } from "./spec.js";
import { findTag, parseTlv } from "./tlv.js";

export type Transceive = (apdu: Uint8Array) => Promise<Uint8Array>;

export type ReadStep =
  | "detect"
  | "card_type"
  | "get_challenge"
  | "mutual_authenticate"
  | "set_session_key"
  | "verify"
  | "select"
  | "read";

export class CardReadError extends Error {
  constructor(
    readonly step: ReadStep,
    readonly sw: number | null,
    message: string,
  ) {
    super(`${message}(${step}${sw === null ? "" : ` SW=${sw.toString(16).toUpperCase().padStart(4, "0")}`})`);
    this.name = "CardReadError";
  }
}

/** 在留カード等番号が一致しない(VERIFY で 63xx) */
export class CardNumberMismatchError extends CardReadError {
  constructor(sw: number) {
    super("verify", sw, "在留カード等番号が一致しません");
    this.name = "CardNumberMismatchError";
  }
}

/** EF のパス。例: "mf/ef02", "df1/ef01" */
export type EfPath = `${"mf" | "df1" | "df2" | "df3"}/ef0${1 | 2 | 3 | 4}`;

export interface RawCardRead {
  format: CardFormat;
  kind: CardKind;
  /** カード種別(C1)の値。例: "1", "05", "07" */
  cardType: string;
  /** 復号済みの EF の中身(TLV の連結) */
  files: Partial<Record<EfPath, Uint8Array>>;
  /** 計測用: 読み出しに要した時間(ms) */
  elapsedMs: number;
}

export interface ReadOptions {
  /** 券面から読み取った(または手入力した)在留カード等番号 */
  cardNumber: string;
  /** 暗号論的乱数(端末では expo-crypto 等、テストでは webcrypto) */
  randomBytes: (length: number) => Uint8Array;
  /** 特定在留カードの配送鍵(公開鍵)。未設定なら特定在留カードは読めない */
  tokuteiDeliveryKey?: RsaPublicKey;
  /** 特定在留カードで SM 読出しを分割する長さ(個人番号カードの制限。既定 0x400) */
  tokuteiChunkSize?: number;
  /** 経過時間の計測(既定 Date.now) */
  now?: () => number;
}

class Session {
  constructor(private readonly transceive: Transceive) {}

  async send(step: ReadStep, apdu: Uint8Array, expectOk = true): Promise<{ data: Uint8Array; sw: number }> {
    const res = splitResponse(await this.transceive(apdu));
    if (expectOk && res.sw !== SW.OK) throw new CardReadError(step, res.sw, "カードがエラーを返しました");
    return res;
  }
}

export async function readResidenceCard(transceive: Transceive, options: ReadOptions): Promise<RawCardRead> {
  const now = options.now ?? Date.now;
  const started = now();
  const s = new Session(transceive);

  // 1. 様式の判定: 在留 AP が選択できれば特定在留カード、できなければ MF のカード種別で判定
  const ap = await s.send("detect", Apdu.selectAid(AID.residenceAp), false);
  if (ap.sw !== SW.OK) await s.send("detect", Apdu.selectMf());
  const files: RawCardRead["files"] = {};
  files["mf/ef02"] = (await s.send("card_type", Apdu.readBinary(READ_P1.mf.cardType, 0))).data;
  const cardTypeTlv = findTag(parseTlv(files["mf/ef02"]), TAG.cardType);
  const cardType = cardTypeTlv ? ascii(cardTypeTlv.value) : "";
  const typeInfo = (CARD_TYPE as Record<string, { format: CardFormat; kind: CardKind } | undefined>)[cardType];
  if (!typeInfo) throw new CardReadError("card_type", null, "対応していないカード種別です");
  if ((typeInfo.format === "tokutei") !== (ap.sw === SW.OK)) {
    throw new CardReadError("detect", null, "カード種別と AP 構成が一致しません");
  }
  const { format, kind } = typeInfo;

  // 2. 認証(セッション鍵の確立 → 在留カード等番号による認証)
  const sm = format === "tokutei" ? await setSessionKey(s, options) : await mutualAuthenticate(s, format, options);
  const verify = await s.send("verify", Apdu.verifySm(sm.encrypt(new TextEncoder().encode(options.cardNumber))), false);
  if (verify.sw !== SW.OK) {
    if ((verify.sw & 0xff00) === 0x6300) throw new CardNumberMismatchError(verify.sw);
    throw new CardReadError("verify", verify.sw, "在留カード等番号による認証に失敗しました");
  }

  // 3. EF の読み出し
  if (format === "legacy") {
    await s.send("select", Apdu.selectAid(AID.df1));
    files["df1/ef01"] = await readSm(s, sm, READ_P1.legacy.df1.frontImage);
    files["df1/ef02"] = await readSm(s, sm, READ_P1.legacy.df1.face);
    await s.send("select", Apdu.selectAid(AID.df2));
    files["df2/ef01"] = (await s.send("read", Apdu.readBinary(READ_P1.legacy.df2.address, 0))).data;
    if (kind === "residence") {
      files["df2/ef02"] = (await s.send("read", Apdu.readBinary(READ_P1.legacy.df2.outsideComprehensive, 0))).data;
      files["df2/ef03"] = (await s.send("read", Apdu.readBinary(READ_P1.legacy.df2.outsideIndividual, 0))).data;
      files["df2/ef04"] = (await s.send("read", Apdu.readBinary(READ_P1.legacy.df2.renewalStatus, 0))).data;
    }
  } else if (format === "gen2") {
    await s.send("select", Apdu.selectAid(AID.df1));
    files["df1/ef01"] = await readSm(s, sm, READ_P1.gen2.df1.cardNumber);
    files["df1/ef02"] = await readSm(s, sm, READ_P1.gen2.df1.faceItems);
    files["df1/ef03"] = await readSm(s, sm, READ_P1.gen2.df1.nameAndFace);
    files["df1/ef04"] = await readSm(s, sm, READ_P1.gen2.df1.addressImage);
    await readGen2Df2(s, kind, files);
  } else {
    const chunk = options.tokuteiChunkSize ?? 0x400;
    await s.send("select", Apdu.selectAid(AID.df1));
    const df1 = GEN2_EF_ID.df1;
    const size = GEN2_EF_SIZE.df1;
    files["df1/ef01"] = await readSmChunked(s, sm, df1.cardNumber, size.cardNumber, chunk);
    files["df1/ef02"] = await readSmChunked(s, sm, df1.faceItems, size.faceItems, chunk);
    files["df1/ef03"] = await readSmChunked(s, sm, df1.nameAndFace, size.nameAndFace, chunk);
    files["df1/ef04"] = await readSmChunked(s, sm, df1.addressImage, size.addressImage, chunk);
    await readGen2Df2(s, kind, files);
  }
  await s.send("select", Apdu.selectAid(AID.df3));
  files["df3/ef01"] = (await s.send("read", Apdu.readBinary(0x82, 0))).data;

  return { format, kind, cardType, files, elapsedMs: now() - started };
}

async function mutualAuthenticate(s: Session, format: "legacy" | "gen2", options: ReadOptions): Promise<SecureMessaging> {
  const rndIcc = (await s.send("get_challenge", Apdu.getChallenge())).data;
  if (rndIcc.length !== 8) throw new CardReadError("get_challenge", null, "カード乱数の長さが不正です");
  const input = {
    format,
    cardNumber: options.cardNumber,
    rndIcc,
    rndIfd: options.randomBytes(8),
    kIfd: options.randomBytes(16),
  };
  const res = await s.send("mutual_authenticate", Apdu.mutualAuthenticate(buildMutualAuthData(input)));
  try {
    return createSm(format, completeMutualAuth(input, res.data));
  } catch {
    throw new CardReadError("mutual_authenticate", null, "カードの認証応答が不正です");
  }
}

async function setSessionKey(s: Session, options: ReadOptions): Promise<SecureMessaging> {
  if (!options.tokuteiDeliveryKey) {
    throw new CardReadError("set_session_key", null, "特定在留カードの配送鍵が設定されていません");
  }
  const kEnc = options.randomBytes(16);
  const data = buildSetSessionKeyData({
    deliveryKey: options.tokuteiDeliveryKey,
    kEnc,
    kMac: options.randomBytes(16),
    seed1: options.randomBytes(16),
    oaepSeed: options.randomBytes(32),
  });
  await s.send("set_session_key", Apdu.setSessionKey(data));
  return createSm("tokutei", kEnc);
}

async function readSm(s: Session, sm: SecureMessaging, p1: number): Promise<Uint8Array> {
  const res = await s.send("read", Apdu.readBinarySm(p1, 0));
  return sm.decrypt(unwrapSmData(res.data));
}

async function readSmChunked(
  s: Session,
  sm: SecureMessaging,
  efId: number,
  size: number,
  chunk: number,
): Promise<Uint8Array> {
  await s.send("select", Apdu.selectEf(efId));
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const le = Math.min(chunk, size - offset);
    const res = await s.send("read", Apdu.readBinarySmTokutei(offset, le));
    const part = sm.decrypt(unwrapSmData(res.data));
    if (part.length === 0) break;
    out.set(part.subarray(0, size - offset), offset);
    offset += part.length;
  }
  return out.subarray(0, Math.min(offset, size));
}

async function readGen2Df2(s: Session, kind: CardKind, files: RawCardRead["files"]): Promise<void> {
  await s.send("select", Apdu.selectAid(AID.df2));
  if (kind === "residence") {
    files["df2/ef01"] = (await s.send("read", Apdu.readBinary(READ_P1.gen2.df2.outsideActivity, 0))).data;
    files["df2/ef02"] = (await s.send("read", Apdu.readBinary(READ_P1.gen2.df2.renewalStatus, 0))).data;
  }
  files["df2/ef03"] = (await s.send("read", Apdu.readBinary(READ_P1.gen2.df2.other, 0))).data;
}
