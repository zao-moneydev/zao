import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config, expertAccount, loadTestnetConfig } from "./config.ts";
import { db, dbDriver, publicUser, type UserRow } from "./db.ts";
import { LOAN_TERM_SECONDS } from "./jobs.ts";
import { evaluateDisburseGate, parseDenylist } from "./kyc-gate.ts";
import { log } from "./log.ts";
import {
  sep10,
  sep12Get,
  sep12Put,
  sep24Deposit,
  sep24Transaction,
  sep24Withdraw,
  buildWithdrawPayment,
  pollSep24Transaction,
  resolveAnchorAsset,
  unwrapSep24Transaction,
  type KycFields,
} from "./sep.ts";
import {
  contracts,
  deployerKeypair,
  dueAmount,
  ensureTrustline,
  fundAccount,
  invoke,
  readContract,
  sendWithdrawPayment,
  toStroops,
} from "./stellar.ts";
import {
  createInvisibleWallet,
  keypairFromEncrypted,
  randomSessionToken,
} from "./wallets.ts";

export const api = Router();

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function asyncHandler(
  fn: (req: expressReq, res: expressRes) => Promise<unknown>,
): (req: expressReq, res: expressRes, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

type expressReq = import("express").Request;
type expressRes = import("express").Response;

async function userByToken(req: expressReq): Promise<UserRow> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.header("x-session-token") ?? "");
  if (!token) throw new HttpError(401, "missing session token");
  const session = (await db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token)) as
    | { user_id: string }
    | undefined;
  if (!session) throw new HttpError(401, "invalid session");
  const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id)) as UserRow | undefined;
  if (!user) throw new HttpError(401, "user not found");
  return user;
}

async function userById(id: string): Promise<UserRow> {
  const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get(id)) as UserRow | undefined;
  if (!user) throw new HttpError(404, `user ${id} not found`);
  return user;
}

function routeParam(req: expressReq, name: string): string {
  const value = req.params[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) throw new HttpError(400, `missing ${name}`);
  return raw;
}

