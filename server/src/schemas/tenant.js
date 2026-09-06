import { z } from 'zod';

// Widget-facing, safe subset of tenant settings.
export const updateSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  welcomeMessage: z.string().trim().max(500).optional(),
  brandColor: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex color like #2563eb')
    .optional(),
});
