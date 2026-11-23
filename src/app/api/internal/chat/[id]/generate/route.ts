import { handleInternalChatStage } from "@/server/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleInternalChatStage(request, (await context.params).id, "generate");
}