async function writeGateAudit(row: {
  userId?: string | null;
  publicKey?: string | null;
  action: string;
  kycStatus?: string | null;
  amount?: string | null;
  allowed: boolean;
  reason: string;
  code?: string | null;
  groupId?: number | null;
  loanId?: number | null;
}) {
  await db
    .prepare(
      `INSERT INTO gate_audit (at, user_id, public_key, action, kyc_status, amount, allowed, reason, code, group_id, loan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      row.userId ?? null,
      row.publicKey ?? null,
      row.action,
      row.kycStatus ?? null,
      row.amount ?? null,
      row.allowed ? 1 : 0,
      row.reason,
      row.code ?? null,
      row.groupId ?? null,
      row.loanId ?? null,
    );
  log.info("KYC/AML gate", {
    action: row.action,
    allowed: row.allowed,
    code: row.code,
    kycStatus: row.kycStatus,
    publicKey: row.publicKey,
    reason: row.reason,
  });
}

async function refreshSep12(user: UserRow): Promise<UserRow> {
  if (!user.kyc_id && user.kyc_status === "NEEDS_INFO") return user;
  try {
    const kp = keypairFromEncrypted(user.secret_enc);
    const token = await sep10(kp);
    const got = await sep12Get(token, user.public_key, user.kyc_id);
    await db
      .prepare("UPDATE users SET kyc_status = ?, kyc_id = ? WHERE id = ?")
      .run(got.status, got.id ?? user.kyc_id, user.id);
    return { ...user, kyc_status: got.status, kyc_id: got.id ?? user.kyc_id };
  } catch (err) {
    log.error("SEP-12 refresh failed", { publicKey: user.public_key, err: String(err) });
    return user;
  }
}

async function approveLeaderOnchain(leaderPublicKey: string) {
  const cfg = requireContracts();
  const admin = deployerKeypair();
  const already = await readContract({
    contractId: cfg.lendingPoolContractId,
    method: "is_kyc_approved",
    args: [leaderPublicKey],
    source: admin,
  });
  if (already === true) {
    return { hash: null as string | null, expert: null as string | null, already: true };
  }
  const tx = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "set_kyc_approved",
    args: [admin.publicKey(), leaderPublicKey, true],
    source: admin,
  });
  return { hash: tx.hash, expert: tx.expert, already: false };
}

function requireContracts() {
  const cfg = loadTestnetConfig();
  if (!cfg.lendingPoolContractId || !cfg.reputationContractId || !cfg.escrowContractId) {
    throw new HttpError(503, "contracts are not deployed — run npm run deploy in /backend");
  }
  return cfg;
}

const CONTRACT_MESSAGES: Record<number, string> = {
  3: "You are not allowed to do that.",
  4: "A group needs 3 to 5 people.",
  5: "Each person can only be in the group once.",
  6: "The leader must be one of the group members.",
  7: "That group was not found.",
  8: "No loan found for this group.",
  9: "Enter an amount greater than zero.",
  10: "This group already has an open loan.",
  11: "Only group members can sign.",
  12: "Ask for a loan before signing.",
  13: "This person already signed.",
  14: "Everyone in the group must sign first.",
  15: "The lending pool does not have enough USDC yet.",
  16: "This loan has not been paid out yet.",
  17: "This loan is already closed.",
  18: "It is too early to mark this loan as defaulted.",
  20: "Not enough deposited to withdraw.",
  21: "The pool is still used by an open loan.",
  22: "The group leader is not KYC-approved on-chain.",
};

function publicError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof z.ZodError) {
    const flat = err.flatten();
    const field = Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0];
    return { status: 400, message: field ?? "Please check what you entered." };
  }
  const text = err instanceof Error ? err.message : String(err);
  const code = text.match(/Error\(Contract, #(\d+)\)/i);
  if (code && CONTRACT_MESSAGES[Number(code[1])]) {
    return { status: 400, message: CONTRACT_MESSAGES[Number(code[1])] };
  }
  if (/fetch failed|ConnectTimeout|ECONNREFUSED|timed out/i.test(text)) {
    return { status: 503, message: "The network is busy. Wait a few seconds and try again." };
  }
  if (/invalid session|missing session/i.test(text)) {
    return { status: 401, message: "Please sign in first." };
  }
  if (/BigInt/i.test(text)) {
    return { status: 500, message: "The server hit a number-format bug. Try the action again." };
  }
  if (text.length > 160) {
    return { status: 502, message: "The Stellar request failed. Try again in a moment." };
  }
  return { status: 500, message: text };
}

async function createUser(name: string, email: string): Promise<{ user: ReturnType<typeof publicUser>; token: string }> {
  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new HttpError(409, "That email is already registered. Sign in instead.");
  const wallet = createInvisibleWallet();
  const id = randomUUID();
  await db.prepare(
    `INSERT INTO users (id, email, name, public_key, secret_enc, kyc_status, created_at)
     VALUES (?, ?, ?, ?, ?, 'NEEDS_INFO', ?)`,
  ).run(id, email, name, wallet.publicKey, wallet.secretEnc, Date.now());
  try {
    await fundAccount(wallet.publicKey);
  } catch (err) {
    log.error("friendbot funding failed", { publicKey: wallet.publicKey, err: String(err) });
  }
  const token = randomSessionToken();
  await db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    id,
    Date.now(),
  );
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  return { user: publicUser(user), token };
}

api.get("/health", (_req, res) => {
  const cfg = loadTestnetConfig();
  res.json({
    ok: true,
    network: config.network,
    anchor: config.anchorHomeDomain,
    db: dbDriver,
    supabase: config.supabaseUrl || null,
    amlMaxAmount: config.amlMaxAmount,
    contracts: {
      lendingPool: cfg.lendingPoolContractId,
      reputation: cfg.reputationContractId,
      escrow: cfg.escrowContractId,
      usdc: cfg.usdcContractId,
    },
  });
});

api.post(
  "/users/register",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        email: z.string().email(),
      })
      .parse(req.body);
    const created = await createUser(body.name, body.email);
    res.status(201).json({
      ...created,
      explorer: expertAccount(created.user.publicKey),
    });
  }),
);

api.post(
  "/demo/start",
  asyncHandler(async (_req, res) => {
    const stamp = Date.now();
    const leader = await createUser("Thabo", `thabo.${stamp}@zao.local`);
    const memberB = await createUser("Lerato", `lerato.${stamp}@zao.local`);
    const memberC = await createUser("Sipho", `sipho.${stamp}@zao.local`);
    res.status(201).json({
      token: leader.token,
      leader: leader.user,
      members: [leader.user, memberB.user, memberC.user],
    });
  }),
);

api.post(
  "/users/login",
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(body.email) as UserRow | undefined;
    if (!user) throw new HttpError(404, "user not found");
    const token = randomSessionToken();
    await db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
      token,
      user.id,
      Date.now(),
    );
    res.json({ user: publicUser(user), token });
  }),
);

api.get(
  "/users/me",
  asyncHandler(async (req, res) => {
    const user = await userByToken(req);
    res.json({
      user: publicUser(user),
      explorer: expertAccount(user.public_key),
    });
  }),
);

api.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    res.json({ users: rows.map(publicUser) });
  }),
);

api.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z
      .object({
        memberIds: z.array(z.string()).min(2).max(4),
      })
      .parse(req.body);
    const ids = Array.from(new Set([me.id, ...body.memberIds]));
    if (ids.length < 3 || ids.length > 5) {
      throw new HttpError(400, "groups must have 3–5 unique members including the leader");
    }
    const members = await Promise.all(ids.map((id) => userById(id)));
    const cfg = requireContracts();
    const leaderKp = keypairFromEncrypted(me.secret_enc);
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "create_group",
      args: [me.public_key, members.map((m) => m.public_key)],
      source: leaderKp,
    });
    const onchainId = Number(result.returnValue);
    const info = await db
      .prepare(
        `INSERT INTO groups (onchain_id, leader_id, member_ids, create_tx, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(onchainId, me.id, JSON.stringify(ids), result.hash, Date.now());
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      onchainId,
      leaderId: me.id,
      memberIds: ids,
      tx: result,
    });
  }),
);

