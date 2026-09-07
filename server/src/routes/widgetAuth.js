import crypto from 'node:crypto';
import { forTenant } from '../lib/tenantDb.js';
import { tenantRoom } from '../realtime/socket.js';
import { startSessionSchema } from '../schemas/widget.js';

/**
 * Public widget endpoints. NO `authenticate` — only `tenantContext`, which here
 * takes the `x-widget-api-key` branch. A missing / unknown key -> 401 from the
 * plugin before any handler runs.
 */
export default async function widgetAuthRoutes(fastify) {
  fastify.addHook('preHandler', fastify.tenantContext);

  // POST /widget/session — start an anonymous visitor session.
  fastify.post('/session', async (request, reply) => {
    startSessionSchema.parse(request.body ?? {});

    const db = forTenant(request.tenantId);
    const visitorSessionId = crypto.randomUUID();
    const conversation = await db.conversation.create({
      data: { visitorSessionId, status: 'AI' },
    });

    // Mirror the socket `start-conversation` path: notify agent dashboards for
    // this tenant so a new conversation appears live. `io` is decorated in
    // server.js; guard with `?.` for tests that build the app without a socket.
    request.server.io
      ?.to(tenantRoom(request.tenantId))
      .emit('conversation-created', { conversation });

    return reply.status(201).send({
      sessionId: visitorSessionId,
      conversationId: conversation.id,
    });
  });
}
