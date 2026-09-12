/**
 * Agent-only tenant widget settings.
 *
 * Every handler runs `authenticate` then `tenantContext`, so `request.tenantId`
 * is always the caller's own tenant. All access goes through forTenant() — the
 * `tenant` accessor is pinned to the caller's row, so cross-tenant reads/writes
 * are impossible by construction.
 */
import { forTenant } from '../lib/tenantDb.js';
import { AppError } from '../lib/errors.js';
import { updateSettingsSchema } from '../schemas/tenant.js';
import { normalizeSettings } from '../lib/tenantSettings.js';

export default async function tenantRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.tenantContext);

  // GET /tenants/me/settings — normalized settings for the caller's tenant.
  fastify.get('/me/settings', async (request) => {
    const tenant = await forTenant(request.tenantId).tenant.get();
    return normalizeSettings(tenant);
  });

  // PATCH /tenants/me/settings — merge the provided fields into the stored JSON
  // (never replace it) and return the same normalized shape as GET.
  fastify.patch('/me/settings', async (request) => {
    const parsed = updateSettingsSchema.parse(request.body);
    if (Object.keys(parsed).length === 0) {
      throw new AppError(400, 'No fields to update', 'EMPTY_UPDATE');
    }

    const db = forTenant(request.tenantId);
    const tenant = await db.tenant.get();
    const settings = { ...(tenant.settings ?? {}), ...parsed };
    const updated = await db.tenant.update({ data: { settings } });
    return normalizeSettings(updated);
  });
}