api.get(
  "/groups",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM groups ORDER BY id DESC").all() as Array<{
      id: number;
      onchain_id: number;
      leader_id: string;
      member_ids: string;
      create_tx: string;
      created_at: number;
    }>;
    const users = await db.prepare("SELECT * FROM users").all() as UserRow[];
    const byId = new Map(users.map((u) => [u.id, publicUser(u)]));
    const groups = await Promise.all(
      rows.map(async (row) => {
        const memberIds = JSON.parse(row.member_ids) as string[];
        const loan = await db
          .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
          .get(row.id);
        return {
          ...row,
          memberIds,
          members: memberIds.map((id) => byId.get(id)).filter(Boolean),
          loan: loan ?? null,
        };
      }),
    );
    res.json({ groups });
  }),
);

api.get(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(Number(req.params.id));
    if (!group) throw new HttpError(404, "group not found");
    const loan = await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(Number(req.params.id));
    res.json({ group, loan: loan ?? null });
  }),
);

api.post(
  "/loans",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z
      .object({
        groupId: z.number().int(),
        amount: z.string().or(z.number()),
      })
      .parse(req.body);
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(body.groupId) as
      | { id: number; onchain_id: number; leader_id: string; member_ids: string }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    if (group.leader_id !== me.id) throw new HttpError(403, "only the group leader can request a loan");
    const principal = toStroops(body.amount);
    if (principal <= 0n) throw new HttpError(400, "amount must be positive");
    const due = dueAmount(principal);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "request_loan",
      args: [{ u64: group.onchain_id }, principal],
      source: keypairFromEncrypted(me.secret_enc),
    });
    const onchainId = Number(result.returnValue);
    const info = await db
      .prepare(
        `INSERT INTO loans (group_id, onchain_id, principal, due_amount, status, signatures, request_tx, created_at)
         VALUES (?, ?, ?, ?, 'REQUESTED', '[]', ?, ?)`,
      )
      .run(group.id, onchainId, principal.toString(), due.toString(), result.hash, Date.now());
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      onchainId,
      principal: principal.toString(),
      dueAmount: due.toString(),
      tx: result,
    });
  }),
);

