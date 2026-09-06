import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { initSocket, conversationRoom } from '../src/realtime/socket.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 3 checkpoint: real-time chat over Socket.io, tenant-scoped rooms.
 *
 * Requires a migrated database (docker compose up -d && npx prisma migrate dev).
 * Hermetic: mints its own tenants via /auth/signup, cleans them up after.
 *
 * Unlike the other suites this one needs a real listening socket, so it calls
 * app.listen({ port: 0 }) and derives the URL from app.server.address().
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
  await app.close();
  await prisma.$disconnect();
});

async function signup(label) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `RT ${label} ${suffix}`,
      agentEmail: `rt-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

/** Connect a client socket; resolves on `connect`, rejects on `connect_error`. */
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

/** One-shot promise for the next `event` on `socket`. */
function once(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('messages flow both ways and every delivered message is persisted', async () => {
  const A = await signup('A');

  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const started = await emit(visitor, 'start-conversation', { pageUrl: 'https://shop.example/cart' });
  assert.equal(started.ok, true);
  assert.ok(started.conversationId);
  const conversationId = started.conversationId;

  const agent = await connect({ token: A.token });
  const joined = await emit(agent, 'join-conversation', { conversationId });
  assert.equal(joined.ok, true);
  assert.equal(joined.conversation.id, conversationId);
  assert.deepEqual(joined.messages, []);

  // visitor -> agent
  const agentGot = once(agent, 'new-message');
  const vAck = await emit(visitor, 'send-message', { conversationId, content: 'Hi, I need help' });
  assert.equal(vAck.ok, true);
  const m1 = await agentGot;
  assert.equal(m1.role, 'VISITOR');
  assert.equal(m1.content, 'Hi, I need help');
  assert.equal(m1.conversationId, conversationId);

  // agent -> visitor
  const visitorGot = once(visitor, 'new-message');
  const aAck = await emit(agent, 'send-message', { conversationId, content: 'Happy to help!' });
  assert.equal(aAck.ok, true);
  const m2 = await visitorGot;
  assert.equal(m2.role, 'AGENT');
  assert.equal(m2.content, 'Happy to help!');

  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.role),
    ['VISITOR', 'AGENT'],
  );
});

test("a second tenant's agent cannot join or receive another tenant's conversation", async () => {
  const A = await signup('A');
  const B = await signup('B');

  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  const bAgent = await connect({ token: B.token });
  const joined = await emit(bAgent, 'join-conversation', { conversationId });
  assert.equal(joined.ok, false);
  assert.equal(joined.error.code, 'NOT_FOUND');
  assert.ok(!bAgent.rooms?.has?.(conversationRoom(conversationId)));

  // B's agent must receive nothing when A's conversation gets a message.
  let leaked = false;
  bAgent.on('new-message', () => {
    leaked = true;
  });
  await emit(visitor, 'send-message', { conversationId, content: 'private to tenant A' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(leaked, false, "tenant B agent must not receive tenant A's messages");
});

test('a visitor cannot post to a conversation it did not start', async () => {
  const A = await signup('A');

  const v1 = await connect({ widgetApiKey: A.widgetApiKey });
  const v2 = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(v1, 'start-conversation', {});

  const ack = await emit(v2, 'send-message', { conversationId, content: 'not my conversation' });
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'FORBIDDEN');
});

test('connections with no / invalid credentials are refused', async () => {
  await assert.rejects(connect({ widgetApiKey: 'not-a-real-key-zzzzzzzzzzzz' }));
  await assert.rejects(connect({ token: 'garbage.jwt.value' }));
  await assert.rejects(connect({}));
});
