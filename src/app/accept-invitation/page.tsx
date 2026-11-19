import type { Metadata } from "next";
import { AcceptInvitationForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Accept invitation | AI SOP Assistant" };

export default function AcceptInvitationPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10 sm:py-12">
      <div className="max-w-md">
        <p className="text-sm font-medium text-[#4b5563]">AI SOP Assistant</p>
        <h1 className="mt-6 text-3xl font-semibold">Accept invitation</h1>
        <p className="mt-3 text-[#4b5563]">Create your account with the email address used for your invitation.</p>
        <AcceptInvitationForm />
      </div>
    </main>
  );
}