api.post(
  "/loans/:groupId/sign",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as
      | { id: number; onchain_id: number; member_ids: string }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    const members: string[] = JSON.parse(group.member_ids);
    if (!members.includes(me.id)) throw new HttpError(403, "not a group member");
    const loan = await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId) as { id: number; signatures: string } | undefined;
    if (!loan) throw new HttpError(404, "loan not found");
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "sign",
      args: [{ u64: group.onchain_id }, me.public_key],
      source: keypairFromEncrypted(me.secret_enc),
    });
    const signatures: string[] = JSON.parse(loan.signatures);
    if (!signatures.includes(me.id)) signatures.push(me.id);
    await db.prepare("UPDATE loans SET signatures = ? WHERE id = ?").run(JSON.stringify(signatures), loan.id);
    res.json({ signatures, tx: result });
  }),
);

api.post(
  "/loans/:groupId/sign-all",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as
      | { id: number; onchain_id: number; member_ids: string }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    const memberIds: string[] = JSON.parse(group.member_ids);
    if (!memberIds.includes(me.id)) throw new HttpError(403, "not a group member");
    const loan = await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId) as { id: number; signatures: string } | undefined;
    if (!loan) throw new HttpError(404, "Ask for a loan before signing.");
    const cfg = requireContracts();
    const signatures: string[] = JSON.parse(loan.signatures);
    const txs = [];
    for (const memberId of memberIds) {
      if (signatures.includes(memberId)) continue;
      const member = await userById(memberId);
      const result = await invoke({
        contractId: cfg.lendingPoolContractId,
        method: "sign",
        args: [{ u64: group.onchain_id }, member.public_key],
        source: keypairFromEncrypted(member.secret_enc),
      });
      signatures.push(memberId);
      txs.push(result);
    }
    await db.prepare("UPDATE loans SET signatures = ? WHERE id = ?").run(JSON.stringify(signatures), loan.id);
    res.json({ signatures, txs });
  }),
);

api.get(
  "/loans/:groupId/gate",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = (await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId)) as
      | { id: number; onchain_id: number; leader_id: string }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    const leader = await userById(group.leader_id);
    const fresh = leader.id === me.id ? await refreshSep12(leader) : leader;
    const loan = (await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId)) as { id: number; principal: string } | undefined;
    if (!loan) throw new HttpError(404, "loan not found");
    const decision = evaluateDisburseGate({
      kycStatus: fresh.kyc_status,
      amountStroops: loan.principal,
      publicKey: fresh.public_key,
    });
    let onchainKyc = false;
    try {
      const cfg = loadTestnetConfig();
      if (cfg.lendingPoolContractId && config.deployerSecret) {
        onchainKyc = Boolean(
          await readContract({
            contractId: cfg.lendingPoolContractId,
            method: "is_kyc_approved",
            args: [fresh.public_key],
            source: deployerKeypair(),
          }),
        );
      }
    } catch (err) {
      log.error("is_kyc_approved read failed", { err: String(err) });
    }
    res.json({
      ...decision,
      onchainKyc,
      amlMaxAmount: config.amlMaxAmount,
      denylisted: parseDenylist().includes(fresh.public_key.toUpperCase()),
    });
  }),
);

