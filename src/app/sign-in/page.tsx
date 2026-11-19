import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Sign in | AI SOP Assistant" };

export default function SignInPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10 sm:py-12">
      <div className="max-w-md">
        <p className="text-sm font-medium text-[#4b5563]">AI SOP Assistant</p>
        <h1 className="mt-6 text-3xl font-semibold">Sign in</h1>
        <p className="mt-3 text-[#4b5563]">Use the email address invited by your Admin.</p>
        <SignInForm />
      </div>
    </main>
  );
}
