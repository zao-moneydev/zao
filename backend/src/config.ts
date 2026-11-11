import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

dotenv.config({ path: resolve(root, ".env") });
dotenv.config({ path: resolve(here, "..", ".env") });

export const ROOT = root;

export const config = {
  port: Number(process.env.PORT ?? 3001),
  network: process.env.STELLAR_NETWORK ?? "testnet",
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
  friendbotUrl: process.env.FRIENDBOT_URL ?? "https://friendbot.stellar.org",
  deployerSecret: process.env.DEPLOYER_SECRET ?? "",
  usdcAssetCode: process.env.USDC_ASSET_CODE ?? "USDC",
  usdcIssuer:
    process.env.USDC_ISSUER ??
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  walletKey: process.env.WALLET_ENCRYPTION_KEY ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "change-me",
  adminEmail: process.env.ADMIN_USER_EMAIL ?? "admin@zao.local",
  anchorHomeDomain:
    process.env.ANCHOR_HOME_DOMAIN ?? "https://testanchor.stellar.org",
  anchorAssetCode: process.env.ANCHOR_ASSET_CODE ?? "USDC",
  e2eMintUsdc: (process.env.E2E_MINT_USDC ?? "true") === "true",
};

export type TestnetConfig = {
  network: string;
  usdcAsset: string;
  usdcContractId: string;
  reputationContractId: string;
  lendingPoolContractId: string;
  escrowContractId: string;
  deployerPublicKey: string;
  deployedAt?: string;
};

export function loadTestnetConfig(): TestnetConfig {
  const path = resolve(ROOT, "config", "testnet.json");
  if (!existsSync(path)) {
    return {
      network: "testnet",
      usdcAsset: `${config.usdcAssetCode}:${config.usdcIssuer}`,
      usdcContractId: process.env.USDC_CONTRACT_ID ?? "",
      reputationContractId: process.env.REPUTATION_CONTRACT_ID ?? "",
      lendingPoolContractId: process.env.LENDING_POOL_CONTRACT_ID ?? "",
      escrowContractId: process.env.ESCROW_CONTRACT_ID ?? "",
      deployerPublicKey: "",
    };
  }
  return JSON.parse(readFileSync(path, "utf8")) as TestnetConfig;
}

export function expertTx(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function expertContract(id: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${id}`;
}

export function expertAccount(id: string): string {
  return `https://stellar.expert/explorer/testnet/account/${id}`;
}