api.post(
  "/loans/:groupId/disburse",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = (await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId)) as
      | { id: number; onchain_id: number; leader_id: string; member_ids: string }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    if (group.leader_id !== me.id) throw new HttpError(403, "only the leader can disburse");
    const loan = (await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId)) as { id: number; signatures: string; principal: string } | undefined;
    if (!loan) throw new HttpError(404, "loan not found");
    const fresh = await refreshSep12(me);
    const decision = evaluateDisburseGate({
      kycStatus: fresh.kyc_status,
      amountStroops: loan.principal,
      publicKey: fresh.public_key,
    });
    await writeGateAudit({
      userId: me.id,
      publicKey: me.public_key,
      action: "disburse",
      kycStatus: decision.kycStatus,
      amount: decision.amount,
      allowed: decision.allowed,
      reason: decision.reason,
      code: decision.code,
      groupId,
      loanId: loan.id,
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.reason);
    }
    const kycTx = await approveLeaderOnchain(me.public_key);
    const cfg = requireContracts();
    const kp = keypairFromEncrypted(me.secret_enc);
    await ensureTrustline(kp);
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "disburse",
      args: [{ u64: Number(group.onchain_id) }],
      source: kp,
    });
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `UPDATE loans SET status = 'DISBURSED', disbursed_at = ?, due_at = ?, disburse_tx = ? WHERE id = ?`,
      )
      .run(now, now + LOAN_TERM_SECONDS, result.hash, loan.id);
    res.json({
      status: "DISBURSED",
      dueAt: now + LOAN_TERM_SECONDS,
      tx: result,
      kycOnchain: kycTx,
      gate: decision,
    });
  }),
);

api.post(
  "/loans/:groupId/repay",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as
      | { id: number; onchain_id: number }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    const loan = await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId) as { id: number } | undefined;
    if (!loan) throw new HttpError(404, "loan not found");
    const kp = keypairFromEncrypted(me.secret_enc);
    await ensureTrustline(kp);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "repay",
      args: [{ u64: group.onchain_id }, me.public_key],
      source: kp,
    });
    await db.prepare(`UPDATE loans SET status = 'REPAID', repay_tx = ?, flagged_overdue = 0 WHERE id = ?`).run(
      result.hash,
      loan.id,
    );
    res.json({ status: "REPAID", tx: result });
  }),
);

api.post(
  "/loans/:groupId/default",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const groupId = Number(req.params.groupId);
    const group = await db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as
      | { id: number; onchain_id: number }
      | undefined;
    if (!group) throw new HttpError(404, "group not found");
    const loan = await db
      .prepare("SELECT * FROM loans WHERE group_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId) as { id: number } | undefined;
    if (!loan) throw new HttpError(404, "loan not found");
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "mark_default",
      args: [{ u64: group.onchain_id }],
      source: keypairFromEncrypted(me.secret_enc),
    });
    await db.prepare(`UPDATE loans SET status = 'DEFAULTED', default_tx = ? WHERE id = ?`).run(
      result.hash,
      loan.id,
    );
    res.json({ status: "DEFAULTED", tx: result });
  }),
);

api.get(
  "/loans",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM loans ORDER BY id DESC").all();
    res.json({ loans: rows });
  }),
);

api.post(
  "/pool/deposit",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z.object({ amount: z.string().or(z.number()) }).parse(req.body);
    const amount = toStroops(body.amount);
    const kp = keypairFromEncrypted(me.secret_enc);
    await ensureTrustline(kp);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "deposit",
      args: [me.public_key, amount],
      source: kp,
    });
    res.json({ tx: result });
  }),
);

api.post(
  "/pool/withdraw",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z.object({ amount: z.string().or(z.number()) }).parse(req.body);
    const amount = toStroops(body.amount);
    const kp = keypairFromEncrypted(me.secret_enc);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "withdraw",
      args: [me.public_key, amount],
      source: kp,
    });
    res.json({ tx: result });
  }),
);

api.get(
  "/escrow",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM escrows ORDER BY id DESC").all();
    res.json({ escrows: rows });
  }),
);

