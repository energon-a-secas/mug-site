// Runner tokens (docs/CONTRACTS.md C8): "mugr_" and 32 base62 characters.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const TOKEN_RE = /^mugr_[0-9A-Za-z]{32}$/;

/** Rejection sampling keeps every character equally likely. Call from an action only. */
export function newToken(): string {
  let out = "";
  while (out.length < 32) {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 248 && out.length < 32) out += ALPHABET[b % 62];
    }
  }
  return `mugr_${out}`;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
