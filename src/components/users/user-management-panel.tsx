"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import {
  accountSchema,
  buttonClassName,
  inputClassName,
  linkClassName,
  type Account,
} from "@/components/auth/client";
import type { UserRole, UserStatus } from "@/server/auth/validation";
import {
  fetchUserDirectory,
  inviteDirectoryUser,
  updateDirectoryUserAccess,
  UserManagementRequestError,
  type DirectoryFilterState,
  type DirectoryUserDto,
  type UserDirectoryResponse,
} from "./client";

type SessionAccessState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "signed-in"; user: Account };

const secondaryButtonClassName =
  "min-h-11 cursor-pointer rounded-md border border-[#334155] bg-white px-4 py-2 text-sm font-medium text-[#0f172a] hover:bg-[#f1f5f9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-50";

const dangerButtonClassName =
  "min-h-11 cursor-pointer rounded-md border border-[#991b1b] bg-[#991b1b] px-4 py-2 text-sm font-medium text-white hover:bg-[#7f1d1d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#991b1b] disabled:cursor-not-allowed disabled:opacity-50";

const inviteEmailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254));

function formatCountLabel(count: number, query: string): string {
  const noun = count === 1 ? "user" : "users";
  return query ? `${count} ${noun} shown for "${query}".` : `${count} ${noun} shown.`;
}

function formatShortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function UserManagementPanel() {
  const [access, setAccess] = useState<SessionAccessState>({ kind: "loading" });
  const [sessionRefresh, setSessionRefresh] = useState(0);

  const [directory, setDirectory] = useState<UserDirectoryResponse | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<UserStatus | "ALL">("ALL");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("STAFF");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const directoryController = useRef<AbortController | null>(null);

  async function loadDirectory(
    filters: DirectoryFilterState,
    signal?: AbortSignal,
  ): Promise<UserDirectoryResponse | null> {
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const response = await fetchUserDirectory(filters, signal);
      if (signal?.aborted) return null;
      setDirectory(response);
      setAppliedQuery(filters.q?.trim() ?? "");
      return response;
    } catch (failure) {
      if (signal?.aborted) return null;
      if (failure instanceof UserManagementRequestError) {
        if (failure.code === "UNAUTHENTICATED") {
          setAccess({ kind: "anonymous" });
          return null;
        }
        if (failure.code === "FORBIDDEN") {
          setAccess((previous) =>
            previous.kind === "signed-in"
              ? { kind: "signed-in", user: { ...previous.user, role: "STAFF" } }
              : previous,
          );
          return null;
        }
        setDirectoryError(failure.message);
      } else {
        setDirectoryError("User management is temporarily unavailable. Try again.");
      }
      return null;
    } finally {
      if (!signal?.aborted) {
        setDirectoryLoading(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) setAccess({ kind: "anonymous" });
          return;
        }
        const parsed = z.object({ user: accountSchema }).safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Account unavailable");
        if (controller.signal.aborted) return;
        setAccess({ kind: "signed-in", user: parsed.data.user });
        if (parsed.data.user.role === "ADMIN") {
          await loadDirectory({ q: "", role: "ALL", status: "ALL" }, controller.signal);
        }
      } catch {
        if (!controller.signal.aborted) setAccess({ kind: "error" });
      }
    })();
    return () => {
      controller.abort();
      directoryController.current?.abort();
    };
  }, [sessionRefresh]);

  function triggerFilterFetch(nextFilters: DirectoryFilterState) {
    directoryController.current?.abort();
    const controller = new AbortController();
    directoryController.current = controller;
    void loadDirectory(nextFilters, controller.signal);
  }

  async function handleInviteSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteBusy) return;
    setInviteStatus(null);
    setInviteError(null);

    const parsedEmail = inviteEmailSchema.safeParse(inviteEmail);
    if (!parsedEmail.success) {
      setInviteError(parsedEmail.error.issues[0]?.message ?? "Enter a valid email address.");
      return;
    }

    setInviteBusy(true);
    try {
      const invited = await inviteDirectoryUser({
        email: parsedEmail.data,
        role: inviteRole,
      });
      setInviteEmail("");
      setInviteStatus(
        `Invitation sent to ${invited.email} (${invited.role === "ADMIN" ? "Admin" : "Staff"}).`,
      );
      await loadDirectory({ q: searchInput, role: roleFilter, status: statusFilter });
    } catch (failure) {
      if (failure instanceof UserManagementRequestError) {
        if (failure.code === "UNAUTHENTICATED") {
          setAccess({ kind: "anonymous" });
          return;
        }
        setInviteError(failure.message);
      } else {
        setInviteError("Could not send invitation email right now. Try again.");
      }
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleUserAccessChange(
    target: DirectoryUserDto,
    changes: { role?: UserRole; active?: boolean },
  ) {
    if (busyUserId) return;
    setBusyUserId(target.id);
    setActionStatus(null);
    setActionError(null);
    try {
      const { user } = await updateDirectoryUserAccess(target.id, changes);
      const roleLabel = user.role === "ADMIN" ? "Admin" : "Staff";
      const statusLabel = user.active ? "Active" : "Inactive";
      setActionStatus(`Updated ${user.name} (${user.email}): ${roleLabel}, ${statusLabel}.`);
      await loadDirectory({ q: searchInput, role: roleFilter, status: statusFilter });
    } catch (failure) {
      if (failure instanceof UserManagementRequestError) {
        if (failure.code === "UNAUTHENTICATED") {
          setAccess({ kind: "anonymous" });
          return;
        }
        setActionError(failure.message);
      } else {
        setActionError("User management is temporarily unavailable. Try again.");
      }
    } finally {
      setBusyUserId(null);
    }
  }

  if (access.kind === "loading") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          User Management
        </h1>
        <p role="status" className="mt-6 text-sm text-[#475569]">
          Checking sign-in...
        </p>
      </main>
    );
  }

  if (access.kind === "anonymous") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          User Management
        </h1>
        <p className="mt-4 text-sm text-[#475569]">
          Sign in with your Admin account to manage users and invitations.
        </p>
        <div className="mt-4">
          <Link href="/sign-in" className={linkClassName}>
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (access.kind === "error") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          User Management
        </h1>
        <p role="alert" className="mt-4 text-sm text-[#991b1b]">
          Sign-in status is temporarily unavailable.
        </p>
        <button
          type="button"
          onClick={() => {
            setAccess({ kind: "loading" });
            setSessionRefresh((current) => current + 1);
          }}
          className={`mt-4 ${buttonClassName}`}
        >
          Retry
        </button>
      </main>
    );
  }

  if (access.user.role !== "ADMIN") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="border-b border-[#e2e8f0] pb-4">
          <nav aria-label="Primary" className="flex flex-wrap items-center gap-4">
            <Link href="/chat" className={linkClassName}>
              Chat
            </Link>
            <Link href="/documents" className={linkClassName}>
              List Document SOP
            </Link>
          </nav>
        </header>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          User Management
        </h1>
        <p role="alert" className="mt-4 text-sm font-medium text-[#991b1b]">
          Admin access required.
        </p>
      </main>
    );
  }

  const summary = directory?.summary ?? {
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    activeAdmins: 0,
    pendingInvitations: 0,
  };
  const users = directory?.users ?? [];
  const pendingInvitations = directory?.pendingInvitations ?? [];

  return (
    <main
      className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10"
      data-user-management="ready"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] pb-4">
        <nav aria-label="Primary" className="flex flex-wrap items-center gap-4">
          <Link href="/chat" className={linkClassName}>
            Chat
          </Link>
          <Link href="/documents" className={linkClassName}>
            List Document SOP
          </Link>
          <Link href="/users" aria-current="page" className={`${linkClassName} font-semibold`}>
            User Management
          </Link>
        </nav>
        <p className="text-xs text-[#475569] break-words">
          Signed in as {access.user.name} (Admin)
        </p>
      </header>

      <div className="mt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          User Management
        </h1>
        <p className="mt-1 text-sm text-[#475569]">
          Invite company members, update Staff or Admin roles, and manage active account access.
        </p>
      </div>

      <section aria-label="Directory summary" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div
          data-testid="summary-total-users"
          className="rounded-lg border border-[#cbd5e1] bg-[#f8fafc] p-3 text-sm text-[#0f172a]"
        >
          <span className="block text-xs text-[#475569]">Total users</span>
          <span className="mt-1 block text-lg font-semibold [font-variant-numeric:tabular-nums]">
            {summary.totalUsers}
          </span>
        </div>
        <div
          data-testid="summary-active-users"
          className="rounded-lg border border-[#cbd5e1] bg-[#f8fafc] p-3 text-sm text-[#0f172a]"
        >
          <span className="block text-xs text-[#475569]">Active</span>
          <span className="mt-1 block text-lg font-semibold [font-variant-numeric:tabular-nums]">
            {summary.activeUsers}
          </span>
        </div>
        <div
          data-testid="summary-inactive-users"
          className="rounded-lg border border-[#cbd5e1] bg-[#f8fafc] p-3 text-sm text-[#0f172a]"
        >
          <span className="block text-xs text-[#475569]">Inactive</span>
          <span className="mt-1 block text-lg font-semibold [font-variant-numeric:tabular-nums]">
            {summary.inactiveUsers}
          </span>
        </div>
        <div
          data-testid="summary-active-admins"
          className="rounded-lg border border-[#cbd5e1] bg-[#f8fafc] p-3 text-sm text-[#0f172a]"
        >
          <span className="block text-xs text-[#475569]">Active Admins</span>
          <span className="mt-1 block text-lg font-semibold [font-variant-numeric:tabular-nums]">
            {summary.activeAdmins}
          </span>
        </div>
        <div
          data-testid="summary-pending-invitations"
          className="col-span-2 rounded-lg border border-[#cbd5e1] bg-[#f8fafc] p-3 text-sm text-[#0f172a] sm:col-span-1"
        >
          <span className="block text-xs text-[#475569]">Pending invites</span>
          <span className="mt-1 block text-lg font-semibold [font-variant-numeric:tabular-nums]">
            {summary.pendingInvitations}
          </span>
        </div>
      </section>

      <section
        aria-labelledby="invite-user-heading"
        className="mt-8 rounded-xl border border-[#cbd5e1] bg-white p-4 sm:p-6"
      >
        <h2 id="invite-user-heading" className="text-lg font-semibold text-[#0f172a]">
          Invite user
        </h2>
        <p className="mt-1 text-sm text-[#475569]">
          Send a single-use 24-hour invitation link bound to the recipient&apos;s email address and role.
        </p>

        <form onSubmit={(event) => void handleInviteSubmit(event)} noValidate className="mt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
            <div className="min-w-0 space-y-1">
              <label htmlFor="invite-email" className="block text-sm font-medium text-[#0f172a]">
                Email address
              </label>
              <input
                id="invite-email"
                name="email"
                type="email"
                autoComplete="off"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                disabled={inviteBusy}
                placeholder="colleague@company.example"
                className={inputClassName}
              />
            </div>

            <div className="min-w-0 space-y-1">
              <label htmlFor="invite-role" className="block text-sm font-medium text-[#0f172a]">
                Role
              </label>
              <select
                id="invite-role"
                name="role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as UserRole)}
                disabled={inviteBusy}
                className={inputClassName}
              >
                <option value="STAFF">Staff</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>

            <button type="submit" disabled={inviteBusy} className={buttonClassName}>
              {inviteBusy ? "Sending invitation..." : "Send invitation"}
            </button>
          </div>
        </form>

        {inviteStatus && (
          <p
            role="status"
            data-testid="invite-status"
            className="mt-3 text-sm font-medium text-[#065f46] break-words"
          >
            {inviteStatus}
          </p>
        )}
        {inviteError && (
          <p
            role="alert"
            data-testid="invite-error"
            className="mt-3 text-sm font-medium text-[#991b1b] break-words"
          >
            {inviteError}
          </p>
        )}
      </section>

      {pendingInvitations.length > 0 && (
        <section
          aria-labelledby="pending-invitations-heading"
          className="mt-8 rounded-xl border border-[#cbd5e1] bg-[#f8fafc] p-4 sm:p-6"
        >
          <h2 id="pending-invitations-heading" className="text-lg font-semibold text-[#0f172a]">
            Pending invitations
          </h2>
          <ul data-testid="pending-invitations-list" className="mt-3 space-y-2">
            {pendingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                data-testid={`pending-invitation-${invitation.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm"
              >
                <span className="min-w-0 font-medium text-[#0f172a] break-all">
                  {invitation.email}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-[#475569]">
                  <span className="rounded bg-[#e2e8f0] px-2 py-0.5 font-semibold text-[#0f172a]">
                    {invitation.role}
                  </span>
                  <span className="[font-variant-numeric:tabular-nums]">
                    Expires {formatShortDate(invitation.expiresAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="directory-heading" className="mt-8">
        <h2 id="directory-heading" className="text-lg font-semibold text-[#0f172a]">
          User directory
        </h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            triggerFilterFetch({ q: searchInput, role: roleFilter, status: statusFilter });
          }}
          className="mt-4 rounded-xl border border-[#cbd5e1] bg-white p-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_10rem_auto_auto] sm:items-end">
            <div className="min-w-0 space-y-1">
              <label htmlFor="search-users" className="block text-sm font-medium text-[#0f172a]">
                Search users
              </label>
              <input
                id="search-users"
                name="q"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by name or email..."
                className={inputClassName}
              />
            </div>

            <div className="min-w-0 space-y-1">
              <label htmlFor="filter-role" className="block text-sm font-medium text-[#0f172a]">
                Role filter
              </label>
              <select
                id="filter-role"
                name="roleFilter"
                value={roleFilter}
                onChange={(event) => {
                  const nextRole = event.target.value as UserRole | "ALL";
                  setRoleFilter(nextRole);
                  triggerFilterFetch({ q: searchInput, role: nextRole, status: statusFilter });
                }}
                className={inputClassName}
              >
                <option value="ALL">All roles</option>
                <option value="ADMIN">Admin</option>
                <option value="STAFF">Staff</option>
              </select>
            </div>

            <div className="min-w-0 space-y-1">
              <label htmlFor="filter-status" className="block text-sm font-medium text-[#0f172a]">
                Status filter
              </label>
              <select
                id="filter-status"
                name="statusFilter"
                value={statusFilter}
                onChange={(event) => {
                  const nextStatus = event.target.value as UserStatus | "ALL";
                  setStatusFilter(nextStatus);
                  triggerFilterFetch({ q: searchInput, role: roleFilter, status: nextStatus });
                }}
                className={inputClassName}
              >
                <option value="ALL">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>

            <button type="submit" className={buttonClassName}>
              Search
            </button>

            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setRoleFilter("ALL");
                setStatusFilter("ALL");
                triggerFilterFetch({ q: "", role: "ALL", status: "ALL" });
              }}
              className={secondaryButtonClassName}
            >
              Clear
            </button>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p
            role="status"
            data-testid="users-count-status"
            className="text-sm text-[#475569] [font-variant-numeric:tabular-nums]"
          >
            {directoryLoading && !directory
              ? "Loading users..."
              : formatCountLabel(users.length, appliedQuery)}
          </p>
        </div>

        {actionStatus && (
          <p
            role="status"
            data-testid="user-action-status"
            className="mt-3 rounded-lg border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm font-medium text-[#065f46] break-words"
          >
            {actionStatus}
          </p>
        )}

        {actionError && (
          <p
            role="alert"
            data-testid="user-action-error"
            className="mt-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-sm font-medium text-[#991b1b] break-words"
          >
            {actionError}
          </p>
        )}

        {directoryError && (
          <div
            role="alert"
            data-testid="directory-error"
            className="mt-4 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
          >
            <p>{directoryError}</p>
            <button
              type="button"
              onClick={() =>
                triggerFilterFetch({ q: searchInput, role: roleFilter, status: statusFilter })
              }
              className={`mt-3 ${secondaryButtonClassName}`}
            >
              Retry directory
            </button>
          </div>
        )}

        {!directoryLoading && !directoryError && users.length === 0 && (
          <div
            data-testid="users-empty-state"
            className="mt-4 rounded-xl border border-[#cbd5e1] bg-[#f8fafc] p-6 text-sm text-[#475569]"
          >
            No user accounts match the current filter.
          </div>
        )}

        <ul data-testid="users-directory-list" className="mt-4 space-y-3">
          {users.map((user) => {
            const isSelf = user.id === access.user.id;
            const isRowBusy = busyUserId === user.id;
            const nextRole: UserRole = user.role === "ADMIN" ? "STAFF" : "ADMIN";
            const nextActive = !user.active;

            return (
              <li
                key={user.id}
                data-testid={`user-row-${user.id}`}
                data-user-email={user.email}
                data-user-role={user.role}
                data-user-status={user.status}
                className="rounded-xl border border-[#cbd5e1] bg-white p-4 shadow-2xs"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        data-testid={`user-name-${user.id}`}
                        className="font-semibold text-[#0f172a] break-words"
                      >
                        {user.name}
                      </span>
                      <span
                        data-testid={`user-role-${user.id}`}
                        className="rounded bg-[#e2e8f0] px-2 py-0.5 text-xs font-semibold text-[#0f172a]"
                      >
                        {user.role}
                      </span>
                      <span
                        data-testid={`user-status-${user.id}`}
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          user.active
                            ? "bg-[#dcfce7] text-[#166534]"
                            : "bg-[#fee2e2] text-[#991b1b]"
                        }`}
                      >
                        {user.active ? "Active" : "Inactive"}
                      </span>
                      {isSelf && (
                        <span
                          data-testid={`user-self-badge-${user.id}`}
                          className="rounded border border-[#94a3b8] bg-[#f8fafc] px-2 py-0.5 text-xs font-medium text-[#334155]"
                        >
                          Current Admin (you)
                        </span>
                      )}
                    </div>
                    <p
                      data-testid={`user-email-${user.id}`}
                      className="text-sm text-[#475569] break-all"
                    >
                      {user.email}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isSelf || isRowBusy}
                      onClick={() => void handleUserAccessChange(user, { role: nextRole })}
                      className={secondaryButtonClassName}
                    >
                      {user.role === "ADMIN" ? "Make Staff" : "Make Admin"}
                    </button>
                    <button
                      type="button"
                      disabled={isSelf || isRowBusy}
                      onClick={() => void handleUserAccessChange(user, { active: nextActive })}
                      className={user.active ? dangerButtonClassName : buttonClassName}
                    >
                      {user.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