api.post(
  "/escrow",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z
      .object({
        sellerId: z.string(),
        amount: z.string().or(z.number()),
      })
      .parse(req.body);
    const seller = await userById(body.sellerId);
    const amount = toStroops(body.amount);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "create_escrow",
      args: [me.public_key, seller.public_key, amount],
      source: keypairFromEncrypted(me.secret_enc),
    });
    const onchainId = Number(result.returnValue);
    const info = await db
      .prepare(
        `INSERT INTO escrows (onchain_id, buyer_id, seller_id, amount, status, create_tx, created_at)
         VALUES (?, ?, ?, ?, 'CREATED', ?, ?)`,
      )
      .run(onchainId, me.id, seller.id, amount.toString(), result.hash, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid), onchainId, tx: result });
  }),
);

api.post(
  "/escrow/:id/fund",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const row = await db.prepare("SELECT * FROM escrows WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; onchain_id: number; buyer_id: string }
      | undefined;
    if (!row) throw new HttpError(404, "escrow not found");
    if (row.buyer_id !== me.id) throw new HttpError(403, "only the buyer can fund");
    const kp = keypairFromEncrypted(me.secret_enc);
    await ensureTrustline(kp);
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "fund",
      args: [{ u64: row.onchain_id }],
      source: kp,
    });
    await db.prepare("UPDATE escrows SET status = 'FUNDED', fund_tx = ? WHERE id = ?").run(result.hash, row.id);
    res.json({ status: "FUNDED", tx: result });
  }),
);

api.post(
  "/escrow/:id/confirm",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const row = await db.prepare("SELECT * FROM escrows WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; onchain_id: number; buyer_id: string }
      | undefined;
    if (!row) throw new HttpError(404, "escrow not found");
    if (row.buyer_id !== me.id) throw new HttpError(403, "only the buyer can confirm delivery");
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "confirm_delivery",
      args: [{ u64: row.onchain_id }],
      source: keypairFromEncrypted(me.secret_enc),
    });
    await db.prepare("UPDATE escrows SET status = 'RELEASED', close_tx = ? WHERE id = ?").run(
      result.hash,
      row.id,
    );
    res.json({ status: "RELEASED", tx: result });
  }),
);

api.post(
  "/escrow/:id/refund",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const row = await db.prepare("SELECT * FROM escrows WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; onchain_id: number }
      | undefined;
    if (!row) throw new HttpError(404, "escrow not found");
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "refund",
      args: [{ u64: row.onchain_id }, me.public_key],
      source: keypairFromEncrypted(me.secret_enc),
    });
    await db.prepare("UPDATE escrows SET status = 'REFUNDED', close_tx = ? WHERE id = ?").run(
      result.hash,
      row.id,
    );
    res.json({ status: "REFUNDED", tx: result });
  }),
);

api.post(
  "/escrow/:id/dispute",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const row = await db.prepare("SELECT * FROM escrows WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; onchain_id: number }
      | undefined;
    if (!row) throw new HttpError(404, "escrow not found");
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "dispute",
      args: [{ u64: row.onchain_id }, me.public_key],
      source: keypairFromEncrypted(me.secret_enc),
    });
    await db.prepare("UPDATE escrows SET status = 'DISPUTED' WHERE id = ?").run(row.id);
    res.json({ status: "DISPUTED", tx: result });
  }),
);

api.post(
  "/escrow/:id/arbitrate",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z.object({ releaseToSeller: z.boolean() }).parse(req.body);
    const row = await db.prepare("SELECT * FROM escrows WHERE id = ?").get(Number(req.params.id)) as
      | { id: number; onchain_id: number }
      | undefined;
    if (!row) throw new HttpError(404, "escrow not found");
    if (me.email !== config.adminEmail) {
      throw new HttpError(403, "only the protocol admin can arbitrate");
    }
    const cfg = requireContracts();
    const result = await invoke({
      contractId: cfg.escrowContractId,
      method: "arbitrate",
      args: [{ u64: row.onchain_id }, body.releaseToSeller],
      source: keypairFromEncrypted(me.secret_enc),
    });
    const status = body.releaseToSeller ? "RELEASED" : "REFUNDED";
    await db.prepare("UPDATE escrows SET status = ?, close_tx = ? WHERE id = ?").run(
      status,
      result.hash,
      row.id,
    );
    res.json({ status, tx: result });
  }),
);

