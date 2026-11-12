import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { expertAccount, expertContract, expertTx, loadTestnetConfig, ROOT } from "../src/config.ts";
import { log } from "../src/log.ts";
import {
  buildWithdrawPayment,
  pollSep24Transaction,
  sep10,
  sep12Put,
  sep12Get,
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
  sendWithdrawPayment,
  toStroops,
  usdcAsset,
} from "../src/stellar.ts";
import { deployTestnet, ensureDeployer } from "./deploy.ts";
import { completeSep24Interactive } from "./sep24-interactive.ts";

type Step = { name: string; hash?: string; expert?: string; extra?: unknown };

const steps: Step[] = [];
const evidenceDir = resolve(ROOT, "evidence");
const screenshotPath = resolve(evidenceDir, "screenshots", "sep24-interactive.png");

function redactExtra(extra: unknown): unknown {
  const raw = JSON.stringify(extra, (_k, v) => {
    if (typeof v === "string") {
      return v
        .replace(/token=[^&]+/gi, "token=[REDACTED]")
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "[REDACTED_JWT]");
    }
    return v;
  });
  return JSON.parse(raw);
}

function printStep(step: Step) {
  steps.push(step);
  const link = step.hash ? ` ${expertTx(step.hash)}` : "";
  console.log(`\n==> ${step.name}${step.hash ? `\n    tx: ${step.hash}${link}` : ""}`);
  if (step.extra) console.log(`    ${JSON.stringify(redactExtra(step.extra))}`);
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
  const kyc = await sep12Get(token, kp.publicKey(), put.id);
  printStep({ name: `SEP-12 KYC ${kp.publicKey()}`, extra: { status: kyc.status, id: kyc.id } });
  return token;
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

function writeEvidence(body: string) {
  mkdirSync(resolve(evidenceDir, "screenshots"), { recursive: true });
  writeFileSync(resolve(evidenceDir, "deliverable2.md"), body, "utf8");
}

async function main() {
  mkdirSync(resolve(evidenceDir, "screenshots"), { recursive: true });
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
      reputation: cfg.reputationContractId,
      escrow: cfg.escrowContractId,
      assetSac: cfg.usdcContractId,
      asset: cfg.usdcAsset,
      deployer: cfg.deployerPublicKey,
      lendingPoolExplorer: expertContract(cfg.lendingPoolContractId),
      assetSacExplorer: expertContract(cfg.usdcContractId),
    },
  });

  const principal = toStroops("2");
  const withdrawAmount = "2";

  const lender = Keypair.random();
  const leader = Keypair.random();
  const memberB = Keypair.random();
  const memberC = Keypair.random();
  const members = [leader, memberB, memberC];

  for (const kp of [lender, ...members]) {
    await fundAccount(kp.publicKey());
    const trust = await ensureTrustline(kp, usdcAsset());
    printStep({
      name: `funded + trustline ${kp.publicKey()}`,
      hash: trust ?? undefined,
      expert: trust ? expertTx(trust) : undefined,
      extra: { explorer: expertAccount(kp.publicKey()) },
    });
  }

  printStep({ name: "SEP-24 deposit to fund the lender with the anchor asset" });
  const lenderToken = await kycFor(lender, "lender.zao.d2@example.com");
  const deposit = await sep24Deposit({
    token: lenderToken,
    account: lender.publicKey(),
    amount: "5",
    assetCode,
  });
  printStep({ name: "SEP-24 deposit interactive started", extra: deposit });
  await completeSep24Interactive(deposit.url, screenshotPath, "5");
  const deposited = await pollSep24Transaction({
    token: lenderToken,
    id: deposit.id,
    until: ["completed"],
    timeoutMs: 180_000,
    intervalMs: 4_000,
  });
  printStep({
    name: "SEP-24 deposit completed",
    extra: { id: deposited.id, status: deposited.status, stellar: deposited.stellar_transaction_id },
  });

  const lenderBal = await creditBalance(lender.publicKey(), assetCode, assetIssuer);
  printStep({ name: "lender asset balance after deposit", extra: { balance: lenderBal } });
  const available = Number(lenderBal);
  if (!(available >= 2)) {
    throw new Error(`lender has ${lenderBal} ${assetCode}; need at least 2 after SEP-24 deposit`);
  }
  const poolUnits = Math.min(Math.floor(available), 4).toFixed(0);
  const poolAmount = toStroops(poolUnits);

  const depositPool = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "deposit",
    args: [lender.publicKey(), poolAmount],
    source: lender,
  });
  printStep({ name: "deposit into lending pool", ...depositPool });

  const group = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "create_group",
    args: [leader.publicKey(), members.map((m) => m.publicKey())],
    source: leader,
  });
  const groupId = Number(group.returnValue);
  printStep({ name: "create_group (3 members)", ...group, extra: { groupId } });

  const loan = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "request_loan",
    args: [{ u64: groupId }, principal],
    source: leader,
  });
  const loanId = Number(loan.returnValue);
  printStep({ name: "request_loan 2 units", ...loan, extra: { loanId } });

  for (const member of members) {
    const signed = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "sign",
      args: [{ u64: groupId }, member.publicKey()],
      source: member,
    });
    printStep({ name: `sign by ${member.publicKey()}`, ...signed });
  }

  const kycOnchain = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "set_kyc_approved",
    args: [deployer.publicKey(), leader.publicKey(), true],
    source: deployer,
  });
  printStep({ name: "set_kyc_approved(leader)", ...kycOnchain });

  const disburse = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "disburse",
    args: [{ u64: groupId }],
    source: leader,
  });
  printStep({ name: "disburse to group leader", ...disburse });

  const leaderBal = await creditBalance(leader.publicKey(), assetCode, assetIssuer);
  printStep({ name: "leader balance after disburse", extra: { balance: leaderBal } });

  printStep({ name: "SEP-24 withdraw for the group leader" });
  const leaderToken = await kycFor(leader, "leader.zao.d2@example.com");
  const withdraw = await sep24Withdraw({
    token: leaderToken,
    account: leader.publicKey(),
    amount: withdrawAmount,
    assetCode,
  });
  printStep({ name: "SEP-24 withdraw interactive started", extra: withdraw });
  await completeSep24Interactive(
    withdraw.url,
    resolve(evidenceDir, "screenshots", "sep24-withdraw-interactive.png"),
    withdrawAmount,
  );

  const pending = await pollSep24Transaction({
    token: leaderToken,
    id: withdraw.id,
    until: ["pending_user_transfer_start"],
    timeoutMs: 180_000,
    intervalMs: 4_000,
  });
  printStep({
    name: "anchor ready for payment (pending_user_transfer_start)",
    extra: {
      id: pending.id,
      status: pending.status,
      withdraw_anchor_account: pending.withdraw_anchor_account,
      withdraw_memo: pending.withdraw_memo,
      amount_in: pending.amount_in,
    },
  });

  const payment = buildWithdrawPayment(pending, {
    amount: withdrawAmount,
    assetCode,
    assetIssuer,
  });
  const sent = await sendWithdrawPayment(leader, payment);
  printStep({
    name: "USDC/SRT payment to withdraw_anchor_account",
    ...sent,
    extra: {
      destination: payment.destination,
      amount: payment.amount,
      memo: payment.memo,
      memoType: payment.memoType,
    },
  });

  let final = pending;
  try {
    final = await pollSep24Transaction({
      token: leaderToken,
      id: withdraw.id,
      until: ["completed"],
      timeoutMs: 180_000,
      intervalMs: 4_000,
    });
  } catch (err) {
    log.error("SEP-24 did not reach completed", { err: String(err) });
    final = unwrapSep24Transaction(await sep24Transaction(leaderToken, withdraw.id));
  }
  printStep({
    name: "SEP-24 final status",
    extra: {
      id: final.id,
      status: final.status,
      stellar_transaction_id: final.stellar_transaction_id,
    },
  });

  const md = `# Deliverable 2 evidence — testnet SEP-24 payout

Anchor: \`${cfg.anchorHomeDomain ?? "https://testanchor.stellar.org"}\`
Asset (from stellar.toml): \`${cfg.usdcAsset}\`
Generated: ${new Date().toISOString()}

## Contract IDs

| Contract | ID | Explorer |
|---|---|---|
| Asset SAC | \`${cfg.usdcContractId}\` | ${expertContract(cfg.usdcContractId)} |
| reputation | \`${cfg.reputationContractId}\` | ${expertContract(cfg.reputationContractId)} |
| lending_pool | \`${cfg.lendingPoolContractId}\` | ${expertContract(cfg.lendingPoolContractId)} |
| marketplace_escrow | \`${cfg.escrowContractId}\` | ${expertContract(cfg.escrowContractId)} |

## Transaction hashes

${steps
  .filter((s) => s.hash)
  .map((s) => `- **${s.name}**: [\`${s.hash}\`](${expertTx(s.hash!)})`)
  .join("\n")}

