import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 10 — GET /conversations/:id/export.
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

let seq = 0;
async function signup(label) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `EXP ${label} ${suffix}-${seq}`,
      agentEmail: `exp-${label}-${suffix}-${seq}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function startWidgetSession(widgetApiKey) {
  const res = await app.inject({
    method: 'POST',
    url: '/widget/session',
    headers: { 'x-widget-api-key': widgetApiKey },
    payload: {},
  });
  assert.equal(res.statusCode, 201);
  return res.json().conversationId;
}

test('happy path: plain-text export lists messages in order with correct sender labels', async () => {
  const A = await signup('happy');
  const conversationId = await startWidgetSession(A.widgetApiKey);

  await prisma.message.create({
    data: { conversationId, role: 'VISITOR', content: 'Hi, I need help' },
  });
  await prisma.message.create({
    data: { conversationId, role: 'AI', content: 'Sure, what do you need?' },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: 'AGENT', assignedAgentId: (await prisma.agent.findFirst({ where: { tenantId: A.tenantId } })).id },
  });
  await prisma.message.create({
    data: { conversationId, role: 'AGENT', content: 'Happy to help!' },
  });

  const res = await app.inject({
    method: 'GET',
    url: `/conversations/${conversationId}/export`,
    headers: auth(A.token),
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.headers['content-disposition'], /attachment/);
  assert.match(res.headers['content-disposition'], new RegExp(conversationId));

  const body = res.body;
  const visitorIdx = body.indexOf('Visitor: Hi, I need help');
  const aiIdx = body.indexOf('AI Assistant: Sure, what do you need?');
  const agentIdx = body.indexOf('Agent Agent happy: Happy to help!');
  assert.ok(visitorIdx !== -1 && aiIdx !== -1 && agentIdx !== -1, 'all three lines present');
  assert.ok(visitorIdx < aiIdx && aiIdx < agentIdx, 'messages are in chronological order');
});

test('?format=json returns the same data structured', async () => {
  const A = await signup('json');
  const conversationId = await startWidgetSession(A.widgetApiKey);
  await prisma.message.create({
    data: { conversationId, role: 'VISITOR', content: 'hello' },
  });

  const res = await app.inject({
    method: 'GET',
    url: `/conversations/${conversationId}/export?format=json`,
    headers: auth(A.token),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = res.json();
  assert.equal(body.conversationId, conversationId);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].sender, 'Visitor');
  assert.equal(body.messages[0].content, 'hello');
});

test('an agent from Tenant A cannot export a Tenant B conversation by ID', async () => {
  const A = await signup('cross-a');
  const B = await signup('cross-b');
  const bConversationId = await startWidgetSession(B.widgetApiKey);

  const res = await app.inject({
    method: 'GET',
    url: `/conversations/${bConversationId}/export`,
    headers: auth(A.token),
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(res.json()).includes(bConversationId), 'must not echo the target id back');
});

test('unauthenticated export request is 401', async () => {
  const A = await signup('unauth');
  const conversationId = await startWidgetSession(A.widgetApiKey);

  const res = await app.inject({
    method: 'GET',
    url: `/conversations/${conversationId}/export`,
  });
  assert.equal(res.statusCode, 401);
});
