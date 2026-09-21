import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Watched cloud sources are re-scanned weekly (docs/CONTRACTS.md C2).
crons.weekly("rescan watched sources", { dayOfWeek: "monday", hourUTC: 7, minuteUTC: 0 }, internal.scan.cronWatch);

// Rate-limit rows older than every window, cleared daily.
crons.daily("sweep old rate events", { hourUTC: 4, minuteUTC: 30 }, internal.maintenance.sweepRate);

export default crons;
