import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { logger } from '../utils/logger.js';

/**
 * BullMQ needs its own dedicated Redis connection: `maxRetriesPerRequest`
 * must be `null` (BullMQ manages retries itself) and offline queueing must
 * stay enabled so jobs added while Redis is briefly down are queued
 * client-side rather than rejected. There is no other shared Redis client in
 * this codebase (server/src/cache/redisClient.js was removed as dead code —
 * see server/docs/resilience.md) — this is the only Redis connection.
 */
export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on('error', (err) => {
  logger.warn({ err: err.message }, 'bullmq redis connection error');
});

export const ANALYTICS_QUEUE_NAME = 'analytics-rollup';

export const analyticsQueue = new Queue(ANALYTICS_QUEUE_NAME, { connection });

/**
 * Registers the hourly repeatable rollup job. Uses a fixed `jobId` so calling
 * this again (e.g. on every worker restart) is idempotent instead of
 * stacking duplicate repeatable schedulers. A cron pattern (top of every
 * hour) is used instead of `every: 3_600_000` to avoid BullMQ's `every`-based
 * drift and to keep run times predictable/log-friendly.
 */
export async function registerRepeatableJob() {
  await analyticsQueue.add(
    'rollup',
    {},
    {
      repeat: { pattern: '0 * * * *' },
      jobId: 'analytics-rollup-hourly',
    },
  );
}

export default { analyticsQueue, registerRepeatableJob, connection };
