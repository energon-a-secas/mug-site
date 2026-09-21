// Small helpers the cores share.

/** A copy without undefined values: an insert should name only the fields it sets. */
export function compact<T extends Record<string, unknown>>(object: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out as T;
}

/** Control characters out, whitespace collapsed, bounded. For free text a person typed. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max).trim();
}
