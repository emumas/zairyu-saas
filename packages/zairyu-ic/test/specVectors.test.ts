/**
 * 仕様書の「別添2 読出しシーケンス コマンド例」に載っている値で検証する。
 * カード番号 "AA12345678BB"、RND.IFD / K.IFD は仕様書の例示値。
 */
import { constants, createCipheriv, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { concatBytes, hex, padIso, toHex } from "../src/bytes.js";
import { aesCbcEncrypt, aesEcbEncryptBlock } from "../src/crypto/aes.js";
import { retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../src/crypto/des.js";
import { rsaOaepSha256Encrypt } from "../src/crypto/rsaOaep.js";
import { buildMutualAuthData, buildSetSessionKeyData, completeMutualAuth, deriveBasicKey } from "../src/keyExchange.js";
import { createSm } from "../src/sm.js";

const CARD_NUMBER = "AA12345678BB";
const RND_IFD = hex("11 22 33 44 55 66 77 88");
const K_IFD = hex("40 41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F");

it("Kenc = Kmac = SHA-1(番号) の先頭16バイト", () => {
  expect(toHex(deriveBasicKey(CARD_NUMBER))).toBe("6522B4E171195BB218223A976C040111");
});

describe("旧様式(在留カード等仕様書 Ver1.5 別添2)", () => {
  const input = { format: "legacy" as const, cardNumber: CARD_NUMBER, rndIcc: hex("5A 6E 7E 38 51 62 B7 A3"), rndIfd: RND_IFD, kIfd: K_IFD };
  const response = hex(
    "58 60 77 5B 4D 03 2C C5 64 BA 20 4B 8E A8 68 F6 94 A7 4E 74 75 A8 FE F2 40 58 8B DA 1A F4 96 CE 59 38 8F D6 CD 45 24 8B",
  );

  it("E_IFD||M_IFD", () => {
    expect(toHex(buildMutualAuthData(input))).toBe(
      "937745C20883A1BAD1E04193722A1592378F81A8F1DC589157AEB0F7544FA1BA" + "1AD7FB6A3389E017",
    );
  });

  it("E_ICC||M_ICC を検証して KSenc を得る", () => {
    expect(toHex(completeMutualAuth(input, response))).toBe("CE94938E19E3B97DF96EABCEDC1715CC");
  });

  it("M_ICC が壊れていれば失敗", () => {
    const broken = Uint8Array.from(response);
    broken[39]! ^= 1;
    expect(() => completeMutualAuth(input, broken)).toThrow(/MAC/);
  });

  it("在留カード等番号を SM で暗号化(VERIFY)", () => {
    const sm = createSm("legacy", hex("CE94938E19E3B97DF96EABCEDC1715CC"));
    expect(toHex(sm.encrypt(new TextEncoder().encode(CARD_NUMBER)))).toBe("1AA82973DB959A811F9711D728F0EEF6");
  });

  it("TDES をランダムな鍵・データで Node(OpenSSL)と突き合わせる", () => {
    for (let i = 0; i < 50; i++) {
      const key = new Uint8Array(randomBytes(16));
      const data = new Uint8Array(randomBytes(8 * (1 + (i % 9))));
      const c = createCipheriv("des-ede-cbc", key, Buffer.alloc(8));
      c.setAutoPadding(false);
      const expected = Buffer.concat([c.update(data), c.final()]);
      expect(toHex(tdesCbcEncrypt(key, data))).toBe(toHex(expected));
      expect(toHex(tdesCbcDecrypt(key, expected))).toBe(toHex(data));
    }
  });

  it("TDES / Retail MAC を Node(OpenSSL)と突き合わせる", () => {
    const key = hex("0123456789ABCDEFFEDCBA9876543210");
    const data = hex("00112233445566778899AABBCCDDEEFF0011223344556677");
    const c = createCipheriv("des-ede-cbc", key, Buffer.alloc(8));
    c.setAutoPadding(false);
    const expected = Buffer.concat([c.update(data), c.final()]);
    expect(toHex(tdesCbcEncrypt(key, data))).toBe(toHex(expected));
    expect(toHex(tdesCbcDecrypt(key, expected))).toBe(toHex(data));
    // Retail MAC = 単DES CBC-MAC の最終段のみ 3DES。全ブロック 1 ブロックなら 3DES(K1,K2,K1) と一致する
    const one = hex("0011223344556677");
    const e = createCipheriv("des-ede-ecb", key, null);
    e.setAutoPadding(false);
    const mac1 = retailMac(key, one.subarray(0, 7)); // 7 バイト + 80 → 1 ブロック
    const block = padIso(one.subarray(0, 7), 8);
    expect(toHex(mac1)).toBe(toHex(Buffer.concat([e.update(block), e.final()])));
  });
});

describe("第2世代(第２世代在留カード等仕様書 Ver1.1 別添2)", () => {
  const input = { format: "gen2" as const, cardNumber: CARD_NUMBER, rndIcc: hex("92 1C E2 77 32 3D A0 57"), rndIfd: RND_IFD, kIfd: K_IFD };
  const response = hex(
    "28 9A 96 B1 DA 6A E3 DA 87 77 04 19 BF D1 4F 0B DA D1 5F 36 43 2B 5A 94 6C 18 8C 72 21 75 9A 62 FA 94 2E C5 1E 62 FF 5F",
  );

  it("E_IFD||M_IFD", () => {
    expect(toHex(buildMutualAuthData(input))).toBe(
      "4AD3C7B6BB484A52771977DED618B41DF841FA0476A05FBE041DEAD6109E773B" + "AC854617634F5397",
    );
  });

  it("KSenc", () => {
    expect(toHex(completeMutualAuth(input, response))).toBe("C19CF13D3D7FBEE9EA293D834C88952F");
  });

  it("在留カード等番号を SM で暗号化(VERIFY)", () => {
    const sm = createSm("gen2", hex("C19CF13D3D7FBEE9EA293D834C88952F"));
    expect(toHex(sm.encrypt(new TextEncoder().encode(CARD_NUMBER)))).toBe("EE0B31EF877F68D071C56D58C72E6748");
  });
});

describe("特定在留カード(特定在留カード等仕様書 Ver1.1 別添2)", () => {
  const kEnc = hex("6522B4E171195BB218223A976C040111");

  it("1回目の IV = AES(Kenc, 00..01)", () => {
    expect(toHex(aesEcbEncryptBlock(kEnc, hex("00000000000000000000000000000001")))).toBe(
      "BCD5DA6579AD607FF937A32B925788D9",
    );
  });

  it("在留カード等番号を SM で暗号化(VERIFY、N=1)", () => {
    const sm = createSm("tokutei", kEnc);
    expect(toHex(sm.encrypt(new TextEncoder().encode(CARD_NUMBER)))).toBe("0622C6B1A403D2FFA773E226F339C06C");
  });

  it("N が進むと IV が変わる", () => {
    const sm = createSm("tokutei", kEnc);
    const first = sm.encrypt(new TextEncoder().encode(CARD_NUMBER));
    const second = sm.encrypt(new TextEncoder().encode(CARD_NUMBER));
    expect(toHex(second)).not.toBe(toHex(first));
    const iv2 = aesEcbEncryptBlock(kEnc, hex("00000000000000000000000000000002"));
    expect(toHex(second)).toBe(toHex(aesCbcEncrypt(kEnc, padIso(new TextEncoder().encode(CARD_NUMBER), 16), iv2)));
  });

  it("SET SESSION KEY: RSA-OAEP(SHA-256) を Node で復号できる", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const deliveryKey = { modulus: Buffer.from(jwk.n!, "base64url"), exponent: Buffer.from(jwk.e!, "base64url") };
    const seed1 = new Uint8Array(16).fill(0x5a);
    const data = buildSetSessionKeyData({ deliveryKey, kEnc, kMac: kEnc, seed1, oaepSeed: new Uint8Array(32).fill(7) });
    expect(data.length).toBe(256);
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, data);
    expect(toHex(plain)).toBe(
      toHex(concatBytes(hex("A044 8020"), kEnc, seed1, hex("8120"), kEnc, seed1)),
    );
    // 仕様書記載の lHASH(空文字列の SHA-256)と DB 長 223 バイトの前提
    expect(() => rsaOaepSha256Encrypt(deliveryKey, new Uint8Array(191), new Uint8Array(32))).toThrow();
  });
});
