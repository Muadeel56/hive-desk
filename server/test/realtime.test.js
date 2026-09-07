import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { initSocket, conversationRoom } from '../src/realtime/socket.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 3 + 4 checkpoint: real-time chat over Socket.io, tenant-scoped rooms,
 * and the AI auto-reply / human-handoff loop.
 *
 * Requires a migrated database (docker compose up -d && npx prisma migrate dev).
 * Hermetic: mints its own tenants via /auth/signup, cleans them up after.
 *
 * Unlike the other suites this one needs a real listening socket, so it calls
 * app.listen({ port: 0 }) and derives the URL from app.server.address().
 *
 * The LLM is a tiny in-process HTTP stub (LLM_API_URL points at it) so the real
 * aiClient runs — retry/backoff included. The stub keys off the visitor's text:
 * "hours"/"open" -> confident answer; anything else -> not confident.
 */

let app;
let io;
let url;
let llmStub;
const suffix = Date.now();
const created = { tenantIds: [] };
const openSockets = new Set();
const savedEnv = {};

// Mutable stub behaviour, reset per-test where it matters.
const stubState = { hits: 0, fail429: 0 };

function geminiBody(text, finishReason = 'STOP') {
  return JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 }],
    usageMetadata: { totalTokenCount: 1 },
    modelVersion: 'stub',
  });
}

function startLlmStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        stubState.hits += 1;
        if (stubState.fail429 > 0) {
          stubState.fail429 -= 1;
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
          return;
        }
        let lastUser = '';
        try {
          const body = JSON.parse(raw);
          const users = (body.contents ?? []).filter((c) => c.role === 'user');
          lastUser = users.at(-1)?.parts?.[0]?.text ?? '';
        } catch {
          /* ignore — treated as not confident below */
        }
        const confident = /hours|\bopen\b/i.test(lastUser);
        const text = confident
          ? '{"confident":true,"answer":"9 to 5, Mon–Fri."}'
          : '{"confident":false,"answer":""}';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(geminiBody(text));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test.before(async () => {
  llmStub = await startLlmStub();
  const { port: stubPort } = llmStub.address();
  for (const k of ['LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MAX_RETRIES', 'LLM_BACKOFF_MS']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LLM_API_URL = `http://127.0.0.1:${stubPort}`;
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'stub-model';
  process.env.LLM_MAX_RETRIES = '2';
  process.env.LLM_BACKOFF_MS = '5';

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
  await new Promise((r) => llmStub.close(r));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

/** Resolve with the first `event` payload that satisfies `predicate`. */
function waitFor(socket, event, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}" matching predicate`));
    }, timeoutMs);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // visitor -> agent. ("Hi, I need help" is off-topic for the LLM stub, so the
  // AI will also hand off — filter for the roles each side actually expects.)
  const agentGot = waitFor(agent, 'new-message', (m) => m.role === 'VISITOR');
  const vAck = await emit(visitor, 'send-message', { conversationId, content: 'Hi, I need help' });
  assert.equal(vAck.ok, true);
  const m1 = await agentGot;
  assert.equal(m1.content, 'Hi, I need help');
  assert.equal(m1.conversationId, conversationId);

  // agent -> visitor
  const visitorGot = waitFor(visitor, 'new-message', (m) => m.role === 'AGENT');
  const aAck = await emit(agent, 'send-message', { conversationId, content: 'Happy to help!' });
  assert.equal(aAck.ok, true);
  const m2 = await visitorGot;
  assert.equal(m2.content, 'Happy to help!');

  // Persisted rows: the visitor + agent messages. The AI handoff for the
  // off-topic visitor message emits a system line but persists nothing.
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
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

// --- Phase 4: AI auto-reply & human handoff -----------------------------------

test('visitor asks a KB question -> AI answers automatically, conversation stays AI', async () => {
  const A = await signup('ai-kb');
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  const aiMsg = waitFor(visitor, 'new-message', (m) => m.role === 'AI');
  await emit(visitor, 'send-message', { conversationId, content: 'what are your opening hours?' });
  const ai = await aiMsg;
  assert.match(ai.content, /9 to 5/);

  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  assert.equal(convo.status, 'AI');

  const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => r.role), ['VISITOR', 'AI']);
});

