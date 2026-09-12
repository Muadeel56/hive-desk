import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { forTenant } from '../lib/tenantDb.js';
import { isPrismaUnavailable } from '../lib/prismaErrors.js';
import {
  startConversationSchema,
  joinConversationSchema,
  resumeConversationSchema,
  sendMessageSchema,
  typingSchema,
  readReceiptSchema,
} from '../schemas/realtime.js';
import { respondToVisitorMessage, handoff as aiHandoff } from '../ai/responder.js';
import { checkLimit } from './rateLimiter.js';

// Conservative starting limits — session-start is the more expensive/abusable
// action (creates a DB row, notifies dashboards) so it's throttled much more
// tightly than a per-message send. Tunable via these constants only.
const RATE_LIMITS = {
  'start-conversation': { limit: 5, windowSeconds: 60 },
  'send-message': { limit: 20, windowSeconds: 10 },
  'resume-conversation': { limit: 30, windowSeconds: 60 },
  'join-conversation': { limit: 30, windowSeconds: 60 },
};

/**
 * Phase 3 — real-time chat.
 *
 * Identity is resolved once in the handshake middleware and stashed on
 * `socket.data`:
 *   - agent   → { kind: 'agent',   tenantId, agentId, role }   (JWT)
 *   - visitor → { kind: 'visitor', tenantId }                  (widget API key)
 *
 * Rooms are per-conversation (`conversation:<id>`). A conversation belongs to
 * exactly one tenant, so a socket that is in a conversation room is transitively
 * tenant-scoped. Every join is tenant-checked server-side via forTenant() — the
 * client's claim is never trusted. Socket.io removes a socket from all rooms on
 * disconnect, so there is no manual registry to leak.
 */
