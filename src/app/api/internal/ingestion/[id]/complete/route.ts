import { handleIngestionStageRequest } from "@/server/ingestion/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleIngestionStageRequest(request, (await context.params).id, "complete");
}
