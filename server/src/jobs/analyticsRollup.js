import { prisma } from '../lib/prisma.js';
import { forTenant } from '../lib/tenantDb.js';
import { logger } from '../utils/logger.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hourly rollup: computes per-tenant analytics for the trailing 24h window
 * and appends an AnalyticsSnapshot row per tenant. Invoked by the BullMQ
 * repeatable job registered in src/jobs/queue.js, but kept free of any
 * BullMQ import so it stays directly callable/testable and usable as a
 * manual "backfill now" CLI invocation.
 *
 * Window choice: trailing 24h, recomputed fresh on every run (not "since the
 * last snapshot"). This is self-healing — a missed run (worker down, Redis
 * blip) never leaves a permanent gap that needs catch-up logic. Trade-off:
 * consecutive hourly snapshots' windows overlap, so `totalConversations`
 * across snapshots is NOT additive/summable into a true daily total — the
 * resulting series is a rolling-24h trend sampled hourly, not disjoint
 * hourly buckets.
 *
 * Known approximations (no better signal exists in the schema today):
 *  - AI-resolved % is a proxy: CLOSED conversations with no AGENT message
 *    and no assignedAgentId are treated as "the AI resolved this alone."
 *    There's no explicit "resolved by AI" flag.
 *  - Avg time-to-first-human-response uses the conversation's `createdAt`
 *    as the clock start, since there's no explicit "escalated to WAITING
 *    at" timestamp. This overstates the wait if a conversation spent time
 *    with the AI before escalating.
 *  - Active agents = distinct `assignedAgentId` values touched in the
 *    window, i.e. "agents who worked a conversation," not "currently
 *    online" — there's no presence/lastSeenAt tracking yet.
 * If these approximations prove too inaccurate in practice, the documented
 * fallback (not implemented here) is adding nullable
 * `Conversation.firstAgentResponseAt` / `closedAt` columns backfilled at
 * write-time in conversations.js / the AI responder.
 */
export async function runAnalyticsRollup({ now = new Date() } = {}) {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - WINDOW_MS);

  // Listing every tenant is not request-scoped, so forTenant() doesn't apply
  // here — this is a deliberate, documented exception to the "always go
  // through forTenant()" rule (see src/lib/tenantDb.js), and the first place
  // in the codebase that needs a cross-tenant query.
  const tenants = await prisma.tenant.findMany({ select: { id: true } });

  for (const { id: tenantId } of tenants) {
    try {
      const snapshot = await computeTenantSnapshot(tenantId, periodStart, periodEnd);
      const db = forTenant(tenantId);
      await db.analyticsSnapshot.create({ data: snapshot });
      logger.info(
        { tenantId, ...snapshot, periodStart, periodEnd },
        'analyticsRollup: tenant snapshot computed',
      );
    } catch (err) {
      logger.error({ err, tenantId }, 'analyticsRollup: failed to roll up tenant');
    }
  }
}

async function computeTenantSnapshot(tenantId, periodStart, periodEnd) {
  const db = forTenant(tenantId);
  const windowWhere = { createdAt: { gte: periodStart, lt: periodEnd } };

  const totalConversations = await db.conversation.count({ where: windowWhere });

  const aiResolvedPct = await computeAiResolvedPct(db, windowWhere);
  const avgFirstResponseMs = await computeAvgFirstResponseMs(db, windowWhere);
  const activeAgents = await computeActiveAgents(db, windowWhere);

  return { periodStart, periodEnd, totalConversations, aiResolvedPct, avgFirstResponseMs, activeAgents };
}

async function computeAiResolvedPct(db, windowWhere) {
  const closed = await db.conversation.findMany({
    where: { ...windowWhere, status: 'CLOSED' },
    select: { id: true, assignedAgentId: true },
  });
  if (closed.length === 0) return 0;

  const agentTouched = await db.message.findMany({
    where: { conversationId: { in: closed.map((c) => c.id) }, role: 'AGENT' },
    select: { conversationId: true },
    distinct: ['conversationId'],
  });
  const touchedSet = new Set(agentTouched.map((m) => m.conversationId));

  const aiResolvedCount = closed.filter(
    (c) => c.assignedAgentId == null && !touchedSet.has(c.id),
  ).length;

  return aiResolvedCount / closed.length;
}

async function computeAvgFirstResponseMs(db, windowWhere) {
  const conversations = await db.conversation.findMany({
    where: windowWhere,
    select: { id: true, createdAt: true },
  });
  if (conversations.length === 0) return null;

  const agentMessages = await db.message.findMany({
    where: { conversationId: { in: conversations.map((c) => c.id) }, role: 'AGENT' },
    orderBy: { createdAt: 'asc' },
    select: { conversationId: true, createdAt: true },
  });

  // Ascending order means the first time we see a conversationId is its
  // first AGENT reply — keep only that one.
  const firstAgentReplyByConversation = new Map();
  for (const msg of agentMessages) {
    if (!firstAgentReplyByConversation.has(msg.conversationId)) {
      firstAgentReplyByConversation.set(msg.conversationId, msg.createdAt);
    }
  }

  const deltas = [];
  for (const conversation of conversations) {
    const firstReplyAt = firstAgentReplyByConversation.get(conversation.id);
    if (firstReplyAt) {
      deltas.push(firstReplyAt.getTime() - conversation.createdAt.getTime());
    }
  }

  if (deltas.length === 0) return null;
  const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  return Math.round(avg);
}

async function computeActiveAgents(db, windowWhere) {
  const rows = await db.conversation.findMany({
    where: { ...windowWhere, assignedAgentId: { not: null } },
    select: { assignedAgentId: true },
    distinct: ['assignedAgentId'],
  });
  return rows.length;
}

export default { runAnalyticsRollup };
