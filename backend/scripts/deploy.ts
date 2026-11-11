import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { config, ROOT, type TestnetConfig } from "../src/config.ts";
import { fundAccount } from "../src/stellar.ts";
import { log } from "../src/log.ts";

const wasmDir = resolve(ROOT, "wasm");

function run(bin: string, args: string[], input?: string): string {
  const result = execFileSync(bin, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
  });
  return String(result).trim();
}

function stellar(args: string[]): string {
  return run("stellar", args);
}

function wasmPath(name: string): string {
  const dirs = [
    wasmDir,
    resolve(ROOT, "target", "wasm32v1-none", "release"),
  ];
  if (process.env.CARGO_TARGET_DIR) {
    dirs.push(resolve(process.env.CARGO_TARGET_DIR, "wasm32v1-none", "release"));
  }
  const path = dirs.map((dir) => resolve(dir, `${name}.wasm`)).find((p) => existsSync(p));
  if (!path) {
    throw new Error(`missing ${name}.wasm — run stellar contract build`);
  }
  mkdirSync(wasmDir, { recursive: true });
  const pinned = resolve(wasmDir, `${name}.wasm`);
  if (path !== pinned) {
    copyFileSync(path, pinned);
  }
  return pinned;
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function deployWasm(path: string, source: string, alias: string): string {
  const out = stellar([
    "contract",
    "deploy",
    "--wasm",
    path,
    "--source-account",
    source,
    "--network",
    "testnet",
    "--alias",
    alias,
  ]);
  const id = lastNonEmptyLine(out);
  if (!id.startsWith("C")) {
    throw new Error(`deploy ${alias} did not return a contract id:\n${out}`);
  }
  log.info("deployed", { alias, id });
  return id;
}

function invokeCli(id: string, source: string, method: string, args: string[]): string {
  const out = stellar([
    "contract",
    "invoke",
    "--id",
    id,
    "--source-account",
    source,
    "--network",
    "testnet",
    "--",
    method,
    ...args,
  ]);
  return out;
}

export async function ensureDeployer(): Promise<Keypair> {
  let secret = config.deployerSecret;
  if (!secret) {
    const kp = Keypair.random();
    secret = kp.secret();
    const envPath = resolve(ROOT, ".env");
    if (!existsSync(envPath)) {
      writeFileSync(envPath, `DEPLOYER_SECRET=${secret}\n`, "utf8");
    } else if (!readFileSync(envPath, "utf8").includes("DEPLOYER_SECRET=")) {
      appendFileSync(envPath, `\nDEPLOYER_SECRET=${secret}\n`);
    } else if (readFileSync(envPath, "utf8").match(/DEPLOYER_SECRET=\s*$/m)) {
      const next = readFileSync(envPath, "utf8").replace(
        /DEPLOYER_SECRET=.*$/m,
        `DEPLOYER_SECRET=${secret}`,
      );
      writeFileSync(envPath, next);
    }
    config.deployerSecret = secret;
    log.info("generated DEPLOYER_SECRET and wrote it to .env (not logged)");
  }
  const kp = Keypair.fromSecret(secret);
  await fundAccount(kp.publicKey());
  log.info("deployer ready", { publicKey: kp.publicKey() });
  return kp;
}

export async function deployTestnet(): Promise<TestnetConfig> {
  const deployer = await ensureDeployer();
  const source = deployer.secret();

  const haveWasm = ["reputation", "lending_pool", "marketplace_escrow"].every((name) =>
    existsSync(resolve(wasmDir, `${name}.wasm`)),
  );
  if (haveWasm) {
    log.info("using existing wasm/ artifacts");
  } else {
    log.info("building contracts");
    stellar(["contract", "build"]);
  }

  const usdcAsset = config.e2eMintUsdc
    ? `${config.usdcAssetCode}:${deployer.publicKey()}`
    : `${config.usdcAssetCode}:${config.usdcIssuer}`;

  log.info("deploying USDC Stellar Asset Contract", { usdcAsset });
  const usdcOut = stellar([
    "contract",
    "asset",
    "deploy",
    "--asset",
    usdcAsset,
    "--source-account",
    source,
    "--network",
    "testnet",
  ]);
  const usdcContractId = lastNonEmptyLine(usdcOut);
  if (!usdcContractId.startsWith("C")) {
    throw new Error(`USDC SAC deploy failed:\n${usdcOut}`);
  }

  const reputationContractId = deployWasm(wasmPath("reputation"), source, "zao-reputation");
  const lendingPoolContractId = deployWasm(wasmPath("lending_pool"), source, "zao-lending-pool");
  const escrowContractId = deployWasm(wasmPath("marketplace_escrow"), source, "zao-escrow");

  log.info("initializing contracts");
  invokeCli(reputationContractId, source, "initialize", ["--admin", deployer.publicKey()]);
  invokeCli(reputationContractId, source, "set_writer", ["--writer", lendingPoolContractId]);
  invokeCli(lendingPoolContractId, source, "initialize", [
    "--admin",
    deployer.publicKey(),
    "--usdc",
    usdcContractId,
    "--reputation",
    reputationContractId,
  ]);
  invokeCli(escrowContractId, source, "initialize", [
    "--admin",
    deployer.publicKey(),
    "--usdc",
    usdcContractId,
  ]);

  const cfg: TestnetConfig = {
    network: "testnet",
    usdcAsset,
    usdcContractId,
    reputationContractId,
    lendingPoolContractId,
    escrowContractId,
    deployerPublicKey: deployer.publicKey(),
    deployedAt: new Date().toISOString(),
  };
  mkdirSync(resolve(ROOT, "config"), { recursive: true });
  writeFileSync(resolve(ROOT, "config", "testnet.json"), JSON.stringify(cfg, null, 2) + "\n");
  log.info("wrote config/testnet.json", cfg);
  return cfg;
}

const isMain = process.argv[1]?.includes("deploy");
if (isMain) {
  deployTestnet().catch((err) => {
    log.error("deploy failed", { err: String(err) });
    process.exit(1);
  });
}
