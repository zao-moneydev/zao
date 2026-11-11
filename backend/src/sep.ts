import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "./config.ts";

export type AnchorToml = {
  WEB_AUTH_ENDPOINT?: string;
  KYC_SERVER?: string;
  TRANSFER_SERVER_SEP0024?: string;
  TRANSFER_SERVER?: string;
  SIGNING_KEY?: string;
  NETWORK_PASSPHRASE?: string;
};

let cachedToml: { at: number; value: AnchorToml } | null = null;

export function anchorOrigin(): string {
  return config.anchorHomeDomain.replace(/\/$/, "");
}

export async function loadToml(): Promise<AnchorToml> {
  if (cachedToml && Date.now() - cachedToml.at < 10 * 60_000) {
    return cachedToml.value;
  }
  const url = `${anchorOrigin()}/.well-known/stellar.toml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  const value: AnchorToml = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^(WEB_AUTH_ENDPOINT|KYC_SERVER|TRANSFER_SERVER_SEP0024|TRANSFER_SERVER|SIGNING_KEY|NETWORK_PASSPHRASE)\s*=\s*"?([^"]+)"?/,
    );
    if (match) {
      value[match[1] as keyof AnchorToml] = match[2];
    }
  }
  cachedToml = { at: Date.now(), value };
  return value;
}

/** SEP-10: challenge + signed response against the configured anchor. */
export async function sep10(kp: Keypair): Promise<string> {
  const toml = await loadToml();
  const auth = toml.WEB_AUTH_ENDPOINT;
  if (!auth) throw new Error("anchor stellar.toml missing WEB_AUTH_ENDPOINT");
  const challengeUrl = new URL(auth);
  challengeUrl.searchParams.set("account", kp.publicKey());
  challengeUrl.searchParams.set("home_domain", anchorOrigin().replace(/^https?:\/\//, ""));
  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
  }
  const { transaction, network_passphrase } = (await challengeRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };
  const passphrase = network_passphrase ?? config.networkPassphrase;
  const tx = TransactionBuilder.fromXDR(transaction, passphrase);
  tx.sign(kp);
  const tokenRes = await fetch(auth, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (!tokenRes.ok) {
    throw new Error(`SEP-10 token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const body = (await tokenRes.json()) as { token: string };
  if (!body.token) throw new Error("SEP-10 response missing token");
  return body.token;
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
  const res = await fetch(`${kyc}/customer`, {
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
    throw new Error(`SEP-12 PUT failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    fields?: unknown;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`SEP-12 GET failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
  }
  return {
    id: json.id,
    status: (json.status ?? "NEEDS_INFO").toUpperCase(),
    fields: json.fields,
  };
}

export async function sep24Withdraw(opts: {
  token: string;
  account: string;
  amount: string;
  assetCode?: string;
}): Promise<{ id: string; url: string; type: string }> {
  const toml = await loadToml();
  const sep24 = toml.TRANSFER_SERVER_SEP0024;
  if (!sep24) throw new Error("anchor stellar.toml missing TRANSFER_SERVER_SEP0024");
  const body = new FormData();
  body.set("asset_code", opts.assetCode ?? config.anchorAssetCode);
  body.set("account", opts.account);
  body.set("amount", opts.amount);
  const res = await fetch(`${sep24}/transactions/withdraw/interactive`, {
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
    throw new Error(`SEP-24 withdraw failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
  }
  return { id: json.id, url: json.url, type: json.type ?? "interactive_customer_info_needed" };
}

export async function sep24Deposit(opts: {
  token: string;
  account: string;
  amount: string;
  assetCode?: string;
}): Promise<{ id: string; url: string; type: string }> {
  const toml = await loadToml();
  const sep24 = toml.TRANSFER_SERVER_SEP0024;
  if (!sep24) throw new Error("anchor stellar.toml missing TRANSFER_SERVER_SEP0024");
  const body = new FormData();
  body.set("asset_code", opts.assetCode ?? config.anchorAssetCode);
  body.set("account", opts.account);
  body.set("amount", opts.amount);
  const res = await fetch(`${sep24}/transactions/deposit/interactive`, {
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
    throw new Error(`SEP-24 deposit failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
  }
  return { id: json.id, url: json.url, type: json.type ?? "interactive_customer_info_needed" };
}

export async function sep24Transaction(token: string, id: string) {
  const toml = await loadToml();
  const sep24 = toml.TRANSFER_SERVER_SEP0024;
  if (!sep24) throw new Error("anchor stellar.toml missing TRANSFER_SERVER_SEP0024");
  const url = new URL(`${sep24}/transaction`);
  url.searchParams.set("id", id);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`SEP-24 transaction lookup failed: ${res.status}`);
  return res.json();
}

export const horizonPassphrase = config.networkPassphrase;
