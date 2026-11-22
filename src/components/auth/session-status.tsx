"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { accountSchema, buttonClassName, linkClassName, postAuth, type Account } from "./client";

type SessionState = { kind: "loading" } | { kind: "anonymous" } | { kind: "signed-in"; user: Account } | { kind: "error" };

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
      if (!z.object({ success: z.literal(true) }).safeParse(result).success) throw new Error("Sign-out is temporarily unavailable. Try again.");
      requestController.current?.abort();
      setSession({ kind: "anonymous" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-out is temporarily unavailable. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (session.kind === "loading") return <p role="status" className="mt-8 min-h-20">Checking sign-in...</p>;
  if (session.kind === "anonymous") return <section className="mt-8 space-y-4"><p>Sign in with the email address invited by your Admin.</p><Link href="/sign-in" className={linkClassName}>Sign in</Link></section>;
  if (session.kind === "error") return <section className="mt-8 space-y-4"><p role="alert">Sign-in status is temporarily unavailable.</p><button type="button" onClick={reload} className={buttonClassName}>Retry</button></section>;
  return (
    <section className="mt-8 space-y-4" aria-label="Your account">
      <p className="break-words">Signed in as {session.user.name} ({session.user.email}).</p>
      <p>Role: {session.user.role === "ADMIN" ? "Admin" : "Staff"}</p>
      {session.user.role === "ADMIN" && <div><Link href="/documents" className={linkClassName}>List Document SOP</Link></div>}
      <button type="button" onClick={() => void signOut()} disabled={signingOut} className={buttonClassName}>{signingOut ? "Signing out..." : "Sign out"}</button>
      {error && <p role="alert" className="text-[#991b1b]">{error}</p>}
    </section>
  );
}
