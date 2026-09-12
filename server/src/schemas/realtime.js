import { z } from 'zod';

/**
 * Socket.io event payload schemas. Parsed inline in the handlers in
 * src/realtime/socket.js; a thrown ZodError is mapped to a
 * `{ ok: false, error: { code: 'VALIDATION_ERROR' } }` ack.
 */

// `start-conversation` (visitor). Mirrors startSessionSchema in schemas/widget.js —
// metadata is validated but not persisted (no column for it yet).
export const startConversationSchema = z
  .object({
    pageUrl: z.string().url().max(2000).optional(),
    referrer: z.string().max(2000).optional(),
  })
  .default({});

// `join-conversation` (agent).
export const joinConversationSchema = z.object({
  conversationId: z.string().min(1),
});

// `resume-conversation` (visitor). Lets a reloaded widget rejoin the same
// server-side conversation. `sessionId` is the visitorSessionId handed back by
// `start-conversation`; it must match the stored row or the resume is refused.
export const resumeConversationSchema = z.object({
  conversationId: z.string().min(1),
  sessionId: z.string().min(1),
});

// `send-message` (visitor or agent).
export const sendMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().trim().min(1).max(4000),
});

// `typing:start` / `typing:stop` (visitor or agent) — same shape either way.
export const typingSchema = z.object({
  conversationId: z.string().min(1),
});

// `message:read` (visitor or agent) — mark every message up to and including
// `upToMessageId` as read, rather than one event per message.
export const readReceiptSchema = z.object({
  conversationId: z.string().min(1),
  upToMessageId: z.string().min(1),
});
