import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the whole process.
 *
 * NOTE: routes must NOT reach for raw `prisma.<model>` with a client-supplied
 * tenant filter. All tenant data access goes through `forTenant()` in
 * ./tenantDb.js. Reviewers: reject any route that imports this module directly
 * to query a tenant-owned model.
 */
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__hivedeskPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__hivedeskPrisma = prisma;
}

export default prisma;
