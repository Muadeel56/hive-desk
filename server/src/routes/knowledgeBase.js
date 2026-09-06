/**
 * Agent-only knowledge base CRUD (FAQ entries the AI draws from).
 *
 * Every handler runs `authenticate` then `tenantContext`, so `request.tenantId`
 * is always the caller's own tenant. All queries go through forTenant() — never
 * raw prisma with a client-supplied filter. A cross-tenant `:id` resolves to
 * null on reads (→ 404 here) and makes forTenant() throw 404 on update/delete.
 */
import { forTenant } from '../lib/tenantDb.js';
import { AppError } from '../lib/errors.js';
import {
  createKbEntrySchema,
  updateKbEntrySchema,
  kbIdParam,
  listKbEntriesQuery,
} from '../schemas/knowledgeBase.js';

export default async function knowledgeBaseRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  // POST /knowledge-base — create an entry for the caller's tenant.
  fastify.post('/', async (request, reply) => {
    const data = createKbEntrySchema.parse(request.body);
    const entry = await forTenant(request.tenantId).knowledgeBaseEntry.create({ data });
    return reply.status(201).send({ entry });
  });

  // GET /knowledge-base — paginated list, newest first.
  fastify.get('/', async (request) => {
    const { take, skip } = listKbEntriesQuery.parse(request.query);
    const db = forTenant(request.tenantId);
    const [entries, total] = await Promise.all([
      db.knowledgeBaseEntry.findMany({ orderBy: { createdAt: 'desc' }, take, skip }),
      db.knowledgeBaseEntry.count(),
    ]);
    return { entries, pagination: { total, take, skip } };
  });

  // GET /knowledge-base/:id — 404 for anything not owned by the caller's tenant.
  fastify.get('/:id', async (request) => {
    const { id } = kbIdParam.parse(request.params);
    const entry = await forTenant(request.tenantId).knowledgeBaseEntry.findUnique({
      where: { id },
    });
    if (!entry) {
      throw new AppError(404, 'Knowledge base entry not found', 'NOT_FOUND');
    }
    return { entry };
  });

  // PATCH /knowledge-base/:id — merge the provided fields. forTenant() throws
  // 404 for a cross-tenant/unknown id.
  fastify.patch('/:id', async (request) => {
    const { id } = kbIdParam.parse(request.params);
    const data = updateKbEntrySchema.parse(request.body);
    if (Object.keys(data).length === 0) {
      throw new AppError(400, 'No fields to update', 'EMPTY_UPDATE');
    }
    const entry = await forTenant(request.tenantId).knowledgeBaseEntry.update({
      where: { id },
      data,
    });
    return { entry };
  });

  // DELETE /knowledge-base/:id — 204, no body. 404 for a cross-tenant/unknown id.
  fastify.delete('/:id', async (request, reply) => {
    const { id } = kbIdParam.parse(request.params);
    await forTenant(request.tenantId).knowledgeBaseEntry.delete({ where: { id } });
    return reply.status(204).send();
  });
}
