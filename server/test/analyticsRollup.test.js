import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runAnalyticsRollup } from '../src/jobs/analyticsRollup.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 7 unit tests for the analytics rollup job. Requires a migrated
 * database (the job reads/writes real rows through forTenant()/prisma).
 *
 * `now` is injected into runAnalyticsRollup() to pin a deterministic 24h
 * window instead of depending on wall-clock time.
 */

const suffix = Date.now();
const createdTenantIds = [];

test.after(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

async function makeTenant(label) {
  const tenant = await prisma.tenant.create({
    data: {
      name: `Analytics ${label} ${suffix}`,
      widgetApiKey: `analytics-${label}-${suffix}-${randomUUID()}`,
    },
  });
  createdTenantIds.push(tenant.id);
  return tenant;
}

async function makeConversation(tenantId, { status = 'CLOSED', assignedAgentId = null, createdAt } = {}) {
  return prisma.conversation.create({
    data: {
      tenantId,
      visitorSessionId: randomUUID(),
      status,
      assignedAgentId,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

async function makeMessage(conversationId, role, createdAt) {
  return prisma.message.create({
    data: { conversationId, role, content: 'x', createdAt },
  });
}

async function makeAgent(tenantId, label) {
  return prisma.agent.create({
    data: {
      tenantId,
      email: `agent-${label}-${suffix}@test.local`,
      passwordHash: 'not-a-real-hash',
      name: `Agent ${label}`,
    },
  });
}

async function latestSnapshot(tenantId) {
  return prisma.analyticsSnapshot.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

test('CLOSED conversation with no agent involvement counts as AI-resolved', async () => {
  const tenant = await makeTenant('ai-resolved');
  const now = new Date();
  await makeConversation(tenant.id, { status: 'CLOSED', createdAt: new Date(now.getTime() - 60_000) });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.totalConversations, 1);
  assert.equal(snapshot.aiResolvedPct, 1);
});

test('CLOSED conversation with an AGENT message is excluded from AI-resolved numerator', async () => {
  const tenant = await makeTenant('agent-msg');
  const now = new Date();
  const conversation = await makeConversation(tenant.id, {
    status: 'CLOSED',
    createdAt: new Date(now.getTime() - 60_000),
  });
  await makeMessage(conversation.id, 'AGENT', new Date(now.getTime() - 30_000));

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.totalConversations, 1);
  assert.equal(snapshot.aiResolvedPct, 0);
});

test('CLOSED conversation with an assignedAgentId (but no AGENT message) is excluded from AI-resolved numerator', async () => {
  const tenant = await makeTenant('assigned');
  const agent = await makeAgent(tenant.id, 'assigned');
  const now = new Date();
  await makeConversation(tenant.id, {
    status: 'CLOSED',
    assignedAgentId: agent.id,
    createdAt: new Date(now.getTime() - 60_000),
  });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.aiResolvedPct, 0);
});

test('avg first-response time is computed only over conversations with an AGENT reply', async () => {
  const tenant = await makeTenant('first-response');
  const now = new Date();

  const conversationCreatedAt = new Date(now.getTime() - 10 * 60_000);
  const withReply = await makeConversation(tenant.id, {
    status: 'AGENT',
    createdAt: conversationCreatedAt,
  });
  await makeMessage(withReply.id, 'AGENT', new Date(conversationCreatedAt.getTime() + 5 * 60_000));

  // No AGENT reply — must not be zero-filled into the average.
  await makeConversation(tenant.id, { status: 'WAITING', createdAt: new Date(now.getTime() - 60_000) });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.avgFirstResponseMs, 5 * 60_000);
});

test('avgFirstResponseMs is null when nobody in the window got a human reply', async () => {
  const tenant = await makeTenant('no-reply');
  const now = new Date();
  await makeConversation(tenant.id, { status: 'WAITING', createdAt: new Date(now.getTime() - 60_000) });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.avgFirstResponseMs, null);
});

test('activeAgents counts distinct assignedAgentId values, ignoring null, no double-count', async () => {
  const tenant = await makeTenant('active-agents');
  const agentA = await makeAgent(tenant.id, 'A');
  const agentB = await makeAgent(tenant.id, 'B');
  const now = new Date();

  await makeConversation(tenant.id, { assignedAgentId: agentA.id, createdAt: new Date(now.getTime() - 60_000) });
  await makeConversation(tenant.id, { assignedAgentId: agentA.id, createdAt: new Date(now.getTime() - 30_000) });
  await makeConversation(tenant.id, { assignedAgentId: agentB.id, createdAt: new Date(now.getTime() - 10_000) });
  await makeConversation(tenant.id, { assignedAgentId: null, createdAt: new Date(now.getTime() - 5_000) });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.activeAgents, 2);
});

test('conversations older than the 24h window are excluded from all counts', async () => {
  const tenant = await makeTenant('old');
  const now = new Date();
  await makeConversation(tenant.id, {
    status: 'CLOSED',
    createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
  });

  await runAnalyticsRollup({ now });

  const snapshot = await latestSnapshot(tenant.id);
  assert.equal(snapshot.totalConversations, 0);
  assert.equal(snapshot.aiResolvedPct, 0);
  assert.equal(snapshot.avgFirstResponseMs, null);
  assert.equal(snapshot.activeAgents, 0);
});

test('two tenants each get their own correctly-scoped snapshot, no cross-tenant leakage', async () => {
  const tenantA = await makeTenant('multi-a');
  const tenantB = await makeTenant('multi-b');
  const now = new Date();

  await makeConversation(tenantA.id, { status: 'CLOSED', createdAt: new Date(now.getTime() - 60_000) });
  await makeConversation(tenantB.id, { status: 'CLOSED', createdAt: new Date(now.getTime() - 60_000) });
  await makeConversation(tenantB.id, { status: 'CLOSED', createdAt: new Date(now.getTime() - 30_000) });

  await runAnalyticsRollup({ now });

  const snapshotA = await latestSnapshot(tenantA.id);
  const snapshotB = await latestSnapshot(tenantB.id);
  assert.equal(snapshotA.totalConversations, 1);
  assert.equal(snapshotB.totalConversations, 2);
  assert.equal(snapshotA.tenantId, tenantA.id);
  assert.equal(snapshotB.tenantId, tenantB.id);
});
