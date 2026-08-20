import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_INFO = "opencode-browser-plugin/history/v1/chunk-key";
const KEY_FILE_PERMS = 0o600;

export function loadOrCreateRootKey(root) {
  const keyFile = path.join(root, "key");
  try {
    const existing = readFileSync(keyFile);
    if (existing.length === KEY_BYTES) return existing;
  } catch {
    // no key yet; create below
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyFile, key, { mode: KEY_FILE_PERMS });
  try {
    chmodSync(keyFile, KEY_FILE_PERMS);
  } catch {
    // Windows ignores POSIX modes
  }
  return key;
}

export function destroyRootKey(root) {
  rmSync(path.join(root, "key"), { force: true });
}

export function chunkKey(rootKey, chunkId) {
  return hkdfSync("sha256", rootKey, Buffer.from(chunkId, "utf8"), Buffer.from(KEY_INFO, "utf8"), KEY_BYTES);
}

export function encryptRecord(key, aad, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

export function decryptRecord(key, aad, record) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ct, "base64")), decipher.final()]).toString("utf8");
}

export function selfTestKey(root) {
  const key = loadOrCreateRootKey(root);
  const aad = "self-test";
  const roundtrip = decryptRecord(key, aad, encryptRecord(key, aad, "opencode-browser-plugin history self-test"));
  return roundtrip === "opencode-browser-plugin history self-test" ? key : null;
}