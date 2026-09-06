import { z } from 'zod';

export const conversationStatus = z.enum(['AI', 'WAITING', 'AGENT', 'CLOSED']);

export const listConversationsQuery = z.object({
  status: conversationStatus.optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const conversationIdParam = z.object({
  id: z.string().min(1),
});
