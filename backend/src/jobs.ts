import { db } from "./db.ts";
import { log } from "./log.ts";

const DAY = 24 * 60 * 60;

export function flagOverdueLoans(now = Math.floor(Date.now() / 1000)): number {
  const rows = db
    .prepare(
      `SELECT id, due_at FROM loans
       WHERE status = 'DISBURSED' AND due_at IS NOT NULL AND due_at <= ? AND flagged_overdue = 0`,
    )
    .all(now) as { id: number; due_at: number }[];
  const update = db.prepare(`UPDATE loans SET flagged_overdue = 1, status = 'OVERDUE' WHERE id = ?`);
  for (const row of rows) {
    update.run(row.id);
    log.info("flagged overdue loan", { id: row.id, dueAt: row.due_at, now });
  }
  return rows.length;
}

export function startLoanMonitor(intervalMs = 60_000): NodeJS.Timeout {
  flagOverdueLoans();
  return setInterval(() => {
    try {
      flagOverdueLoans();
    } catch (err) {
      log.error("loan monitor failed", { err: String(err) });
    }
  }, intervalMs);
}

export const LOAN_TERM_SECONDS = 30 * DAY;
