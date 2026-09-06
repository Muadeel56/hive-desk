import { z } from 'zod';

export const createKbEntrySchema = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(5000),
});

export const updateKbEntrySchema = createKbEntrySchema.partial();

export const kbIdParam = z.object({
  id: z.string().min(1),
});

// Basic pagination for the list endpoint — mirrors listConversationsQuery.
export const listKbEntriesQuery = z.object({
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});
