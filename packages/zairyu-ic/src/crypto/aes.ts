/** AES-128 CBC / ECB / CMAC(第2世代・特定在留カードのセキュアメッセージング用) */
import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";

export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array = new Uint8Array(16)): Uint8Array {
  return cbc(key, iv, { disablePadding: true }).encrypt(data);
}

export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array = new Uint8Array(16)): Uint8Array {
  return cbc(key, iv, { disablePadding: true }).decrypt(data);
}

export function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return ecb(key, { disablePadding: true }).encrypt(block);
}

/** AES-CMAC(NIST SP 800-38B)の先頭 8 バイト */
export function aesCmac8(key: Uint8Array, data: Uint8Array): Uint8Array {
  return cmac(data, key).subarray(0, 8);
}
