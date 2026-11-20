/**
 * 読み出した EF の中身を解釈する(端末・サーバー共通)。
 * 署名対象データの組み立てもここで行う(検証自体はサーバーの verify.ts)。
 */
import { ascii, concatBytes, padNulls, trimTrailingNulls } from "./bytes.js";
import type { RawCardRead } from "./reader.js";
import {
  FACE_LEN,
  GEN2_FACE_ITEMS,
  GEN2_FACE_ITEMS_SIGNED_LEN,
  GEN2_NAME_IMAGE_LEN,
  LEGACY_FRONT_IMAGE_LEN,
  TAG,
  type CardFormat,
  type CardKind,
} from "./spec.js";
import { parseTlv, type Tlv } from "./tlv.js";

export class CardParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardParseError";
  }
}

/** YYYYMMDD → YYYY-MM-DD。空なら null */
function date(v: Uint8Array | undefined): string | null {
  const s = v ? ascii(v) : "";
  if (s === "") return null;
  if (!/^\d{8}$/.test(s)) throw new CardParseError("日付の形式が不正です");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

const utf8 = (v: Uint8Array | undefined): string | null => {
  const t = v ? trimTrailingNulls(v) : new Uint8Array(0);
  return t.length === 0 ? null : new TextDecoder("utf-8", { fatal: true }).decode(t);
};
const text = (v: Uint8Array | undefined): string | null => (v ? ascii(v) || null : null);

function tlvMap(data: Uint8Array | undefined): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  if (!data) return m;
  for (const t of parseTlv(data) as Tlv[]) if (!m.has(t.tag)) m.set(t.tag, t.value);
  return m;
}

export type WorkRestrictionCode = "1" | "2" | "4" | "9";

export interface Gen2FaceItems {
  /** 有効期限満了日(カード自体の有効期限) */
  cardValidUntil: string | null;
  birthDate: string | null;
  /** 1:男 2:女 3:不詳 */
  sex: string | null;
  /** 国籍・地域コード */
  nationality: string | null;
  /** 在留資格コード */
  statusOfResidence: string | null;
  /** 在留期間(YYMM / DDD / 無期限は 0000) */
  periodOfStay: string | null;
  /** 許可の種類コード(在留カードのみ) */
  permissionType: string | null;
  permittedAt: string | null;
  /** 就労制限の有無 1:なし 2:在留資格に基づく就労のみ 4:指定書による就労のみ 9:就労不可 */
  workRestriction: string | null;
  /** 在留期間の満了日(在留カードのみ) */
  stayExpiry: string | null;
}

export interface SignatureParts {
  algorithm: "rsa-pkcs1v15-sha256" | "ecdsa-p384-sha256";
  checkCode: Uint8Array;
  certificate: Uint8Array;
  /** 署名対象データ(仕様書の解釈どおりに連結したもの) */
  signedData: Uint8Array;
  /**
   * 仕様書の記述があいまいな箇所の別解釈(PoC で実カードと照合するため)。
   * signedData で一致しなかった場合に順に試し、一致した label を検証結果に返す
   */
  alternatives?: { label: string; data: Uint8Array }[];
}

export interface ParsedCard {
  format: CardFormat;
  kind: CardKind;
  /** IC に記録された在留カード等番号(第2世代・特定のみ。旧様式は IC に番号のテキストなし) */
  cardNumber: string | null;
  /** 券面記載事項(第2世代・特定のみ。旧様式は券面イメージのみで項目のテキストなし) */
  faceItems: Gen2FaceItems | null;
  images: {
    /** 旧様式: 券面(表)イメージ(MMR 圧縮 TIFF) */
    front: Uint8Array | null;
    /** 顔画像(JPEG2000)。1 歳/16 歳未満は無い */
    face: Uint8Array | null;
    /** 第2世代・特定: 氏名イメージ(MMR 圧縮 TIFF) */
    name: Uint8Array | null;
    /** 第2世代・特定: 住居地イメージ(MMR 圧縮 TIFF) */
    address: Uint8Array | null;
  };
  back: LegacyBack | Gen2Back;
  /** 署名がない(年少者のカード)場合は null */
  signature: SignatureParts | null;
}

export interface LegacyBack {
  format: "legacy";
  addressWrittenAt: string | null;
  municipalityCode: string | null;
  address: string | null;
  /** 資格外活動 包括許可欄の記載内容(テキスト) */
  outsideActivityComprehensive: string | null;
  /** 資格外活動 個別許可欄の記載内容(テキスト) */
  outsideActivityIndividual: string | null;
  /** 在留期間更新等許可申請中 */
  renewalApplying: boolean | null;
}

export interface Gen2Back {
  format: "gen2";
  /** 包括許可 0:無し 1:許可(週28時間以内・風俗営業不可) 2:許可(週28時間以内・教育等の活動) */
  outsideActivityComprehensive: string | null;
  outsideActivityComprehensiveUntil: string | null;
  /** 個別許可の有無 */
  outsideActivityIndividual: boolean | null;
  renewalApplying: boolean | null;
  /** 出入国在留管理庁長官が記録した旨 */
  recordedByCommissioner: boolean | null;
  reserved: string | null;
}

const flag = (v: Uint8Array | undefined): boolean | null => {
  const s = text(v);
  return s === null ? null : s === "1";
};

const nonEmpty = (v: Uint8Array | undefined): Uint8Array | null => (v && v.length > 0 ? v : null);

