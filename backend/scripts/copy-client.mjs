import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "..", "client", "dist");
const pub = resolve(root, "public");
rmSync(pub, { recursive: true, force: true });
cpSync(dist, pub, { recursive: true });
console.log("copied client build to backend/public");
