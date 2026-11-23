import { handleGetChatConversation } from "@/server/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleGetChatConversation(request, (await context.params).id);
}
