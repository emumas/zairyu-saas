/**
 * テスト専用: 仕様書のファイル構成どおりの EF を組み立てる(中身はダミー)。本番コードから使わないこと。
 * apps/api の結合テストからも使うため、パッケージの "./testing" として公開している
 */
import { constants, createHash, createPrivateKey, privateEncrypt, sign, X509Certificate, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes, padNulls } from "./bytes.js";
import { parseCardRead } from "./parse.js";
import type { EfPath } from "./reader.js";
import type { CardFormat, CardKind } from "./spec.js";
import { encodeTlv } from "./tlv.js";

const ascii = (s: string) => new TextEncoder().encode(s);
const fill = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

export interface FixtureOptions {
  format: CardFormat;
  kind: CardKind;
  cardNumber: string;
  /** 署名鍵と証明書。省略すると署名なし(年少者カード相当) */
  signer?: { key: KeyObject; certDer: Uint8Array };
  /** 第2世代・特定: 券面記載事項の上書き(YYYYMMDD など IC の生の値) */
  items?: Partial<Record<"C5" | "C6" | "C9" | "CC" | "CD", string>>;
  /** 更新申請中(第2世代・特定は D8、旧様式は D7) */
  renewalApplying?: boolean;
}

export function buildCardFiles(o: FixtureOptions): Partial<Record<EfPath, Uint8Array>> {
  const files: Partial<Record<EfPath, Uint8Array>> = {};
  files["mf/ef01"] = encodeTlv(0xc0, ascii("0001"));
  const cardType = { legacy: { residence: "1", special_permanent: "2" }, gen2: { residence: "05", special_permanent: "06" }, tokutei: { residence: "07", special_permanent: "08" } }[o.format][o.kind];
  files["mf/ef02"] = encodeTlv(0xc1, ascii(cardType));

  if (o.format === "legacy") {
    // 実カードの形: TLV の長さは実データ長、EF の残り(7004 / 3004 バイトまで)は 0x00
    files["df1/ef01"] = padNulls(encodeTlv(0xd0, fill(5000, 1)), 7004);
    files["df1/ef02"] = padNulls(encodeTlv(0xd1, fill(2800, 2)), 3004);
    files["df2/ef01"] = concatBytes(
      encodeTlv(0xd2, ascii("20240310")),
      encodeTlv(0xd3, ascii("131016")),
      encodeTlv(0xd4, padNulls(ascii("東京都千代田区霞が関1-1-1"), 320)),
    );
    if (o.kind === "residence") {
      files["df2/ef02"] = encodeTlv(0xd5, padNulls(ascii("許可:原則週28時間以内"), 120));
      files["df2/ef03"] = new Uint8Array(122); // 「無」に書き換えた場合はすべて 0x00
      files["df2/ef04"] = encodeTlv(0xd7, ascii(o.renewalApplying === false ? "0" : "1"));
    }
  } else {
    files["df1/ef01"] = encodeTlv(0xc2, ascii(o.cardNumber));
    const residence = o.kind === "residence";
    files["df1/ef02"] = concatBytes(
      encodeTlv(0xc5, ascii(o.items?.C5 ?? "20310331")),
      encodeTlv(0xc6, ascii(o.items?.C6 ?? "19950401")),
      encodeTlv(0xc7, ascii("2")),
      encodeTlv(0xc8, ascii("VNM")),
      encodeTlv(0xc9, padNulls(ascii(o.items?.C9 ?? "15"), 10)),
      encodeTlv(0xce, ascii("0300")),
      ...(residence
        ? [encodeTlv(0xca, ascii("01")), encodeTlv(0xcb, ascii("20260620")), encodeTlv(0xcc, ascii(o.items?.CC ?? "2")), encodeTlv(0xcd, ascii(o.items?.CD ?? "20290620"))]
        : []),
    );
    files["df1/ef03"] = concatBytes(encodeTlv(0xd0, padNulls(fill(2000, 3), 2500)), encodeTlv(0xd1, padNulls(fill(2900, 4), 3000)));
    files["df1/ef04"] = encodeTlv(0xdfd1, padNulls(fill(1800, 5), 2500));
    if (residence) {
      files["df2/ef01"] = concatBytes(encodeTlv(0xd5, padNulls(ascii("1"), 7)), encodeTlv(0xd6, ascii("20290620")), encodeTlv(0xd7, ascii("0")));
      files["df2/ef02"] = encodeTlv(0xd8, ascii(o.renewalApplying === false ? "0" : "1"));
    }
    files["df2/ef03"] = concatBytes(encodeTlv(0xd9, ascii("0")), encodeTlv(0xde, new Uint8Array(200)));
  }

  // 署名(DF3/EF01)
  const ecdsa = o.format !== "legacy";
  if (!o.signer) {
    files["df3/ef01"] = ecdsa ? concatBytes(Uint8Array.of(0xdc, 0x00, 0xdd, 0x00), new Uint8Array(700)) : concatBytes(Uint8Array.of(0xda, 0x00), new Uint8Array(1462));
    return files;
  }
  const parsed = parseCardRead({ format: o.format, kind: o.kind, files: { ...files, "df3/ef01": dummySig(ecdsa) } });
  const signedData = parsed.signature!.signedData;
  const checkCode = ecdsa
    ? sign("sha256", signedData, { key: o.signer.key, dsaEncoding: "ieee-p1363" })
    : rsaRawSign(o.signer.key, signedData);
  files["df3/ef01"] = ecdsa
    ? concatBytes(encodeTlv(0xdc, checkCode), encodeTlv(0xdd, o.signer.certDer), new Uint8Array(4))
    : concatBytes(encodeTlv(0xda, checkCode), encodeTlv(0xdb, padNulls(o.signer.certDer, 1200)));
  return files;
}

function dummySig(ecdsa: boolean): Uint8Array {
  return ecdsa ? concatBytes(encodeTlv(0xdc, new Uint8Array(96)), encodeTlv(0xdd, new Uint8Array(1))) : concatBytes(encodeTlv(0xda, new Uint8Array(256)), encodeTlv(0xdb, new Uint8Array(1)));
}

/** 仕様書 Ver1.5 図3-4 の形式: PKCS#1 v1.5 パディング + 生の SHA-256(DigestInfo なし) */
export function rsaRawSign(key: KeyObject, data: Uint8Array): Buffer {
  return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, createHash("sha256").update(data).digest());
}

/** テスト用に鍵と自己署名証明書(DER)を openssl で生成する */
export function makeCertAndKey(type: "rsa" | "ec"): { key: KeyObject; certDer: Buffer; cert: X509Certificate } {
  const dir = mkdtempSync(join(tmpdir(), "zairyu-ic-test-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.der");
    const newkey = type === "rsa" ? ["-newkey", "rsa:2048"] : ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1"];
    execFileSync(
      "openssl",
      ["req", "-x509", ...newkey, "-nodes", "-keyout", keyPath, "-subj", "/CN=TEST ONLY", "-days", "3650", "-outform", "DER", "-out", certPath],
      { stdio: "ignore" },
    );
    const certDer = readFileSync(certPath);
    return { key: createPrivateKey(readFileSync(keyPath)), certDer, cert: new X509Certificate(certDer) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
