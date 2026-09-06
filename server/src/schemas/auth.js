import { z } from 'zod';

export const signupSchema = z.object({
  tenantName: z.string().trim().min(2).max(120),
  agentEmail: z.string().trim().toLowerCase().email(),
  agentPassword: z.string().min(8).max(200),
  agentName: z.string().trim().min(1).max(120),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
