import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/forms";
import { BrandMark } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Sign in | AI SOP Assistant" };

export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6 sm:py-12">
      <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] border-t-2 border-t-[#1d4ed8] bg-white p-6 shadow-[var(--shadow-elevated)] sm:p-7">
        <BrandMark />
        <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">Sign in</h1>
        <p className="mt-2 text-sm text-[#475569]">Use the email address invited by your Admin.</p>
        <SignInForm />
      </div>
    </main>
  );
}
