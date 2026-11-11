import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "./config.ts";

const KEY_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const hex = config.walletKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be 64 hex chars (32 bytes). See .env.example.",
    );
  }
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM. Output is iv:tag:ciphertext, all hex. Never log the plaintext. */
export function encryptSecret(secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AUTH_TAG_LENGTH) {
    throw new Error("unexpected GCM tag length");
  }
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function createInvisibleWallet(): { publicKey: string; secretEnc: string } {
  const kp = Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secretEnc: encryptSecret(kp.secret()),
  };
}

export function keypairFromEncrypted(secretEnc: string): Keypair {
  return Keypair.fromSecret(decryptSecret(secretEnc));
}

export function assertNotSecret(value: string): void {
  if (value.startsWith("S") && value.length === 56) {
    throw new Error("refusing to handle a raw Stellar secret in API output");
  }
}

export function randomSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const KEY_LEN = KEY_BYTES;
