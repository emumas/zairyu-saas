/**
 * 郵便番号データ(日本郵便 KEN_ALL)を DB に入れる(全件入れ替え)。毎月更新されるので月 1 回ほど実行する。
 *   pnpm --filter api postal:load                         # 日本郵便のサイトから取得(UTF-8 版、だめなら Shift_JIS 版)
 *   pnpm --filter api postal:load -- --file ken_all.zip   # 手元のファイル(zip / csv。UTF-8 版・Shift_JIS 版のどちらでも)
 * データに個人情報は含まれない。住所の照合はこの DB の中だけで行い、住所を外部に送らない
 */
import { readFileSync } from "node:fs";
import { createDb, replacePostalCodes } from "@zairyu/db";
import { parseKenAll } from "@zairyu/shared";
import { unzipSync } from "fflate";

/* eslint-disable no-console -- 運用スクリプトの案内 */
/** 取得先(順に試す)。日本郵便のサイトの構成が変わったら、ダウンロードページで確かめて直す */
const SOURCE_URLS = [
  // 2026 年時点の場所(Shift_JIS 版。読み仮名は使わないので大書き・小書きのどちらでもよい)
  "https://www.post.japanpost.jp/service/search/zipcode/download/oogaki/zip/ken_all.zip",
  // 以前の場所(予備)
  "https://www.post.japanpost.jp/zipcode/dl/utf/zip/utf_ken_all.zip",
  "https://www.post.japanpost.jp/zipcode/dl/kogaki/zip/ken_all.zip",
];
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
  for (const u of SOURCE_URLS) {
    console.log(`日本郵便のサイトから取得します: ${u}`);
    const res = await fetch(u).catch(() => null);
    if (res?.ok) return new Uint8Array(await res.arrayBuffer());
    console.log(`  取得できませんでした(${res ? `HTTP ${res.status}` : "接続できません"})`);
  }
  console.error(
    "自動で取得できませんでした。ブラウザで日本郵便の「郵便番号データダウンロード」ページから「全国一括」の zip を保存し、\n" +
      "  pnpm postal:load -- --file <保存した zip のパス>\nで入れてください(UTF-8 版・Shift_JIS 版のどちらでも可)",
  );
  process.exit(1);
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
/** UTF-8 として読めなければ Shift_JIS(従来の ken_all.csv)として読む */
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}
const rows = parseKenAll(decode(csv));
if (rows.length < 100_000) {
  // 取り違えたファイルで全件を消さないための確認
  console.error(`行数が少なすぎます(${rows.length} 行)。「全国一括」のファイルを指定してください`);
  process.exit(1);
}
const { db, pool } = createDb(url, { max: 1 });
try {
  const n = await replacePostalCodes(db, rows);
  console.log(`郵便番号データを入れ替えました(${n} 行)`);
} finally {
  await pool.end();
}
