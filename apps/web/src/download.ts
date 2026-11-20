/** 文字列をファイルとして保存させる(サーバーを経由しない。URL はすぐ破棄する) */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  // 文書に入れないと、ブラウザによってはファイル名が使われない
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV ファイルを文字列にする。UTF-8 として読めなければ Shift_JIS(Excel の既定)として読む */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}
