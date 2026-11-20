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
import { AID, CARD_TYPE, GEN2_EF_ID, GEN2_EF_SIZE, LEGACY_EF_SIZE, READ_P1, TAG, type CardFormat, type CardKind } from "./spec.js";
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
  /**
   * 1 回の READ BINARY で要求する最大長。端末が拡張長 APDU の大きな応答を受けられない場合に設定する
   * (Android の IsoDep.getMaxTransceiveLength 等から決める)。未設定なら EF 全体を 1 回で読む
   */
  maxReadLength?: number;
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

  // 1. 様式の判定はカード種別(C1)の値で行う。
  //    特定在留カードは在留 AP を選択しないとカード種別が読めないため、まず在留 AP の選択を試す。
  //    実機の旧様式カードは在留 AP の AID にも 9000 を返したため、選択の成否では様式を判定しない。
  const files: RawCardRead["files"] = {};
  const ap = await s.send("detect", Apdu.selectAid(AID.residenceAp), false);
  let typeInfo: { format: CardFormat; kind: CardKind; cardType: string } | null = null;
  if (ap.sw === SW.OK) {
    const res = await s.send("card_type", Apdu.readBinary(READ_P1.mf.cardType, 0), false);
    if (res.sw === SW.OK) {
      typeInfo = cardTypeOf(res.data);
      if (typeInfo?.format === "tokutei") files["mf/ef02"] = res.data;
    }
  }
  if (typeInfo?.format !== "tokutei") {
    // 旧様式・第2世代: MF を選び直してカード種別を読む
    await s.send("detect", Apdu.selectMf());
    files["mf/ef02"] = (await s.send("card_type", Apdu.readBinary(READ_P1.mf.cardType, 0))).data;
    typeInfo = cardTypeOf(files["mf/ef02"]);
    if (typeInfo?.format === "tokutei") {
      throw new CardReadError("detect", null, "特定在留カードの AP を選択できません");
    }
  }
  if (!typeInfo) throw new CardReadError("card_type", null, "対応していないカード種別です");
  const cardType = typeInfo.cardType;
  const { format, kind } = typeInfo;

  // 2. 認証(セッション鍵の確立 → 在留カード等番号による認証)
  const sm = format === "tokutei" ? await setSessionKey(s, options) : await mutualAuthenticate(s, format, options);
  const verify = await s.send("verify", Apdu.verifySm(sm.encrypt(new TextEncoder().encode(options.cardNumber))), false);
  if (verify.sw !== SW.OK) {
    if ((verify.sw & 0xff00) === 0x6300) throw new CardNumberMismatchError(verify.sw);
    throw new CardReadError("verify", verify.sw, "在留カード等番号による認証に失敗しました");
  }

  // 3. EF の読み出し
  const r = new EfReader(s, sm, options.maxReadLength);
  if (format === "legacy") {
    const p = READ_P1.legacy;
    const size = LEGACY_EF_SIZE;
    await s.send("select", Apdu.selectAid(AID.df1));
    files["df1/ef01"] = await r.readTlvs(p.df1.frontImage, size.df1.frontImage, 1);
    files["df1/ef02"] = await r.readTlvs(p.df1.face, size.df1.face, 1);
    await s.send("select", Apdu.selectAid(AID.df2));
    files["df2/ef01"] = await r.read(p.df2.address, size.df2.address, false);
    if (kind === "residence") {
      files["df2/ef02"] = await r.read(p.df2.outsideComprehensive, size.df2.outsideComprehensive, false);
      files["df2/ef03"] = await r.read(p.df2.outsideIndividual, size.df2.outsideIndividual, false);
      files["df2/ef04"] = await r.read(p.df2.renewalStatus, size.df2.renewalStatus, false);
    }
    await s.send("select", Apdu.selectAid(AID.df3));
    files["df3/ef01"] = await r.read(p.df3.signature, size.df3.signature, false);
  } else {
    const p = READ_P1.gen2;
    const size = GEN2_EF_SIZE;
    await s.send("select", Apdu.selectAid(AID.df1));
    if (format === "gen2") {
      files["df1/ef01"] = await r.read(p.df1.cardNumber, size.df1.cardNumber, true);
      files["df1/ef02"] = await r.read(p.df1.faceItems, size.df1.faceItems, true);
      files["df1/ef03"] = await r.readTlvs(p.df1.nameAndFace, size.df1.nameAndFace, 2);
      files["df1/ef04"] = await r.readTlvs(p.df1.addressImage, size.df1.addressImage, 1);
    } else {
      // 特定在留カード: EF-ID で選択し、オフセット指定で分割読出し(個人番号カードの SM 読出し長制限)
      const chunk = Math.min(options.tokuteiChunkSize ?? 0x400, options.maxReadLength ?? Infinity);
      const id = GEN2_EF_ID.df1;
      files["df1/ef01"] = await readSmTokutei(s, sm, id.cardNumber, size.df1.cardNumber, chunk);
      files["df1/ef02"] = await readSmTokutei(s, sm, id.faceItems, size.df1.faceItems, chunk);
      files["df1/ef03"] = await readSmTokutei(s, sm, id.nameAndFace, size.df1.nameAndFace, chunk);
      files["df1/ef04"] = await readSmTokutei(s, sm, id.addressImage, size.df1.addressImage, chunk);
    }
    await s.send("select", Apdu.selectAid(AID.df2));
    if (kind === "residence") {
      files["df2/ef01"] = await r.read(p.df2.outsideActivity, size.df2.outsideActivity, false);
      files["df2/ef02"] = await r.read(p.df2.renewalStatus, size.df2.renewalStatus, false);
    }
    files["df2/ef03"] = await r.read(p.df2.other, size.df2.other, false);
    await s.send("select", Apdu.selectAid(AID.df3));
    files["df3/ef01"] = await r.read(p.df3.signature, size.df3.signature, false);
  }

  return { format, kind, cardType, files, elapsedMs: now() - started };
}

