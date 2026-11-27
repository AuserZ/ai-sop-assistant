"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  flexRender,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { AlertCircle, CheckCircle2, Loader2, MailPlus, Search, ShieldAlert } from "lucide-react";
import { z } from "zod";
import { accountSchema, buttonClassName, inputClassName, type Account } from "@/components/auth/client";
import { AppShell } from "@/components/layout/app-shell";
import { getMonogramInitials } from "@/components/layout/navigation";
import { BrandMark, buttonClass, StatusBadge } from "@/components/ui/primitives";
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

const usersTableFeatures = tableFeatures({});

type SessionAccessState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "signed-in"; user: Account };

const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address.").max(254));

function formatCountLabel(count: number, query: string): string {
  const noun = count === 1 ? "user" : "users";
  return query ? `${count} ${noun} shown for "${query}".` : `${count} ${noun} shown.`;
}

function formatShortDate(iso: string): string {
  return iso.slice(0, 10);
}

const columnWidthClass: Readonly<Record<string, string>> = {
  name: "md:w-[24%]",
  email: "md:w-[26%]",
  role: "md:w-[11%]",
  status: "md:w-[13%]",
  actions: "md:w-[26%]",
};

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

  const loadDirectory = useCallback(
    async (
      filters: DirectoryFilterState,
      signal?: AbortSignal,
    ): Promise<UserDirectoryResponse | null> => {
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
    },
    [],
  );

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
  }, [sessionRefresh, loadDirectory]);

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

  const handleUserAccessChange = useCallback(
    async (target: DirectoryUserDto, changes: { role?: UserRole; active?: boolean }) => {
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
    },
    [busyUserId, loadDirectory, searchInput, roleFilter, statusFilter],
  );

  const currentUserId = access.kind === "signed-in" ? access.user.id : null;
  const users = directory?.users ?? [];

  const columns = useMemo<ColumnDef<typeof usersTableFeatures, DirectoryUserDto>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => {
          const user = row.original;
          const isSelf = user.id === currentUserId;
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[#e2e8f0] bg-[#f1f5f9] text-xs font-semibold text-[#0f172a]"
              >
                {getMonogramInitials(user.name)}
              </span>
              <div className="min-w-0 space-y-1">
                <p
                  data-testid={`user-name-${user.id}`}
                  className="break-words font-medium text-[#0f172a]"
                >
                  {user.name}
                </p>
                {isSelf && (
                  <span
                    data-testid={`user-self-badge-${user.id}`}
                    className="inline-flex rounded-[var(--radius-sm)] border border-[#cbd5e1] bg-[#f8fafc] px-2 py-0.5 text-xs font-medium text-[#475569]"
                  >
                    Current Admin (you)
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => (
          <p
            data-testid={`user-email-${row.original.id}`}
            className="break-all font-mono text-xs text-[#475569]"
          >
            {row.original.email}
          </p>
        ),
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => (
          <StatusBadge
            label={row.original.role}
            tone={row.original.role === "ADMIN" ? "processing" : "neutral"}
            testId={`user-role-${row.original.id}`}
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusBadge
            label={row.original.active ? "Active" : "Inactive"}
            tone={row.original.active ? "active" : "danger"}
            testId={`user-status-${row.original.id}`}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const user = row.original;
          const isSelf = user.id === currentUserId;
          const isRowBusy = busyUserId === user.id;
          const nextRole: UserRole = user.role === "ADMIN" ? "STAFF" : "ADMIN";
          const nextActive = !user.active;

          return (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isSelf || isRowBusy}
                onClick={() => void handleUserAccessChange(user, { role: nextRole })}
                className={buttonClass("secondary", "sm")}
              >
                {user.role === "ADMIN" ? "Make Staff" : "Make Admin"}
              </button>
              <button
                type="button"
                disabled={isSelf || isRowBusy}
                onClick={() => void handleUserAccessChange(user, { active: nextActive })}
                className={buttonClass(user.active ? "destructive" : "primary", "sm")}
              >
                {user.active ? "Deactivate" : "Reactivate"}
              </button>
            </div>
          );
        },
      },
    ],
    [currentUserId, busyUserId, handleUserAccessChange],
  );

  const table = useTable({
    features: usersTableFeatures,
    data: users,
    columns,
    getRowId: (row) => row.id,
  });

  if (access.kind !== "signed-in") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-6">
          <BrandMark />
          <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">User Management</h1>
          {access.kind === "loading" && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-[#475569]">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>Checking sign-in...</span>
            </p>
          )}
          {access.kind === "anonymous" && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-[#475569]">
                Sign in with your Admin account to manage users and invitations.
              </p>
              <Link href="/sign-in" className={buttonClass("primary", "default", "w-full")}>
                Sign in
              </Link>
            </div>
          )}
          {access.kind === "error" && (
            <div className="mt-4 space-y-4">
              <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                Sign-in status is temporarily unavailable.
              </p>
              <button
                type="button"
                onClick={() => {
                  setAccess({ kind: "loading" });
                  setSessionRefresh((current) => current + 1);
                }}
                className={buttonClassName}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  if (access.user.role !== "ADMIN") {
    return (
      <AppShell
        user={access.user}
        activeMenu="users"
        onSignedOut={() => setAccess({ kind: "anonymous" })}
      >
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold text-[#0f172a]">User Management</h1>
          <div className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm font-medium text-[#991b1b]">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <p role="alert">Admin access required.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  const summary = directory?.summary ?? {
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    activeAdmins: 0,
    pendingInvitations: 0,
  };
  const pendingInvitations = directory?.pendingInvitations ?? [];

  return (
    <AppShell
      user={access.user}
      activeMenu="users"
      onSignedOut={() => setAccess({ kind: "anonymous" })}
      mainDataAttributes={{ "data-user-management": "ready" }}
    >
      <div className="space-y-8">
        <header className="border-b border-[#e2e8f0] pb-4">
          <h1 className="text-2xl font-semibold text-[#0f172a]">User Management</h1>
          <p className="mt-1 max-w-[68ch] text-sm text-[#475569]">
            Invite company members, update Staff or Admin roles, and manage active account access.
          </p>
        </header>

        <section
          aria-label="Directory summary"
          className="grid grid-cols-2 gap-3 sm:grid-cols-5"
        >
          <div
            data-testid="summary-total-users"
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-sm text-[#0f172a]"
          >
            <span className="block text-xs text-[#475569]">Total users</span>
            <span className="tabular-nums mt-1 block font-mono text-lg font-semibold">
              {summary.totalUsers}
            </span>
          </div>
          <div
            data-testid="summary-active-users"
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-sm text-[#0f172a]"
          >
            <span className="block text-xs text-[#475569]">Active</span>
            <span className="tabular-nums mt-1 block font-mono text-lg font-semibold text-[#065f46]">
              {summary.activeUsers}
            </span>
          </div>
          <div
            data-testid="summary-inactive-users"
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-sm text-[#0f172a]"
          >
            <span className="block text-xs text-[#475569]">Inactive</span>
            <span className="tabular-nums mt-1 block font-mono text-lg font-semibold text-[#991b1b]">
              {summary.inactiveUsers}
            </span>
          </div>
          <div
            data-testid="summary-active-admins"
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-sm text-[#0f172a]"
          >
            <span className="block text-xs text-[#475569]">Active Admins</span>
            <span className="tabular-nums mt-1 block font-mono text-lg font-semibold text-[#1d4ed8]">
              {summary.activeAdmins}
            </span>
          </div>
          <div
            data-testid="summary-pending-invitations"
            className="col-span-2 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-sm text-[#0f172a] sm:col-span-1"
          >
            <span className="block text-xs text-[#475569]">Pending invites</span>
            <span className="tabular-nums mt-1 block font-mono text-lg font-semibold text-[#92400e]">
              {summary.pendingInvitations}
            </span>
          </div>
        </section>

        <section
          aria-labelledby="invite-user-heading"
          className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-6"
        >
          <h2 id="invite-user-heading" className="text-lg font-semibold text-[#0f172a]">
            Invite user
          </h2>
          <p className="mt-1 max-w-[68ch] text-sm text-[#475569]">
            Send a single-use 24-hour invitation link bound to the recipient&apos;s email address and role.
          </p>

          <form onSubmit={(event) => void handleInviteSubmit(event)} noValidate className="mt-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
              <div className="min-w-0 space-y-1.5">
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

              <div className="min-w-0 space-y-1.5">
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

              <button type="submit" disabled={inviteBusy} className={buttonClass("primary")}>
                {inviteBusy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <MailPlus className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                )}
                <span>{inviteBusy ? "Sending invitation..." : "Send invitation"}</span>
              </button>
            </div>
          </form>

          {inviteStatus && (
            <p
              role="status"
              data-testid="invite-status"
              className="mt-3 flex items-center gap-2 text-sm font-medium text-[#065f46] break-words"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{inviteStatus}</span>
            </p>
          )}
          {inviteError && (
            <p
              role="alert"
              data-testid="invite-error"
              className="mt-3 flex items-center gap-2 text-sm font-medium text-[#991b1b] break-words"
            >
              <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{inviteError}</span>
            </p>
          )}
        </section>

        {pendingInvitations.length > 0 && (
          <section
            aria-labelledby="pending-invitations-heading"
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-6"
          >
            <h2 id="pending-invitations-heading" className="text-lg font-semibold text-[#0f172a]">
              Pending invitations
            </h2>
            <ul data-testid="pending-invitations-list" className="mt-3 space-y-2">
              {pendingInvitations.map((invitation) => (
                <li
                  key={invitation.id}
                  data-testid={`pending-invitation-${invitation.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5 text-sm"
                >
                  <span className="min-w-0 font-mono text-xs font-medium text-[#0f172a] break-all">
                    {invitation.email}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-[#475569]">
                    <StatusBadge label="Invited" tone="pending" />
                    <StatusBadge
                      label={invitation.role}
                      tone={invitation.role === "ADMIN" ? "processing" : "neutral"}
                    />
                    <span className="tabular-nums font-mono">
                      Expires {formatShortDate(invitation.expiresAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="directory-heading" className="space-y-4">
          <h2 id="directory-heading" className="text-lg font-semibold text-[#0f172a]">
            User directory
          </h2>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              triggerFilterFetch({ q: searchInput, role: roleFilter, status: statusFilter });
            }}
            className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_10rem_auto_auto] sm:items-end">
              <div className="min-w-0 space-y-1.5">
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

              <div className="min-w-0 space-y-1.5">
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

              <div className="min-w-0 space-y-1.5">
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

              <button type="submit" className={buttonClass("primary")}>
                <Search className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span>Search</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  setRoleFilter("ALL");
                  setStatusFilter("ALL");
                  triggerFilterFetch({ q: "", role: "ALL", status: "ALL" });
                }}
                className={buttonClass("secondary")}
              >
                Clear
              </button>
            </div>
          </form>

          <p
            role="status"
            data-testid="users-count-status"
            className="tabular-nums text-sm text-[#475569]"
          >
            {directoryLoading && !directory
              ? "Loading users..."
              : formatCountLabel(users.length, appliedQuery)}
          </p>

          {actionStatus && (
            <p
              role="status"
              data-testid="user-action-status"
              className="rounded-[var(--radius-md)] border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm font-medium text-[#065f46] break-words"
            >
              {actionStatus}
            </p>
          )}

          {actionError && (
            <p
              role="alert"
              data-testid="user-action-error"
              className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm font-medium text-[#991b1b] break-words"
            >
              {actionError}
            </p>
          )}

          {directoryError && (
            <div
              role="alert"
              data-testid="directory-error"
              className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
            >
              <p>{directoryError}</p>
              <button
                type="button"
                onClick={() =>
                  triggerFilterFetch({ q: searchInput, role: roleFilter, status: statusFilter })
                }
                className={`mt-3 ${buttonClass("secondary")}`}
              >
                Retry directory
              </button>
            </div>
          )}

          {!directoryLoading && !directoryError && users.length === 0 ? (
            <div
              data-testid="users-empty-state"
              className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-5 text-sm text-[#475569]"
            >
              No user accounts match the current filter.
            </div>
          ) : (
            <div className="min-w-0 max-w-full md:overflow-hidden md:rounded-[var(--radius-lg)] md:border md:border-[#e2e8f0] md:bg-white">
              <table
                data-testid="users-directory-list"
                aria-label="User directory"
                className="block w-full md:table md:table-fixed"
              >
                <thead className="hidden border-b border-[#e2e8f0] bg-[#f8fafc] text-left text-xs font-medium text-[#475569] md:table-header-group">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id} className="md:table-row">
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          scope="col"
                          className={`md:table-cell md:px-4 md:py-3 ${columnWidthClass[header.id] ?? ""}`}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody className="block space-y-3 md:table-row-group md:space-y-0 md:divide-y md:divide-[#e2e8f0]">
                  {table.getRowModel().rows.map((row) => {
                    const user = row.original;
                    return (
                      <tr
                        key={row.id}
                        data-testid={`user-row-${user.id}`}
                        data-user-email={user.email}
                        data-user-role={user.role}
                        data-user-status={user.status}
                        className="cp-instant block space-y-3 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 md:table-row md:space-y-0 md:rounded-none md:border-0 md:p-0 md:hover:bg-[#f8fafc]"
                      >
                        {row.getAllCells().map((cell) => (
                          <td
                            key={cell.id}
                            className="block min-w-0 md:table-cell md:px-4 md:py-3.5 md:align-middle"
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
