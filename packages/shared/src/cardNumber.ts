/**
 * 在留カード番号: 英字2文字 + 数字8桁 + 英字2文字(例: AB12345678CD)
 *
 * 仕様上の公開チェックディジットはないため、形式チェックと
 * OCR でよくある誤読(0/O, 1/I 等)の位置別補正のみを行う。
 */
export const CARD_NUMBER_PATTERN = /^[A-Z]{2}[0-9]{8}[A-Z]{2}$/;

export function isValidCardNumber(value: string): boolean {
  return CARD_NUMBER_PATTERN.test(value);
}

/** 入力の揺れ(全角・小文字・空白・ハイフン)を吸収して正規化する。形式は検証しない */
export function normalizeCardNumberInput(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\-‐−]/g, "");
}

const DIGIT_TO_LETTER: Readonly<Record<string, string>> = {
  "0": "O",
  "1": "I",
  "2": "Z",
  "5": "S",
  "6": "G",
  "8": "B",
};

const LETTER_TO_DIGIT: Readonly<Record<string, string>> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  B: "8",
};

function fixAt(candidate: string): string | null {
  let out = "";
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]!;
    const wantDigit = i >= 2 && i < 10;
    if (wantDigit) {
      if (/[0-9]/.test(ch)) out += ch;
      else if (LETTER_TO_DIGIT[ch]) out += LETTER_TO_DIGIT[ch];
      else return null;
    } else {
      if (/[A-Z]/.test(ch)) out += ch;
      else if (DIGIT_TO_LETTER[ch]) out += DIGIT_TO_LETTER[ch];
      else return null;
    }
  }
  return isValidCardNumber(out) ? out : null;
}

/**
 * OCR の全文テキストから在留カード番号の候補を抽出する。
 * 12文字の英数字の並びを走査し、位置別に誤読を補正して形式に合うものだけ返す。
 * 補正なしで一致したものを先に並べる(重複は除く)。
 */
export function extractCardNumberCandidates(ocrText: string): string[] {
  // 行ごとに処理し、行内の空白・ハイフン(OCR で分割されがち)は詰める
  const tokens = ocrText
    .split(/\r?\n/)
    .flatMap((line) => normalizeCardNumberInput(line).split(/[^A-Z0-9]+/))
    .filter((t) => t.length >= 12);
  const exact: string[] = [];
  const corrected: string[] = [];
  for (const token of tokens) {
    for (let start = 0; start + 12 <= token.length; start++) {
      const window = token.slice(start, start + 12);
      if (isValidCardNumber(window)) {
        exact.push(window);
        continue;
      }
      const fixed = fixAt(window);
      if (fixed) corrected.push(fixed);
    }
  }
  return [...new Set([...exact, ...corrected])];
}
