import { z } from "zod";
import type {
  DirectoryUserDto,
  PendingInvitationDto,
  UserDirectoryResponse,
  UserDirectorySummaryDto,
} from "@/server/auth/accounts";
import type { UserRole, UserStatus } from "@/server/auth/validation";

export const directoryUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.email(),
  role: z.enum(["ADMIN", "STAFF"]),
  active: z.boolean(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const pendingInvitationSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  role: z.enum(["ADMIN", "STAFF"]),
  invitedBy: z.string().min(1),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const userDirectorySummarySchema = z.object({
  totalUsers: z.number().int().nonnegative(),
  activeUsers: z.number().int().nonnegative(),
  inactiveUsers: z.number().int().nonnegative(),
  activeAdmins: z.number().int().nonnegative(),
  pendingInvitations: z.number().int().nonnegative(),
});

export const userDirectoryResponseSchema = z.object({
  users: z.array(directoryUserSchema),
  pendingInvitations: z.array(pendingInvitationSchema),
  summary: userDirectorySummarySchema,
});

export const invitationIssuedResponseSchema = z.object({
  invitationId: z.string().min(1),
  email: z.email(),
  role: z.enum(["ADMIN", "STAFF"]),
  expiresAt: z.string(),
});

export const userAccessUpdatedResponseSchema = z.object({
  user: directoryUserSchema,
});

export type DirectoryFilterState = {
  q?: string;
  role?: UserRole | "ALL";
  status?: UserStatus | "ALL";
  limit?: number;
};

export type {
  DirectoryUserDto,
  PendingInvitationDto,
  UserDirectoryResponse,
  UserDirectorySummaryDto,
};

const errorMessages: Record<string, string> = {
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  FORBIDDEN: "Admin access required.",
  ACCOUNT_EXISTS: "An account with this email address already exists.",
  INVITATION_ALREADY_PENDING: "An active invitation is already pending for this email address.",
  INVITATION_DELIVERY_FAILED: "Could not send invitation email right now. Try again.",
  SELF_ACCESS_CHANGE_DENIED: "You cannot demote or deactivate your own Admin account.",
  LAST_ADMIN_REQUIRED: "At least one active Admin account must remain.",
  NOT_FOUND: "The requested user account was not found.",
  INVALID_INPUT: "Check the form values and try again.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
};

export function userManagementErrorMessage(code: string): string {
  return errorMessages[code] ?? "User management is temporarily unavailable. Try again.";
}

export class UserManagementRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(userManagementErrorMessage(code));
    this.name = "UserManagementRequestError";
    this.code = code;
    this.status = status;
  }
}

function parseErrorCode(payload: unknown, status: number): string {
  const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
  if (parsed.success) return parsed.data.error.code;
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return "SERVICE_UNAVAILABLE";
}

export function buildUserDirectoryQueryString(filters: DirectoryFilterState = {}): string {
  const params = new URLSearchParams();
  const trimmedQuery = filters.q?.trim() ?? "";
  if (trimmedQuery.length > 0) params.set("q", trimmedQuery);
  if (filters.role && filters.role !== "ALL") params.set("role", filters.role);
  if (filters.status && filters.status !== "ALL") params.set("status", filters.status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchUserDirectory(
  filters: DirectoryFilterState = {},
  signal?: AbortSignal,
): Promise<UserDirectoryResponse> {
  const response = await fetch(`/api/users${buildUserDirectoryQueryString(filters)}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new UserManagementRequestError(parseErrorCode(payload, response.status), response.status);
  }
  const parsed = userDirectoryResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UserManagementRequestError("SERVICE_UNAVAILABLE", 503);
  }
  return parsed.data;
}

export async function inviteDirectoryUser(
  input: { email: string; role: UserRole },
  signal?: AbortSignal,
): Promise<z.infer<typeof invitationIssuedResponseSchema>> {
  const response = await fetch("/api/users/invite", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new UserManagementRequestError(parseErrorCode(payload, response.status), response.status);
  }
  const parsed = invitationIssuedResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UserManagementRequestError("SERVICE_UNAVAILABLE", 503);
  }
  return parsed.data;
}

export async function updateDirectoryUserAccess(
  userId: string,
  changes: { role?: UserRole; active?: boolean },
  signal?: AbortSignal,
): Promise<{ user: DirectoryUserDto }> {
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new UserManagementRequestError(parseErrorCode(payload, response.status), response.status);
  }
  const parsed = userAccessUpdatedResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UserManagementRequestError("SERVICE_UNAVAILABLE", 503);
  }
  return parsed.data;
}
