import { logger } from '../utils/logger.js';

/**
 * STUB — Phase 7. A repeatable background job that rolls up per-tenant stats
 * (conversations/day, AI resolution rate, avg time-to-human-response).
 */
export async function runAnalyticsRollup() {
  logger.debug('analyticsRollup: stub — no-op (Phase 7)');
}

export default { runAnalyticsRollup };
