/**
 * テスト用の在留カード IC シミュレータ。仕様書の挙動を最小限に模倣する。
 * 暗号部品は src のものを使うが、それらは specVectors.test.ts で仕様書の値と照合済み。
 */
import { constants, privateDecrypt, randomBytes, type KeyObject } from "node:crypto";
import { concatBytes, equalBytes } from "../src/bytes.js";
import { aesCbcDecrypt, aesCbcEncrypt, aesCmac8 } from "../src/crypto/aes.js";
import { retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../src/crypto/des.js";
import { deriveBasicKey, deriveSessionKey } from "../src/keyExchange.js";
import type { EfPath } from "../src/reader.js";
import { createSm, type SecureMessaging } from "../src/sm.js";
import { AID, type CardFormat } from "../src/spec.js";
import { encodeTlv, parseTlv } from "../src/tlv.js";

type Dir = "mf" | "ap" | "df1" | "df2" | "df3";

const SHORT_EF: Record<"legacy" | "gen2", Partial<Record<Dir, Record<number, string>>>> = {
  legacy: {
    mf: { 0x8b: "ef01", 0x8a: "ef02" },
    df1: { 0x85: "ef01", 0x86: "ef02" },
    df2: { 0x81: "ef01", 0x82: "ef02", 0x83: "ef03", 0x84: "ef04" },
    df3: { 0x82: "ef01" },
  },
  gen2: {
    mf: { 0x8b: "ef01", 0x8a: "ef02" },
    df1: { 0x81: "ef01", 0x83: "ef02", 0x84: "ef03", 0x86: "ef04" },
    df2: { 0x81: "ef01", 0x82: "ef02", 0x83: "ef03" },
    df3: { 0x82: "ef01" },
  },
};

const ok = (data: Uint8Array = new Uint8Array(0)) => concatBytes(data, Uint8Array.of(0x90, 0x00));
const err = (sw: number) => Uint8Array.of(sw >> 8, sw & 0xff);

export interface SimulatorOptions {
  format: CardFormat;
  cardNumber: string;
  files: Partial<Record<EfPath, Uint8Array>>;
  /** 特定在留カードの配送鍵(秘密鍵) */
  deliveryPrivateKey?: KeyObject;
  /** 特定在留カード: SM で一度に読み出せる最大長 */
  smReadLimit?: number;
  /** 端末が受けられる応答の最大長を模す(超えると 6700) */
  maxResponseLength?: number;
}

export class CardSimulator {
  private dir: Dir = "mf";
  private currentEf: string | null = null;
  private rndIcc: Uint8Array | null = null;
  private sm: SecureMessaging | null = null;
  private authenticated = false;
  readonly log: Uint8Array[] = [];

  constructor(private readonly o: SimulatorOptions) {}

  transceive = async (apdu: Uint8Array): Promise<Uint8Array> => {
    this.log.push(apdu);
    return this.handle(apdu);
  };

  private file(dir: Dir, ef: string): Uint8Array | undefined {
    const d = dir === "ap" ? "mf" : dir;
    return this.o.files[`${d}/${ef}` as EfPath];
  }

  private handle(a: Uint8Array): Uint8Array {
    const [cla, ins, p1, p2] = [a[0]!, a[1]!, a[2]!, a[3]!];
    const tokutei = this.o.format === "tokutei";

    if (cla === 0x00 && ins === 0xa4) {
      if (p1 === 0x00) {
        if (tokutei) return err(0x6a82);
        this.dir = "mf";
        return ok();
      }
      if (p1 === 0x04) {
        const aid = a.subarray(5, 5 + a[4]!);
        if (equalBytes(aid, AID.residenceAp)) {
          if (!tokutei) return err(0x6a82);
          this.dir = "ap";
          this.sm = null; // AP 選択でセッション鍵はクリア
          this.authenticated = false;
          return ok();
        }
        if (tokutei && this.dir === "mf") return err(0x6a82);
        const map: [Uint8Array, Dir][] = [[AID.df1, "df1"], [AID.df2, "df2"], [AID.df3, "df3"]];
        const hit = map.find(([x]) => equalBytes(x, aid));
        if (!hit) return err(0x6a82);
        this.dir = hit[1];
        this.currentEf = null;
        return ok();
      }
      if (p1 === 0x02 && tokutei) {
        this.currentEf = `ef0${(a[5]! << 8) | a[6]!}`;
        return this.file(this.dir, this.currentEf) ? ok() : err(0x6a82);
      }
      return err(0x6a86);
    }

    if (cla === 0x00 && ins === 0x84 && !tokutei) {
      this.rndIcc = randomBytes(8);
      return ok(this.rndIcc);
    }

    if (cla === 0x00 && ins === 0x82 && !tokutei) {
      if (!this.rndIcc) return err(0x6985);
      const fmt = this.o.format as "legacy" | "gen2";
      const enc = fmt === "legacy" ? tdesCbcEncrypt : aesCbcEncrypt;
      const dec = fmt === "legacy" ? tdesCbcDecrypt : aesCbcDecrypt;
      const mac = fmt === "legacy" ? retailMac : aesCmac8;
      const k = deriveBasicKey(this.o.cardNumber);
      const eIfd = a.subarray(5, 37);
      if (!equalBytes(mac(k, eIfd), a.subarray(37, 45))) return err(0x6300);
      const plain = dec(k, eIfd);
      if (!equalBytes(plain.subarray(8, 16), this.rndIcc)) return err(0x6300);
      const rndIfd = plain.subarray(0, 8);
      const kIfd = plain.subarray(16, 32);
      const kIcc = randomBytes(16);
      const eIcc = enc(k, concatBytes(this.rndIcc, rndIfd, kIcc));
      this.sm = createSm(fmt, deriveSessionKey(kIfd, kIcc));
      this.rndIcc = null;
      return ok(concatBytes(eIcc, mac(k, eIcc)));
    }

    if (cla === 0x80 && ins === 0xae && tokutei) {
      const len = (a[5]! << 8) | a[6]!;
      const m = privateDecrypt(
        { key: this.o.deliveryPrivateKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        a.subarray(7, 7 + len),
      );
      const [outer] = parseTlv(m, { recursive: true, skipPadding: false });
      const encKey = outer!.children!.find((c) => c.tag === 0x80)!.value.subarray(0, 16);
      this.sm = createSm("tokutei", Uint8Array.from(encKey));
      this.authenticated = false;
      return ok();
    }

    if (cla === 0x08 && ins === 0x20) {
      if (!this.sm) return err(0x6982);
      const [obj] = parseTlv(a.subarray(5), { skipPadding: false });
      const number = this.sm.decrypt(obj!.value.subarray(1));
      this.authenticated = equalBytes(number, new TextEncoder().encode(this.o.cardNumber));
      return this.authenticated ? ok() : err(0x6300);
    }

    if (ins === 0xb0) {
      const smCmd = cla === 0x08;
      let ef: string | null;
      let offset: number;
      let le: number;
      if (tokutei && smCmd) {
        ef = this.currentEf;
        offset = ((p1 & 0x7f) << 8) | p2;
        le = (a[10]! << 8) | a[11]!;
      } else if (p1 & 0x80) {
        ef = SHORT_EF[tokutei ? "gen2" : (this.o.format as "legacy" | "gen2")][this.dir === "ap" ? "mf" : this.dir]?.[p1] ?? null;
        offset = p2;
        le = smCmd ? (a[9]! << 8) | a[10]! : (a[5]! << 8) | a[6]!;
      } else {
        // カレント EF をオフセット指定で読む
        ef = this.currentEf;
        offset = (p1 << 8) | p2;
        le = smCmd ? (a[9]! << 8) | a[10]! : (a[5]! << 8) | a[6]!;
      }
      if (!ef) return err(0x6a82);
      const data = this.file(this.dir, ef);
      if (!data) return err(0x6a82);
      const isMf = this.dir === "mf" || this.dir === "ap";
      if (!isMf && !this.authenticated) return err(0x6982);
      if (this.dir === "df1" && !smCmd) return err(0x6982); // DF1 は SM 必須
      this.currentEf = ef;
      let part = data.subarray(offset, le === 0 ? data.length : offset + le);
      if (this.o.maxResponseLength && part.length > this.o.maxResponseLength) return err(0x6700);
      if (!smCmd) return ok(part);
      if (tokutei && this.o.smReadLimit) part = part.subarray(0, this.o.smReadLimit);
      const enc = this.sm!.encrypt(part);
      return ok(encodeTlv(0x86, concatBytes(Uint8Array.of(0x01), enc)));
    }

    return err(0x6d00);
  }
}
