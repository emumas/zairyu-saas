import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CardNumberMismatchError, CardReadError, readResidenceCard } from "../src/reader.js";
import { parseCardRead } from "../src/parse.js";
import type { CardFormat, CardKind } from "../src/spec.js";
import { verifyCardSignature } from "../src/verify.js";
import { CardSimulator } from "./cardSimulator.js";
import { buildCardFiles } from "./fixtures.js";
import { makeCertAndKey } from "./helpers.js";

const CARD_NUMBER = "AB12345678CD";
const rsa = makeCertAndKey("rsa");
const ec = makeCertAndKey("ec");
const delivery = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = delivery.publicKey.export({ format: "jwk" });
const tokuteiDeliveryKey = { modulus: Buffer.from(jwk.n!, "base64url"), exponent: Buffer.from(jwk.e!, "base64url") };
const rnd = (n: number) => new Uint8Array(randomBytes(n));

function setup(
  format: CardFormat,
  kind: CardKind,
  opts: { signed?: boolean; smReadLimit?: number; maxResponseLength?: number } = {},
) {
  const signer = opts.signed === false ? undefined : format === "legacy" ? rsa : ec;
  const files = buildCardFiles({ format, kind, cardNumber: CARD_NUMBER, ...(signer ? { signer } : {}) });
  return new CardSimulator({
    format,
    cardNumber: CARD_NUMBER,
    files,
    deliveryPrivateKey: delivery.privateKey,
    ...(opts.smReadLimit ? { smReadLimit: opts.smReadLimit } : {}),
    ...(opts.maxResponseLength ? { maxResponseLength: opts.maxResponseLength } : {}),
  });
}

const cases: [CardFormat, CardKind][] = [
  ["legacy", "residence"],
  ["legacy", "special_permanent"],
  ["gen2", "residence"],
  ["gen2", "special_permanent"],
  ["tokutei", "residence"],
  ["tokutei", "special_permanent"],
];

describe.each(cases)("%s / %s", (format, kind) => {
  it("読み出し → 解釈 → 署名検証まで通る", async () => {
    const card = setup(format, kind, { smReadLimit: 0x100 });
    const raw = await readResidenceCard(card.transceive, {
      cardNumber: CARD_NUMBER,
      randomBytes: rnd,
      tokuteiDeliveryKey,
      tokuteiChunkSize: 0x100,
    });
    expect(raw.format).toBe(format);
    expect(raw.kind).toBe(kind);

    const parsed = parseCardRead(raw);
    expect(parsed.images.face?.length).toBe(3000);
    if (format === "legacy") {
      expect(parsed.cardNumber).toBeNull();
      expect(parsed.images.front?.length).toBe(7000);
      expect(parsed.back).toMatchObject({ format: "legacy", municipalityCode: "131016", address: "東京都千代田区霞が関1-1-1" });
      if (kind === "residence") {
        expect(parsed.back).toMatchObject({ renewalApplying: true, outsideActivityComprehensive: "許可:原則週28時間以内", outsideActivityIndividual: null });
      }
    } else {
      expect(parsed.cardNumber).toBe(CARD_NUMBER);
      expect(parsed.faceItems).toMatchObject({ cardValidUntil: "2031-03-31", birthDate: "1995-04-01", nationality: "VNM", statusOfResidence: "15" });
      if (kind === "residence") {
        expect(parsed.faceItems).toMatchObject({ workRestriction: "2", stayExpiry: "2029-06-20", permittedAt: "2026-06-20" });
        expect(parsed.back).toMatchObject({ outsideActivityComprehensive: "1", outsideActivityComprehensiveUntil: "2029-06-20", renewalApplying: true });
      } else {
        expect(parsed.faceItems).toMatchObject({ workRestriction: null, stayExpiry: null });
        expect(parsed.signature!.signedData.length).toBe(53 + 3000 + 2500);
      }
    }
    expect(verifyCardSignature(parsed.signature)).toMatchObject({ status: "valid" });
  });

  it("応答長に制限がある端末では maxReadLength で分割して読める", async () => {
    const card = setup(format, kind, { maxResponseLength: 0x200 });
    const opts = { cardNumber: CARD_NUMBER, randomBytes: rnd, tokuteiDeliveryKey };
    await expect(readResidenceCard(card.transceive, opts)).rejects.toMatchObject({ sw: 0x6700 });
    const card2 = setup(format, kind, { maxResponseLength: 0x200 });
    const raw = await readResidenceCard(card2.transceive, { ...opts, maxReadLength: 0x1e0 });
    expect(verifyCardSignature(parseCardRead(raw).signature)).toMatchObject({ status: "valid" });
  });

  it("番号が違えば認証できない", async () => {
    const card = setup(format, kind);
    await expect(
      readResidenceCard(card.transceive, { cardNumber: "ZZ99999999ZZ", randomBytes: rnd, tokuteiDeliveryKey }),
    ).rejects.toBeInstanceOf(CardReadError);
  });

  it("署名が記録されていないカードは absent", async () => {
    const card = setup(format, kind, { signed: false });
    const raw = await readResidenceCard(card.transceive, { cardNumber: CARD_NUMBER, randomBytes: rnd, tokuteiDeliveryKey });
    expect(verifyCardSignature(parseCardRead(raw).signature)).toEqual({ status: "absent" });
  });
});

describe("例外系", () => {
  it("旧様式・第2世代で番号違いは VERIFY 前の相互認証で失敗する", async () => {
    // Kenc/Kmac が番号から導出されるため、MUTUAL AUTHENTICATE がエラーになる
    const card = setup("gen2", "residence");
    await expect(
      readResidenceCard(card.transceive, { cardNumber: "ZZ99999999ZZ", randomBytes: rnd }),
    ).rejects.toMatchObject({ step: "mutual_authenticate" });
  });

  it("特定在留カードは VERIFY で番号不一致になる", async () => {
    const card = setup("tokutei", "residence");
    await expect(
      readResidenceCard(card.transceive, { cardNumber: "ZZ99999999ZZ", randomBytes: rnd, tokuteiDeliveryKey }),
    ).rejects.toBeInstanceOf(CardNumberMismatchError);
  });

  it("特定在留カードで配送鍵が未設定ならエラー", async () => {
    const card = setup("tokutei", "residence");
    await expect(readResidenceCard(card.transceive, { cardNumber: CARD_NUMBER, randomBytes: rnd })).rejects.toMatchObject({
      step: "set_session_key",
    });
  });

  it("エラーメッセージにカード番号を含めない", async () => {
    const card = setup("tokutei", "residence");
    const e = await readResidenceCard(card.transceive, { cardNumber: "ZZ99999999ZZ", randomBytes: rnd, tokuteiDeliveryKey }).catch((x: unknown) => x);
    expect(String((e as Error).message)).not.toContain("ZZ99999999ZZ");
  });

  it("署名対象が改ざんされていれば検証に失敗する", async () => {
    const card = setup("gen2", "residence");
    const raw = await readResidenceCard(card.transceive, { cardNumber: CARD_NUMBER, randomBytes: rnd });
    raw.files["df1/ef02"]![5]! ^= 1; // 券面記載事項の 1 バイトを変える
    expect(verifyCardSignature(parseCardRead(raw).signature)).toEqual({ status: "invalid", reason: "signature_invalid" });
  });
});
