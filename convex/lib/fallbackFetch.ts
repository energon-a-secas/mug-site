// C4.3's last resort: this deployment fetches an image itself when the Worker
// is not configured. It obeys the same rules as the Worker and the runner
// (C10): MugBot's own User-Agent, the SSRF guard, robots.txt, the caps.
// Implemented on shared/net/polite.js once that module lands; until then a
// fetch here refuses, so nothing can bypass robots.txt by this path.

export type DirectImage =
  | { ok: true; blob: Blob; w?: number; h?: number }
  | { ok: false; code: string; message: string };

export async function fetchImageDirect(_url: string): Promise<DirectImage> {
  return { ok: false, code: "NOT_CONFIGURED", message: "The direct image fetch is not wired to shared/net/polite.js yet." };
}
