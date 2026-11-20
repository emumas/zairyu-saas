/**
 * 郵便番号データ(日本郵便 KEN_ALL、UTF-8 版)を DB に入れる(全件入れ替え)。毎月更新されるので月 1 回ほど実行する。
 *   pnpm --filter api postal:load                       # 日本郵便のサイトから取得
 *   pnpm --filter api postal:load -- --file utf_ken_all.zip   # 手元のファイル(zip または csv)
 * データに個人情報は含まれない。住所の照合はこの DB の中だけで行い、住所を外部に送らない
 */
import { readFileSync } from "node:fs";
import { createDb, replacePostalCodes } from "@zairyu/db";
import { parseKenAll } from "@zairyu/shared";
import { unzipSync } from "fflate";

/* eslint-disable no-console -- 運用スクリプトの案内 */
const SOURCE_URL = "https://www.post.japanpost.jp/zipcode/dl/utf/zip/utf_ken_all.zip";
const args = process.argv.slice(2);
const i = args.indexOf("--file");
const file = i >= 0 ? args[i + 1] : undefined;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL(apps/api/.env)を設定してください");
  process.exit(1);
}

async function readSource(): Promise<Uint8Array> {
  if (file) return readFileSync(file);
  console.log(`日本郵便のサイトから取得します: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`取得できませんでした(HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const data = await readSource();
// zip なら中の CSV を取り出す
const isZip = data[0] === 0x50 && data[1] === 0x4b;
const csv = isZip
  ? Object.entries(unzipSync(data)).find(([name]) => name.toLowerCase().endsWith(".csv"))?.[1]
  : data;
if (!csv) {
  console.error("zip の中に CSV がありません");
  process.exit(1);
}
const rows = parseKenAll(new TextDecoder("utf-8").decode(csv));
if (rows.length < 100_000) {
  // 取り違えたファイル(Shift_JIS 版など)で全件を消さないための確認
  console.error(`行数が少なすぎます(${rows.length} 行)。UTF-8 版の utf_ken_all を指定してください`);
  process.exit(1);
}
const { db, pool } = createDb(url, { max: 1 });
try {
  const n = await replacePostalCodes(db, rows);
  console.log(`郵便番号データを入れ替えました(${n} 行)`);
} finally {
  await pool.end();
}
