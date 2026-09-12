import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * Dedicated Redis connection for request-path concerns (currently: rate
 * limiting) that must stay independent of the BullMQ connection in
 * src/jobs/queue.js. BullMQ's connection is tuned for a background worker
 * (maxRetriesPerRequest: null, no ready check, offline queueing) — wrong
 * defaults for a synchronous check on the request path, which should fail
 * fast rather than hang.
 *
 * Rate limiting is a defense, not a hard dependency: if Redis is down we log
 * and let callers fail open (see src/realtime/rateLimiter.js and the
 * @fastify/rate-limit registration in routes/widgetAuth.js) rather than take
 * all widget traffic down with it.
 */
export const rateLimitRedis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  // Lazy: importing this module (or anything that transitively imports it,
  // e.g. src/ai/responder.js -> realtime/socket.js -> realtime/rateLimiter.js)
  // must not, by itself, open a live socket that keeps a process alive —
  // several unit-test files import that chain without ever exercising rate
  // limiting. The connection opens on the first actual command.
  lazyConnect: true,
});

rateLimitRedis.on('error', (err) => {
  logger.warn({ err: err.message }, 'rate-limit redis connection error');
});

export default rateLimitRedis;
