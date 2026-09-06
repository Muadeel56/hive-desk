import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * Shared ioredis instance built from REDIS_URL.
 *
 * `lazyConnect` keeps the process bootable (and GET /health green) even when
 * Redis is down — the connection is opened on first use. Phase 3+ (Socket.io
 * adapter, rate limiting) depend on this being reachable.
 */
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'redis connection error');
});

export default redis;
