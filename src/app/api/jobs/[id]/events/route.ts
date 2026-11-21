import { z } from "zod";
import { authErrorResponse, AuthFailure } from "@/server/auth/errors";
import { requireCurrentAccount } from "@/server/auth/authorization";
import { consumeRateLimit } from "@/server/auth/rate-limit";
import { workflowProbeEnabled } from "@/server/jobs/config";
import { createJobEventStream } from "@/server/jobs/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!workflowProbeEnabled()) throw new AuthFailure("NOT_FOUND", 404);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);
    const account = await requireCurrentAccount(request.headers);
    await consumeRateLimit("workflow-stream", account.id, { maximum: 30, windowSeconds: 60 });
    return await createJobEventStream(request, id, account);
  } catch (error) { return authErrorResponse(error); }
}