export function parseCardRead(raw: Pick<RawCardRead, "format" | "kind" | "files">): ParsedCard {
  const f = raw.files;
  if (raw.format === "legacy") {
    const df1a = tlvMap(f["df1/ef01"]);
    const df1b = tlvMap(f["df1/ef02"]);
    const addr = tlvMap(f["df2/ef01"]);
    const sig = tlvMap(f["df3/ef01"]);
    const front = nonEmpty(df1a.get(TAG.frontImage));
    const face = nonEmpty(df1b.get(TAG.face));
    const checkCode = nonEmpty(sig.get(TAG.rsaCheckCode));
    const certificate = nonEmpty(sig.get(TAG.rsaCertificate));
    return {
      format: raw.format,
      kind: raw.kind,
      cardNumber: null,
      faceItems: null,
      images: { front, face, name: null, address: null },
      back: {
        format: "legacy",
        addressWrittenAt: date(addr.get(TAG.legacyAddressDate)),
        municipalityCode: text(addr.get(TAG.legacyMunicipality)),
        address: utf8(addr.get(TAG.legacyAddress)),
        outsideActivityComprehensive: utf8(tlvMap(f["df2/ef02"]).get(TAG.legacyOutsideComprehensive)),
        outsideActivityIndividual: utf8(tlvMap(f["df2/ef03"]).get(TAG.legacyOutsideIndividual)),
        renewalApplying: flag(tlvMap(f["df2/ef04"]).get(TAG.legacyRenewalStatus)),
      },
      signature:
        checkCode && certificate && front && face
          ? {
              algorithm: "rsa-pkcs1v15-sha256",
              checkCode,
              certificate,
              // 実カードで確認済み(2026-11-20): TLV の長さは実データ長で、値を最大長まで 0x00 で埋めて連結したものが署名対象
              signedData: concatBytes(padNulls(front, LEGACY_FRONT_IMAGE_LEN), padNulls(face, FACE_LEN)),
            }
          : null,
    };
  }

  // 第2世代・特定在留カード(データ構造は同じ)
  const num = tlvMap(f["df1/ef01"]);
  const items = tlvMap(f["df1/ef02"]);
  const nameFace = tlvMap(f["df1/ef03"]);
  const addrImg = tlvMap(f["df1/ef04"]);
  const df2a = tlvMap(f["df2/ef01"]);
  const df2b = tlvMap(f["df2/ef02"]);
  const df2c = tlvMap(f["df2/ef03"]);
  const sig = tlvMap(f["df3/ef01"]);

  const faceItems = Object.fromEntries(
    GEN2_FACE_ITEMS.map((it) => {
      const v = items.get(it.tag);
      const isDate = it.key === "cardValidUntil" || it.key === "birthDate" || it.key === "permittedAt" || it.key === "stayExpiry";
      return [it.key, isDate ? date(v) : text(v)];
    }),
  ) as unknown as Gen2FaceItems;

  // 署名対象: 券面記載事項(記載順に連結、各項目を最大長まで 0x00 埋め、全体を 53 バイトに)||顔画像||氏名イメージ
  const itemBytes = concatBytes(
    ...GEN2_FACE_ITEMS.filter((it) => raw.kind === "residence" || !it.residenceOnly).map((it) =>
      padNulls(items.get(it.tag) ?? new Uint8Array(0), it.len),
    ),
  );
  const name = nonEmpty(nameFace.get(TAG.frontImage));
  const face = nonEmpty(nameFace.get(TAG.face));
  const checkCode = nonEmpty(sig.get(TAG.ecdsaCheckCode));
  const certificate = nonEmpty(sig.get(TAG.ecdsaCertificate));

  return {
    format: raw.format,
    kind: raw.kind,
    cardNumber: text(num.get(TAG.cardNumber)),
    faceItems,
    images: { front: null, face, name, address: nonEmpty(addrImg.get(TAG.addressImage)) },
    back: {
      format: "gen2",
      outsideActivityComprehensive: text(df2a.get(TAG.outsideComprehensive)),
      outsideActivityComprehensiveUntil: date(df2a.get(TAG.outsideComprehensiveUntil)),
      outsideActivityIndividual: flag(df2a.get(TAG.outsideIndividual)),
      renewalApplying: flag(df2b.get(TAG.renewalStatus)),
      recordedByCommissioner: flag(df2c.get(TAG.recordedByCommissioner)),
      reserved: utf8(df2c.get(TAG.reserved)),
    },
    signature:
      checkCode && certificate && face && name
        ? {
            algorithm: "ecdsa-p384-sha256",
            checkCode,
            certificate,
            signedData: concatBytes(
              padNulls(itemBytes, GEN2_FACE_ITEMS_SIGNED_LEN),
              padNulls(face, FACE_LEN),
              padNulls(name, GEN2_NAME_IMAGE_LEN),
            ),
            alternatives: [
              {
                label: "exact",
                data: concatBytes(
                  ...GEN2_FACE_ITEMS.map((it) => items.get(it.tag) ?? new Uint8Array(0)),
                  face,
                  name,
                ),
              },
              { label: "file-order", data: concatBytes(f["df1/ef02"] ?? new Uint8Array(0), f["df1/ef03"] ?? new Uint8Array(0)) },
            ],
          }
        : null,
  };
}

/**
 * 診断用: 各 EF の TLV 構造(タグと長さ、末尾の 0x00 埋めの長さ)を返す。値は含めない
 */
export function describeFiles(files: RawCardRead["files"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, data] of Object.entries(files)) {
    if (!data) continue;
    let desc: string;
    try {
      const tlvs = parseTlv(data);
      desc = tlvs.map((t) => `${t.tag.toString(16).toUpperCase()}:${t.value.length}`).join(" ");
      const last = tlvs.at(-1);
      const trailing = last ? data.length - last.end : data.length;
      if (trailing > 0) desc += ` +${trailing}`;
    } catch {
      desc = "TLV 解析不可";
    }
    out[path] = `${data.length}B ${desc}`;
  }
  return out;
}
