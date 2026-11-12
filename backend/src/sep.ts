import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "./config.ts";
import { log } from "./log.ts";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable HTTP for unit tests. Production uses global fetch. */
export const sepHttp: { fetch: FetchLike } = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

export type TomlCurrency = {
  code: string;
  issuer?: string;
  status?: string;
  desc?: string;
};

export type AnchorToml = {
  WEB_AUTH_ENDPOINT?: string;
  KYC_SERVER?: string;
  TRANSFER_SERVER_SEP0024?: string;
  TRANSFER_SERVER?: string;
  SIGNING_KEY?: string;
  NETWORK_PASSPHRASE?: string;
  currencies: TomlCurrency[];
};

let cachedToml: { at: number; value: AnchorToml } | null = null;

export function clearTomlCache(): void {
  cachedToml = null;
}

export function anchorOrigin(): string {
  return config.anchorHomeDomain.replace(/\/$/, "");
}

export function parseStellarToml(text: string): AnchorToml {
  const value: AnchorToml = { currencies: [] };
  let current: TomlCurrency | null = null;
  const flush = () => {
    if (current?.code) value.currencies.push(current);
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[CURRENCIES]]") {
      flush();
      current = { code: "" };
      continue;
    }
    if (line.startsWith("[") && line !== "[[CURRENCIES]]") {
      flush();
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const val = match[2].trim().replace(/^"|"$/g, "");
    if (current) {
      if (key === "code") current.code = val;
      else if (key === "issuer") current.issuer = val;
      else if (key === "status") current.status = val;
      else if (key === "desc") current.desc = val;
      continue;
    }
    if (
      key === "WEB_AUTH_ENDPOINT" ||
      key === "KYC_SERVER" ||
      key === "TRANSFER_SERVER_SEP0024" ||
      key === "TRANSFER_SERVER" ||
      key === "SIGNING_KEY" ||
      key === "NETWORK_PASSPHRASE"
    ) {
      value[key] = val;
    }
  }
  flush();
  return value;
}

export async function loadToml(): Promise<AnchorToml> {
  if (cachedToml && Date.now() - cachedToml.at < 10 * 60_000) {
    return cachedToml.value;
  }
  const url = `${anchorOrigin()}/.well-known/stellar.toml`;
  const res = await sepHttp.fetch(url);
  if (!res.ok) {
    const msg = `failed to fetch ${url}: ${res.status}`;
    log.error(msg);
    throw new Error(msg);
  }
  const value = parseStellarToml(await res.text());
  cachedToml = { at: Date.now(), value };
  return value;
}

/** Prefer ANCHOR_ASSET_CODE, then SRT (what testanchor issues), then USDC. */
export function pickAnchorAsset(toml: AnchorToml): { code: string; issuer: string } {
  const wanted = (config.anchorAssetCode || "SRT").toUpperCase();
  const issued = toml.currencies.filter((c) => c.code && c.issuer);
  const match = issued.find((c) => c.code.toUpperCase() === wanted);
  if (match?.issuer) return { code: match.code, issuer: match.issuer };
  const srt = issued.find((c) => c.code.toUpperCase() === "SRT");
  if (srt?.issuer) return { code: srt.code, issuer: srt.issuer };
  const usdc = issued.find((c) => c.code.toUpperCase() === "USDC");
  if (usdc?.issuer) return { code: usdc.code, issuer: usdc.issuer };
  throw new Error("stellar.toml lists no SRT/USDC credit asset with an issuer");
}

export async function resolveAnchorAsset(): Promise<{ code: string; issuer: string }> {
  return pickAnchorAsset(await loadToml());
}

export function signSep10Challenge(
  transactionXdr: string,
  networkPassphrase: string,
  kp: Keypair,
): string {
  const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  tx.sign(kp);
  return tx.toXDR();
}

