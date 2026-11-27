import type { Metadata } from "next";
import { ReviewWorkspace } from "@/components/verification/review-workspace";

export const metadata: Metadata = { title: "Verify SOP | AI SOP Assistant" };

export default async function VerifyDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewWorkspace documentId={id} />;
}
