import type { Metadata } from "next";
import { UploadPanel } from "@/components/documents/upload-panel";

export const metadata: Metadata = { title: "List Document SOP | AI SOP Assistant" };

export default function DocumentsPage() {
  return <UploadPanel />;
}
