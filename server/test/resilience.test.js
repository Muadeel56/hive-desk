import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 8 checkpoint: Postgres-outage error mapping.
 *
 * This suite verifies only the error-mapping layer (Prisma connection-level
 * error codes -> 503 SERVICE_UNAVAILABLE) via a mocked Prisma error. Live
 * outage and reconnect behavior (actually stopping/starting the postgres
 * container mid-request) is a manual test — see server/docs/resilience.md.
 * node --test has no facility to safely bounce a real Postgres container
 * inside this suite without risking flaking every other suite that shares
 * the same database.
 *
 * Note: PrismaClient's model methods are Proxy-backed, and
 * Object.getOwnPropertyDescriptor() on them returns a fake `{value:
 * undefined}` descriptor — so node:test's t.mock.method() (which relies on
 * that descriptor) can't target them. Mocking here is a plain
 * save-the-reference / reassign / restore-in-t.after() instead.
 *
 * Pure .inject() suite, no listening socket — see resilience-socket.test.js
 * for the Socket.io equivalent, which needs a real listening server.
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
      tenantName: `RES ${label} ${suffix}`,
      agentEmail: `res-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

test('GET /conversations returns 503 SERVICE_UNAVAILABLE when Postgres is unreachable', async (t) => {
  const A = await signup('A');

  const original = prisma.conversation.findMany;
  prisma.conversation.findMany = () => {
    throw Object.assign(new Error('simulated: server has closed the connection'), { code: 'P1017' });
  };
  t.after(() => {
    prisma.conversation.findMany = original;
  });

  const res = await app.inject({
    method: 'GET',
    url: '/conversations',
    headers: { authorization: `Bearer ${A.token}` },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'SERVICE_UNAVAILABLE');
});

test('/health/ready reflects Postgres outage and recovery', async () => {
  const original = prisma.$queryRaw;
  prisma.$queryRaw = () => {
    throw Object.assign(new Error('simulated: cannot reach database server'), { code: 'P1001' });
  };

  const down = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().error.code, 'SERVICE_UNAVAILABLE');

  prisma.$queryRaw = original; // simulates Postgres coming back, without restarting the server

  const up = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().status, 'ok');
});
