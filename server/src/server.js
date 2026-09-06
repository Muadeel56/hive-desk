import { buildApp } from './app.js';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './cache/redisClient.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = await buildApp();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  logger.error({ err }, 'failed to start server');
  process.exit(1);
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await prisma.$disconnect();
    if (redis.status === 'ready' || redis.status === 'connecting') {
      redis.disconnect();
    }
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}
