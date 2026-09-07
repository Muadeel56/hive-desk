import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { respondToVisitorMessage } from '../src/ai/responder.js';
import { AiError } from '../src/ai/aiClient.js';
import { conversationRoom, tenantRoom } from '../src/realtime/socket.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 4 unit tests for the AI responder decision logic.
 *
 * No socket server, no real LLM: a fake `client` stands in for aiClient and a
 * fake `io` records every emit. Requires a migrated database (the responder
 * reads/writes real rows through forTenant()).
 */

const suffix = Date.now();
const createdTenantIds = [];

test.after(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

async function makeTenant(label, { settings } = {}) {
  const tenant = await prisma.tenant.create({
    data: {
      name: `Responder ${label} ${suffix}`,
      widgetApiKey: `resp-${label}-${suffix}-${randomUUID()}`,
      ...(settings ? { settings } : {}),
    },
  });
  createdTenantIds.push(tenant.id);
  return tenant;
}

async function makeConversation(tenantId, { status = 'AI', visitorText = 'hello there' } = {}) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, visitorSessionId: randomUUID(), status },
  });
  if (visitorText) {
    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'VISITOR', content: visitorText },
    });
  }
  return conversation;
}

function fakeIo() {
  const emits = [];
  return {
    emits,
    to(room) {
      return {
        emit(event, payload) {
          emits.push({ room, event, payload });
        },
      };
    },
    events(name) {
      return emits.filter((e) => e.event === name);
    },
  };
}

function fakeClient({ configured = true, reply, error } = {}) {
  const state = { generateReplyCalls: 0 };
  return {
    state,
    isConfigured: () => configured,
    generateReply: async () => {
      state.generateReplyCalls += 1;
      if (error) throw error;
      return reply;
    },
  };
}

const aiMessages = (conversationId) =>
  prisma.message.findMany({ where: { conversationId, role: 'AI' } });

test('KB hit: confident reply is posted as an AI message, conversation stays AI', async () => {
  const tenant = await makeTenant('hit');
  const conversation = await makeConversation(tenant.id);
  await prisma.knowledgeBaseEntry.create({
    data: { tenantId: tenant.id, question: 'Opening hours?', answer: '9 to 5, Mon–Fri.' },
  });

  const io = fakeIo();
  const client = fakeClient({
    reply: { text: '{"confident":true,"answer":"We are open 9 to 5, Mon–Fri."}', finishReason: 'STOP' },
  });

  const result = await respondToVisitorMessage(
    { io, tenantId: tenant.id, conversationId: conversation.id },
    { client },
  );

  assert.deepEqual(result, { acted: true, mode: 'ai' });

  const ai = await aiMessages(conversation.id);
  assert.equal(ai.length, 1);
  assert.equal(ai[0].content, 'We are open 9 to 5, Mon–Fri.');

  const newMsgs = io.events('new-message');
  assert.equal(newMsgs.length, 1);
  assert.equal(newMsgs[0].room, conversationRoom(conversation.id));
  assert.equal(newMsgs[0].payload.role, 'AI');
  assert.equal(io.events('conversation-needs-human').length, 0);

  const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(fresh.status, 'AI');
});

test('unrelated question: not-confident reply flips conversation to WAITING and notifies the tenant', async () => {
  const tenant = await makeTenant('miss');
  const conversation = await makeConversation(tenant.id, { visitorText: 'do you sell dog food?' });

  const io = fakeIo();
  const client = fakeClient({ reply: { text: '{"confident":false,"answer":""}', finishReason: 'STOP' } });

  const result = await respondToVisitorMessage(
    { io, tenantId: tenant.id, conversationId: conversation.id },
    { client },
  );

  assert.deepEqual(result, { acted: true, mode: 'needsHuman' });

  const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(fresh.status, 'WAITING');

  const needsHuman = io.events('conversation-needs-human');
  assert.equal(needsHuman.length, 1);
  assert.equal(needsHuman[0].room, tenantRoom(tenant.id));
  assert.equal(needsHuman[0].payload.conversationId, conversation.id);
  assert.equal(needsHuman[0].payload.lastVisitorMessage, 'do you sell dog food?');
  assert.equal(needsHuman[0].payload.reason, 'ai-not-confident');

  // Visitor-facing system line, but no persisted AI row.
  const sysLine = io.events('new-message');
  assert.equal(sysLine.length, 1);
  assert.equal(sysLine[0].room, conversationRoom(conversation.id));
  assert.equal((await aiMessages(conversation.id)).length, 0);
});

