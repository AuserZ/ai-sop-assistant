import { z } from "zod";

export const userRole = z.enum(["ADMIN", "STAFF"]);
export const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const invitationInput = z.object({ email: normalizedEmail, role: userRole }).strict();
export const accountAccessInput = z.object({ role: userRole.optional(), active: z.boolean().optional() }).strict()
  .refine((changes) => changes.role !== undefined || changes.active !== undefined);
export const invitationAcceptanceInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: normalizedEmail,
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
}).strict();
export const signInInput = z.object({
  email: normalizedEmail,
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().optional(),
}).strict();

export type UserRole = z.infer<typeof userRole>;
