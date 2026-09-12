import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { initSocket } from '../src/realtime/socket.js';
import { prisma } from '../src/lib/prisma.js';
import { rateLimitRedis } from '../src/lib/redisClient.js';

/**
 * Phase 10 — rate limiting on the public widget surface (REST + Socket.io).
 *
 * Requires a migrated database and Redis (docker compose up -d). Hermetic:
 * mints its own tenants via /auth/signup, cleans them (and their Redis
 * counters) up after.
 */

let app;
let io;
let url;
const suffix = Date.now();
const created = { tenantIds: [] };
const openSockets = new Set();

test.before(async () => {
  app = await buildApp({ loggerInstance: false });
  io = initSocket(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  url = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  for (const s of openSockets) s.disconnect();
  io.close();
  await prisma.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
  // Don't leave this test's counters around to pollute a re-run in the same
  // window — must happen before app.close(), which quits the shared
  // rate-limit Redis connection (see the onClose hook in routes/widgetAuth.js).
  const keys = await rateLimitRedis.keys(`ratelimit:*:*${suffix}*`);
  if (keys.length) await rateLimitRedis.del(keys);
  await app.close();
  await prisma.$disconnect();
});

async function signup(label) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `RL ${label} ${suffix}`,
      agentEmail: `rl-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = ioc(url, { auth, transports: ['websocket'], reconnection: false });
    openSockets.add(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      openSockets.delete(socket);
      socket.close();
      reject(err);
    });
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('start-conversation is rate-limited per tenant+IP; the Nth+1 attempt is rejected', async () => {
  const A = await signup('start-a');
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });

  // The limit is 5/60s (see RATE_LIMITS in src/realtime/socket.js).
  for (let i = 0; i < 5; i++) {
    const ack = await emit(visitor, 'start-conversation', {});
    assert.equal(ack.ok, true, `attempt ${i + 1} should be allowed`);
  }

  const rejected = await emit(visitor, 'start-conversation', {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'RATE_LIMITED');
  assert.ok(rejected.error.retryAfterMs > 0);
});

test("a different tenant on the same connection isn't throttled by another tenant's usage", async () => {
  const A = await signup('start-b1');
  const B = await signup('start-b2');

  const visitorA = await connect({ widgetApiKey: A.widgetApiKey });
  for (let i = 0; i < 5; i++) {
    await emit(visitorA, 'start-conversation', {});
  }
  const exhaustedA = await emit(visitorA, 'start-conversation', {});
  assert.equal(exhaustedA.ok, false, "tenant A's own budget should now be exhausted");

  // Tenant B, same loopback IP, must still have its full budget.
  const visitorB = await connect({ widgetApiKey: B.widgetApiKey });
  const okB = await emit(visitorB, 'start-conversation', {});
  assert.equal(okB.ok, true, "tenant B must not be throttled by tenant A's usage");
});

test('send-message has its own limit, independent of start-conversation', async () => {
  const A = await signup('send-a');
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  // The limit is 20/10s (see RATE_LIMITS in src/realtime/socket.js).
  for (let i = 0; i < 20; i++) {
    const ack = await emit(visitor, 'send-message', { conversationId, content: `msg ${i}` });
    assert.equal(ack.ok, true, `message ${i + 1} should be allowed`);
  }

  const rejected = await emit(visitor, 'send-message', { conversationId, content: 'one too many' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'RATE_LIMITED');
});

test('POST /widget/session returns 429 with Retry-After once the REST limit is hit', async () => {
  const A = await signup('rest');

  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await app.inject({
      method: 'POST',
      url: '/widget/session',
      headers: { 'x-widget-api-key': A.widgetApiKey },
      payload: {},
    });
  }

  assert.equal(lastRes.statusCode, 429);
  assert.ok(lastRes.headers['retry-after'], 'Retry-After header should be present');
  const body = lastRes.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
});

test('a rate-limited request never leaks whether a conversationId belongs to another tenant', async () => {
  const A = await signup('leak-a');
  const B = await signup('leak-b');

  const visitorA = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitorA, 'start-conversation', {});

  // Exhaust tenant B's join-conversation budget (30/60s) with real cross-tenant
  // attempts against A's conversation, then compare the *last allowed* attempt's
  // error against the *first rate-limited* attempt's error — both must be a
  // plain NOT_FOUND/RATE_LIMITED with no id/existence hint, and reaching the
  // limiter must not change what a cross-tenant id resolves to.
  const bAgent = await connect({ token: B.token });
  let lastAllowed;
  for (let i = 0; i < 30; i++) {
    lastAllowed = await emit(bAgent, 'join-conversation', { conversationId });
  }
  assert.equal(lastAllowed.ok, false);
  assert.equal(lastAllowed.error.code, 'NOT_FOUND', 'still a plain not-found while under the limit');

  const limited = await emit(bAgent, 'join-conversation', { conversationId });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, 'RATE_LIMITED', 'now limited, not a different not-found shape');
  assert.equal(limited.error.message, 'Too many requests — please wait a moment');
});

test('REST rate limiting is scoped to /widget only — /auth is unaffected', async () => {
  // Hammer /auth/signup well past the widget's 5/min session-start limit;
  // it must never see a 429 since rate-limit is registered only inside the
  // widgetAuth plugin's encapsulated scope.
  for (let i = 0; i < 7; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        tenantName: `RL scope ${suffix}-${i}`,
        agentEmail: `rl-scope-${suffix}-${i}@test.local`,
        agentPassword: 'password123',
        agentName: 'Agent Scope',
      },
    });
    assert.notEqual(res.statusCode, 429);
    if (res.statusCode === 201) created.tenantIds.push(res.json().tenant.id);
  }
});
