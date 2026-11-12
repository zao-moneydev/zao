const SECRET_RE = /(secret|seed|private|encrypted|token|authorization|password)/i;

function redactSecrets(value: string): string {
  return value
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "[REDACTED_JWT]");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_RE.test(k) ? "[REDACTED]" : sanitize(v);
    }
    return out;
  }
  return value;
}

function write(level: string, msg: string, extra?: Record<string, unknown>) {
  const line = extra ? `${msg} ${JSON.stringify(sanitize(extra))}` : msg;
  if (level === "error") console.error(`[zao] ${line}`);
  else console.log(`[zao] ${line}`);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};
