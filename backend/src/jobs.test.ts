import assert from "node:assert/strict";
import test from "node:test";
import { flagOverdueLoans } from "./jobs.ts";
import { db } from "./db.ts";

test("flags disbursed loans whose due date has passed", () => {
  db.exec("DELETE FROM loans");
  db.prepare(
    `INSERT INTO loans (group_id, principal, due_amount, status, due_at, flagged_overdue, created_at)
     VALUES (1, '10', '11', 'DISBURSED', 1, 0, 0)`,
  ).run();
  const n = flagOverdueLoans(2);
  assert.equal(n, 1);
  const row = db.prepare("SELECT status, flagged_overdue FROM loans").get() as {
    status: string;
    flagged_overdue: number;
  };
  assert.equal(row.status, "OVERDUE");
  assert.equal(row.flagged_overdue, 1);
});
