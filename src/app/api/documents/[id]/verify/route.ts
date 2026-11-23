import { handleVerificationRequest } from "@/server/verification/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleVerificationRequest(request, (await context.params).id, "verify");
}
