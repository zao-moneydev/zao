import { fromStroops, toStroops } from "./amounts.ts";
import { config } from "./config.ts";

export type GateCode =
  | "ALLOWED"
  | "KYC_NEEDS_INFO"
  | "KYC_PROCESSING"
  | "KYC_REJECTED"
  | "KYC_UNKNOWN"
  | "AML_AMOUNT"
  | "AML_DENYLIST";

export type GateDecision = {
  allowed: boolean;
  code: GateCode;
  reason: string;
  kycStatus: string;
  amount: string;
  publicKey: string;
};

export type GateInput = {
  kycStatus: string;
  /** Loan principal in stroops (7-decimal integer string or bigint). */
  amountStroops: string | bigint | number;
  publicKey: string;
  maxAmountHuman?: string;
  denylist?: string[];
};

const STATUS_CODES: Record<string, GateCode> = {
  NEEDS_INFO: "KYC_NEEDS_INFO",
  PROCESSING: "KYC_PROCESSING",
  REJECTED: "KYC_REJECTED",
};

export function parseDenylist(raw = config.amlDenylist): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^G[A-Z2-7]{55}$/.test(s));
}

export function evaluateDisburseGate(input: GateInput): GateDecision {
  const kycStatus = (input.kycStatus || "NEEDS_INFO").toUpperCase();
  const amountStroops = BigInt(input.amountStroops);
  const amount = fromStroops(amountStroops);
  const publicKey = input.publicKey;
  const maxHuman = input.maxAmountHuman ?? config.amlMaxAmount;
  const denylist = input.denylist ?? parseDenylist();
  const base = { kycStatus, amount, publicKey };

  if (kycStatus !== "ACCEPTED") {
    const code = STATUS_CODES[kycStatus] ?? "KYC_UNKNOWN";
    return {
      ...base,
      allowed: false,
      code,
      reason: `KYC/AML gate: disbursement blocked until the anchor reports ACCEPTED (current: ${kycStatus})`,
    };
  }

  if (denylist.includes(publicKey.toUpperCase())) {
    return {
      ...base,
      allowed: false,
      code: "AML_DENYLIST",
      reason: `AML: address ${publicKey} is on the denylist`,
    };
  }

  const maxStroops = toStroops(maxHuman);
  if (amountStroops > maxStroops) {
    return {
      ...base,
      allowed: false,
      code: "AML_AMOUNT",
      reason: `AML: amount ${amount} exceeds the maximum of ${maxHuman}`,
    };
  }

  return {
    ...base,
    allowed: true,
    code: "ALLOWED",
    reason: "KYC ACCEPTED and AML checks passed",
  };
}
