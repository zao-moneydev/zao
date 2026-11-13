import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import postgres from "postgres";
import { config } from "./config.ts";

export type SqlValue = string | number | bigint | boolean | null;

export type RunInfo = {
  lastInsertRowid: number;
  changes: number;
};

export type Statement = {
  get: (...params: SqlValue[]) => Promise<unknown>;
  all: (...params: SqlValue[]) => Promise<unknown[]>;
  run: (...params: SqlValue[]) => Promise<RunInfo>;
};

export type Db = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => Promise<void>;
};

const inTest = Boolean(process.env.NODE_TEST_CONTEXT);
export const dbDriver: "postgres" | "sqlite" =
  config.databaseUrl && !inTest ? "postgres" : "sqlite";

const SQLITE_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  public_key TEXT,
  action TEXT NOT NULL,
  kyc_status TEXT,
  amount TEXT,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  code TEXT,
  group_id INTEGER,
  loan_id INTEGER
);
`;

function toPgPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function asRowId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function createSqlite(): Db {
  const dir = process.env.VERCEL
    ? "/tmp"
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "data");
  mkdirSync(dir, { recursive: true });
  const sqlite = new DatabaseSync(resolve(dir, "zao.db"));
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(SQLITE_SCHEMA);

  const wrap = (stmt: StatementSync): Statement => ({
    async get(...params) {
      return stmt.get(...params);
    },
    async all(...params) {
      return stmt.all(...params) as unknown[];
    },
    async run(...params) {
      const result = stmt.run(...params);
      return {
        lastInsertRowid: asRowId(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    },
  });

  return {
    prepare(sql) {
      return wrap(sqlite.prepare(sql));
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}

function createPostgres(url: string): Db {
  const sql = postgres(url, {
    max: 8,
    prepare: false,
    ssl: "require",
    transform: { undefined: null },
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number | bigint | string) => String(x),
      },
    },
  });

  return {
    prepare(query) {
      const pgQuery = toPgPlaceholders(query);
      const isInsert = /^\s*insert\b/i.test(pgQuery);
      const text =
        isInsert && !/\breturning\b/i.test(pgQuery)
          ? `${pgQuery.replace(/;\s*$/, "")} RETURNING id`
          : pgQuery;
      return {
        async get(...params) {
          const rows = await sql.unsafe(text, params as never[]);
          return rows[0];
        },
        async all(...params) {
          const rows = await sql.unsafe(text, params as never[]);
          return [...rows];
        },
        async run(...params) {
          const rows = await sql.unsafe(text, params as never[]);
          return {
            lastInsertRowid: asRowId(rows[0] ? (rows[0] as { id?: unknown }).id : 0),
            changes: rows.count,
          };
        },
      };
    },
    async exec(query) {
      if (/^\s*pragma\b/i.test(query)) return;
      await sql.unsafe(query);
    },
  };
}

export const db: Db = dbDriver === "postgres" ? createPostgres(config.databaseUrl) : createSqlite();

const PG_GATE_AUDIT = `
CREATE TABLE IF NOT EXISTS gate_audit (
  id bigint generated by default as identity primary key,
  at bigint not null,
  user_id text,
  public_key text,
  action text not null,
  kyc_status text,
  amount text,
  allowed integer not null,
  reason text not null,
  code text,
  group_id bigint,
  loan_id bigint
);
`;

if (dbDriver === "postgres") {
  void db.exec(PG_GATE_AUDIT).catch(() => undefined);
}

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