test('aiClient errors (TIMEOUT / RATE_LIMIT / HTTP_ERROR) hand off gracefully', async () => {
  const tenant = await makeTenant('err');

  for (const code of ['TIMEOUT', 'RATE_LIMIT', 'HTTP_ERROR']) {
    const conversation = await makeConversation(tenant.id);
    const io = fakeIo();
    const client = fakeClient({ error: new AiError(`boom ${code}`, code) });

    const result = await respondToVisitorMessage(
      { io, tenantId: tenant.id, conversationId: conversation.id },
      { client },
    );

    assert.deepEqual(result, { acted: true, mode: 'needsHuman' }, code);
    const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(fresh.status, 'WAITING', code);
    const needsHuman = io.events('conversation-needs-human');
    assert.equal(needsHuman.length, 1, code);
    assert.equal(needsHuman[0].payload.reason, code);
    assert.equal((await aiMessages(conversation.id)).length, 0, code);
  }
});

test('malformed model output hands off (bad JSON, truncated fence, MAX_TOKENS)', async () => {
  const tenant = await makeTenant('malformed');

  const cases = [
    { text: 'not json at all', finishReason: 'STOP' },
    { text: '```json\n{"confident":true,"answer":"partial', finishReason: 'STOP' },
    { text: '{"confident":true,"answer":"cut off"}', finishReason: 'MAX_TOKENS' },
  ];

  for (const [i, reply] of cases.entries()) {
    const conversation = await makeConversation(tenant.id);
    const io = fakeIo();
    const client = fakeClient({ reply });

    const result = await respondToVisitorMessage(
      { io, tenantId: tenant.id, conversationId: conversation.id },
      { client },
    );

    assert.deepEqual(result, { acted: true, mode: 'needsHuman' }, `case ${i}`);
    const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(fresh.status, 'WAITING', `case ${i}`);
    assert.equal((await aiMessages(conversation.id)).length, 0, `case ${i}`);
  }
});

test('isConfigured() false: immediate handoff, generateReply never called', async () => {
  const tenant = await makeTenant('nokey');
  const conversation = await makeConversation(tenant.id);

  const io = fakeIo();
  const client = fakeClient({ configured: false, reply: { text: '{"confident":true,"answer":"x"}' } });

  const result = await respondToVisitorMessage(
    { io, tenantId: tenant.id, conversationId: conversation.id },
    { client },
  );

  assert.deepEqual(result, { acted: true, mode: 'needsHuman' });
  assert.equal(client.state.generateReplyCalls, 0);
  const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(fresh.status, 'WAITING');
  assert.equal(io.events('conversation-needs-human')[0].payload.reason, 'ai-not-configured');
});

test('conversation already AGENT: responder is a no-op', async () => {
  const tenant = await makeTenant('locked');
  const conversation = await makeConversation(tenant.id, { status: 'AGENT' });

  const io = fakeIo();
  const client = fakeClient({ reply: { text: '{"confident":true,"answer":"hi"}' } });

  const result = await respondToVisitorMessage(
    { io, tenantId: tenant.id, conversationId: conversation.id },
    { client },
  );

  assert.deepEqual(result, { acted: false });
  assert.equal(client.state.generateReplyCalls, 0);
  assert.equal(io.emits.length, 0);
  assert.equal((await aiMessages(conversation.id)).length, 0);
});
