import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bundledIssuerPaths, trustedIssuers } from "./trust.js";

describe("発行者証明書(ZairyuCard CA)", () => {
  it("同梱の 3 つを読み込み、フィンガープリントが入管庁の公開値と一致する", () => {
    expect(bundledIssuerPaths()).toHaveLength(3);
    const certs = trustedIssuers({});
    const fp = certs.map((c) => createHash("sha256").update(c.raw).digest("hex").toUpperCase());
    expect(fp).toEqual([
      "FF02323CEA7B8C3DFC0DC2DE79D46E78514AF587368523086B188E9690AEC861",
      "6F50161AA80F7FF7C630505FAF472906F7B101D5083E327A6182C82CD7985E67",
      "BF854466ED9ABF61F559C39BF8790546F8ACDAB99B51FD2330563669CE4A71B2",
    ]);
    for (const c of certs) {
      expect(c.subject).toContain("CN=ZairyuCard CA");
      expect(c.ca).toBe(true);
      expect(c.publicKey.asymmetricKeyType).toBe("rsa");
    }
  });
});
