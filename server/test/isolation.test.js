import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 1 checkpoint: prove tenant isolation end-to-end.
 *
 * Requires a migrated database (docker compose up -d && npx prisma migrate dev).
 * Hermetic: mints its own two tenants via /auth/signup, cleans them up after.
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
      tenantName: `ISO ${label} ${suffix}`,
      agentEmail: `iso-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

async function startWidgetSession(widgetApiKey) {
  return app.inject({
    method: 'POST',
    url: '/widget/session',
    headers: { 'x-widget-api-key': widgetApiKey },
    payload: {},
  });
}

test('cross-tenant conversation fetch is rejected with no data leak', async () => {
  const A = await signup('A');
  const B = await signup('B');

  const bSession = await startWidgetSession(B.widgetApiKey);
  assert.equal(bSession.statusCode, 201);
  const bConversationId = bSession.json().conversationId;

  const res = await app.inject({
    method: 'GET',
    url: `/conversations/${bConversationId}`,
    headers: { authorization: `Bearer ${A.token}` },
  });

  assert.ok([403, 404].includes(res.statusCode), `expected 403/404, got ${res.statusCode}`);
  const body = res.json();
  assert.equal(body.conversation, undefined, 'must not return the conversation');
  assert.ok(!JSON.stringify(body).includes(bConversationId), 'must not echo the target id back');
});

test('GET /conversations returns only the caller tenant rows', async () => {
  const A = await signup('A');
  const B = await signup('B');

  const aSession = await startWidgetSession(A.widgetApiKey);
  const bSession = await startWidgetSession(B.widgetApiKey);
  const aConversationId = aSession.json().conversationId;
  const bConversationId = bSession.json().conversationId;

  const res = await app.inject({
    method: 'GET',
    url: '/conversations',
    headers: { authorization: `Bearer ${A.token}` },
  });
  assert.equal(res.statusCode, 200);
  const { conversations } = res.json();
  const ids = conversations.map((c) => c.id);
  assert.ok(ids.includes(aConversationId), 'sees its own conversation');
  assert.ok(!ids.includes(bConversationId), 'never sees tenant B conversation');
  assert.ok(
    conversations.every((c) => c.tenantId === A.tenantId),
    'every returned row belongs to tenant A',
  );
});

test('widget session is scoped to the key tenant', async () => {
  const A = await signup('A');

  const res = await startWidgetSession(A.widgetApiKey);
  assert.equal(res.statusCode, 201);
  const { conversationId, sessionId } = res.json();
  assert.ok(sessionId);

  const row = await prisma.conversation.findUnique({ where: { id: conversationId } });
  assert.equal(row.tenantId, A.tenantId, 'conversation created under tenant A only');
});

test('widget session with a garbage api key is 401', async () => {
  const res = await startWidgetSession('not-a-real-key-zzzzzzzzzzzzzzzzzzzz');
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().conversationId, undefined);
});

test('widget session with no api key is 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/widget/session', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('agent route rejects a widgetApiKey used as a bearer token', async () => {
  const A = await signup('A');

  const res = await app.inject({
    method: 'GET',
    url: '/conversations',
    headers: { authorization: `Bearer ${A.widgetApiKey}` },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHORIZED');
});

test('widget route rejects an agent JWT used as x-widget-api-key', async () => {
  const A = await signup('A');

  const res = await app.inject({
    method: 'POST',
    url: '/widget/session',
    headers: { 'x-widget-api-key': A.token },
    payload: {},
  });

  assert.equal(res.statusCode, 401);
});

test('takeover on another tenant conversation id is 404', async () => {
  const A = await signup('A');
  const B = await signup('B');

  const bSession = await startWidgetSession(B.widgetApiKey);
  assert.equal(bSession.statusCode, 201);
  const bConversationId = bSession.json().conversationId;

  const res = await app.inject({
    method: 'POST',
    url: `/conversations/${bConversationId}/takeover`,
    headers: { authorization: `Bearer ${A.token}` },
  });

  assert.equal(res.statusCode, 404);
  assert.ok(!JSON.stringify(res.json()).includes(bConversationId), 'must not echo the target id back');
});
