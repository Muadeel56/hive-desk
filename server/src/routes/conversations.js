import { forTenant } from '../lib/tenantDb.js';
import { AppError } from '../lib/errors.js';
import { tenantRoom } from '../realtime/socket.js';
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
    const { status, assignedAgentId, take, skip } = listConversationsQuery.parse(request.query);
    const db = forTenant(request.tenantId);
    const where = {};
    if (status) where.status = status;
    if (assignedAgentId) {
      where.assignedAgentId = assignedAgentId === 'me' ? request.agent.agentId : assignedAgentId;
    }
    const [rows, total] = await Promise.all([
      db.conversation.findMany({ where, orderBy: { updatedAt: 'desc' }, take, skip }),
      db.conversation.count({ where }),
    ]);
    return { conversations: rows, pagination: { total, take, skip } };
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

  // POST /conversations/:id/takeover — claim a conversation for the calling
  // agent. Sets status = AGENT (locks the AI responder out permanently) and
  // assignedAgentId = caller. 404 cross-tenant / unknown; 409 if already claimed
  // by a different agent (re-claiming your own is idempotent). Broadcasts
  // `conversation-updated` to the tenant room so other dashboards patch in place.
  fastify.post('/:id/takeover', async (request, reply) => {
    const { id } = conversationIdParam.parse(request.params);
    const db = forTenant(request.tenantId);

    const existing = await db.conversation.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError(404, 'Conversation not found', 'NOT_FOUND');
    }
    if (existing.assignedAgentId && existing.assignedAgentId !== request.agent.agentId) {
      throw new AppError(409, 'Conversation already assigned to another agent', 'ALREADY_ASSIGNED');
    }

    const conversation = await db.conversation.update({
      where: { id },
      data: { status: 'AGENT', assignedAgentId: request.agent.agentId },
    });

    request.server.io?.to(tenantRoom(request.tenantId)).emit('conversation-updated', {
      conversationId: conversation.id,
      status: conversation.status,
      assignedAgentId: conversation.assignedAgentId,
    });

    return reply.send({ conversation });
  });

  // --- stubs for later phases -------------------------------------------------
  // Agent replies flow over Socket.io (`send-message`); a REST equivalent and
  // a generic PATCH are left for a later phase.
  const notImplemented = async (_request, reply) =>
    reply.status(501).send({ error: { message: 'Not implemented', code: 'NOT_IMPLEMENTED' } });

  fastify.post('/:id/messages', notImplemented);
  fastify.patch('/:id', notImplemented);
}
