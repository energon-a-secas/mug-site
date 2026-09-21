// Admin identity, the fleet pattern (vitrina, sash, buyhacks): membership of
// ADMIN_SUBJECTS, comma separated Clerk subjects. The list arrives as an
// argument, so cores never read process.env and tests can hand one in.

/** Blanks and surrounding space are ignored. */
export function adminSubjects(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exact match only. An unset list means nobody is an admin, never everybody. */
export function isAdminSubject(subject: string | null | undefined, raw: string | null | undefined): boolean {
  if (!subject) return false;
  return adminSubjects(raw).includes(subject);
}
