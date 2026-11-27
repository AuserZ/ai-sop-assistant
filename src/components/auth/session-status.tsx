"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, LogOut, ShieldCheck } from "lucide-react";
import { z } from "zod";
import { AppShell } from "@/components/layout/app-shell";
import { BrandMark, buttonClass, StatusBadge } from "@/components/ui/primitives";
import { accountSchema, buttonClassName, postAuth, type Account } from "./client";

type SessionState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "signed-in"; user: Account }
  | { kind: "error" };

async function readAccount(signal: AbortSignal): Promise<SessionState | null> {
  try {
    const response = await fetch("/api/account", { credentials: "same-origin", cache: "no-store", signal });
    if (response.status === 401) return { kind: "anonymous" };
    const result = z.object({ user: accountSchema }).safeParse(await response.json());
    if (!response.ok || !result.success) throw new Error("Unavailable account");
    return { kind: "signed-in", user: result.data.user };
  } catch {
    return signal.aborted ? null : { kind: "error" };
  }
}

export function SessionStatus() {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshId, setRefreshId] = useState(0);
  const requestController = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    setSession({ kind: "loading" });
    setRefreshId((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    requestController.current = controller;
    void readAccount(controller.signal).then((nextSession) => {
      if (nextSession && !controller.signal.aborted) setSession(nextSession);
    });
    return () => controller.abort();
  }, [refreshId]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  async function signOut() {
    requestController.current?.abort();
    setSigningOut(true);
    setError(null);
    try {
      const result = await postAuth("/api/auth/sign-out", {});
      if (!z.object({ success: z.literal(true) }).safeParse(result).success) {
        throw new Error("Sign-out is temporarily unavailable. Try again.");
      }
      requestController.current?.abort();
      setSession({ kind: "anonymous" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-out is temporarily unavailable. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (session.kind !== "signed-in") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-6">
          <BrandMark />
          <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">AI SOP Assistant</h1>
          {session.kind === "loading" && (
            <p role="status" className="mt-6 flex min-h-16 items-center gap-2 text-sm text-[#475569]">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>Checking sign-in...</span>
            </p>
          )}
          {session.kind === "anonymous" && (
            <section className="mt-5 space-y-4">
              <p className="text-sm text-[#475569]">
                Sign in with the email address invited by your Admin.
              </p>
              <Link href="/sign-in" className={buttonClass("primary", "default", "w-full")}>
                Sign in
              </Link>
            </section>
          )}
          {session.kind === "error" && (
            <section className="mt-5 space-y-4">
              <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                Sign-in status is temporarily unavailable.
              </p>
              <button type="button" onClick={reload} className={buttonClassName}>
                Retry
              </button>
            </section>
          )}
        </div>
      </main>
    );
  }

  const roleLabel = session.user.role === "ADMIN" ? "Admin" : "Staff";

  return (
    <AppShell
      user={session.user}
      activeMenu={null}
      hideAccountSignOut
      mainClassName="mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-10"
    >
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-[#0f172a] sm:text-3xl">AI SOP Assistant</h1>
          <p className="max-w-[68ch] text-sm text-[#475569]">
            Verified company SOP search, assisted extraction review, and cited procedural answers.
          </p>
        </header>

        <section
          aria-label="Your account"
          className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-[#1d4ed8]" strokeWidth={1.5} aria-hidden="true" />
                <h2 className="text-base font-semibold text-[#0f172a]">Account session</h2>
                <StatusBadge label="Active" tone="active" />
              </div>
              <p className="break-words text-sm text-[#0f172a]">
                Signed in as {session.user.name} ({session.user.email}).
              </p>
              <p className="text-sm font-medium text-[#475569]">Role: {roleLabel}</p>
            </div>

            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              className={buttonClass("secondary")}
            >
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{signingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
              {error}
            </p>
          )}
        </section>

        <p className="text-xs text-[#64748b]">
          Use the navigation menu to open{" "}
          <span className="font-medium text-[#0f172a]">Chat</span> or{" "}
          <span className="font-medium text-[#0f172a]">List Document SOP</span>
          {session.user.role === "ADMIN" ? (
            <>
              , or manage accounts in{" "}
              <span className="font-medium text-[#0f172a]">User Management</span>.
            </>
          ) : (
            "."
          )}
        </p>
      </div>
    </AppShell>
  );
}
