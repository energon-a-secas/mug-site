// Sliding-window limits per Clerk subject (docs/CONTRACTS.md C9). One table so
// the numbers are reviewable in one place; rate.ts enforces them.

export const LIMITS = {
  "shelf.write": { max: 240, windowMs: 60 * 60 * 1000 },
  "profile.edit": { max: 30, windowMs: 60 * 60 * 1000 },
  "handle.change": { max: 3, windowMs: 30 * 24 * 60 * 60 * 1000 },
  "photo.upload": { max: 20, windowMs: 24 * 60 * 60 * 1000 },
  "suggestion.create": { max: 30, windowMs: 24 * 60 * 60 * 1000 },
  "runner.request": { max: 3000, windowMs: 60 * 60 * 1000 },
} as const;

export type LimitName = keyof typeof LIMITS;

// Stale rows one call may delete, so an idle bucket cannot make one request pay
// for a month of history; the daily sweep takes the rest.
export const RATE_PRUNE_MAX = 25;