/** SEP-10: challenge + signed response against the configured anchor. */
export async function sep10(kp: Keypair): Promise<string> {
  try {
    const toml = await loadToml();
    const auth = toml.WEB_AUTH_ENDPOINT;
    if (!auth) throw new Error("anchor stellar.toml missing WEB_AUTH_ENDPOINT");
    const challengeUrl = new URL(auth);
    challengeUrl.searchParams.set("account", kp.publicKey());
    challengeUrl.searchParams.set(
      "home_domain",
      anchorOrigin().replace(/^https?:\/\//, ""),
    );
    const challengeRes = await sepHttp.fetch(challengeUrl.toString());
    if (!challengeRes.ok) {
      throw new Error(
        `SEP-10 challenge failed: ${challengeRes.status} ${await challengeRes.text()}`,
      );
    }
    const { transaction, network_passphrase } = (await challengeRes.json()) as {
      transaction: string;
      network_passphrase?: string;
    };
    if (!transaction) throw new Error("SEP-10 challenge missing transaction XDR");
    const passphrase = network_passphrase ?? config.networkPassphrase;
    const signed = signSep10Challenge(transaction, passphrase, kp);
    const tokenRes = await sepHttp.fetch(auth, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signed }),
    });
    if (!tokenRes.ok) {
      throw new Error(
        `SEP-10 token failed: ${tokenRes.status} ${await tokenRes.text()}`,
      );
    }
    const body = (await tokenRes.json()) as { token: string };
    if (!body.token) throw new Error("SEP-10 response missing token");
    return body.token;
  } catch (err) {
    log.error("SEP-10 failed", { err: String(err), account: kp.publicKey() });
    throw err;
  }
}

export type KycFields = {
  first_name: string;
  last_name: string;
  email_address: string;
  id_type?: string;
  id_number?: string;
  address?: string;
  mobile_number?: string;
};

export async function sep12Put(
  token: string,
  account: string,
  fields: KycFields,
): Promise<{ id?: string; status: string }> {
  const toml = await loadToml();
  const kyc = toml.KYC_SERVER;
  if (!kyc) throw new Error("anchor stellar.toml missing KYC_SERVER");
  const body = new FormData();
  body.set("account", account);
  for (const [key, value] of Object.entries(fields)) {
    if (value) body.set(key, value);
  }
  const res = await sepHttp.fetch(`${kyc}/customer`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    error?: string;
  };
  if (!res.ok) {
    const msg = `SEP-12 PUT failed: ${res.status} ${json.error ?? JSON.stringify(json)}`;
    log.error(msg);
    throw new Error(msg);
  }
  return { id: json.id, status: (json.status ?? "NEEDS_INFO").toUpperCase() };
}

export async function sep12Get(
  token: string,
  account: string,
  id?: string | null,
): Promise<{ id?: string; status: string; fields?: unknown }> {
  const toml = await loadToml();
  const kyc = toml.KYC_SERVER;
  if (!kyc) throw new Error("anchor stellar.toml missing KYC_SERVER");
  const url = new URL(`${kyc}/customer`);
  url.searchParams.set("account", account);
  if (id) url.searchParams.set("id", id);
  const res = await sepHttp.fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    fields?: unknown;
    error?: string;
  };
  if (!res.ok) {
    const msg = `SEP-12 GET failed: ${res.status} ${json.error ?? JSON.stringify(json)}`;
    log.error(msg);
    throw new Error(msg);
  }
  return {
    id: json.id,
    status: (json.status ?? "NEEDS_INFO").toUpperCase(),
    fields: json.fields,
  };
}

export type Sep24Transaction = {
  id: string;
  status: string;
  kind?: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  more_info_url?: string;
  stellar_transaction_id?: string;
  message?: string;
};

export type WithdrawPayment = {
  destination: string;
  amount: string;
  memo?: string;
  memoType?: string;
  assetCode: string;
  assetIssuer: string;
};

const FATAL_SEP24 = new Set([
  "error",
  "expired",
  "refunded",
  "no_market",
  "too_small",
  "too_large",
]);

export function unwrapSep24Transaction(json: unknown): Sep24Transaction {
  if (json && typeof json === "object" && "transaction" in json) {
    return (json as { transaction: Sep24Transaction }).transaction;
  }
  return json as Sep24Transaction;
}

export function isPendingUserTransferStart(status: string): boolean {
  return status === "pending_user_transfer_start";
}

