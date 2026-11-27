import type { Metadata } from "next";
import { AcceptInvitationForm } from "@/components/auth/forms";
import { BrandMark } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Accept invitation | AI SOP Assistant" };

export default function AcceptInvitationPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6 sm:py-12">
      <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-6">
        <BrandMark />
        <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">Accept invitation</h1>
        <p className="mt-2 text-sm text-[#475569]">
          Create your account with the email address used for your invitation.
        </p>
        <AcceptInvitationForm />
      </div>
    </main>
  );
}
