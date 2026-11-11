import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(resolve(dir, "zao.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  kyc_status TEXT NOT NULL DEFAULT 'NEEDS_INFO',
  kyc_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onchain_id INTEGER,
  leader_id TEXT NOT NULL,
  member_ids TEXT NOT NULL,
  create_tx TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  onchain_id INTEGER,
  principal TEXT NOT NULL,
  due_amount TEXT NOT NULL,
  status TEXT NOT NULL,
  signatures TEXT NOT NULL DEFAULT '[]',
  disbursed_at INTEGER,
  due_at INTEGER,
  request_tx TEXT,
  disburse_tx TEXT,
  repay_tx TEXT,
  default_tx TEXT,
  flagged_overdue INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS escrows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onchain_id INTEGER,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  create_tx TEXT,
  fund_tx TEXT,
  close_tx TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anchor_txs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  created_at INTEGER NOT NULL
);
`);

export type UserRow = {
  id: string;
  email: string;
  name: string;
  public_key: string;
  secret_enc: string;
  kyc_status: string;
  kyc_id: string | null;
  created_at: number;
};

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    publicKey: row.public_key,
    kycStatus: row.kyc_status,
  };
}