export function initSocket(app) {
  const io = new Server(app.server, {
    cors: { origin: process.env.SOCKET_CORS_ORIGIN ?? '*' },
  });

  // --- handshake auth ------------------------------------------------------
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth ?? {};

    if (auth.token) {
      try {
        const payload = await app.jwt.verify(auth.token);
        if (!payload?.agentId || !payload?.tenantId) {
          return next(new Error('unauthorized'));
        }
        socket.data = {
          kind: 'agent',
          tenantId: payload.tenantId,
          agentId: payload.agentId,
          role: payload.role ?? 'AGENT',
        };
        return next();
      } catch {
        return next(new Error('unauthorized'));
      }
    }

    if (auth.widgetApiKey) {
      const tenant = await prisma.tenant.findUnique({
        where: { widgetApiKey: auth.widgetApiKey },
        select: { id: true },
      });
      if (!tenant) {
        return next(new Error('invalid widget api key'));
      }
      socket.data = { kind: 'visitor', tenantId: tenant.id };
      return next();
    }

    return next(new Error('no credentials'));
  });

  // Conversations with an AI reply in flight — a second visitor message while
  // the model is still thinking must not kick off an overlapping run.
  const aiInFlight = new Set();

  // Typing-indicator auto-expire timers, keyed by `${socket.id}:${conversationId}`.
  // A well-behaved client sends typing:stop itself, but a dropped connection
  // (closed tab, lost network) must not leave the other party staring at a
  // stale "typing…" forever — the server clears it after TYPING_TIMEOUT_MS of
  // silence, and also on disconnect.
  const TYPING_TIMEOUT_MS = 5000;
  const typingTimers = new Map();

  function clearTypingTimer(key) {
    const timer = typingTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      typingTimers.delete(key);
    }
  }

  // --- per-connection handlers ------------------------------------------------
  io.on('connection', (socket) => {
    app.log.debug({ id: socket.id, kind: socket.data.kind, tenantId: socket.data.tenantId }, 'socket connected');

    // Agents get their tenant-wide room so dashboards receive tenant-scoped
    // notifications (conversation-needs-human, conversation-updated) without
    // having joined every conversation.
    if (socket.data.kind === 'agent') {
      socket.join(tenantRoom(socket.data.tenantId));
    }

    const fail = (ack, code, message, extra) => {
      if (typeof ack === 'function') ack({ ok: false, error: { code, message, ...extra } });
    };

    // Wrap a handler so thrown errors become a well-formed ack instead of an
    // unhandled rejection. `bucket` optionally rate-limits the event first,
    // keyed by tenant + connecting IP (never IP alone — see rateLimiter.js)
    // so one tenant's traffic can never exhaust another's budget.
    const guard = (handler, bucket) => async (payload, ack) => {
      try {
        if (bucket) {
          const { allowed, retryAfterMs } = await checkLimit({
            bucket,
            tenantId: socket.data.tenantId,
            ip: socket.handshake.address,
            ...RATE_LIMITS[bucket],
          });
          if (!allowed) {
            return fail(ack, 'RATE_LIMITED', 'Too many requests — please wait a moment', {
              retryAfterMs,
            });
          }
        }
        await handler(payload, ack);
      } catch (err) {
        if (err instanceof ZodError) {
          return fail(ack, 'VALIDATION_ERROR', 'Validation failed');
        }
        if (err instanceof AppError || err?.isAppError) {
          return fail(ack, err.code ?? 'APP_ERROR', err.message);
        }
        if (isPrismaUnavailable(err)) {
          app.log.error({ err: err.message, code: err.code, socketId: socket.id, tenantId: socket.data.tenantId }, 'database unavailable');
          return fail(ack, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable');
        }
        app.log.error({ err, socketId: socket.id, tenantId: socket.data.tenantId }, 'socket handler error');
        return fail(ack, 'INTERNAL_ERROR', 'Internal error');
      }
    };

    // start-conversation — visitor only.
    socket.on(
      'start-conversation',
      guard(async (payload, ack) => {
        if (socket.data.kind !== 'visitor') {
          return fail(ack, 'FORBIDDEN', 'Only visitors can start a conversation');
        }
        startConversationSchema.parse(payload ?? {});

        const db = forTenant(socket.data.tenantId);
        const conversation = await db.conversation.create({
          data: { visitorSessionId: crypto.randomUUID(), status: 'AI' },
        });

        socket.join(conversationRoom(conversation.id));
        socket.data.conversationId = conversation.id;

        // Let agent dashboards for this tenant show the new conversation live,
        // without a refresh or a poll. The full row is sent so the client can
        // prepend it directly.
        io.to(tenantRoom(socket.data.tenantId)).emit('conversation-created', { conversation });

        if (typeof ack === 'function') {
          ack({
            ok: true,
            conversationId: conversation.id,
            sessionId: conversation.visitorSessionId,
          });
        }
      }, 'start-conversation'),
    );

    // resume-conversation — visitor only. Lets a reloaded widget rejoin the
    // conversation it started earlier, without spawning a new one. The stored
    // visitorSessionId must match, so one visitor can't resume another's thread.
    socket.on(
      'resume-conversation',
      guard(async (payload, ack) => {
        if (socket.data.kind !== 'visitor') {
          return fail(ack, 'FORBIDDEN', 'Only visitors can resume a conversation');
        }
        const { conversationId, sessionId } = resumeConversationSchema.parse(payload ?? {});

        const db = forTenant(socket.data.tenantId);
        // Cross-tenant id resolves to null inside forTenant() — do not leak existence.
        const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation || conversation.visitorSessionId !== sessionId) {
          return fail(ack, 'NOT_FOUND', 'Conversation not found');
        }

        const messages = await db.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'asc' },
          take: 50,
        });

        socket.join(conversationRoom(conversationId));
        socket.data.conversationId = conversationId;

        if (typeof ack === 'function') {
          ack({ ok: true, conversationId, messages });
        }
      }, 'resume-conversation'),
    );

    // join-conversation — agent only. Tenant-checked server-side.
    socket.on(
      'join-conversation',
      guard(async (payload, ack) => {
        if (socket.data.kind !== 'agent') {
          return fail(ack, 'FORBIDDEN', 'Only agents can join a conversation');
        }
        const { conversationId } = joinConversationSchema.parse(payload ?? {});

        const db = forTenant(socket.data.tenantId);
        // Cross-tenant id resolves to null inside forTenant() — do not leak existence.
        const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation) {
          return fail(ack, 'NOT_FOUND', 'Conversation not found');
        }

        const messages = await db.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'asc' },
          take: 50,
        });

        socket.join(conversationRoom(conversationId));

        if (typeof ack === 'function') {
          ack({ ok: true, conversation, messages });
        }
      }, 'join-conversation'),
    );

    // send-message — visitor or agent. Authorized by room membership, not by
    // any id the client sends.
    socket.on(
      'send-message',
      guard(async (payload, ack) => {
        const { conversationId, content } = sendMessageSchema.parse(payload ?? {});

        if (!socket.rooms.has(conversationRoom(conversationId))) {
          return fail(ack, 'FORBIDDEN', 'Not a participant in this conversation');
        }

        const role = socket.data.kind === 'agent' ? 'AGENT' : 'VISITOR';
        const db = forTenant(socket.data.tenantId);

        // scopedMessages.create re-asserts the conversation belongs to this
        // tenant — defense in depth.
        const message = await db.message.create({
          data: { conversationId, role, content },
        });

        // Bump updatedAt so agent dashboards can sort by recency; the returned
        // row also gives us the current status for the AI / human-lock logic.
        const conversation = await db.conversation.update({
          where: { id: conversationId },
          data: {},
        });

        io.to(conversationRoom(conversationId)).emit('new-message', {
          id: message.id,
          conversationId,
          role,
          content: message.content,
          createdAt: message.createdAt,
        });

        // --- Phase 4: AI auto-reply / permanent human lock ---------------------
        if (role === 'VISITOR' && conversation.status === 'AI' && !aiInFlight.has(conversationId)) {
          // Fire-and-forget — the visitor's ack must never wait on the model.
          aiInFlight.add(conversationId);
          io.to(conversationRoom(conversationId)).emit('ai-typing', { conversationId });
          respondToVisitorMessage({ io, tenantId: socket.data.tenantId, conversationId })
            .catch((err) => {
              app.log.error({ err, conversationId, tenantId: socket.data.tenantId }, 'ai responder failed — forcing handoff');
              return aiHandoff({
                io,
                tenantId: socket.data.tenantId,
                conversation: { id: conversationId, status: 'AI' },
                reason: 'responder-threw',
              }).catch(() => {});
            })
            .finally(() => aiInFlight.delete(conversationId));
        } else if (role === 'AGENT' && conversation.status !== 'AGENT') {
          // First agent message locks the conversation to AGENT for good.
          await db.conversation.update({
            where: { id: conversationId },
            data: { status: 'AGENT', assignedAgentId: socket.data.agentId },
          });
          io.to(tenantRoom(socket.data.tenantId)).emit('conversation-updated', {
            conversationId,
            status: 'AGENT',
            assignedAgentId: socket.data.agentId,
          });
        }

        if (typeof ack === 'function') ack({ ok: true, id: message.id });
      }, 'send-message'),
    );

    // typing:start / typing:stop — visitor or agent, broadcast to the other
    // party in the same conversation room. Authorized by room membership,
    // exactly like send-message — no client-asserted id is ever trusted.
    socket.on(
      'typing:start',
      guard(async (payload, ack) => {
        const { conversationId } = typingSchema.parse(payload ?? {});
        if (!socket.rooms.has(conversationRoom(conversationId))) {
          return fail(ack, 'FORBIDDEN', 'Not a participant in this conversation');
        }

        const key = `${socket.id}:${conversationId}`;
        clearTypingTimer(key);
        typingTimers.set(
          key,
          setTimeout(() => {
            typingTimers.delete(key);
            io.to(conversationRoom(conversationId)).emit('typing', {
              conversationId,
              from: socket.data.kind,
              typing: false,
            });
          }, TYPING_TIMEOUT_MS),
        );

        socket.to(conversationRoom(conversationId)).emit('typing', {
          conversationId,
          from: socket.data.kind,
          typing: true,
        });

        if (typeof ack === 'function') ack({ ok: true });
      }),
    );

    socket.on(
      'typing:stop',
      guard(async (payload, ack) => {
        const { conversationId } = typingSchema.parse(payload ?? {});
        if (!socket.rooms.has(conversationRoom(conversationId))) {
          return fail(ack, 'FORBIDDEN', 'Not a participant in this conversation');
        }

        clearTypingTimer(`${socket.id}:${conversationId}`);
        socket.to(conversationRoom(conversationId)).emit('typing', {
          conversationId,
          from: socket.data.kind,
          typing: false,
        });

        if (typeof ack === 'function') ack({ ok: true });
      }),
    );

    // message:read — visitor or agent marks every message up to and
    // including `upToMessageId` as read (mark-through, not one event per
    // message). Re-verifies room membership and re-resolves the cutoff
    // message through forTenant() before writing — never trusts the client's
    // conversationId/tenant pairing.
    socket.on(
      'message:read',
      guard(async (payload, ack) => {
        const { conversationId, upToMessageId } = readReceiptSchema.parse(payload ?? {});
        if (!socket.rooms.has(conversationRoom(conversationId))) {
          return fail(ack, 'FORBIDDEN', 'Not a participant in this conversation');
        }

        const db = forTenant(socket.data.tenantId);
        const cutoff = await db.message.findFirst({ where: { id: upToMessageId, conversationId } });
        if (!cutoff) {
          return fail(ack, 'NOT_FOUND', 'Message not found');
        }

        const readAt = new Date();
        await db.message.updateMany({
          where: { conversationId, readAt: null, createdAt: { lte: cutoff.createdAt } },
          data: { readAt },
        });

        io.to(conversationRoom(conversationId)).emit('messages-read', {
          conversationId,
          upToMessageId,
          readAt,
        });

        if (typeof ack === 'function') ack({ ok: true });
      }),
    );

    socket.on('disconnect', (reason) => {
      const prefix = `${socket.id}:`;
      for (const key of [...typingTimers.keys()]) {
        if (!key.startsWith(prefix)) continue;
        clearTypingTimer(key);
        const conversationId = key.slice(prefix.length);
        io.to(conversationRoom(conversationId)).emit('typing', {
          conversationId,
          from: socket.data.kind,
          typing: false,
        });
      }
      app.log.debug({ id: socket.id, reason, tenantId: socket.data.tenantId }, 'socket disconnected');
    });
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
