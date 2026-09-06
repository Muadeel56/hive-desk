import { z } from 'zod';

// POST /widget/session currently takes no body — the tenant is resolved from the
// `x-widget-api-key` header by the tenantContext plugin. Kept for future fields
// (visitor metadata, page URL, referrer, ...).
export const startSessionSchema = z
  .object({
    pageUrl: z.string().url().max(2000).optional(),
    referrer: z.string().max(2000).optional(),
  })
  .default({});
