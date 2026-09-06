import { buildApp } from './app.js';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './cache/redisClient.js';
import { initSocket } from './realtime/socket.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = await buildApp();

// Attach Socket.io to Fastify's underlying HTTP server before it starts
// listening (decorators must be added pre-start). Phase 4 (AI responder) emits
// through `app.io`.
const io = initSocket(app);
app.decorate('io', io);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  logger.error({ err }, 'failed to start server');
  process.exit(1);
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  try {
    io.close();
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
