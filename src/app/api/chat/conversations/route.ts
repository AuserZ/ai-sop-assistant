import { handleListChatConversations } from "@/server/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleListChatConversations(request);
}