## SEP-24 withdraw

- Transaction id: \`${withdraw.id}\`
- Interactive URL: ${withdraw.url.replace(/token=[^&]+/gi, "token=[REDACTED]")}
- Final status: **${final.status}**
- Withdraw account: \`${payment.destination}\`
- Payment tx: [\`${sent.hash}\`](${expertTx(sent.hash)})
- Screenshot: \`evidence/screenshots/sep24-interactive.png\` (deposit) and \`evidence/screenshots/sep24-withdraw-interactive.png\` (withdraw)

## Notes

Payment to the anchor's \`withdraw_anchor_account\` is a live testnet Horizon submit. Nothing here is mocked.
`;
  writeEvidence(md);

  console.log("\n========== Deliverable 2 payout summary ==========");
  for (const step of steps.filter((s) => s.hash)) {
    console.log(`- ${step.name}: ${step.hash} ${step.expert}`);
  }
  console.log(`- SEP-24 id: ${withdraw.id}`);
  console.log(`- SEP-24 final status: ${final.status}`);
  console.log(`- payment: ${sent.hash} ${sent.expert}`);
  console.log(`- evidence: evidence/deliverable2.md`);

  if (!sent.hash) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error("demo:payout failed", { err: String(err) });
  console.error(err);
  process.exit(1);
});
