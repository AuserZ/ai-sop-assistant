import type { Metadata } from "next";
import Link from "next/link";
import { UploadPanel } from "@/components/documents/upload-panel";
import { linkClassName } from "@/components/auth/client";

export const metadata: Metadata = { title: "List Document SOP | AI SOP Assistant" };

export default function DocumentsPage() {
  return <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
    <Link href="/" className={linkClassName}>Back to account</Link>
    <h1 className="mt-4 text-2xl font-semibold sm:text-3xl">List Document SOP</h1>
    <UploadPanel />
  </main>;
}
