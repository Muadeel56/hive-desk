import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

/**
 * Exposes `fastify.tenantContext`, a preHandler that decorates `request.tenantId`.
 *
 * Resolution order (and ONLY these sources):
 *   1. `request.agent` is set (agent routes, after `authenticate`)
 *        -> request.tenantId = request.agent.tenantId
 *   2. `x-widget-api-key` header present (public widget routes)
 *        -> look up Tenant by widgetApiKey; hit -> set request.tenantId (+ request.tenant)
 *        -> miss -> 401
 *   3. neither -> 401
 *
 * tenantId is NEVER read from the request body, query string, or route params.
 */
async function tenantContext(fastify) {
  fastify.decorateRequest('tenantId', null);
  fastify.decorateRequest('tenant', null);

  fastify.decorate('tenantContext', async function (request) {
    if (request.agent?.tenantId) {
      request.tenantId = request.agent.tenantId;
      return;
    }

    const apiKey = request.headers['x-widget-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const tenant = await prisma.tenant.findUnique({
        where: { widgetApiKey: apiKey },
        select: { id: true, name: true },
      });
      if (!tenant) {
        throw new AppError(401, 'Invalid widget API key', 'INVALID_WIDGET_KEY');
      }
      request.tenantId = tenant.id;
      request.tenant = tenant;
      return;
    }

    throw new AppError(401, 'No tenant credentials provided', 'UNAUTHORIZED');
  });
}

export default fp(tenantContext, { name: 'tenantContext', dependencies: [] });
