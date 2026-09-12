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

/**
 * Binds a child logger carrying `tenantId` and the templated route (e.g.
 * `/conversations/:id`, not the raw URL with real ids in it) onto the
 * request, once tenantId is known — this is the one place all three
 * resolution branches converge, so every tenant-scoped route gets these
 * fields on every log line for free without a second hook.
 */
function bindTenantLogger(request, reply) {
  const child = request.log.child({
    tenantId: request.tenantId,
    route: request.routeOptions?.url ?? request.url,
  });
  // Fastify's own "request completed"/"request errored" lines are logged via
  // `reply.log`, a separate reference from `request.log` (see
  // fastify/lib/log-controller.js) — both must be reassigned or only handler-
  // level logging (not Fastify's own access-log lines) would carry these fields.
  request.log = child;
  reply.log = child;
}

async function tenantContext(fastify) {
  fastify.decorateRequest('tenantId', null);
  fastify.decorateRequest('tenant', null);

  fastify.decorate('tenantContext', async function (request, reply) {
    if (request.agent?.tenantId) {
      request.tenantId = request.agent.tenantId;
      bindTenantLogger(request, reply);
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
      bindTenantLogger(request, reply);
      return;
    }

    throw new AppError(401, 'No tenant credentials provided', 'UNAUTHORIZED');
  });
}

export default fp(tenantContext, { name: 'tenantContext', dependencies: [] });
