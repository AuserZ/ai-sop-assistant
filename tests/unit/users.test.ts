import { describe, expect, it } from "vitest";
import {
  buildUserDirectoryQueryString,
  invitationIssuedResponseSchema,
  userAccessUpdatedResponseSchema,
  userDirectoryResponseSchema,
  userManagementErrorMessage,
  UserManagementRequestError,
} from "../../src/components/users/client";
import {
  assertNotLastActiveAdmin,
  toDirectoryUserDto,
} from "../../src/server/auth/accounts";
import type { AuthTransaction } from "../../src/server/auth/authorization";
import { AuthFailure, authErrorResponse } from "../../src/server/auth/errors";
import {
  accountAccessInput,
  escapeIlikePattern,
  invitationInput,
  listUsersQueryInput,
  targetUserIdInput,
  userDirectoryBounds,
} from "../../src/server/auth/validation";

function createMockAdminCheckTransaction(otherAdminIds: string[]): AuthTransaction {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => otherAdminIds.map((id) => ({ id })),
          }),
        }),
      }),
    }),
  } as unknown as AuthTransaction;
}

describe("S12 U1/U2/U3/U4 user directory and account management unit contracts", () => {
  it("validates listUsersQueryInput bounds, role/status filters, and rejects control characters or unknown keys", () => {
    expect(listUsersQueryInput.parse({})).toEqual({
      q: "",
      limit: userDirectoryBounds.defaultLimit,
    });

    expect(
      listUsersQueryInput.parse({
        q: "  Alice_Admin%  ",
        role: "ADMIN",
        status: "ACTIVE",
        limit: "25",
      }),
    ).toEqual({
      q: "Alice_Admin%",
      role: "ADMIN",
      status: "ACTIVE",
      limit: 25,
    });

    for (const invalid of [
      { q: "a".repeat(userDirectoryBounds.maximumQueryLength + 1) },
      { q: "bad\u0000query" },
      { q: "bad\nquery" },
      { role: "SUPERADMIN" },
      { status: "DELETED" },
      { limit: 0 },
      { limit: "0" },
      { limit: userDirectoryBounds.maximumLimit + 1 },
      { limit: "-5" },
      { limit: "abc" },
      { extra: "forged" },
    ]) {
      expect(listUsersQueryInput.safeParse(invalid).success).toBe(false);
    }
  });

  it("escapes PostgreSQL ILIKE wildcards without altering ordinary characters", () => {
    expect(escapeIlikePattern("100%_admin\\ops")).toBe("100\\%\\_admin\\\\ops");
    expect(escapeIlikePattern("ordinary.user@example.invalid")).toBe(
      "ordinary.user@example.invalid",
    );
  });

  it("validates targetUserIdInput and accountAccessInput while rejecting privilege escalation fields", () => {
    expect(targetUserIdInput.safeParse("  user-123  ")).toEqual({
      success: true,
      data: "user-123",
    });
    expect(targetUserIdInput.safeParse("").success).toBe(false);
    expect(targetUserIdInput.safeParse("   ").success).toBe(false);
    expect(targetUserIdInput.safeParse("x".repeat(129)).success).toBe(false);
    expect(targetUserIdInput.safeParse("bad\u0007id").success).toBe(false);

    expect(accountAccessInput.safeParse({ role: "ADMIN" }).success).toBe(true);
    expect(accountAccessInput.safeParse({ active: false }).success).toBe(true);
    expect(accountAccessInput.safeParse({ role: "STAFF", active: true }).success).toBe(true);
    expect(accountAccessInput.safeParse({}).success).toBe(false);
    expect(
      accountAccessInput.safeParse({
        role: "ADMIN",
        email: "hijack@example.invalid",
      }).success,
    ).toBe(false);
    expect(
      accountAccessInput.safeParse({
        active: true,
        password: "forged-password-12345",
      }).success,
    ).toBe(false);

    expect(
      invitationInput.safeParse({
        email: "  New.Staff@Example.Invalid ",
        role: "STAFF",
      }),
    ).toEqual({
      success: true,
      data: {
        email: "new.staff@example.invalid",
        role: "STAFF",
      },
    });
    expect(
      invitationInput.safeParse({
        email: "new.staff@example.invalid",
        role: "STAFF",
        password: "never-allow-passwords-in-invite",
      }).success,
    ).toBe(false);
  });

  it("maps directory user DTOs with deterministic status and enforces last-active-Admin protection", async () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    const activeDto = toDirectoryUserDto({
      id: "user-1",
      name: "Primary Admin",
      email: "admin@example.invalid",
      role: "ADMIN",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(activeDto).toEqual({
      id: "user-1",
      name: "Primary Admin",
      email: "admin@example.invalid",
      role: "ADMIN",
      active: true,
      status: "ACTIVE",
      createdAt: "2026-11-23T12:00:00.000Z",
      updatedAt: "2026-11-23T12:00:00.000Z",
    });

    const inactiveDto = toDirectoryUserDto({
      id: "user-2",
      name: "Deactivated Staff",
      email: "staff@example.invalid",
      role: "STAFF",
      active: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(inactiveDto.status).toBe("INACTIVE");

    await expect(
      assertNotLastActiveAdmin(
        createMockAdminCheckTransaction([]),
        { id: "admin-1", role: "ADMIN", active: true },
        { role: "STAFF" },
      ),
    ).rejects.toMatchObject({
      code: "LAST_ADMIN_REQUIRED",
      status: 409,
    });

    await expect(
      assertNotLastActiveAdmin(
        createMockAdminCheckTransaction([]),
        { id: "admin-1", role: "ADMIN", active: true },
        { active: false },
      ),
    ).rejects.toMatchObject({
      code: "LAST_ADMIN_REQUIRED",
      status: 409,
    });

    await expect(
      assertNotLastActiveAdmin(
        createMockAdminCheckTransaction(["admin-2"]),
        { id: "admin-1", role: "ADMIN", active: true },
        { role: "STAFF", active: false },
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertNotLastActiveAdmin(
        createMockAdminCheckTransaction([]),
        { id: "staff-1", role: "STAFF", active: true },
        { active: false },
      ),
    ).resolves.toBeUndefined();
  });

  it("maps S12 error codes safely without leaking internal details and validates client DTOs", async () => {
    for (const [code, status, expectedText] of [
      ["SELF_ACCESS_CHANGE_DENIED", 409, "You cannot demote or deactivate your own Admin account."],
      ["LAST_ADMIN_REQUIRED", 409, "At least one active Admin account must remain."],
      [
        "INVITATION_ALREADY_PENDING",
        409,
        "An active invitation is already pending for this email address.",
      ],
      ["ACCOUNT_EXISTS", 409, "An account with this email address already exists."],
      [
        "INVITATION_DELIVERY_FAILED",
        503,
        "Could not send invitation email right now. Try again.",
      ],
      ["FORBIDDEN", 403, "Admin access required."],
    ] as const) {
      const response = authErrorResponse(new AuthFailure(code, status));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: { code } });
      expect(userManagementErrorMessage(code)).toBe(expectedText);
      const clientError = new UserManagementRequestError(code, status);
      expect(clientError.code).toBe(code);
      expect(clientError.status).toBe(status);
      expect(clientError.message).toBe(expectedText);
    }

    expect(
      buildUserDirectoryQueryString({
        q: "  ops  ",
        role: "ADMIN",
        status: "ACTIVE",
        limit: 25,
      }),
    ).toBe("?q=ops&role=ADMIN&status=ACTIVE&limit=25");
    expect(
      buildUserDirectoryQueryString({
        q: "   ",
        role: "ALL",
        status: "ALL",
      }),
    ).toBe("");

    expect(
      userDirectoryResponseSchema.safeParse({
        users: [
          {
            id: "u1",
            name: "Admin One",
            email: "admin1@example.invalid",
            role: "ADMIN",
            active: true,
            status: "ACTIVE",
            createdAt: "2026-11-23T12:00:00.000Z",
            updatedAt: "2026-11-23T12:00:00.000Z",
          },
        ],
        pendingInvitations: [
          {
            id: "inv-1",
            email: "pending@example.invalid",
            role: "STAFF",
            invitedBy: "u1",
            expiresAt: "2026-11-24T12:00:00.000Z",
            createdAt: "2026-11-23T12:00:00.000Z",
          },
        ],
        summary: {
          totalUsers: 1,
          activeUsers: 1,
          inactiveUsers: 0,
          activeAdmins: 1,
          pendingInvitations: 1,
        },
      }).success,
    ).toBe(true);

    expect(
      invitationIssuedResponseSchema.safeParse({
        invitationId: "inv-1",
        email: "pending@example.invalid",
        role: "STAFF",
        expiresAt: "2026-11-24T12:00:00.000Z",
      }).success,
    ).toBe(true);

    expect(
      userAccessUpdatedResponseSchema.safeParse({
        user: {
          id: "u2",
          name: "Staff Two",
          email: "staff2@example.invalid",
          role: "STAFF",
          active: false,
          status: "INACTIVE",
          createdAt: "2026-11-23T12:00:00.000Z",
          updatedAt: "2026-11-23T12:05:00.000Z",
        },
      }).success,
    ).toBe(true);
  });
});
