import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { toStroops } from "./amounts.ts";
import { evaluateDisburseGate } from "./kyc-gate.ts";

const leader = Keypair.random().publicKey();
const amount = toStroops("10");

test("blocks disbursement when KYC is NEEDS_INFO", () => {
  const d = evaluateDisburseGate({ kycStatus: "NEEDS_INFO", amountStroops: amount, publicKey: leader });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "KYC_NEEDS_INFO");
  assert.match(d.reason, /NEEDS_INFO/);
});

test("blocks disbursement when KYC is PROCESSING", () => {
  const d = evaluateDisburseGate({ kycStatus: "PROCESSING", amountStroops: amount, publicKey: leader });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "KYC_PROCESSING");
  assert.match(d.reason, /PROCESSING/);
});

test("blocks disbursement when KYC is REJECTED", () => {
  const d = evaluateDisburseGate({ kycStatus: "REJECTED", amountStroops: amount, publicKey: leader });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "KYC_REJECTED");
  assert.match(d.reason, /REJECTED/);
});

test("AML blocks an amount above the configured maximum", () => {
  const d = evaluateDisburseGate({
    kycStatus: "ACCEPTED",
    amountStroops: toStroops("50"),
    publicKey: leader,
    maxAmountHuman: "10",
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "AML_AMOUNT");
  assert.match(d.reason, /exceeds the maximum of 10/);
});

test("AML blocks an address on the denylist", () => {
  const d = evaluateDisburseGate({
    kycStatus: "ACCEPTED",
    amountStroops: amount,
    publicKey: leader,
    denylist: [leader],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "AML_DENYLIST");
  assert.match(d.reason, /denylist/);
});

test("allows disbursement when KYC is ACCEPTED and AML passes", () => {
  const d = evaluateDisburseGate({
    kycStatus: "ACCEPTED",
    amountStroops: amount,
    publicKey: leader,
    maxAmountHuman: "1000",
    denylist: [],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.code, "ALLOWED");
});
