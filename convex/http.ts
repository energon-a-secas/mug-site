import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { hashToken, TOKEN_RE } from "./lib/tokens.ts";

// The local runner's endpoints (docs/CONTRACTS.md C8), at
// <CONVEX_SITE_URL>/runner/*. Server to server: no CORS, JSON in and out, and
// a runner token on every request.

const MAX_BODY = 5 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function authorize(ctx: any, request: Request): Promise<Response | { prefix: string }> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!TOKEN_RE.test(token)) return json(401, { ok: false, code: "unauthorized", message: "Send Authorization: Bearer mugr_..." });
  const row = await ctx.runQuery(internal.runnerTokens.byHash, { hash: await hashToken(token) });
  if (!row) return json(401, { ok: false, code: "unauthorized", message: "That runner token is unknown or revoked." });
  const allowed = await ctx.runMutation(internal.runner.touch, { tokenId: row.id, prefix: row.prefix });
  if (!allowed) return json(429, { ok: false, code: "rate-limited", message: "Too many runner requests this hour." });
  return { prefix: row.prefix };
}

async function body(request: Request): Promise<any> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("too-large");
  return text ? JSON.parse(text) : {};
}

function route(handler: (ctx: any, request: Request, who: { prefix: string }) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const who = await authorize(ctx, request);
    if (who instanceof Response) return who;
    try {
      return await handler(ctx, request, who);
    } catch (err: any) {
      if (err && err.message === "too-large") return json(413, { ok: false, code: "too-large", message: "Request body over 5 MB." });
      if (err instanceof SyntaxError) return json(400, { ok: false, code: "bad-json", message: "The body is not JSON." });
      return json(500, { ok: false, code: "internal", message: String(err?.message || err).slice(0, 200) });
    }
  });
}

const http = httpRouter();

http.route({
  path: "/runner/queue",
  method: "GET",
  handler: route(async (ctx, request) => {
    const limit = Number(new URL(request.url).searchParams.get("limit") || 25);
    const items = await ctx.runQuery(internal.runner.queue, { limit: Number.isFinite(limit) ? limit : 25 });
    return json(200, { ok: true, items });
  }),
});

http.route({
  path: "/runner/ingest",
  method: "POST",
  handler: route(async (ctx, request) => {
    const input = await body(request);
    if (typeof input.id !== "string") return json(400, { ok: false, code: "bad-body", message: "id is required." });
    const error = input.error && typeof input.error === "object"
      ? {
          code: String(input.error.code || "INTERNAL").slice(0, 40),
          message: String(input.error.message || "").slice(0, 300),
          ...(input.error.retryable === true ? { retryable: true } : {}),
        }
      : undefined;
    const url = typeof input.url === "string" ? input.url.slice(0, 2048) : undefined;
    const result = await ctx.runMutation(internal.runner.ingest, { id: input.id, url, listing: input.listing, error });
    return json(result.ok ? 200 : 400, result);
  }),
});

http.route({
  path: "/runner/scan",
  method: "POST",
  handler: route(async (ctx, request, who) => {
    const input = await body(request);
    if (typeof input.sourceSlug !== "string") return json(400, { ok: false, code: "bad-body", message: "sourceSlug is required." });
    const result = await ctx.runMutation(internal.runner.startScan, { sourceSlug: input.sourceSlug, prefix: who.prefix });
    return json(result.ok ? 200 : 400, result);
  }),
});

http.route({
  path: "/runner/stage",
  method: "POST",
  handler: route(async (ctx, request) => {
    const input = await body(request);
    if (typeof input.runId !== "string" || !Array.isArray(input.listings)) {
      return json(400, { ok: false, code: "bad-body", message: "runId and listings are required." });
    }
    const result = await ctx.runMutation(internal.runner.stage, { runId: input.runId, listings: input.listings });
    return json(result.ok ? 200 : 400, result);
  }),
});

http.route({
  path: "/runner/finish",
  method: "POST",
  handler: route(async (ctx, request) => {
    const input = await body(request);
    if (typeof input.runId !== "string") return json(400, { ok: false, code: "bad-body", message: "runId is required." });
    const result = await ctx.runMutation(internal.runner.finish, {
      runId: input.runId,
      error: typeof input.error === "string" && input.error ? input.error : undefined,
    });
    return json(result.ok ? 200 : 400, result);
  }),
});

http.route({
  path: "/runner/upload-url",
  method: "POST",
  handler: route(async (ctx) => json(200, { ok: true, uploadUrl: await ctx.storage.generateUploadUrl() })),
});

http.route({
  path: "/runner/image",
  method: "POST",
  handler: route(async (ctx, request) => {
    const input = await body(request);
    if (typeof input.mugId !== "string" || !Number.isInteger(input.index) || typeof input.storageId !== "string") {
      return json(400, { ok: false, code: "bad-body", message: "mugId, index and storageId are required." });
    }
    // A9: the URL, when sent, decides which image this is; positions shift as others land.
    const url = typeof input.url === "string" ? input.url.slice(0, 2048) : undefined;
    const target = await ctx.runQuery(internal.runner.imageTarget, { mugId: input.mugId, index: input.index, url });
    if (!target) return json(400, { ok: false, code: "not-pending", message: "That image is not waiting for the runner." });
    const result = await ctx.runAction(internal.images.acceptRunnerImage, { mugId: target.mugId, index: target.index, storageId: input.storageId });
    return json(result.ok ? 200 : 400, result);
  }),
});

export default http;
