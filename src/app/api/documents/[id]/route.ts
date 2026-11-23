import { handleDocumentDeleteRequest, handleDocumentRequest } from "@/server/documents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDocumentRequest(request, "status", (await context.params).id);
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDocumentDeleteRequest(request, (await context.params).id);
}
