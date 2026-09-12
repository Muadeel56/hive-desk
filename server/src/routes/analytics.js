import { forTenant } from '../lib/tenantDb.js';
import { getAnalyticsSummaryQuery } from '../schemas/analytics.js';

/**
 * Agent-only. Every handler runs `authenticate` then `tenantContext`, so
 * `request.tenantId` is always the caller's own tenant. All queries go
 * through forTenant() — never raw prisma with a client-supplied filter.
 */
export default async function analyticsRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  // GET /analytics/summary — latest AnalyticsSnapshot plus up to `range`
  // recent ones (chronological) for a trend chart. No snapshot yet (first
  // rollup hasn't run, or the tenant has no conversations) is a normal
  // empty state, not an error — 200 with nulls/empties, not a 404.
  fastify.get('/summary', async (request) => {
    const { range } = getAnalyticsSummaryQuery.parse(request.query);
    const db = forTenant(request.tenantId);
    const rows = await db.analyticsSnapshot.findMany({
      orderBy: { periodEnd: 'desc' },
      take: range,
    });
    const series = rows.slice().reverse();
    return { latest: series.at(-1) ?? null, series };
  });
}