function cardTypeOf(data: Uint8Array): { format: CardFormat; kind: CardKind; cardType: string } | null {
  let tlv;
  try {
    tlv = findTag(parseTlv(data), TAG.cardType);
  } catch {
    return null;
  }
  const cardType = tlv ? ascii(tlv.value) : "";
  const info = (CARD_TYPE as Record<string, { format: CardFormat; kind: CardKind } | undefined>)[cardType];
  return info ? { ...info, cardType } : null;
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

/**
 * 短縮 EF 指定(P1)で EF を読む。maxReadLength 未満に収まらない場合は分割する:
 * 1 回目は短縮 EF 指定で読み(読んだ EF がカレントになる)、2 回目以降はカレント EF をオフセット指定で読む。
 */
class EfReader {
  constructor(
    private readonly s: Session,
    private readonly sm: SecureMessaging,
    private readonly maxReadLength: number | undefined,
  ) {}

  async read(p1: number, size: number, secure: boolean): Promise<Uint8Array> {
    const chunk = this.maxReadLength;
    if (!chunk || chunk >= size) return this.readOnce(p1, 0, 0, secure);
    const out = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const le = Math.min(chunk, size - offset);
      const part =
        offset === 0
          ? await this.readOnce(p1, 0, le, secure)
          : await this.readOnce((offset >> 8) & 0x7f, offset & 0xff, le, secure);
      if (part.length === 0) break;
      out.set(part.subarray(0, size - offset), offset);
      offset += part.length;
    }
    return out.subarray(0, Math.min(offset, size));
  }

  /**
   * SM の EF を TLV 単位で読む。実カードは TLV の長さが実データ長で EF の残りが 0x00 埋めのため、
   * 先にヘッダ(最大 5 バイト)を読んで長さを知り、値の分だけ読む(埋め草の暗号化・転送を省く)。
   * tlvCount(仕様書の EF 内のデータオブジェクト数)だけ読むか、0x00 埋めに達したら終える。
   * 返すのは読んだ TLV の連結(後ろの 0x00 は含まない)
   */
  async readTlvs(p1: number, size: number, tlvCount: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < size && parts.length < tlvCount) {
      const headerLen = Math.min(5, size - offset);
      const head = offset === 0 ? await this.readOnce(p1, 0, headerLen, true) : await this.readAt(offset, headerLen);
      if (head.length === 0 || head[0] === 0x00 || head[0] === 0xff) break;
      const h = tlvHeader(head);
      if (!h) throw new CardReadError("read", null, "TLV のヘッダを解釈できません");
      const total = Math.min(h.headerLength + h.valueLength, size - offset);
      const tlv = new Uint8Array(total);
      const have = Math.min(head.length, total);
      tlv.set(head.subarray(0, have));
      let filled = have;
      while (filled < total) {
        const le = Math.min(this.maxReadLength ?? total, total - filled);
        const part = await this.readAt(offset + filled, le);
        if (part.length === 0) throw new CardReadError("read", null, "データが途中で終わっています");
        tlv.set(part.subarray(0, total - filled), filled);
        filled += part.length;
      }
      parts.push(tlv);
      offset += total;
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** カレント EF をオフセット指定で読む(SM) */
  private readAt(offset: number, le: number): Promise<Uint8Array> {
    return this.readOnce((offset >> 8) & 0x7f, offset & 0xff, le, true);
  }

  private async readOnce(p1: number, p2: number, le: number, secure: boolean): Promise<Uint8Array> {
    if (!secure) return (await this.s.send("read", Apdu.readBinary(p1, p2, le))).data;
    const res = await this.s.send("read", Apdu.readBinarySm(p1, p2, le));
    return this.sm.decrypt(unwrapSmData(res.data));
  }
}

/** TLV ヘッダ(タグ 1〜2 バイト、長さ 1〜3 バイト)の長さと値の長さ */
function tlvHeader(b: Uint8Array): { headerLength: number; valueLength: number } | null {
  let i = 0;
  if (b.length < 2) return null;
  i += (b[0]! & 0x1f) === 0x1f ? 2 : 1;
  const l = b[i];
  if (l === undefined) return null;
  if (l < 0x80) return { headerLength: i + 1, valueLength: l };
  const n = l & 0x7f;
  if (n < 1 || n > 2 || b.length < i + 1 + n) return null;
  let v = 0;
  for (let k = 0; k < n; k++) v = v * 256 + b[i + 1 + k]!;
  return { headerLength: i + 1 + n, valueLength: v };
}

async function readSmTokutei(
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