api.get(
  "/reputation/:userId",
  asyncHandler(async (req, res) => {
    const user = await userById(routeParam(req, "userId"));
    const cfg = requireContracts();
    const source = keypairFromEncrypted(user.secret_enc);
    const [score, record, history] = await Promise.all([
      readContract({
        contractId: cfg.reputationContractId,
        method: "get_score",
        args: [user.public_key],
        source,
      }),
      readContract({
        contractId: cfg.reputationContractId,
        method: "get_record",
        args: [user.public_key],
        source,
      }),
      readContract({
        contractId: cfg.reputationContractId,
        method: "get_history",
        args: [user.public_key],
        source,
      }),
    ]);
    res.json({
      user: publicUser(user),
      score,
      record,
      history,
    });
  }),
);

api.post(
  "/anchor/kyc",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z
      .object({
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        email_address: z.string().email().optional(),
        id_type: z.string().optional(),
        id_number: z.string().optional(),
        address: z.string().optional(),
        mobile_number: z.string().optional(),
      })
      .parse(req.body);
    const kp = keypairFromEncrypted(me.secret_enc);
    const token = await sep10(kp);
    const fields: KycFields = {
      first_name: body.first_name,
      last_name: body.last_name,
      email_address: body.email_address ?? me.email,
      id_type: body.id_type ?? "passport",
      id_number: body.id_number ?? "ZA-TEST-0001",
      address: body.address ?? "Cape Town, South Africa",
      mobile_number: body.mobile_number,
    };
    const put = await sep12Put(token, me.public_key, fields);
    const got = await sep12Get(token, me.public_key, put.id);
    await db.prepare("UPDATE users SET kyc_status = ?, kyc_id = ? WHERE id = ?").run(
      got.status,
      got.id ?? put.id ?? null,
      me.id,
    );
    let kycOnchain: { hash: string | null; expert: string | null; already: boolean } | null = null;
    if (got.status === "ACCEPTED") {
      try {
        kycOnchain = await approveLeaderOnchain(me.public_key);
      } catch (err) {
        log.error("set_kyc_approved after SEP-12 ACCEPTED failed", { err: String(err) });
      }
    }
    await writeGateAudit({
      userId: me.id,
      publicKey: me.public_key,
      action: "kyc_submit",
      kycStatus: got.status,
      allowed: got.status === "ACCEPTED",
      reason:
        got.status === "ACCEPTED"
          ? "SEP-12 ACCEPTED; on-chain set_kyc_approved will run at disburse if needed"
          : `SEP-12 status ${got.status}`,
      code: got.status === "ACCEPTED" ? "ALLOWED" : `KYC_${got.status}`,
    });
    res.json({
      status: got.status,
      id: got.id ?? put.id,
      fields: got.fields,
      kycOnchain,
    });
  }),
);

api.get(
  "/anchor/kyc",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const kp = keypairFromEncrypted(me.secret_enc);
    const token = await sep10(kp);
    const got = await sep12Get(token, me.public_key, me.kyc_id);
    await db.prepare("UPDATE users SET kyc_status = ? WHERE id = ?").run(got.status, me.id);
    res.json({ status: got.status, id: got.id });
  }),
);

api.post(
  "/anchor/withdraw",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z.object({ amount: z.string() }).parse(req.body);
    const kp = keypairFromEncrypted(me.secret_enc);
    const token = await sep10(kp);
    const asset = await resolveAnchorAsset();
    const withdraw = await sep24Withdraw({
      token,
      account: me.public_key,
      amount: body.amount,
      assetCode: asset.code,
    });
    await db.prepare(
      `INSERT INTO anchor_txs (id, user_id, kind, status, url, created_at) VALUES (?, ?, 'withdraw', ?, ?, ?)`,
    ).run(withdraw.id, me.id, withdraw.type, withdraw.url, Date.now());
    log.info("SEP-24 withdraw started", { id: withdraw.id, account: me.public_key });
    res.json({
      id: withdraw.id,
      url: withdraw.url,
      type: withdraw.type,
      asset: `${asset.code}:${asset.issuer}`,
      note: "Open the interactive URL, then POST /anchor/withdraw/:id/pay once the anchor reports pending_user_transfer_start.",
    });
  }),
);

