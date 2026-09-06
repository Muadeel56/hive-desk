/**
 * Agent-only tenant settings / widget config. Stub handlers for now (Phase 2).
 * preHandlers register the auth + tenant-scoping chain so the wiring is proven.
 */
export default async function tenantRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  const notImplemented = async (_request, reply) =>
    reply.status(501).send({ error: { message: 'Not implemented', code: 'NOT_IMPLEMENTED' } });

  fastify.get('/me/settings', notImplemented);
  fastify.patch('/me/settings', notImplemented);
}
