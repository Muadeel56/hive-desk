import { z } from 'zod';

export const createKbEntrySchema = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(5000),
});

export const updateKbEntrySchema = createKbEntrySchema.partial();

export const kbIdParam = z.object({
  id: z.string().min(1),
});
