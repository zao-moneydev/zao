import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "./config.ts";
import {
  createInvisibleWallet,
  decryptSecret,
  encryptSecret,
  keypairFromEncrypted,
} from "./wallets.ts";

test("encrypts and decrypts a Stellar secret without leaking it", () => {
  config.walletKey = randomBytes(32).toString("hex");
  const kp = Keypair.random();
  const enc = encryptSecret(kp.secret());
  assert.equal(enc.includes(kp.secret()), false);
  assert.match(enc, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(decryptSecret(enc), kp.secret());
});

test("round-trips an invisible wallet keypair", () => {
  config.walletKey = randomBytes(32).toString("hex");
  const wallet = createInvisibleWallet();
  assert.match(wallet.publicKey, /^G[A-Z2-7]{55}$/);
  assert.equal(wallet.secretEnc.includes("S"), false);
  const restored = keypairFromEncrypted(wallet.secretEnc);
  assert.equal(restored.publicKey(), wallet.publicKey);
});

test("rejects tampered ciphertext", () => {
  config.walletKey = randomBytes(32).toString("hex");
  const enc = encryptSecret(Keypair.random().secret());
  const [iv, tag, data] = enc.split(":");
  const tampered = `${iv}:${tag}:${data.slice(0, -2)}ff`;
  assert.throws(() => decryptSecret(tampered));
});
