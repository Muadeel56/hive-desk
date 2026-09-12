import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { forTenant } from '../lib/tenantDb.js';
import { AppError } from '../lib/errors.js';
import { tenantRoom } from '../realtime/socket.js';
import { startSessionSchema } from '../schemas/widget.js';
import { normalizeSettings } from '../lib/tenantSettings.js';
import { rateLimitRedis } from '../lib/redisClient.js';

/**
 * Public widget endpoints. NO `authenticate` — only `tenantContext`, which here
 * takes the `x-widget-api-key` branch. A missing / unknown key -> 401 from the
 * plugin before any handler runs.
 *
 * Rate limiting is registered ONLY in this plugin's scope (Fastify's
 * encapsulation keeps it off every other route — /auth, /conversations, etc.
 * never see it), backed by Redis so counters are shared across instances
 * rather than per-process. Keyed by tenant + IP (never IP alone) so one
 * noisy tenant's traffic can't exhaust another tenant's budget on a shared
 * address. The key is derived straight from the `x-widget-api-key` header
 * rather than `request.tenantId`, because @fastify/rate-limit's default hook
 * runs at `onRequest`, before the `tenantContext` preHandler below has had a
 * chance to resolve the tenant — reading the header directly avoids both the
 * ordering problem and an extra DB round trip per request.
 */
export default async function widgetAuthRoutes(fastify) {
  await fastify.register(rateLimit, {
    global: false,
    redis: rateLimitRedis,
    nameSpace: 'ratelimit:widget-rest:',
    // Rate limiting is a defense, not a hard dependency — a Redis blip must
    // never turn into a 500 (or an unbounded fail-closed) for widget traffic.
    skipOnError: true,
    keyGenerator: (request) => {
      const widgetKey = request.headers['x-widget-api-key'];
      return `${typeof widgetKey === 'string' ? widgetKey : 'unknown'}:${request.ip}`;
    },
    // Thrown by the plugin itself, then caught by our own errorHandler —
    // return an AppError, not a plain object, so it lands on the standard
    // {error:{message,code}} envelope (plus retryAfterMs) instead of falling
    // through to a generic 500.
    errorResponseBuilder: (request, context) => {
      const err = new AppError(429, 'Too many requests — please wait a moment', 'RATE_LIMITED');
      err.retryAfterMs = context.ttl;
      return err;
    },
  });

  fastify.addHook('preHandler', fastify.tenantContext);

  // The rate-limit Redis connection is a long-lived module singleton (also
  // used by the Socket.io limiter in realtime/rateLimiter.js) — tie its
  // shutdown to the Fastify instance's own close so both graceful production
  // shutdown (server.js's SIGTERM handler) and test teardown (app.close())
  // release it, instead of leaving an open socket that keeps the process alive.
  fastify.addHook('onClose', async () => {
    await rateLimitRedis.quit().catch(() => {});
  });

  // GET /widget/config — public branding for the tenant that owns the widget
  // API key. Only the three widget-safe fields; never the raw settings column
  // or the widgetApiKey. Shares normalizeSettings() with the agent settings
  // route so the two can't drift.
  fastify.get(
    '/config',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const tenant = await forTenant(request.tenantId).tenant.get();
      const { displayName, welcomeMessage, brandColor } = normalizeSettings(tenant);
      return { displayName, welcomeMessage, brandColor };
    },
  );

  // POST /widget/session — start an anonymous visitor session. Stricter than
  // /config: it writes a row and fans out a socket notification, so it's the
  // more expensive/abusable of the two, mirroring the socket `start-conversation`
  // limit in realtime/rateLimiter.js.
  fastify.post(
    '/session',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      startSessionSchema.parse(request.body ?? {});

      const db = forTenant(request.tenantId);
      const visitorSessionId = crypto.randomUUID();
      const conversation = await db.conversation.create({
        data: { visitorSessionId, status: 'AI' },
      });

      // Mirror the socket `start-conversation` path: notify agent dashboards
      // for this tenant so a new conversation appears live. `io` is
      // decorated in server.js; guard with `?.` for tests that build the app
      // without a socket.
      request.server.io
        ?.to(tenantRoom(request.tenantId))
        .emit('conversation-created', { conversation });

      return reply.status(201).send({
        sessionId: visitorSessionId,
        conversationId: conversation.id,
      });
    },
  );
}
