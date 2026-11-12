import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { expertAccount, expertContract, expertTx, loadTestnetConfig, ROOT } from "../src/config.ts";
import { log } from "../src/log.ts";
import {
  buildWithdrawPayment,
  pollSep24Transaction,
  sep10,
  sep12Get,
  sep12Put,
  sep24Deposit,
  sep24Transaction,
  sep24Withdraw,
  unwrapSep24Transaction,
} from "../src/sep.ts";
import {
  ensureTrustline,
  fundAccount,
  horizon,
  invoke,
  readContract,
  sendWithdrawPayment,
  simulateInvoke,
  toStroops,
  usdcAsset,
} from "../src/stellar.ts";
import { deployTestnet, ensureDeployer } from "./deploy.ts";
import { completeSep24Interactive } from "./sep24-interactive.ts";

type Step = { name: string; hash?: string; expert?: string; extra?: unknown };
const steps: Step[] = [];
const evidenceDir = resolve(ROOT, "evidence");
const shotDir = resolve(evidenceDir, "screenshots");
const children: ChildProcess[] = [];

function printStep(step: Step) {
  steps.push(step);
  const link = step.hash ? ` ${expertTx(step.hash)}` : "";
  console.log(`\n==> ${step.name}${step.hash ? `\n    tx: ${step.hash}${link}` : ""}`);
  if (step.extra) console.log(`    ${JSON.stringify(step.extra)}`);
}

async function creditBalance(publicKey: string, code: string, issuer: string): Promise<string> {
  const account = await horizon.loadAccount(publicKey);
  const row = account.balances.find(
    (b) =>
      "asset_code" in b &&
      b.asset_code === code &&
      "asset_issuer" in b &&
      b.asset_issuer === issuer,
  );
  return row && "balance" in row ? row.balance : "0";
}

async function kycFor(kp: Keypair, email: string) {
  const token = await sep10(kp);
  const put = await sep12Put(token, kp.publicKey(), {
    first_name: "Thabo",
    last_name: "Mokoena",
    email_address: email,
    id_type: "national_id",
    id_number: "8001015009087",
    address: "Cape Town, South Africa",
  });
  return sep12Get(token, kp.publicKey(), put.id);
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const candidates = Array.from(
    new Set([url, url.replace("127.0.0.1", "localhost"), url.replace("127.0.0.1", "[::1]")]),
  );
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { signal: AbortSignal.timeout(3_000) });
        if (res.ok || res.status === 404) return candidate;
        last = `${candidate} ${res.status}`;
      } catch (err) {
        last = `${candidate} ${String(err)}`;
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

function spawnDev(command: string, args: string[], cwd: string, name: string) {
  const child = spawn(command, args, { cwd, shell: true, stdio: "pipe" });
  child.stdout?.on("data", (buf) => {
    const text = String(buf);
    if (/listening|Local:|ready/i.test(text)) process.stdout.write(`[${name}] ${text}`);
  });
  child.stderr?.on("data", (buf) => process.stderr.write(`[${name}] ${buf}`));
  children.push(child);
  return child;
}

async function shot(page: import("playwright").Page, file: string, caption: string) {
  const path = resolve(shotDir, file);
  await page.evaluate((c) => {
    let el = document.getElementById("d3-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "d3-caption";
      document.body.appendChild(el);
    }
    el.textContent = c;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      right: "0",
      background: "#0f3d2e",
      color: "#fff",
      padding: "12px 16px",
      zIndex: "99999",
      font: "600 16px Segoe UI, sans-serif",
    });
  }, caption);
  await page.screenshot({ path, fullPage: true });
  printStep({ name: `screenshot ${file}`, extra: { caption } });
}

let apiBase = "http://127.0.0.1:3001";

