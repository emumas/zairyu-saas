import { describe, expect, it } from "vitest";
import { TlvError, concatBytes, encodeTlv, findTag, parseTlv } from "../src/tlv.js";

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));

describe("parseTlv", () => {
  it("1バイトタグ・短形式長", () => {
    const [t] = parseTlv(hex("C0 03 010203"));
    expect(t!.tag).toBe(0xc0);
    expect(t!.constructed).toBe(false);
    expect([...t!.value]).toEqual([1, 2, 3]);
  });

  it("複数バイトタグ(5F1F)", () => {
    const [t] = parseTlv(hex("5F1F 02 AABB"));
    expect(t!.tag).toBe(0x5f1f);
    expect([...t!.value]).toEqual([0xaa, 0xbb]);
  });

  it("3バイトタグ(DF8101)", () => {
    const [t] = parseTlv(hex("DF8101 01 FF"));
    expect(t!.tag).toBe(0xdf8101);
  });

  it("長形式長 81 / 82 / 83", () => {
    for (const len of [0x80, 0xff, 0x100, 0x1234, 0x12345]) {
      const value = new Uint8Array(len).fill(7);
      const [t] = parseTlv(encodeTlv(0xd0, value));
      expect(t!.value.length).toBe(len);
    }
    expect([...encodeTlv(0xd0, new Uint8Array(0x100)).subarray(0, 4)]).toEqual([0xd0, 0x82, 0x01, 0x00]);
  });

  it("構造化タグを再帰的にパースし findTag で探せる", () => {
    const inner = concatBytes(encodeTlv(0x5f1f, hex("01")), encodeTlv(0xc1, hex("0203")));
    const data = encodeTlv(0x61, inner);
    const tlvs = parseTlv(data, { recursive: true });
    expect(tlvs[0]!.constructed).toBe(true);
    expect(tlvs[0]!.children).toHaveLength(2);
    expect([...findTag(tlvs, 0xc1)!.value]).toEqual([2, 3]);
    expect(findTag(tlvs, 0xc2)).toBeUndefined();
    expect(parseTlv(data)[0]!.children).toBeUndefined();
  });

  it("連続する TLV と 00/FF パディング", () => {
    const tlvs = parseTlv(hex("00 C0 01 01 FF FF C1 00 00"));
    expect(tlvs.map((t) => t.tag)).toEqual([0xc0, 0xc1]);
    expect(tlvs[1]!.value.length).toBe(0);
  });

  it("値は元バッファのビューで offset/end を持つ", () => {
    const data = hex("C0 01 AA C1 02 BBCC");
    const [, t] = parseTlv(data);
    expect(t!.offset).toBe(3);
    expect(t!.end).toBe(7);
    expect(t!.value.buffer).toBe(data.buffer);
  });

  it.each([
    ["値が足りない", "C0 05 0102"],
    ["長さがない", "C0"],
    ["タグが途中で終わる", "5F"],
    ["長形式の長さが足りない", "C0 82 01"],
    ["不定長", "61 80 0000"],
    ["長さバイト数が過大", "C0 85 0000000001 00"],
  ])("不正データ: %s", (_name, data) => {
    expect(() => parseTlv(hex(data))).toThrow(TlvError);
  });
});
