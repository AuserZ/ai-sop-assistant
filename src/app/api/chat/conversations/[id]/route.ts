import {
  handleArchiveChatConversation,
  handleGetChatConversation,
  handleRenameChatConversation,
} from "@/server/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleGetChatConversation(request, (await context.params).id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRenameChatConversation(request, (await context.params).id);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleArchiveChatConversation(request, (await context.params).id);
}