api.post(
  "/anchor/withdraw/:id/pay",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const id = routeParam(req, "id");
    const kp = keypairFromEncrypted(me.secret_enc);
    const token = await sep10(kp);
    const asset = await resolveAnchorAsset();
    const pending = await pollSep24Transaction({
      token,
      id,
      until: ["pending_user_transfer_start"],
      timeoutMs: 15_000,
      intervalMs: 2_000,
    });
    const payment = buildWithdrawPayment(pending, {
      amount: pending.amount_in ?? "1",
      assetCode: asset.code,
      assetIssuer: asset.issuer,
    });
    await ensureTrustline(kp);
    const sent = await sendWithdrawPayment(kp, payment);
    log.info("SEP-24 withdraw payment submitted", {
      id,
      hash: sent.hash,
      destination: payment.destination,
    });
    let finalStatus = pending.status;
    let finalTx = pending;
    try {
      finalTx = await pollSep24Transaction({
        token,
        id,
        until: ["completed"],
        timeoutMs: 120_000,
        intervalMs: 4_000,
      });
      finalStatus = finalTx.status;
    } catch (err) {
      log.error("SEP-24 did not reach completed after payment", { id, err: String(err) });
      finalTx = unwrapSep24Transaction(await sep24Transaction(token, id));
      finalStatus = finalTx.status;
    }
    await db.prepare("UPDATE anchor_txs SET status = ? WHERE id = ?").run(finalStatus, id);
    res.json({
      id,
      payment: sent,
      destination: payment.destination,
      amount: payment.amount,
      memo: payment.memo,
      status: finalStatus,
      transaction: finalTx,
    });
  }),
);

api.post(
  "/anchor/deposit",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const body = z.object({ amount: z.string() }).parse(req.body);
    const kp = keypairFromEncrypted(me.secret_enc);
    const token = await sep10(kp);
    const deposit = await sep24Deposit({
      token,
      account: me.public_key,
      amount: body.amount,
    });
    await db.prepare(
      `INSERT INTO anchor_txs (id, user_id, kind, status, url, created_at) VALUES (?, ?, 'deposit', ?, ?, ?)`,
    ).run(deposit.id, me.id, deposit.type, deposit.url, Date.now());
    res.json(deposit);
  }),
);

api.get(
  "/anchor/transactions/:id",
  asyncHandler(async (req, res) => {
    const me = await userByToken(req);
    const id = routeParam(req, "id");
    const token = await sep10(keypairFromEncrypted(me.secret_enc));
    const tx = await sep24Transaction(token, id);
    const inner = unwrapSep24Transaction(tx);
    if (inner.status) {
      await db.prepare("UPDATE anchor_txs SET status = ? WHERE id = ?").run(inner.status, id);
    }
    res.json(tx);
  }),
);

api.get(
  "/gate/config",
  asyncHandler(async (_req, res) => {
    res.json({
      amlMaxAmount: config.amlMaxAmount,
      denylistCount: parseDenylist().length,
      anchor: config.anchorHomeDomain,
    });
  }),
);

api.get(
  "/gate/audit",
  asyncHandler(async (req, res) => {
    await userByToken(req);
    const rows = await db.prepare("SELECT * FROM gate_audit ORDER BY id DESC LIMIT 50").all();
    res.json({ audit: rows });
  }),
);

api.get(
  "/loans/overdue",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM loans WHERE flagged_overdue = 1").all();
    res.json({ loans: rows });
  }),
);

api.use(
  (
    err: unknown,
    _req: expressReq,
    res: expressRes,
    _next: (err?: unknown) => void,
  ) => {
    const mapped = publicError(err);
    if (mapped.status >= 500) {
      log.error("unhandled api error", { err: String(err) });
    }
    res.status(mapped.status).json({ error: mapped.message });
  },
);

export { HttpError };
export const _contracts = contracts;
