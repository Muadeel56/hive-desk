import { rateLimitRedis } from '../lib/redisClient.js';
import { logger } from '../utils/logger.js';

/**
 * Fixed-window rate limiter for Socket.io events (@fastify/rate-limit only
 * covers HTTP routes — the widget's real traffic is these socket events, so
 * they need their own limiter). A single Lua script keeps the increment +
 * expiry atomic; a plain `INCR` then `EXPIRE` pair has a race where a crash
 * or reconnect between the two calls leaves a key with no TTL, which would
 * either wedge a bucket open forever or (with `EXPIRE NX`) never re-arm it.
 *
 * Keys are always `ratelimit:<bucket>:<tenantId>:<ip>` — tenant + IP, never
 * IP alone, so one noisy tenant can't exhaust another tenant's budget on a
 * shared IP (e.g. behind a corporate NAT), and a busy tenant can't be starved
 * by unrelated traffic to a different tenant from the same address.
 */
const INCR_WITH_TTL = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { current, ttl }
`;

export function rateLimitKey(bucket, tenantId, ip) {
  return `ratelimit:${bucket}:${tenantId ?? 'unknown'}:${ip ?? 'unknown'}`;
}

/**
 * @param {object} opts
 * @param {string} opts.bucket short name for the action being limited (e.g. 'start-conversation')
 * @param {string} opts.tenantId
 * @param {string} opts.ip
 * @param {number} opts.limit max requests allowed per window
 * @param {number} opts.windowSeconds window length in seconds
 * @returns {Promise<{allowed: boolean, retryAfterMs: number}>}
 *
 * Fails open (allowed: true) on a Redis error — rate limiting is a defense,
 * not a hard dependency; a Redis outage must not take down the widget.
 */
export async function checkLimit({ bucket, tenantId, ip, limit, windowSeconds }) {
  const key = rateLimitKey(bucket, tenantId, ip);
  try {
    const [current, ttl] = await rateLimitRedis.eval(INCR_WITH_TTL, 1, key, String(windowSeconds));
    if (current > limit) {
      const retryAfterMs = Math.max(ttl, 1) * 1000;
      return { allowed: false, retryAfterMs };
    }
    return { allowed: true, retryAfterMs: 0 };
  } catch (err) {
    logger.warn({ err: err.message, bucket, tenantId }, 'rate limit check failed — failing open');
    return { allowed: true, retryAfterMs: 0 };
  }
}

export default { checkLimit, rateLimitKey };
