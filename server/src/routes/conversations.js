import { forTenant } from '../lib/tenantDb.js';
import { AppError } from '../lib/errors.js';
import { listConversationsQuery, conversationIdParam } from '../schemas/conversation.js';

/**
 * Agent-only. Every handler runs `authenticate` then `tenantContext`, so
 * `request.tenantId` is always the caller's own tenant. All queries go through
 * forTenant() — never raw prisma with a client-supplied filter.
 */
export default async function conversationRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  // GET /conversations — only the caller's tenant rows.
  fastify.get('/', async (request) => {
    const { status, take, skip } = listConversationsQuery.parse(request.query);
    const db = forTenant(request.tenantId);
    const rows = await db.conversation.findMany({
      where: status ? { status } : {},
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
    });
    return { conversations: rows };
  });

  // GET /conversations/:id — 404 for anything not owned by the caller's tenant
  // (cross-tenant id resolves to null inside forTenant()).
  fastify.get('/:id', async (request) => {
    const { id } = conversationIdParam.parse(request.params);
    const db = forTenant(request.tenantId);
    const conversation = await db.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) {
      throw new AppError(404, 'Conversation not found', 'NOT_FOUND');
    }
    return { conversation };
  });

  // --- stubs for later phases -------------------------------------------------
  const notImplemented = async (_request, reply) =>
    reply.status(501).send({ error: { message: 'Not implemented', code: 'NOT_IMPLEMENTED' } });

  fastify.post('/:id/takeover', notImplemented);
  fastify.post('/:id/messages', notImplemented);
  fastify.patch('/:id', notImplemented);
}
