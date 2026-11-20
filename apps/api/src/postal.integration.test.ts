/** 郵便番号の自動登録。TEST_DATABASE_URL が無ければスキップ */
import { replacePostalCodes, schema, withTenant } from "@zairyu/db";
import { parseKenAll } from "@zairyu/shared";
import { toBase64, type EfPath } from "@zairyu/zairyu-ic";
import { buildCardFiles, makeCertAndKey } from "@zairyu/zairyu-ic/testing";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const row = (code: string, pref: string, city: string, town: string) => `13104,"160  ","${code}","ｶﾅ","ｶﾅ","ｶﾅ","${pref}","${city}","${town}",0,0,0,0,0,0`;
const KEN_ALL = [
  row("1600000", "東京都", "新宿区", "以下に掲載がない場合"),
  row("1600023", "東京都", "新宿区", "西新宿（次のビルを除く）"),
  row("1690073", "東京都", "新宿区", "百人町"),
  row("0600042", "北海道", "札幌市中央区", "大通西（１～１９丁目）"),
  row("0640820", "北海道", "札幌市中央区", "大通西（２０～２８丁目）"),
  row("1830000", "東京都", "府中市", "以下に掲載がない場合"),
  row("7260000", "広島県", "府中市", "以下に掲載がない場合"),
  row("2530000", "神奈川県", "茅ヶ崎市", "以下に掲載がない場合"),
].join("\n");

describe.skipIf(!url)("郵便番号", () => {
  let h: Harness;
  let tenant: string;
  let site: string;
  let admin: AppCaller;
  let viewer: AppCaller;
  const rsa = makeCertAndKey("rsa");
  const ic = (cardNumber: string) => {
    const files = buildCardFiles({ format: "legacy", kind: "residence", cardNumber, signer: rsa, backAddress: null });
    const b64: Partial<Record<EfPath, string>> = {};
    for (const [k, v] of Object.entries(files)) if (v) b64[k as EfPath] = toBase64(v);
    return { format: "legacy" as const, kind: "residence" as const, files: b64 };
  };

  beforeAll(async () => {
    h = await createHarness("api_postal");
    tenant = await h.createTenant("A");
    site = await h.createSite(tenant, "本社");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [site]));
  });
  afterAll(async () => h?.end());

  it("データが未投入なら loaded=false", async () => {
    expect(await admin.postal.lookup({ address: "東京都新宿区西新宿2-8-1" })).toMatchObject({ postalCode: null, loaded: false });
  });

  it("住所から引ける。決まらないときは候補", async () => {
    await replacePostalCodes(h.db, parseKenAll(KEN_ALL));
    expect(await admin.postal.lookup({ address: "東京都新宿区西新宿2-8-1" })).toEqual({
      postalCode: "1600023",
      level: "town",
      candidates: [{ code: "1600023", label: "東京都新宿区西新宿" }],
      loaded: true,
    });
    expect((await admin.postal.lookup({ address: "神奈川県茅ケ崎市本村1-1" })).postalCode).toBe("2530000"); // ヶ と ケ
    expect((await admin.postal.lookup({ address: "北海道札幌市中央区大通西10丁目" })).candidates).toHaveLength(2);
    // 都道府県が無く、同じ名前の市が複数
    const fuchu = await admin.postal.lookup({ address: "府中市宮町1-1" });
    expect(fuchu.postalCode).toBeNull();
    expect(fuchu.candidates.map((c) => c.code).sort()).toEqual(["1830000", "7260000"]);
    expect(await codeOf(viewer.postal.lookup({ address: "東京都新宿区" }))).toBe("FORBIDDEN");
  });

  it("カード登録・記載事項の修正で、郵便番号を住居地から自動で入れる(指定があればそれを使う)", async () => {
    const personId = (await admin.persons.create({ siteId: site, employeeCode: "P1", name: "A" })).id;
    const n = "AQ12345678CD";
    await admin.cards.register({ personId, cardNumber: n, ic: ic(n), manual: { expiryDate: "2029-06-20", address: "東京都新宿区百人町1-2-3", addressSource: "front_photo" } });
    const [card] = await admin.cards.listForPerson({ personId });
    expect(card!.postalCode).toBe("1690073");

    // 住居地を変えると引き直す
    const r = await admin.cards.updateDetails({ cardId: card!.id, address: "東京都新宿区西新宿1-1", addressSource: "manual" });
    expect(r.changed.sort()).toEqual(["address", "postalCode"]);
    expect((await admin.cards.listForPerson({ personId }))[0]!.postalCode).toBe("1600023");

    // 手入力(〒・全角も可)
    await admin.cards.updateDetails({ cardId: card!.id, postalCode: "〒１６０－０００１" });
    expect((await admin.cards.listForPerson({ personId }))[0]!.postalCode).toBe("1600001");
    expect(await codeOf(admin.cards.updateDetails({ cardId: card!.id, postalCode: "160-01" }))).toBe("BAD_REQUEST");

    // 決まらない住所なら空のまま(候補は画面で選ぶ)
    await admin.cards.updateDetails({ cardId: card!.id, address: "北海道札幌市中央区大通西10丁目" });
    expect((await admin.cards.listForPerson({ personId }))[0]!.postalCode).toBeNull();
  });

  it("アプリのロールは郵便番号データを書き換えられない", async () => {
    await expect(withTenant(h.db, tenant, (tx) => tx.insert(schema.postalCodes).values({ code: "0000000", pref: "x", city: "x", town: "", townKey: "" }))).rejects.toThrow();
  });
});
