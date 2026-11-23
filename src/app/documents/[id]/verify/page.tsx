import type { Metadata } from "next";
import Link from "next/link";
import { linkClassName } from "@/components/auth/client";
import { ReviewWorkspace } from "@/components/verification/review-workspace";

export const metadata: Metadata = { title: "Verify SOP | AI SOP Assistant" };

export default async function VerifyDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/documents" className={linkClassName}>
          Back to List Document SOP
        </Link>
      </div>
      <ReviewWorkspace documentId={id} />
    </main>
  );
}