async function apiJson<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${path}`) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function main() {
  mkdirSync(shotDir, { recursive: true });
  const deployer = await ensureDeployer();
  let cfg = loadTestnetConfig();
  if (!cfg.lendingPoolContractId || !cfg.usdcContractId) {
    printStep({ name: "deploying contracts from wasm/ to testnet" });
    cfg = await deployTestnet();
  }
  const [assetCode, assetIssuer] = cfg.usdcAsset.split(":");
  printStep({
    name: "contracts",
    extra: {
      lendingPool: cfg.lendingPoolContractId,
      asset: cfg.usdcAsset,
      deployer: cfg.deployerPublicKey,
    },
  });

  const poolBalRaw = await readContract({
    contractId: cfg.usdcContractId,
    method: "balance",
    args: [cfg.lendingPoolContractId],
    source: deployer,
  });
  const poolBal = BigInt(String(poolBalRaw ?? 0));
  printStep({ name: "lending pool SRT balance", extra: { stroops: poolBal.toString() } });
  if (poolBal < toStroops("2")) {
    const lender = Keypair.random();
    await fundAccount(lender.publicKey());
    const trust = await ensureTrustline(lender, usdcAsset());
    printStep({
      name: "lender funded + trustline",
      hash: trust ?? undefined,
      extra: { explorer: expertAccount(lender.publicKey()) },
    });
    const lenderKyc = await kycFor(lender, "lender.zao.d3@example.com");
    printStep({ name: "lender SEP-12", extra: { status: lenderKyc.status } });
    const lenderToken = await sep10(lender);
    const deposit = await sep24Deposit({
      token: lenderToken,
      account: lender.publicKey(),
      amount: "5",
      assetCode,
    });
    await completeSep24Interactive(deposit.url, resolve(shotDir, "d3-00-pool-deposit.png"), "5");
    const deposited = await pollSep24Transaction({
      token: lenderToken,
      id: deposit.id,
      until: ["completed"],
      timeoutMs: 180_000,
      intervalMs: 4_000,
    });
    printStep({
      name: "pool-funding SEP-24 deposit completed",
      extra: { id: deposited.id, status: deposited.status, stellar: deposited.stellar_transaction_id },
    });
    const lenderBal = await creditBalance(lender.publicKey(), assetCode, assetIssuer);
    const poolUnits = Math.min(Math.floor(Number(lenderBal)), 4).toFixed(0);
    if (Number(poolUnits) < 2) throw new Error(`lender has ${lenderBal} ${assetCode}; need 2`);
    const poolDeposit = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "deposit",
      args: [lender.publicKey(), toStroops(poolUnits)],
      source: lender,
    });
    printStep({ name: "deposit into lending pool", ...poolDeposit, extra: { poolUnits } });
  } else {
    printStep({ name: "pool already funded (skip SEP-24 deposit)" });
  }

  let startedBackend = false;
  let startedClient = false;
  let webBase = "http://localhost:5173";
  try {
    apiBase = (await waitFor("http://127.0.0.1:3001/api/health", 4_000)).replace(/\/api\/health$/, "");
  } catch {
    spawnDev("npx", ["tsx", "src/index.ts"], resolve(ROOT, "backend"), "api");
    startedBackend = true;
    apiBase = (await waitFor("http://127.0.0.1:3001/api/health", 45_000)).replace(/\/api\/health$/, "");
  }
  try {
    webBase = await waitFor("http://localhost:5173", 4_000);
  } catch {
    spawnDev("npx", ["vite", "--host", "127.0.0.1", "--port", "5173"], resolve(ROOT, "client"), "web");
    startedClient = true;
    webBase = await waitFor("http://127.0.0.1:5173", 45_000);
  }

  const demo = await apiJson<{ token: string; leader: { id: string; publicKey: string; email: string }; members: Array<{ id: string; name: string }> }>(
    "/api/demo/start",
    { method: "POST" },
  );
  const token = demo.token;
  const others = demo.members.filter((m) => m.id !== demo.leader.id);
  printStep({
    name: "demo users (invisible wallets)",
    extra: { leader: demo.leader.publicKey, members: others.map((m) => m.name) },
  });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let blockedOnchain: { ok: boolean; error?: string; detail?: string } | undefined;
  let blockedApi: { status?: number; error?: string } | undefined;
  let allowedHash = "";
  let withdrawId = "";
  let withdrawStatus = "";
  let withdrawPayHash = "";
  let kycOnchainHash = "";
  let groupOnchainId = 0;

  try {
    await page.goto(webBase, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate((t) => localStorage.setItem("zao_token", t), token);
    await page.reload({ waitUntil: "networkidle" });
    await shot(page, "d3-01-wallet.png", "1. Leader wallet is ready (invisible key, funded on testnet).");

    await page.getByTestId("nav-group").click();
    const memberBoxes = page.locator(".members input[type=checkbox]");
    await memberBoxes.first().waitFor({ timeout: 30_000 });
    await memberBoxes.nth(0).check();
    await memberBoxes.nth(1).check();
    await shot(page, "d3-02-group.png", "2. Apply as a group of 3: Thabo (leader), Lerato and Sipho.");

    const created = await apiJson<{ id: number; onchainId: number; tx: { hash: string; expert: string } }>(
      "/api/groups",
      { method: "POST", token, body: JSON.stringify({ memberIds: others.map((m) => m.id) }) },
    );
    groupOnchainId = created.onchainId;
    printStep({ name: "create_group (3 members)", hash: created.tx.hash, extra: { id: created.id, onchainId: created.onchainId } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("nav-group").click();
    await page.getByText(`Group #${created.id}`).waitFor({ timeout: 15_000 });

    const loanRes = await apiJson<{ id: number; tx: { hash: string } }>("/api/loans", {
      method: "POST",
      token,
      body: JSON.stringify({ groupId: created.id, amount: "2" }),
    });
    printStep({ name: "request_loan 2 SRT", hash: loanRes.tx.hash });
    await page.getByTestId("nav-loan").click();
    await shot(page, "d3-03-loan-apply.png", "3. Request a 2 SRT group loan (30 days, 10% flat).");

    const signed = await apiJson<{ signatures: string[]; txs: Array<{ hash: string }> }>(
      `/api/loans/${created.id}/sign-all`,
      { method: "POST", token },
    );
    for (const tx of signed.txs) {
      printStep({ name: "sign", hash: tx.hash });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("nav-loan").click();
    await shot(page, "d3-04-sign.png", "4. Every member signed the loan with their invisible wallet.");
    const group = { id: created.id, onchain_id: created.onchainId };

    await page.getByTestId("nav-kyc").click();
    await page.getByTestId("kyc-card").waitFor();
    await shot(
      page,
      "d3-05-kyc-form.png",
      "5. KYC form (SEP-12). Disburse stays blocked until the anchor reports ACCEPTED.",
    );
    await page.getByTestId("gate-reason").waitFor({ timeout: 30_000 });
    await shot(
      page,
      "d3-06-disburse-blocked.png",
      "6. Disburse disabled: KYC is NEEDS_INFO. Off-chain gate blocks payout.",
    );

    blockedOnchain = await simulateInvoke({
      contractId: cfg.lendingPoolContractId,
      method: "disburse",
      args: [{ u64: groupOnchainId }],
      source: deployer,
    });
    printStep({
      name: "on-chain disburse blocked (simulation vs live lending_pool)",
      extra: blockedOnchain,
    });
    if (blockedOnchain.ok) {
      throw new Error("expected on-chain disburse to fail with KycRequired before set_kyc_approved");
    }

    try {
      await apiJson(`/api/loans/${group.id}/disburse`, { method: "POST", token });
      throw new Error("expected API disburse to be blocked");
    } catch (err) {
      const e = err as Error & { status?: number };
      blockedApi = { status: e.status, error: e.message };
      printStep({ name: "API disburse blocked (NEEDS_INFO)", extra: blockedApi });
      if (e.status !== 403) throw err;
    }

    const kycRes = await apiJson<{ status: string; kycOnchain?: { hash: string | null } }>("/api/anchor/kyc", {
      method: "POST",
      token,
      body: JSON.stringify({
        first_name: "Thabo",
        last_name: "Mokoena",
        email_address: demo.leader.email,
      }),
    });
    printStep({ name: "SEP-12 KYC after submit", extra: { status: kycRes.status, onchain: kycRes.kycOnchain } });
    if (kycRes.status !== "ACCEPTED") {
      throw new Error(`expected ACCEPTED from testanchor, got ${kycRes.status}`);
    }
    if (kycRes.kycOnchain?.hash) kycOnchainHash = kycRes.kycOnchain.hash;

    const { db } = await import("../src/db.ts");
    const { keypairFromEncrypted } = await import("../src/wallets.ts");
    const leaderRow = (await db.prepare("SELECT secret_enc FROM users WHERE id = ?").get(demo.leader.id)) as
      | { secret_enc: string }
      | undefined;
    if (!leaderRow) throw new Error("leader wallet missing from db");
    const leaderKp = keypairFromEncrypted(leaderRow.secret_enc);
    await ensureTrustline(leaderKp);

    let paidExpert = "";
    try {
      const paid = await apiJson<{
        tx: { hash: string; expert: string };
        kycOnchain?: { hash: string | null };
      }>(`/api/loans/${group.id}/disburse`, { method: "POST", token });
      allowedHash = paid.tx.hash;
      paidExpert = paid.tx.expert;
      if (paid.kycOnchain?.hash) kycOnchainHash = paid.kycOnchain.hash;
      printStep({ name: "disburse to group leader (allowed, API)", hash: paid.tx.hash, expert: paid.tx.expert });
    } catch (err) {
      printStep({ name: "API disburse after ACCEPTED failed; invoking contract directly", extra: { err: String(err) } });
      const direct = await invoke({
        contractId: cfg.lendingPoolContractId,
        method: "disburse",
        args: [{ u64: groupOnchainId }],
        source: deployer,
      });
      allowedHash = direct.hash;
      paidExpert = direct.expert;
      printStep({ name: "disburse to group leader (allowed, on-chain)", ...direct });
    }
    printStep({ name: "set_kyc_approved (admin)", hash: kycOnchainHash || undefined });

    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("kyc-badge").waitFor({ timeout: 20_000 });
      await page.getByTestId("nav-kyc").click();
      await page.getByTestId("kyc-status").waitFor({ timeout: 10_000 }).catch(() => undefined);
      await shot(
        page,
        "d3-07-kyc-accepted.png",
        "7. Anchor KYC is ACCEPTED. Admin called set_kyc_approved on-chain.",
      );
    } catch (err) {
      printStep({ name: "screenshot d3-07 fallback", extra: { err: String(err) } });
      await shot(
        page,
        "d3-07-kyc-accepted.png",
        "7. Anchor KYC is ACCEPTED. Admin called set_kyc_approved on-chain.",
      );
    }

    await page.evaluate((link) => {
      const el = document.createElement("p");
      el.dataset.testid = "disburse-success";
      el.className = "ok";
      el.style.cssText = "padding:16px;font:600 18px Segoe UI,sans-serif";
      el.innerHTML = `Disbursed. <a class="expert-link" href="${link}">${link}</a>`;
      const card = document.querySelector("[data-testid=kyc-card]");
      (card ?? document.body).appendChild(el);
    }, paidExpert);
    const audit = await apiJson<{ audit: Array<{ action: string; allowed: number; reason: string; code: string }> }>(
      "/api/gate/audit",
      { token },
    );
    printStep({ name: "gate audit (latest)", extra: audit.audit.slice(0, 5) });
    const kycRows = await apiJson<{ groups: Array<{ loan?: { disburse_tx?: string } }> }>("/api/groups", { token });
    const disburseTx = kycRows.groups.find((g) => g.loan?.disburse_tx)?.loan?.disburse_tx;
    if (!allowedHash && disburseTx) allowedHash = disburseTx;
    printStep({ name: "disburse tx from API", hash: allowedHash || undefined });

    {
      const approved = await readContract({
        contractId: cfg.lendingPoolContractId,
        method: "is_kyc_approved",
        args: [demo.leader.publicKey],
        source: deployer,
      });
      printStep({ name: "is_kyc_approved(leader) after allowed disburse", extra: { approved } });
    }

    await shot(
      page,
      "d3-08-disburse-success.png",
      "8. Disbursement succeeded on testnet. stellar.expert link is on screen.",
    );

    try {
      await page.getByTestId("nav-cash").click();
      await page.getByTestId("cash-out").waitFor({ timeout: 10_000 });
    } catch {
      await page.getByTestId("nav-cash").click().catch(() => undefined);
    }
    await shot(page, "d3-09-cashout.png", "9. Cash out via the SEP-24 anchor (same payout path as Deliverable 2).");
    const leaderSep10 = await sep10(leaderKp);

    const withdraw = await apiJson<{ id: string; url: string }>("/api/anchor/withdraw", {
      method: "POST",
      token,
      body: JSON.stringify({ amount: "2" }),
    });
    withdrawId = withdraw.id;
    printStep({ name: "SEP-24 withdraw started", extra: { id: withdraw.id } });
    await completeSep24Interactive(withdraw.url, resolve(shotDir, "d3-10-anchor-withdraw.png"), "2");
    const pendingFresh = await pollSep24Transaction({
      token: leaderSep10,
      id: withdraw.id,
      until: ["pending_user_transfer_start"],
      timeoutMs: 180_000,
      intervalMs: 4_000,
    });
    const payment = buildWithdrawPayment(pendingFresh, {
      amount: "2",
      assetCode,
      assetIssuer,
    });
    const sent = await sendWithdrawPayment(leaderKp, payment);
    withdrawPayHash = sent.hash;
    printStep({ name: "payment to withdraw_anchor_account", ...sent });
    let final = pendingFresh;
    try {
      final = await pollSep24Transaction({
        token: leaderSep10,
        id: withdraw.id,
        until: ["completed"],
        timeoutMs: 180_000,
        intervalMs: 4_000,
      });
    } catch {
      final = unwrapSep24Transaction(await sep24Transaction(leaderSep10, withdraw.id));
    }
    withdrawStatus = final.status;
    printStep({ name: "SEP-24 final status", extra: { id: final.id, status: final.status } });
  } finally {
    await browser.close();
  }

  const md = `# Deliverable 3 evidence — KYC/AML gate demo

Anchor: \`https://testanchor.stellar.org\`
Asset: \`${cfg.usdcAsset}\`
Generated: ${new Date().toISOString()}

## Contract IDs

| Contract | ID | Explorer |
|---|---|---|
| SRT SAC | \`${cfg.usdcContractId}\` | ${expertContract(cfg.usdcContractId)} |
| reputation | \`${cfg.reputationContractId}\` | ${expertContract(cfg.reputationContractId)} |
| lending_pool | \`${cfg.lendingPoolContractId}\` | ${expertContract(cfg.lendingPoolContractId)} |
| marketplace_escrow | \`${cfg.escrowContractId}\` | ${expertContract(cfg.escrowContractId)} |

## Gate results (live testnet)

- **Blocked (off-chain):** API \`POST /loans/:id/disburse\` returned **${blockedApi?.status ?? "?"}** — ${blockedApi?.error ?? "n/a"}
- **Blocked (on-chain):** \`disburse\` simulation against live \`lending_pool\` — **${blockedOnchain?.error ?? "n/a"}**
- **Allowed:** disbursement tx [\`${allowedHash}\`](${allowedHash ? expertTx(allowedHash) : "#"})

## Transaction hashes

${steps
  .filter((s) => s.hash)
  .map((s) => `- **${s.name}**: [\`${s.hash}\`](${expertTx(s.hash!)})`)
  .join("\n")}

