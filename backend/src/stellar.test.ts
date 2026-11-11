import assert from "node:assert/strict";
import test from "node:test";
import { dueAmount, fromStroops, toStroops } from "./amounts.ts";

test("10% flat interest is principal + 10%", () => {
  assert.equal(dueAmount(1_000n), 1_100n);
  assert.equal(dueAmount(toStroops("10")), toStroops("11"));
});

test("stroop conversion keeps 7 decimals", () => {
  assert.equal(toStroops("1"), 10_000_000n);
  assert.equal(fromStroops(11_000_000n), "1.1");
  assert.equal(fromStroops(toStroops("10.5")), "10.5");
});
