"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { accountSchema, buttonClassName, inputClassName, linkClassName, postAuth } from "./client";

const emailField = z.email("Enter a valid email address.").max(254);
const signInFields = z.object({ email: emailField, password: z.string().min(1, "Enter your password.").max(128) });
const acceptanceFields = z.object({
  email: emailField,
  name: z.string().trim().min(1, "Enter your name.").max(100),
  password: z.string().min(12, "Use at least 12 characters.").max(128),
});

function Field({
  id,
  label,
  type = "text",
  autoComplete,
  error,
  registration,
  hint,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete: string;
  error?: string;
  hint?: string;
  registration: UseFormRegisterReturn;
}) {
  const description = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-[#0f172a]">
        {label}
      </label>
      <input
        {...registration}
        id={id}
        type={type}
        autoComplete={autoComplete}
        className={inputClassName}
        aria-invalid={Boolean(error)}
        aria-describedby={description}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-[#475569]">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-[#991b1b]">
          {error}
        </p>
      )}
    </div>
  );
}

export function SignInForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof signInFields>>({ resolver: zodResolver(signInFields) });

  const submit = handleSubmit(async (values) => {
    try {
      const result = await postAuth("/api/auth/sign-in/email", values);
      if (!z.object({ user: accountSchema }).safeParse(result).success) {
        throw new Error("Sign-in is temporarily unavailable. Try again.");
      }
      router.replace("/");
    } catch (error) {
      setError("root", {
        message: error instanceof Error ? error.message : "Sign-in is temporarily unavailable. Try again.",
      });
    }
  });

  return (
    <form onSubmit={submit} noValidate aria-busy={isSubmitting} className="mt-6 space-y-5">
      <fieldset disabled={isSubmitting} className="space-y-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          registration={register("email")}
          error={errors.email?.message}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          registration={register("password")}
          error={errors.password?.message}
        />
        <button type="submit" className={`${buttonClassName} w-full`} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />}
          <span>{isSubmitting ? "Signing in..." : "Sign in"}</span>
        </button>
      </fieldset>
      {errors.root?.message && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0 break-words">{errors.root.message}</span>
        </div>
      )}
    </form>
  );
}

export function AcceptInvitationForm() {
  const [token, setToken] = useState<string | null>(null);
  const [linkChecked, setLinkChecked] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const capturedToken = useRef(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof acceptanceFields>>({ resolver: zodResolver(acceptanceFields) });

  useEffect(() => {
    function captureToken() {
      const fragment = window.location.hash.slice(1);
      if (fragment || !capturedToken.current) {
        capturedToken.current = true;
        window.history.replaceState(null, "", window.location.pathname);
        setToken(/^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null);
      }
      setLinkChecked(true);
    }
    captureToken();
    window.addEventListener("hashchange", captureToken);
    return () => window.removeEventListener("hashchange", captureToken);
  }, []);

  const submit = handleSubmit(async (values) => {
    if (!token) return;
    try {
      const result = await postAuth("/api/auth/invitations/accept", { ...values, token });
      if (!z.object({ accepted: z.literal(true) }).safeParse(result).success) {
        throw new Error("This request is temporarily unavailable. Try again.");
      }
      reset();
      setToken(null);
      setAccepted(true);
    } catch (error) {
      setError("root", {
        message: error instanceof Error ? error.message : "This request is temporarily unavailable. Try again.",
      });
    }
  });

  if (!linkChecked) {
    return (
      <p role="status" className="mt-6 flex items-center gap-2 text-sm text-[#475569]">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
        <span>Checking invitation...</span>
      </p>
    );
  }
  if (accepted) {
    return (
      <div className="mt-6 space-y-4">
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm text-[#065f46]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <p role="status">Your account is ready. Sign in with your invited email and new password.</p>
        </div>
        <Link className={linkClassName} href="/sign-in">
          Continue to sign in
        </Link>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="mt-6 space-y-4">
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <p role="alert">Open the full invitation link from your email. Ask an Admin for a new invitation if it has expired.</p>
        </div>
        <Link className={linkClassName} href="/sign-in">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate aria-busy={isSubmitting} className="mt-6 space-y-5">
      <fieldset disabled={isSubmitting} className="space-y-4">
        <Field
          id="name"
          label="Name"
          autoComplete="name"
          registration={register("name")}
          error={errors.name?.message}
        />
        <Field
          id="email"
          label="Invited email"
          type="email"
          autoComplete="username"
          registration={register("email")}
          error={errors.email?.message}
        />
        <Field
          id="password"
          label="Create password"
          type="password"
          autoComplete="new-password"
          registration={register("password")}
          error={errors.password?.message}
          hint="Use at least 12 characters."
        />
        <button type="submit" className={`${buttonClassName} w-full`} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />}
          <span>{isSubmitting ? "Creating account..." : "Create account"}</span>
        </button>
      </fieldset>
      {errors.root?.message && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0 break-words">{errors.root.message}</span>
        </div>
      )}
    </form>
  );
}
