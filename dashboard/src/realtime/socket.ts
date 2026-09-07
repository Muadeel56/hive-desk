/*
 * Single app-scoped Socket.io connection.
 *
 * One io() instance for the whole dashboard — created on login, torn down on
 * logout, reused across every route change. Components never call io()
 * themselves; they use subscribe()/emit() against this module.
 */
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { API_BASE } from '../lib/api';

export type SocketStatus = 'connected' | 'connecting' | 'disconnected';

let socket: Socket | null = null;
let status: SocketStatus = 'disconnected';
const statusListeners = new Set<(s: SocketStatus) => void>();
let onAuthError: () => void = () => {};

/** Registered by AuthProvider — a permanent auth failure bounces to /login. */
export function setSocketAuthErrorHandler(fn: () => void): void {
  onAuthError = fn;
}

function setStatus(next: SocketStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(status);
}

export function getSocketStatus(): SocketStatus {
  return status;
}

/** Subscribe to connection-status changes; fires immediately with the current value. */
export function onSocketStatus(fn: (s: SocketStatus) => void): () => void {
  statusListeners.add(fn);
  fn(status);
  return () => {
    statusListeners.delete(fn);
  };
}

export function connectSocket(token: string): Socket {
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) {
      setStatus('connecting');
      socket.connect();
    }
    return socket;
  }

  socket = io(API_BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  setStatus('connecting');

  socket.on('connect', () => setStatus('connected'));
  socket.on('disconnect', () => setStatus('disconnected'));
  socket.io.on('reconnect_attempt', () => setStatus('connecting'));
  socket.io.on('reconnect', () => setStatus('connected'));
  socket.on('connect_error', (err: Error) => {
    setStatus('disconnected');
    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('unauthorized') || msg.includes('credentials') || msg.includes('jwt')) {
      onAuthError();
    }
  });

  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  setStatus('disconnected');
}

/** Listen for a server event. Returns an unsubscribe fn. No-op if not connected. */
export function subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
  const s = socket;
  if (!s) return () => {};
  const wrapped = handler as (...args: unknown[]) => void;
  s.on(event, wrapped);
  return () => {
    s.off(event, wrapped);
  };
}

/** Emit an event and resolve with the server's ack (rejects on timeout). */
export function emit<T = unknown>(event: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const s = socket;
    if (!s) {
      reject(new Error('Socket not connected'));
      return;
    }
    s.timeout(timeoutMs).emit(event, payload, (err: Error | null, ack: T) => {
      if (err) reject(err);
      else resolve(ack);
    });
  });
}
