import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isValidDate, jstDate } from "./jst.js";

describe("JST の日付", () => {
  it("UTC 15:00 で日付が変わる", () => {
    expect(jstDate(Date.parse("2026-03-31T14:59:59Z"))).toBe("2026-03-31");
    expect(jstDate(Date.parse("2026-03-31T15:00:00Z"))).toBe("2026-04-01");
  });

  it("実在しない日付を弾く", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2027-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-01")).toBe(false);
  });

  it("日数の加減と差", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-01-01", "2026-03-01")).toBe(59);
  });
});
