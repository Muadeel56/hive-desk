import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';

/**
 * STUB — Phase 3 wires the real visitor/agent flows and tenant-scoped rooms.
 * For now this just constructs the io server; server.js does not attach it yet.
 */
export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.SOCKET_CORS_ORIGIN ?? '*' },
  });

  io.on('connection', (socket) => {
    logger.debug({ id: socket.id }, 'socket connected (stub — no handlers yet)');
  });

  return io;
}

/** Room name for a conversation. Conversations belong to exactly one tenant. */
export function conversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

/** Tenant-wide room (agent dashboards for a tenant). */
export function tenantRoom(tenantId) {
  return `tenant:${tenantId}`;
}
