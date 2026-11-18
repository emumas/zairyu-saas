import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** テスト用に鍵と自己署名証明書(DER)を openssl で生成する */
export function makeCertAndKey(type: "rsa" | "ec"): { key: KeyObject; certDer: Buffer; cert: X509Certificate } {
  const dir = mkdtempSync(join(tmpdir(), "zairyu-ic-test-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.der");
    const newkey = type === "rsa" ? ["-newkey", "rsa:2048"] : ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1"];
    execFileSync(
      "openssl",
      ["req", "-x509", ...newkey, "-nodes", "-keyout", keyPath, "-subj", "/CN=TEST ONLY", "-days", "3650", "-outform", "DER", "-out", certPath],
      { stdio: "ignore" },
    );
    const certDer = readFileSync(certPath);
    return { key: createPrivateKey(readFileSync(keyPath)), certDer, cert: new X509Certificate(certDer) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
