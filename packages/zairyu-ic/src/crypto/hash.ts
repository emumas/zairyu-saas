import { sha1 as nobleSha1 } from "@noble/hashes/legacy.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export const sha1 = (data: Uint8Array): Uint8Array => nobleSha1(data);
export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);
