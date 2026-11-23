import { handlePostChatMessage } from "@/server/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePostChatMessage(request);
}
