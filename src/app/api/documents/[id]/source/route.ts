import { handleDocumentSourceRequest } from "@/server/documents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDocumentSourceRequest(request, (await context.params).id);
}
