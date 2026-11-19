"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";
import { accountSchema, buttonClassName, inputClassName, linkClassName, postAuth } from "./client";

const emailField = z.email("Enter a valid email address.").max(254);
const signInFields = z.object({ email: emailField, password: z.string().min(1, "Enter your password.").max(128) });
const acceptanceFields = z.object({
  email: emailField,
  name: z.string().trim().min(1, "Enter your name.").max(100),
  password: z.string().min(12, "Use at least 12 characters.").max(128),
});

function Field({ id, label, type = "text", autoComplete, error, registration, hint }: {
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
    <div className="space-y-2">
      <label htmlFor={id} className="block font-medium">{label}</label>
      <input {...registration} id={id} type={type} autoComplete={autoComplete} className={inputClassName} aria-invalid={Boolean(error)} aria-describedby={description} />
      {hint && <p id={`${id}-hint`} className="text-sm text-[#4b5563]">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-[#991b1b]">{error}</p>}
    </div>
  );
}

export function SignInForm() {
  const router = useRouter();
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.infer<typeof signInFields>>({ resolver: zodResolver(signInFields) });
  const submit = handleSubmit(async (values) => {
    try {
      const result = await postAuth("/api/auth/sign-in/email", values);
      if (!z.object({ user: accountSchema }).safeParse(result).success) throw new Error("Sign-in is temporarily unavailable. Try again.");
      router.replace("/");
    } catch (error) {
      setError("root", { message: error instanceof Error ? error.message : "Sign-in is temporarily unavailable. Try again." });
    }
  });
  return (
    <form onSubmit={submit} noValidate aria-busy={isSubmitting} className="mt-8 space-y-6">
      <fieldset disabled={isSubmitting} className="space-y-6">
        <Field id="email" label="Email" type="email" autoComplete="username" registration={register("email")} error={errors.email?.message} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" registration={register("password")} error={errors.password?.message} />
        <button type="submit" className={buttonClassName} disabled={isSubmitting}>{isSubmitting ? "Signing in..." : "Sign in"}</button>
      </fieldset>
      {errors.root?.message && <p role="alert" className="text-[#991b1b]">{errors.root.message}</p>}
    </form>
  );
}

export function AcceptInvitationForm() {
  const [token, setToken] = useState<string | null>(null);
  const [linkChecked, setLinkChecked] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const capturedToken = useRef(false);
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm<z.infer<typeof acceptanceFields>>({ resolver: zodResolver(acceptanceFields) });

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
      if (!z.object({ accepted: z.literal(true) }).safeParse(result).success) throw new Error("This request is temporarily unavailable. Try again.");
      reset();
      setToken(null);
      setAccepted(true);
    } catch (error) {
      setError("root", { message: error instanceof Error ? error.message : "This request is temporarily unavailable. Try again." });
    }
  });

  if (!linkChecked) return <p role="status" className="mt-8">Checking invitation...</p>;
  if (accepted) return <div className="mt-8 space-y-4"><p role="status">Your account is ready. Sign in with your invited email and new password.</p><Link className={linkClassName} href="/sign-in">Continue to sign in</Link></div>;
  if (!token) return <div className="mt-8 space-y-4"><p role="alert">Open the full invitation link from your email. Ask an Admin for a new invitation if it has expired.</p><Link className={linkClassName} href="/sign-in">Back to sign in</Link></div>;
  return (
    <form onSubmit={submit} noValidate aria-busy={isSubmitting} className="mt-8 space-y-6">
      <fieldset disabled={isSubmitting} className="space-y-6">
        <Field id="name" label="Name" autoComplete="name" registration={register("name")} error={errors.name?.message} />
        <Field id="email" label="Invited email" type="email" autoComplete="username" registration={register("email")} error={errors.email?.message} />
        <Field id="password" label="Create password" type="password" autoComplete="new-password" registration={register("password")} error={errors.password?.message} hint="Use at least 12 characters." />
        <button type="submit" className={buttonClassName} disabled={isSubmitting}>{isSubmitting ? "Creating account..." : "Create account"}</button>
      </fieldset>
      {errors.root?.message && <p role="alert" className="text-[#991b1b]">{errors.root.message}</p>}
    </form>
  );
}
