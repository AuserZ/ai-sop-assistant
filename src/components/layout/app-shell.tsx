"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FileText, LogOut, MessageSquare, Users } from "lucide-react";
import { z } from "zod";
import { postAuth, type Account } from "@/components/auth/client";
import { BrandMark, buttonClass } from "@/components/ui/primitives";
import {
  getMonogramInitials,
  getNavigationItems,
  resolveActiveMenu,
  type NavigationIconName,
  type PrimaryMenuKey,
} from "./navigation";

function NavigationIcon({ name }: { name: NavigationIconName }) {
  if (name === "message-square") {
    return <MessageSquare className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />;
  }
  if (name === "file-text") {
    return <FileText className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />;
  }
  return <Users className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />;
}

export type AppShellProps = {
  user: Account;
  activeMenu?: PrimaryMenuKey | null;
  hideAccountSignOut?: boolean;
  onSignedOut?: () => void;
  mainClassName?: string;
  mainDataAttributes?: Record<string, string | number | undefined>;
  children: ReactNode;
};

export function AppShell({
  user,
  activeMenu,
  hideAccountSignOut = false,
  onSignedOut,
  mainClassName,
  mainDataAttributes,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const items = getNavigationItems(user.role);
  const resolvedActive = activeMenu !== undefined ? activeMenu : resolveActiveMenu(pathname ?? "/");
  const roleLabel = user.role === "ADMIN" ? "Admin" : "Staff";
  const initials = getMonogramInitials(user.name);

  function focusMainContent() {
    const target = document.getElementById("main-content");
    if (target) {
      target.focus();
    }
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await postAuth("/api/auth/sign-out", {});
      if (!z.object({ success: z.literal(true) }).safeParse(result).success) {
        throw new Error("Sign-out is temporarily unavailable. Try again.");
      }
      if (onSignedOut) {
        onSignedOut();
      } else {
        router.replace("/sign-in");
      }
    } catch (failure) {
      setSignOutError(
        failure instanceof Error ? failure.message : "Sign-out is temporarily unavailable. Try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] lg:flex">
      <button
        type="button"
        onClick={focusMainContent}
        className="cp-control fixed -top-24 left-4 z-50 inline-flex min-h-11 items-center rounded-[var(--radius-sm)] bg-[#1d4ed8] px-4 py-2 text-sm font-medium text-white shadow-sm focus:top-4"
      >
        Skip to main content
      </button>

      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:flex-col lg:border-r lg:border-[#e2e8f0] lg:bg-white">
        <div className="border-b border-[#e2e8f0] px-4 py-4">
          <BrandMark />
        </div>

        <nav aria-label="Primary" className="flex-1 space-y-1 p-3">
          {items.map((item) => {
            const isActive = resolvedActive === item.key;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`cp-instant flex min-h-11 items-center gap-2.5 rounded-[var(--radius-md)] border px-3 py-2 text-sm ${
                  isActive
                    ? "border-[#bfdbfe] bg-[#eff6ff] font-medium text-[#1d4ed8]"
                    : "border-transparent text-[#475569] hover:bg-[#f1f5f9] hover:text-[#0f172a]"
                }`}
              >
                <NavigationIcon name={item.iconName} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[#e2e8f0] p-4 space-y-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f1f5f9] text-xs font-semibold text-[#0f172a]"
            >
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[#0f172a]">{user.name}</p>
              <p className="truncate text-xs text-[#475569]">{roleLabel}</p>
            </div>
          </div>

          {!hideAccountSignOut && (
            <button
              type="button"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              className={buttonClass("secondary", "sm", "w-full justify-start")}
            >
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{signingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          )}

          {signOutError && (
            <p role="alert" className="text-xs text-[#991b1b]">
              {signOutError}
            </p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-20 lg:pb-0">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-[#e2e8f0] bg-white px-4 py-2 lg:hidden">
          <BrandMark compact />
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-[var(--radius-sm)] border border-[#e2e8f0] bg-[#f8fafc] px-2 py-1 text-xs font-medium text-[#475569]">
              {roleLabel}
            </span>
            {!hideAccountSignOut && (
              <button
                type="button"
                disabled={signingOut}
                onClick={() => void handleSignOut()}
                className={buttonClass("secondary", "compact")}
              >
                <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span>{signingOut ? "Signing out..." : "Sign out"}</span>
              </button>
            )}
          </div>
        </header>

        {signOutError && (
          <div className="px-4 pt-3 lg:hidden">
            <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]">
              {signOutError}
            </p>
          </div>
        )}

        <main
          id="main-content"
          tabIndex={-1}
          {...mainDataAttributes}
          className={
            mainClassName ??
            "mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8"
          }
        >
          {children}
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#e2e8f0] bg-white lg:hidden">
          <nav aria-label="Primary" className="flex w-full items-stretch">
            {items.map((item) => {
              const isActive = resolvedActive === item.key;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`cp-instant flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-t-2 px-1 py-2 text-center text-[11px] leading-tight ${
                    isActive
                      ? "border-[#1d4ed8] bg-[#eff6ff] font-medium text-[#1d4ed8]"
                      : "border-transparent text-[#475569] hover:bg-[#f8fafc] hover:text-[#0f172a]"
                  }`}
                >
                  <NavigationIcon name={item.iconName} />
                  <span className="max-w-full break-words">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}
