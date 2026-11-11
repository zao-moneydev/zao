const SECRET_RE = /(secret|seed|private|encrypted|token|authorization|password)/i;

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("S") && value.length === 56) return "[REDACTED_SECRET]";
    if (value.length > 40 && value.includes(":")) return "[REDACTED]";
    return value;
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
