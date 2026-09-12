import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';

import errorHandler from './plugins/errorHandler.js';
import authenticate from './plugins/authenticate.js';
import tenantContext from './plugins/tenantContext.js';

import authRoutes from './routes/auth.js';
import tenantRoutes from './routes/tenants.js';
import conversationRoutes from './routes/conversations.js';
import knowledgeBaseRoutes from './routes/knowledgeBase.js';
import widgetAuthRoutes from './routes/widgetAuth.js';
import analyticsRoutes from './routes/analytics.js';

/**
 * Builds the Fastify instance (plugins + routes) without listening.
 * server.js calls .listen(); tests use .inject().
 */
export async function buildApp(opts = {}) {
  const app = Fastify({ loggerInstance: logger, ...opts });

  // CORS for the dashboard SPA (dev on :5173) and the embeddable widget, which
  // call this API from a different origin. `CORS_ORIGIN` is a comma-separated
  // allowlist; unset -> reflect any origin (fine for local dev, lock down in prod).
  await app.register(fastifyCors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // The embeddable widget calls `/widget/config` from arbitrary tenant sites
    // with a custom key header — keep it allowed even once CORS_ORIGIN is pinned.
    allowedHeaders: ['Content-Type', 'Authorization', 'x-widget-api-key'],
  });

  await app.register(errorHandler);
  await app.register(authenticate);
  await app.register(tenantContext);

  app.get('/health', async () => ({ status: 'ok', service: 'hivedesk-server' }));

  // Readiness probe: unlike /health (pure liveness, always fast, no
  // dependencies), this actually pings Postgres. Intended for orchestrator
  // readiness checks / the manual outage test in docs/resilience.md, not for
  // high-frequency liveness polling.
  app.get('/health/ready', async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', service: 'hivedesk-server' };
    } catch (err) {
      request.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({
        error: { message: 'Service temporarily unavailable', code: 'SERVICE_UNAVAILABLE' },
      });
    }
  });

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(tenantRoutes, { prefix: '/tenants' });
  await app.register(conversationRoutes, { prefix: '/conversations' });
  await app.register(knowledgeBaseRoutes, { prefix: '/knowledge-base' });
  await app.register(widgetAuthRoutes, { prefix: '/widget' });
  await app.register(analyticsRoutes, { prefix: '/analytics' });

  return app;
}

export default buildApp;
