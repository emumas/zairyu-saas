/**
 * セキュアメッセージング(SM)の暗号化・復号。
 * - legacy : 2-key TDES CBC、IV=0
 * - gen2   : AES-128 CBC、IV=0
 * - tokutei: AES-128 CBC、IV=AES(KSenc, N)。N はセッション開始時 1、暗号化/復号のたびに +1
 */
import { padIso, unpadIso } from "./bytes.js";
import { aesCbcDecrypt, aesCbcEncrypt, aesEcbEncryptBlock } from "./crypto/aes.js";
import { tdesCbcDecrypt, tdesCbcEncrypt } from "./crypto/des.js";
import type { CardFormat } from "./spec.js";

export interface SecureMessaging {
  /** 平文にパディングを付けて暗号化 */
  encrypt(plain: Uint8Array): Uint8Array;
  /** 復号してパディングを除去 */
  decrypt(cipher: Uint8Array): Uint8Array;
}

export class LegacySm implements SecureMessaging {
  constructor(private readonly ksEnc: Uint8Array) {}
  encrypt(plain: Uint8Array): Uint8Array {
    return tdesCbcEncrypt(this.ksEnc, padIso(plain, 8));
  }
  decrypt(cipher: Uint8Array): Uint8Array {
    return unpadIso(tdesCbcDecrypt(this.ksEnc, cipher));
  }
}

export class Gen2Sm implements SecureMessaging {
  constructor(private readonly ksEnc: Uint8Array) {}
  encrypt(plain: Uint8Array): Uint8Array {
    return aesCbcEncrypt(this.ksEnc, padIso(plain, 16));
  }
  decrypt(cipher: Uint8Array): Uint8Array {
    return unpadIso(aesCbcDecrypt(this.ksEnc, cipher));
  }
}

/**
 * 特定在留カード。IV はメッセージカウンタ N(16 バイト big-endian)を KSenc で暗号化したもの。
 * 要実機確認: 平文データを持たないコマンド(READ BINARY)で N が進むか。現状は暗号化・復号の実行時のみ進める。
 */
export class TokuteiSm implements SecureMessaging {
  private counter = 1n;
  constructor(private readonly ksEnc: Uint8Array) {}

  private nextIv(): Uint8Array {
    const n = new Uint8Array(16);
    let c = this.counter;
    for (let i = 15; i >= 0 && c > 0n; i--) {
      n[i] = Number(c & 0xffn);
      c >>= 8n;
    }
    this.counter++;
    return aesEcbEncryptBlock(this.ksEnc, n);
  }

  encrypt(plain: Uint8Array): Uint8Array {
    return aesCbcEncrypt(this.ksEnc, padIso(plain, 16), this.nextIv());
  }
  decrypt(cipher: Uint8Array): Uint8Array {
    return unpadIso(aesCbcDecrypt(this.ksEnc, cipher, this.nextIv()));
  }
}

export function createSm(format: CardFormat, ksEnc: Uint8Array): SecureMessaging {
  switch (format) {
    case "legacy":
      return new LegacySm(ksEnc);
    case "gen2":
      return new Gen2Sm(ksEnc);
    case "tokutei":
      return new TokuteiSm(ksEnc);
  }
}
