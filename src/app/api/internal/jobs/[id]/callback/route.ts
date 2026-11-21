import { handleWorkflowCallback } from "@/server/jobs/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleWorkflowCallback(request, (await context.params).id, "callback");
}
