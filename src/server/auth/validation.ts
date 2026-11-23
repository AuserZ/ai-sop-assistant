import { z } from "zod";

export const userRole = z.enum(["ADMIN", "STAFF"]);
export const userStatus = z.enum(["ACTIVE", "INACTIVE"]);

export const userDirectoryBounds = {
  defaultLimit: 50,
  maximumLimit: 100,
  maximumQueryLength: 100,
  maximumUserIdLength: 128,
} as const;

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

export function escapeIlikePattern(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

export const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const invitationInput = z.object({ email: normalizedEmail, role: userRole }).strict();
export const accountAccessInput = z.object({ role: userRole.optional(), active: z.boolean().optional() }).strict()
  .refine((changes) => changes.role !== undefined || changes.active !== undefined);
export const targetUserIdInput = z
  .string()
  .trim()
  .min(1)
  .max(userDirectoryBounds.maximumUserIdLength)
  .refine((value) => !controlCharacterPattern.test(value));

const directoryLimitInput = z.union([
  z.number().int().min(1).max(userDirectoryBounds.maximumLimit),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(userDirectoryBounds.maximumLimit)),
]);

export const listUsersQueryInput = z
  .object({
    q: z
      .string()
      .refine((value) => !controlCharacterPattern.test(value))
      .transform((value) => value.trim())
      .refine((value) => value.length <= userDirectoryBounds.maximumQueryLength)
      .optional()
      .default(""),
    role: userRole.optional(),
    status: userStatus.optional(),
    limit: directoryLimitInput.optional().default(userDirectoryBounds.defaultLimit),
  })
  .strict();

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
export type UserStatus = z.infer<typeof userStatus>;
export type ListUsersQuery = z.infer<typeof listUsersQueryInput>;
export type AccountAccessChanges = z.infer<typeof accountAccessInput>;
