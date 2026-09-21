// The one result shape every Mug function returns (docs/CONTRACTS.md C6),
// vitrina's convention. Expected failures come back as values, never thrown:
// a thrown error reaches the browser as an opaque "Server Error" with its code
// stripped, and the page needs the code to say what went wrong.

export type Failure = { ok: false; code: string; message: string; [k: string]: unknown };
export type Success = { ok: true; [k: string]: unknown };
export type Result = Failure | Success;

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): Failure {
  return { ok: false, code, message, ...extra };
}

export function done(extra: Record<string, unknown> = {}): Success {
  return { ok: true, ...extra };
}
