import { expect, it } from "vitest";
import { toHex } from "../src/bytes.js";
import { SELECT_IDENTIFIERS } from "../src/spec.js";
import appJson from "../../../apps/mobile/app.json" with { type: "json" };

it("iOS の select-identifiers と spec の AID が一致している", () => {
  const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === "react-native-nfc-manager") as [string, { selectIdentifiers: string[] }];
  expect(plugin[1].selectIdentifiers).toEqual(SELECT_IDENTIFIERS.map(toHex));
});
