import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import cors from "cors";
import { api } from "./api.ts";
import { config, loadTestnetConfig } from "./config.ts";
import { dbDriver } from "./db.ts";
import { startLoanMonitor } from "./jobs.ts";
import { log } from "./log.ts";

if (!config.walletKey) {
  throw new Error("WALLET_ENCRYPTION_KEY is required. Copy .env.example to .env and generate a key.");
}

const app = express();
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value,
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/api", api);

const publicDir = resolve(process.cwd(), "public");
const indexHtml = resolve(publicDir, "index.html");
if (existsSync(indexHtml)) {
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(indexHtml);
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      name: "Zao",
      docs: "/api/health",
    });
  });
}

export default app;

if (!process.env.VERCEL) {
  startLoanMonitor(60_000);
  app.listen(config.port, () => {
    const cfg = loadTestnetConfig();
    log.info("zao backend listening", {
      port: config.port,
      network: config.network,
      anchor: config.anchorHomeDomain,
      lendingPool: cfg.lendingPoolContractId || "(not deployed)",
      db: dbDriver,
    });
  });
}
