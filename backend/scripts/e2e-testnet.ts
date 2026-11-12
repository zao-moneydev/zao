import { Keypair } from "@stellar/stellar-sdk";
import { expertAccount, expertTx, loadTestnetConfig } from "../src/config.ts";
import { log } from "../src/log.ts";
import { sep10, sep12Get, sep12Put, sep24Withdraw } from "../src/sep.ts";
import {
  dueAmount,
  ensureTrustline,
  fundAccount,
  invoke,
  readContract,
  toStroops,
} from "../src/stellar.ts";
import { deployTestnet, ensureDeployer } from "./deploy.ts";

type Step = { name: string; hash?: string; expert?: string; extra?: unknown };

function printStep(step: Step) {
  const link = step.hash ? ` ${expertTx(step.hash)}` : "";
  console.log(`\n==> ${step.name}${step.hash ? `\n    tx: ${step.hash}${link}` : ""}`);
  if (step.extra) console.log(`    ${JSON.stringify(step.extra)}`);
}

async function main() {
  const steps: Step[] = [];
  const deployer = await ensureDeployer();
  let cfg = loadTestnetConfig();
  if (!cfg.lendingPoolContractId) {
    printStep({ name: "deploying contracts to testnet" });
    cfg = await deployTestnet();
  }
  printStep({
    name: "contracts",
    extra: {
      lendingPool: cfg.lendingPoolContractId,
      reputation: cfg.reputationContractId,
      escrow: cfg.escrowContractId,
      usdc: cfg.usdcContractId,
      deployer: cfg.deployerPublicKey,
      deployerExplorer: expertAccount(cfg.deployerPublicKey),
    },
  });

  const principal = toStroops("10");
  const due = dueAmount(principal);
  const poolLiquidity = toStroops("100");

  // SAC mint to the issuer account is invalid. Use a separate lender.
  const lender = Keypair.random();
  await fundAccount(lender.publicKey());
  const trust = await ensureTrustline(lender);
  if (trust) {
    printStep({ name: "lender USDC trustline", hash: trust, extra: { lender: lender.publicKey() } });
  }

  const issuer = (cfg.usdcAsset.split(":")[1] ?? "").trim();
  if (issuer && issuer === deployer.publicKey()) {
    printStep({ name: "mint USDC to lender (deployer-issued SAC)" });
    const mint = await invoke({
      contractId: cfg.usdcContractId,
      method: "mint",
      args: [lender.publicKey(), poolLiquidity],
      source: deployer,
    });
    steps.push({ name: "mint USDC to lender", ...mint, extra: { lender: lender.publicKey() } });
    printStep(steps[steps.length - 1]);
  } else {
    printStep({
      name: "skip mint — pool asset is the anchor's SRT/USDC (use npm run demo:payout to fund via SEP-24)",
      extra: { usdcAsset: cfg.usdcAsset },
    });
  }

  const deposit = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "deposit",
    args: [lender.publicKey(), poolLiquidity],
    source: lender,
  });
  steps.push({ name: "deposit USDC into lending pool", ...deposit });
  printStep(steps[steps.length - 1]);

  const members = [Keypair.random(), Keypair.random(), Keypair.random()];
  const [leader, b, c] = members;
  for (const kp of members) {
    await fundAccount(kp.publicKey());
    await ensureTrustline(kp);
    printStep({
      name: `funded member ${kp.publicKey()}`,
      extra: { explorer: expertAccount(kp.publicKey()) },
    });
  }

  const group = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "create_group",
    args: [leader.publicKey(), members.map((m) => m.publicKey())],
    source: leader,
  });
  const groupId = Number(group.returnValue);
  steps.push({ name: "create_group", ...group, extra: { groupId } });
  printStep(steps[steps.length - 1]);

  const loan = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "request_loan",
    args: [{ u64: groupId }, principal],
    source: leader,
  });
  const loanId = Number(loan.returnValue);
  steps.push({ name: "request_loan 10 USDC", ...loan, extra: { loanId, principal: principal.toString() } });
  printStep(steps[steps.length - 1]);

  for (const member of members) {
    const signed = await invoke({
      contractId: cfg.lendingPoolContractId,
      method: "sign",
      args: [{ u64: groupId }, member.publicKey()],
      source: member,
    });
    steps.push({ name: `sign by ${member.publicKey()}`, ...signed });
    printStep(steps[steps.length - 1]);
  }

  const kycFlag = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "set_kyc_approved",
    args: [deployer.publicKey(), leader.publicKey(), true],
    source: deployer,
  });
  steps.push({ name: "set_kyc_approved(leader)", ...kycFlag });
  printStep(steps[steps.length - 1]);

  printStep({ name: "SEP-10 + SEP-12 KYC for the group leader (testanchor.stellar.org)" });
  const token = await sep10(leader);
  const put = await sep12Put(token, leader.publicKey(), {
    first_name: "Thabo",
    last_name: "Mokoena",
    email_address: "thabo.zao.e2e@example.com",
    id_type: "national_id",
    id_number: "8001015009087",
    address: "Cape Town, South Africa",
  });
  const kyc = await sep12Get(token, leader.publicKey(), put.id);
  printStep({ name: "KYC status", extra: kyc });
  if (kyc.status !== "ACCEPTED") {
    console.log(
      "    KYC is not ACCEPTED yet. Disbursement is gated in the API; the e2e script continues with the on-chain disburse because the contract itself does not enforce KYC.",
    );
  }

  const disburse = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "disburse",
    args: [{ u64: groupId }],
    source: leader,
  });
  steps.push({ name: "disburse USDC to leader", ...disburse });
  printStep(steps[steps.length - 1]);

  printStep({ name: "SEP-24 withdraw (cash-out) — interactive URL from the live anchor" });
  try {
    const withdraw = await sep24Withdraw({
      token,
      account: leader.publicKey(),
      amount: "1",
    });
    printStep({
      name: "anchor withdraw created",
      extra: withdraw,
    });
    console.log(
      "    Complete cash-out in the hosted window. This script does not fake settlement.",
    );
  } catch (err) {
    printStep({
      name: "anchor withdraw error (live network, not mocked)",
      extra: { err: String(err) },
    });
  }

  const mintInterest = await invoke({
    contractId: cfg.usdcContractId,
    method: "mint",
    args: [leader.publicKey(), due - principal],
    source: deployer,
  });
  steps.push({ name: "mint 10% interest so leader can repay 110%", ...mintInterest });
  printStep(steps[steps.length - 1]);

  const repay = await invoke({
    contractId: cfg.lendingPoolContractId,
    method: "repay",
    args: [{ u64: groupId }, leader.publicKey()],
    source: leader,
  });
  steps.push({ name: "repay principal + 10%", ...repay, extra: { due: due.toString() } });
  printStep(steps[steps.length - 1]);

  for (const member of members) {
    const score = await readContract({
      contractId: cfg.reputationContractId,
      method: "get_score",
      args: [member.publicKey()],
      source: member,
    });
    printStep({
      name: `reputation ${member.publicKey()}`,
      extra: { score },
    });
  }

  console.log("\n========== Zao testnet e2e summary ==========");
  for (const step of steps) {
    console.log(`- ${step.name}: ${step.hash} ${step.expert}`);
  }
}

main().catch((err) => {
  log.error("e2e failed", { err: String(err) });
  console.error(err);
  process.exit(1);
});
