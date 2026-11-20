import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bundledIssuerPaths, trustedIssuers } from "./trust.js";

describe("発行者証明書(ZairyuCard CA)", () => {
  it("同梱の 4 つを読み込み、フィンガープリントが入管庁の公開値と一致する", () => {
    expect(bundledIssuerPaths()).toHaveLength(4);
    const certs = trustedIssuers({});
    const fp = certs.map((c) => createHash("sha256").update(c.raw).digest("hex").toUpperCase());
    expect(fp).toEqual([
      "FF02323CEA7B8C3DFC0DC2DE79D46E78514AF587368523086B188E9690AEC861",
      "6F50161AA80F7FF7C630505FAF472906F7B101D5083E327A6182C82CD7985E67",
      "BF854466ED9ABF61F559C39BF8790546F8ACDAB99B51FD2330563669CE4A71B2",
      "11E6AD8B8E64F0CDB1D8BA9E3689926C80E8479A2F098616F674A23582BEC13B",
    ]);
    for (const c of certs) {
      expect(c.subject).toMatch(/CN=ZairyuCard CA2?$/m);
      expect(c.ca).toBe(true);
    }
    // 旧様式は RSA、第2世代は ECDSA P-384
    expect(certs.map((c) => c.publicKey.asymmetricKeyType)).toEqual(["rsa", "rsa", "rsa", "ec"]);
    expect(certs[3]!.publicKey.asymmetricKeyDetails?.namedCurve).toBe("secp384r1");
  });
});
