import { isAdminSubject } from "./admin.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";

// Who is calling, for function handlers. Cores never call these: they take a
// subject as an argument, which is what makes them testable without Convex.

type AuthCtx = { auth: { getUserIdentity(): Promise<{ subject: string; name?: string } | null> } };

export async function subjectOf(ctx: AuthCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? identity.subject : null;
}

export function adminList(): string | undefined {
  return process.env.ADMIN_SUBJECTS;
}

export async function isAdmin(ctx: AuthCtx): Promise<boolean> {
  return isAdminSubject(await subjectOf(ctx), adminList());
}

export const NOT_SIGNED_IN = "Sign in first.";

/** { subject } for a signed-in admin, or the failure to return. */
export async function requireAdmin(ctx: AuthCtx): Promise<{ ok: true; subject: string } | Failure> {
  const subject = await subjectOf(ctx);
  if (!subject) return fail("not-signed-in", NOT_SIGNED_IN);
  if (!isAdminSubject(subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
  return { ok: true, subject };
}

export async function requireSubject(ctx: AuthCtx): Promise<{ ok: true; subject: string } | Failure> {
  const subject = await subjectOf(ctx);
  return subject ? { ok: true, subject } : fail("not-signed-in", NOT_SIGNED_IN);
}
