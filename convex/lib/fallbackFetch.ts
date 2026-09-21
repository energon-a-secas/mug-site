import { sniffImage } from "../../shared/images/sniff.js";
import { politeFetch } from "../../shared/net/polite.js";

// C4.3's last resort: this deployment fetches an image itself when the Worker
// is not configured. It goes through shared/net/polite.js, the same code the
// Worker and the runner use, so it obeys the same rules (C10): MugBot's own
// User-Agent, the SSRF guard, robots.txt, the timeouts and the caps. The
// bytes are sniffed, never trusted by their Content-Type.

export type DirectImage =
  | { ok: true; blob: Blob; w?: number; h?: number }
  | { ok: false; code: string; message: string };

// Robots answers are cached per host for an hour inside politeFetch; a module
// Map survives between invocations of the same isolate, which is all it needs.
const robotsCache = new Map();

export async function fetchImageDirect(url: string): Promise<DirectImage> {
  const answer: any = await politeFetch(url, { fetchImpl: fetch, robotsCache, kind: "image" });
  if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };
  const sniffed: any = sniffImage(answer.body);
  if (!sniffed) return { ok: false, code: "NOT_AN_IMAGE", message: "That address did not return an image." };
  const out: DirectImage = { ok: true, blob: new Blob([answer.body], { type: sniffed.contentType }) };
  if (sniffed.w) out.w = sniffed.w;
  if (sniffed.h) out.h = sniffed.h;
  return out;
}
