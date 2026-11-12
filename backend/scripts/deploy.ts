import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { config, ROOT, type TestnetConfig } from "../src/config.ts";
import { loadToml, pickAnchorAsset } from "../src/sep.ts";
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
  try {
    return run("stellar", args);
  } catch (err) {
    const extra =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: string }).stderr)
        : "";
    const safe = args.map((a) => (/^S[A-Z2-7]{55}$/.test(a) ? "[REDACTED_SECRET]" : a));
    throw new Error(`stellar ${safe.join(" ")} failed: ${extra || String(err)}`);
  }
}

function wasmPath(name: string): string {
  const pinned = resolve(wasmDir, `${name}.wasm`);
  if (!existsSync(pinned)) {
    throw new Error(
      `missing wasm/${name}.wasm — Deliverable 1 optimized artifacts are required`,
    );
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

  for (const name of ["reputation", "lending_pool", "marketplace_escrow"]) {
    wasmPath(name);
  }
  log.info("using optimized wasm/ artifacts");

  const toml = await loadToml();
  const asset = pickAnchorAsset(toml);
  const usdcAsset = `${asset.code}:${asset.issuer}`;
  log.info("anchor asset from stellar.toml", {
    code: asset.code,
    issuer: asset.issuer,
    home: config.anchorHomeDomain,
  });

  log.info("resolving Stellar Asset Contract for the anchor asset", {
    code: asset.code,
    issuer: asset.issuer,
  });
  let usdcContractId = lastNonEmptyLine(
    stellar(["contract", "id", "asset", "--asset", usdcAsset, "--network", "testnet"]),
  );
  try {
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
    const deployed = lastNonEmptyLine(usdcOut);
    if (deployed.startsWith("C")) usdcContractId = deployed;
  } catch (err) {
    const msg = String(err);
    if (!/ExistingValue|already exists/i.test(msg)) throw err;
    log.info("SAC already on-network, using derived contract id");
  }
  if (!usdcContractId.startsWith("C")) {
    throw new Error(`could not resolve SAC id for ${asset.code}`);
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
    anchorHomeDomain: config.anchorHomeDomain,
    assetCode: asset.code,
    assetIssuer: asset.issuer,
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