test('visitor asks something off-topic -> tenant agent is notified, conversation is WAITING', async () => {
  const A = await signup('ai-hh');
  const agent = await connect({ token: A.token }); // auto-joins the tenant room
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  const needsHuman = once(agent, 'conversation-needs-human', 4000);
  const sysLine = waitFor(visitor, 'new-message', (m) => m.role === 'AI');
  await emit(visitor, 'send-message', { conversationId, content: 'do you sell dog food?' });

  const nh = await needsHuman;
  assert.equal(nh.conversationId, conversationId);
  assert.equal(nh.tenantId, A.tenantId);
  assert.equal(nh.lastVisitorMessage, 'do you sell dog food?');

  const sys = await sysLine;
  assert.match(sys.content, /agent will be with you/i);

  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  assert.equal(convo.status, 'WAITING');
  const aiRows = await prisma.message.findMany({ where: { conversationId, role: 'AI' } });
  assert.equal(aiRows.length, 0);
});

test("a second tenant's agent is not notified about the first tenant's handoff", async () => {
  const A = await signup('ai-isoA');
  const B = await signup('ai-isoB');

  const bAgent = await connect({ token: B.token });
  let leaked = false;
  bAgent.on('conversation-needs-human', () => {
    leaked = true;
  });

  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});
  await emit(visitor, 'send-message', { conversationId, content: 'unrelated nonsense question' });
  await sleep(600);

  assert.equal(leaked, false, "tenant B must not see tenant A's conversation-needs-human");
});

test('agent reply locks the conversation to AGENT and the AI never speaks again', async () => {
  const A = await signup('ai-lock');
  const agent = await connect({ token: A.token });
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  // Off-topic message -> WAITING.
  const needsHuman = once(agent, 'conversation-needs-human', 4000);
  await emit(visitor, 'send-message', { conversationId, content: 'I want to buy 500 units' });
  await needsHuman;

  // Agent joins and replies -> permanent AGENT lock.
  await emit(agent, 'join-conversation', { conversationId });
  const updated = once(agent, 'conversation-updated', 4000);
  await emit(agent, 'send-message', { conversationId, content: 'Sure, let me help with that.' });
  const up = await updated;
  assert.equal(up.status, 'AGENT');

  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  assert.equal(convo.status, 'AGENT');
  assert.ok(convo.assignedAgentId, 'assignedAgentId should be set');

  // A later visitor message — even a KB question — gets no AI reply.
  let aiSpoke = false;
  visitor.on('new-message', (m) => {
    if (m.role === 'AI') aiSpoke = true;
  });
  await emit(visitor, 'send-message', { conversationId, content: 'and what are your opening hours?' });
  await sleep(700);
  assert.equal(aiSpoke, false);
});

test('a transient 429 from the LLM is retried -> exactly one AI reply', async () => {
  const A = await signup('ai-retry');
  const visitor = await connect({ widgetApiKey: A.widgetApiKey });
  const { conversationId } = await emit(visitor, 'start-conversation', {});

  stubState.hits = 0;
  stubState.fail429 = 1;

  let aiReplies = 0;
  visitor.on('new-message', (m) => {
    if (m.role === 'AI') aiReplies += 1;
  });
  const aiMsg = waitFor(visitor, 'new-message', (m) => m.role === 'AI');
  await emit(visitor, 'send-message', { conversationId, content: 'please tell me your opening hours' });
  await aiMsg;
  await sleep(300);

  assert.equal(stubState.hits, 2, 'one 429 then one 200');
  assert.equal(aiReplies, 1);
});
