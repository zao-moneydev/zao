import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config, expertTx, loadTestnetConfig } from "./config.ts";
import type { WithdrawPayment } from "./sep.ts";

const horizon = new Horizon.Server(config.horizonUrl);
const server = new rpc.Server(config.rpcUrl, { allowHttp: false });

export { horizon, server };

export function usdcAsset(): Asset {
  const cfg = loadTestnetConfig();
  const [code, issuer] = (cfg.usdcAsset || `${config.usdcAssetCode}:${config.usdcIssuer}`).split(
    ":",
  );
  if (!code || !issuer) {
    throw new Error("USDC asset is not configured");
  }
  return new Asset(code, issuer);
}

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await horizon.loadAccount(publicKey);
    return true;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404) return false;
    throw err;
  }
}

export async function fundAccount(publicKey: string): Promise<void> {
  if (await accountExists(publicKey)) return;
  const url = `${config.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const body = await res.text();
        if (body.toLowerCase().includes("already funded") || res.status === 400) {
          return;
        }
        throw new Error(`friendbot failed: ${res.status} ${body}`);
      }
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
      if (await accountExists(publicKey)) return;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function toMemo(memo: string, memoType?: string): Memo {
  const kind = (memoType ?? "text").toLowerCase();
  if (kind === "id") return Memo.id(memo);
  if (kind === "hash" || kind === "return") {
    const buf = /^[0-9a-fA-F]{64}$/.test(memo)
      ? Buffer.from(memo, "hex")
      : Buffer.from(memo, "base64");
    return kind === "return" ? Memo.return(buf) : Memo.hash(buf);
  }
  return Memo.text(memo.slice(0, 28));
}

/** Classic payment (SEP-24 withdraw) to the anchor with the required memo. */
export async function submitClassicPayment(opts: {
  source: Keypair;
  destination: string;
  amount: string;
  asset?: Asset;
  memo?: string;
  memoType?: string;
}): Promise<{ hash: string; expert: string }> {
  const asset = opts.asset ?? usdcAsset();
  const account = await horizon.loadAccount(opts.source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 10),
    networkPassphrase: config.networkPassphrase,
  }).addOperation(
    Operation.payment({
      destination: opts.destination,
      asset,
      amount: opts.amount,
    }),
  );
  if (opts.memo) builder.addMemo(toMemo(opts.memo, opts.memoType));
  const tx = builder.setTimeout(60).build();
  tx.sign(opts.source);
  const result = await horizon.submitTransaction(tx);
  return { hash: result.hash, expert: expertTx(result.hash) };
}

export async function sendWithdrawPayment(
  source: Keypair,
  payment: WithdrawPayment,
): Promise<{ hash: string; expert: string }> {
  return submitClassicPayment({
    source,
    destination: payment.destination,
    amount: payment.amount,
    asset: new Asset(payment.assetCode, payment.assetIssuer),
    memo: payment.memo,
    memoType: payment.memoType,
  });
}

export async function ensureTrustline(kp: Keypair, asset = usdcAsset()): Promise<string | null> {
  const account = await horizon.loadAccount(kp.publicKey());
  const exists = account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === asset.code &&
      "asset_issuer" in b &&
      b.asset_issuer === asset.issuer,
  );
  if (exists) return null;
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

export type InvokeResult = {
  hash: string;
  expert: string;
  returnValue: unknown;
};

function scAddress(value: string): xdr.ScVal {
  return new Address(value).toScVal();
}

export function scArgs(values: unknown[]): xdr.ScVal[] {
  return values.map((value) => {
    if (value instanceof xdr.ScVal) return value;
    if (typeof value === "string" && (value.startsWith("G") || value.startsWith("C"))) {
      return scAddress(value);
    }
    if (typeof value === "bigint" || typeof value === "number") {
      return nativeToScVal(value, { type: "i128" });
    }
    if (Array.isArray(value)) {
      return xdr.ScVal.scvVec(value.map((item) => scAddress(String(item))));
    }
    if (typeof value === "boolean") return nativeToScVal(value);
    if (typeof value === "object" && value && "u64" in value) {
      return nativeToScVal((value as { u64: number | bigint }).u64, { type: "u64" });
    }
    return nativeToScVal(value as never);
  });
}

export async function readContract(opts: {
  contractId: string;
  method: string;
  args: unknown[];
  source: Keypair;
}): Promise<unknown> {
  const sourceAccount = await server.getAccount(opts.source.publicKey());
  const contract = new Contract(opts.contractId);
  const built = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(opts.method, ...scArgs(opts.args)))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(built);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`${opts.method} simulation failed: ${JSON.stringify(sim)}`);
  }
  return scValToNative(sim.result.retval);
}

export async function invoke(opts: {
  contractId: string;
  method: string;
  args: unknown[];
  source: Keypair;
  extraSigners?: Keypair[];
}): Promise<InvokeResult> {
  const sourceAccount = await server.getAccount(opts.source.publicKey());
  const contract = new Contract(opts.contractId);
  const built = new TransactionBuilder(sourceAccount, {
    fee: String(Number(BASE_FEE) * 20),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(opts.method, ...scArgs(opts.args)))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(opts.source);
  for (const extra of opts.extraSigners ?? []) {
    if (extra.publicKey() !== opts.source.publicKey()) {
      prepared.sign(extra);
    }
  }

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(
      `sendTransaction ERROR for ${opts.method}: ${JSON.stringify(sent.errorResult)}`,
    );
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`RPC asked to retry ${opts.method}`);
  }

  const hash = sent.hash;
  const finished = await waitForTx(hash);
  if (finished.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `${opts.method} failed: ${finished.status} ${JSON.stringify(finished, null, 0).slice(0, 500)}`,
    );
  }
  let returnValue: unknown = null;
  if (finished.returnValue) {
    try {
      returnValue = jsonSafe(scValToNative(finished.returnValue));
    } catch {
      returnValue = finished.returnValue.toXDR("base64");
    }
  }
  return { hash, expert: expertTx(hash), returnValue };
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

async function waitForTx(hash: string, attempts = 40): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < attempts; i++) {
    const tx = await server.getTransaction(hash);
    if (tx.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return tx;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${hash}`);
}

export async function latestAccountTx(publicKey: string): Promise<string | null> {
  const page = await horizon.transactions().forAccount(publicKey).order("desc").limit(1).call();
  return page.records[0]?.hash ?? null;
}

export const contracts = () => loadTestnetConfig();

export { dueAmount, fromStroops, toStroops, USDC_DECIMALS } from "./amounts.ts";