export function buildWithdrawPayment(
  tx: Sep24Transaction,
  fallback: { amount: string; assetCode: string; assetIssuer: string },
): WithdrawPayment {
  if (tx.status && !isPendingUserTransferStart(tx.status)) {
    throw new Error(
      `cannot build withdraw payment: status is ${tx.status}, need pending_user_transfer_start`,
    );
  }
  if (!tx.withdraw_anchor_account) {
    throw new Error("SEP-24 transaction missing withdraw_anchor_account");
  }
  let assetCode = fallback.assetCode;
  let assetIssuer = fallback.assetIssuer;
  const stellarAsset = tx.amount_in_asset?.startsWith("stellar:")
    ? tx.amount_in_asset.slice("stellar:".length)
    : undefined;
  if (stellarAsset && stellarAsset !== "native") {
    const [code, issuer] = stellarAsset.split(":");
    if (code && issuer) {
      assetCode = code;
      assetIssuer = issuer;
    }
  }
  const amount = tx.amount_in ?? fallback.amount;
  if (!amount) throw new Error("SEP-24 transaction missing amount_in");
  return {
    destination: tx.withdraw_anchor_account,
    amount,
    memo: tx.withdraw_memo,
    memoType: tx.withdraw_memo_type,
    assetCode,
    assetIssuer,
  };
}

async function sep24Form(
  path: string,
  opts: { token: string; account: string; amount: string; assetCode?: string },
): Promise<{ id: string; url: string; type: string }> {
  const toml = await loadToml();
  const sep24 = toml.TRANSFER_SERVER_SEP0024;
  if (!sep24) throw new Error("anchor stellar.toml missing TRANSFER_SERVER_SEP0024");
  const asset = opts.assetCode ?? (await resolveAnchorAsset()).code;
  const body = new FormData();
  body.set("asset_code", asset);
  body.set("account", opts.account);
  body.set("amount", opts.amount);
  const url = `${sep24}${path}`;
  const res = await sepHttp.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    type?: string;
    url?: string;
    id?: string;
    error?: string;
  };
  if (!res.ok || !json.url || !json.id) {
    const msg = `SEP-24 ${path} failed: ${res.status} ${json.error ?? JSON.stringify(json)}`;
    log.error(msg);
    throw new Error(msg);
  }
  return { id: json.id, url: json.url, type: json.type ?? "interactive_customer_info_needed" };
}

export async function sep24Withdraw(opts: {
  token: string;
  account: string;
  amount: string;
  assetCode?: string;
}): Promise<{ id: string; url: string; type: string }> {
  try {
    return await sep24Form("/transactions/withdraw/interactive", opts);
  } catch (err) {
    log.error("SEP-24 withdraw start failed", { err: String(err), account: opts.account });
    throw err;
  }
}

export async function sep24Deposit(opts: {
  token: string;
  account: string;
  amount: string;
  assetCode?: string;
}): Promise<{ id: string; url: string; type: string }> {
  try {
    return await sep24Form("/transactions/deposit/interactive", opts);
  } catch (err) {
    log.error("SEP-24 deposit start failed", { err: String(err), account: opts.account });
    throw err;
  }
}

export async function sep24Transaction(token: string, id: string): Promise<unknown> {
  const toml = await loadToml();
  const sep24 = toml.TRANSFER_SERVER_SEP0024;
  if (!sep24) throw new Error("anchor stellar.toml missing TRANSFER_SERVER_SEP0024");
  const url = new URL(`${sep24}/transaction`);
  url.searchParams.set("id", id);
  const res = await sepHttp.fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const msg = `SEP-24 transaction lookup failed: ${res.status} ${await res.text()}`;
    log.error(msg, { id });
    throw new Error(msg);
  }
  return res.json();
}

export async function pollSep24Transaction(opts: {
  token: string;
  id: string;
  until: string[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<Sep24Transaction> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const start = Date.now();
  let last: Sep24Transaction | undefined;
  while (Date.now() - start < timeoutMs) {
    const wrapped = await sep24Transaction(opts.token, opts.id);
    last = unwrapSep24Transaction(wrapped);
    log.info("SEP-24 status", { id: opts.id, status: last.status });
    if (opts.until.includes(last.status)) return last;
    if (FATAL_SEP24.has(last.status)) {
      throw new Error(
        `SEP-24 transaction ${opts.id} ended with status ${last.status}${
          last.message ? `: ${last.message}` : ""
        }`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `SEP-24 poll timed out after ${timeoutMs}ms waiting for ${opts.until.join("|")}; last=${last?.status ?? "none"}`,
  );
}

export const horizonPassphrase = config.networkPassphrase;
