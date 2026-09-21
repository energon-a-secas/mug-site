// Convex's client for the Worker (docs/CONTRACTS.md C3). Actions only: a query
// or mutation cannot fetch. Every answer comes back as the C3 envelope, and
// anything that is not one (a network failure, an HTML error page) is turned
// into one here, so callers switch on `code` and nothing else.

// C3's codes. tests/proxy-codes.test.mjs holds this list equal to the
// Worker's own ERROR_CODES export, because the two deploy separately.
export const PROXY_CODES = [
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "URL_NOT_ALLOWED",
  "ROBOTS_DISALLOWED",
  "UPSTREAM_BLOCKED",
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "TOO_LARGE",
  "NOT_A_PRODUCT",
  "NOT_AN_IMAGE",
  "NOT_CONFIGURED",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ProxyCode = (typeof PROXY_CODES)[number];
export type ProxyAnswer = { ok: true; [k: string]: any } | { ok: false; code: ProxyCode; message: string; [k: string]: any };

export type ProxyEnv = { MUG_PROXY_URL?: string; MUG_PROXY_TOKEN?: string };

export function proxyConfigured(env: ProxyEnv): boolean {
  return !!(env.MUG_PROXY_URL && env.MUG_PROXY_TOKEN);
}

export function proxyEnv(): ProxyEnv {
  return { MUG_PROXY_URL: process.env.MUG_PROXY_URL, MUG_PROXY_TOKEN: process.env.MUG_PROXY_TOKEN };
}

export async function callProxy(
  env: ProxyEnv,
  path: string,
  opts: { method?: string; json?: unknown; body?: ArrayBuffer | Blob; contentType?: string; timeoutMs?: number } = {},
): Promise<ProxyAnswer> {
  if (!proxyConfigured(env)) {
    return { ok: false, code: "NOT_CONFIGURED", message: "MUG_PROXY_URL and MUG_PROXY_TOKEN are not both set on this deployment." };
  }
  const base = String(env.MUG_PROXY_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = { authorization: `Bearer ${env.MUG_PROXY_TOKEN}` };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    headers["content-type"] = opts.contentType || "application/octet-stream";
    body = opts.body as BodyInit;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(`${base}${path}`, { method: opts.method || "POST", headers, body, signal: controller.signal });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
      if (!parsed.ok && !PROXY_CODES.includes(parsed.code)) parsed.code = "INTERNAL";
      return parsed;
    }
    return { ok: false, code: "INTERNAL", message: `The Worker answered HTTP ${res.status} without a JSON envelope.` };
  } catch (err: any) {
    const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message)));
    return aborted
      ? { ok: false, code: "UPSTREAM_TIMEOUT", message: "The Worker did not answer in time." }
      : { ok: false, code: "INTERNAL", message: `Could not reach the Worker: ${String(err?.message || err).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}