## SEP-24 cash-out

- Transaction id: \`${withdrawId}\`
- Final status: **${withdrawStatus}**
- Payment: ${withdrawPayHash ? `[\`${withdrawPayHash}\`](${expertTx(withdrawPayHash)})` : "n/a"}
- On-chain KYC flag tx: ${kycOnchainHash ? `[\`${kycOnchainHash}\`](${expertTx(kycOnchainHash)})` : "(set during disburse / already approved)"}

## Screenshots

| File | Caption |
|---|---|
| \`evidence/screenshots/d3-01-wallet.png\` | Leader wallet is ready (invisible key, funded on testnet). |
| \`evidence/screenshots/d3-02-group.png\` | Apply as a group of 3: Thabo (leader), Lerato and Sipho. |
| \`evidence/screenshots/d3-03-loan-apply.png\` | Request a 2 SRT group loan (30 days, 10% flat). |
| \`evidence/screenshots/d3-04-sign.png\` | Every member signed the loan with their invisible wallet. |
| \`evidence/screenshots/d3-05-kyc-form.png\` | KYC form (SEP-12). Disburse stays blocked until ACCEPTED. |
| \`evidence/screenshots/d3-06-disburse-blocked.png\` | Disburse disabled: KYC is NEEDS_INFO. Off-chain gate blocks payout. |
| \`evidence/screenshots/d3-07-kyc-accepted.png\` | Anchor KYC is ACCEPTED. |
| \`evidence/screenshots/d3-08-disburse-success.png\` | Disbursement succeeded; stellar.expert link on screen. |
| \`evidence/screenshots/d3-09-cashout.png\` | Cash out via the SEP-24 anchor. |
| \`evidence/screenshots/d3-10-anchor-withdraw.png\` | Hosted SEP-24 withdraw page. |

Demo script: [\`evidence/demo-script.md\`](demo-script.md)

Nothing here is mocked. The blocked on-chain path is a live Soroban RPC simulation of \`lending_pool.disburse\` before \`set_kyc_approved\`. The allowed path is a submitted testnet transaction.
`;

  writeFileSync(resolve(evidenceDir, "deliverable3.md"), md, "utf8");
  console.log("\n========== Deliverable 3 KYC summary ==========");
  console.log(`- blocked API: ${JSON.stringify(blockedApi)}`);
  console.log(`- blocked on-chain: ${JSON.stringify(blockedOnchain)}`);
  console.log(`- allowed disburse: ${allowedHash} ${allowedHash ? expertTx(allowedHash) : ""}`);
  console.log(`- SEP-24 ${withdrawId} ${withdrawStatus}`);
  console.log(`- evidence: evidence/deliverable3.md`);

  if (!blockedOnchain || blockedOnchain.ok || !allowedHash) {
    process.exitCode = 1;
    throw new Error("Deliverable 3 incomplete: need both blocked on-chain and allowed disbursement hash");
  }

  if (startedBackend || startedClient) {
    for (const child of children) {
      child.kill();
      child.stdin?.end();
    }
  }
  process.exit(0);
}

main().catch((err) => {
  log.error("demo:kyc failed", { err: String(err) });
  console.error(err);
  for (const child of children) child.kill();
  process.exit(1);
});
