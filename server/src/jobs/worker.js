import { Worker } from 'bullmq';
import { logger } from '../utils/logger.js';
import { prisma } from '../lib/prisma.js';
import { ANALYTICS_QUEUE_NAME, analyticsQueue, connection, registerRepeatableJob } from './queue.js';
import { runAnalyticsRollup } from './analyticsRollup.js';

const worker = new Worker(
  ANALYTICS_QUEUE_NAME,
  async () => {
    await runAnalyticsRollup();
  },
  { connection },
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'analytics worker: rollup job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'analytics worker: rollup job failed');
});

await registerRepeatableJob();

// Run one pass immediately on boot so the dashboard isn't empty for up to an
// hour waiting for the first :00 boundary.
await runAnalyticsRollup();
logger.info('analytics worker: started, hourly rollup scheduled');

async function shutdown(signal) {
  logger.info({ signal }, 'analytics worker: shutting down');
  try {
    await worker.close();
    await analyticsQueue.close();
    await prisma.$disconnect();
    connection.disconnect();
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}
