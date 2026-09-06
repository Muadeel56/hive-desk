/**
 * Agent-only knowledge base CRUD. Stub handlers for now (Phase 2).
 * preHandlers register the auth + tenant-scoping chain so the wiring is proven.
 */
export default async function knowledgeBaseRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  const notImplemented = async (_request, reply) =>
    reply.status(501).send({ error: { message: 'Not implemented', code: 'NOT_IMPLEMENTED' } });

  fastify.get('/', notImplemented);
  fastify.post('/', notImplemented);
  fastify.patch('/:id', notImplemented);
  fastify.delete('/:id', notImplemented);
}
