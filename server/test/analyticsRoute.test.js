import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 7 route tests for GET /analytics/summary: empty-state shape,
 * tenant isolation, and ?range= handling.
 *
 * Requires a migrated database. Hermetic: mints its own tenants via
 * /auth/signup, cleans them up after.
 */

let app;
const suffix = Date.now();
const created = { tenantIds: [] };

test.before(async () => {
  app = await buildApp({ loggerInstance: false });
  await app.ready();
});

test.after(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signup(label) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `Analytics ${label} ${suffix}`,
      agentEmail: `analytics-route-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id };
}

async function makeSnapshot(tenantId, { periodEnd, totalConversations = 0 } = {}) {
  return prisma.analyticsSnapshot.create({
    data: {
      tenantId,
      periodStart: new Date(periodEnd.getTime() - 60 * 60 * 1000),
      periodEnd,
      totalConversations,
      aiResolvedPct: 0.5,
      avgFirstResponseMs: 60_000,
      activeAgents: 1,
    },
  });
}

test('fresh tenant with zero snapshots gets a 200 empty state, not an error', async () => {
  const { token } = await signup('empty');

  const res = await app.inject({
    method: 'GET',
    url: '/analytics/summary',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { latest: null, series: [] });
});

// node's test runner runs separate test files concurrently by default, and
// analyticsRollup.test.js exercises the *real* rollup job — which lists ALL
// tenants in the DB and may insert a real-time snapshot for a tenant this
// file just minted. Anchoring our synthetic snapshots' periodEnd far in the
// future guarantees they always sort newest, so assertions about "latest"
// and ordering stay deterministic regardless of that concurrent job.
const FUTURE_ANCHOR = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;

test('GET /analytics/summary returns only the caller tenant rows', async () => {
  const A = await signup('iso-a');
  const B = await signup('iso-b');

  await makeSnapshot(A.tenantId, { periodEnd: new Date(FUTURE_ANCHOR), totalConversations: 3 });
  await makeSnapshot(B.tenantId, { periodEnd: new Date(FUTURE_ANCHOR), totalConversations: 99 });

  const res = await app.inject({
    method: 'GET',
    url: '/analytics/summary',
    headers: { authorization: `Bearer ${A.token}` },
  });

  assert.equal(res.statusCode, 200);
  const { latest, series } = res.json();
  assert.equal(latest.totalConversations, 3);
  assert.ok(
    series.some((s) => s.totalConversations === 3),
    'series includes the snapshot we inserted for tenant A',
  );
  assert.ok(
    series.every((s) => s.tenantId === A.tenantId),
    'every returned row belongs to tenant A',
  );
});

test('?range= limits how many recent snapshots are returned, chronological order', async () => {
  const { token, tenantId } = await signup('range');

  const periodEnds = [];
  for (let i = 5; i >= 1; i -= 1) {
    const periodEnd = new Date(FUTURE_ANCHOR - i * 60 * 60 * 1000);
    periodEnds.push(periodEnd);
    await makeSnapshot(tenantId, { periodEnd, totalConversations: 6 - i });
  }

  const res = await app.inject({
    method: 'GET',
    url: '/analytics/summary?range=2',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  const { latest, series } = res.json();
  assert.equal(series.length, 2);
  const returnedPeriodEnds = series.map((s) => new Date(s.periodEnd).getTime());
  assert.ok(
    returnedPeriodEnds[0] < returnedPeriodEnds[1],
    'series is in ascending (chronological) periodEnd order',
  );
  assert.equal(new Date(latest.periodEnd).getTime(), periodEnds.at(-1).getTime());
});

test('GET /analytics/summary with no auth header is 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/analytics/summary' });
  assert.equal(res.statusCode, 401);
});
