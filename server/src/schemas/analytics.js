import { z } from 'zod';

// How many recent hourly snapshots to return alongside the latest one, for
// the dashboard's trend chart. 168 = one week of hourly snapshots as a sane
// upper bound.
export const getAnalyticsSummaryQuery = z.object({
  range: z.coerce.number().int().min(1).max(168).default(24),
});
