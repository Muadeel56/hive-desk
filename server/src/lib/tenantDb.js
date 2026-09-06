/**
 * Tenant-scoped Prisma access.
 *
 * ============================================================================
 * ALL tenant data access goes through forTenant(). Reviewers: reject any route
 * that calls raw `prisma.<model>.<op>` with a client-supplied filter for a
 * tenant-owned model. `tenantId` must come from `request.tenantId` (set by the
 * tenantContext plugin from the JWT or the widget API key) — never from the
 * request body, query, or params.
 * ============================================================================
 *
 * forTenant(tenantId) returns an object whose methods force-inject
 *   where: { tenantId }        on reads / updateMany / deleteMany
 *   data:  { tenantId }        on create
 * for every tenant-owned model (agent, conversation, knowledgeBaseEntry), and
 * a `tenant` accessor scoped to the single row `id === tenantId`.
 *
 * `Message` has no tenantId column, so its wrapper scopes through the parent
 * Conversation: reads filter on `conversation: { tenantId }`, and writes first
 * assert the parent conversation belongs to this tenant.
 */
import { prisma } from './prisma.js';
import { AppError } from './errors.js';

function mergeWhere(args, extra) {
  return { ...args, where: { ...(args?.where ?? {}), ...extra } };
}

/** Build a where-scoped wrapper for a model that has a real `tenantId` column. */
function scopedModel(modelName, tenantId) {
  const model = prisma[modelName];

  async function assertOwned(where) {
    const found = await model.findFirst({ where: { ...where, tenantId }, select: { id: true } });
    if (!found) {
      throw new AppError(404, `${modelName} not found`, 'NOT_FOUND');
    }
    return found;
  }

  return {
    findMany: (args = {}) => model.findMany(mergeWhere(args, { tenantId })),
    findFirst: (args = {}) => model.findFirst(mergeWhere(args, { tenantId })),
    // Prisma's findUnique only accepts unique fields, so it cannot take an extra
    // tenantId filter. Downgrade to findFirst with the tenant filter applied:
    // a cross-tenant id simply resolves to null -> caller returns 404.
    findUnique: (args = {}) => model.findFirst(mergeWhere(args, { tenantId })),
    count: (args = {}) => model.count(mergeWhere(args, { tenantId })),
    create: (args) => model.create({ ...args, data: { ...args.data, tenantId } }),
    update: async (args) => {
      await assertOwned(args.where);
      return model.update(args);
    },
    delete: async (args) => {
      await assertOwned(args.where);
      return model.delete(args);
    },
    updateMany: (args = {}) => model.updateMany(mergeWhere(args, { tenantId })),
    deleteMany: (args = {}) => model.deleteMany(mergeWhere(args, { tenantId })),
  };
}

/** Message wrapper — scoped via the parent Conversation's tenantId. */
function scopedMessages(tenantId) {
  async function assertConversationOwned(conversationId) {
    if (!conversationId) {
      throw new AppError(400, 'conversationId is required', 'VALIDATION_ERROR');
    }
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!conv) {
      throw new AppError(404, 'conversation not found', 'NOT_FOUND');
    }
    return conv;
  }

  return {
    findMany: (args = {}) =>
      prisma.message.findMany(mergeWhere(args, { conversation: { tenantId } })),
    findFirst: (args = {}) =>
      prisma.message.findFirst(mergeWhere(args, { conversation: { tenantId } })),
    findUnique: (args = {}) =>
      prisma.message.findFirst(mergeWhere(args, { conversation: { tenantId } })),
    count: (args = {}) => prisma.message.count(mergeWhere(args, { conversation: { tenantId } })),
    create: async (args) => {
      await assertConversationOwned(args?.data?.conversationId);
      return prisma.message.create(args);
    },
  };
}

/** Tenant wrapper — always pinned to the caller's own tenant row. */
function scopedTenant(tenantId) {
  return {
    get: (args = {}) => prisma.tenant.findUnique({ ...args, where: { id: tenantId } }),
    update: (args = {}) => prisma.tenant.update({ ...args, where: { id: tenantId } }),
  };
}

export function forTenant(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new AppError(500, 'forTenant() called without a resolved tenantId', 'TENANT_CONTEXT_MISSING');
  }
  return {
    tenantId,
    tenant: scopedTenant(tenantId),
    agent: scopedModel('agent', tenantId),
    conversation: scopedModel('conversation', tenantId),
    knowledgeBaseEntry: scopedModel('knowledgeBaseEntry', tenantId),
    message: scopedMessages(tenantId),
  };
}

export default forTenant;
