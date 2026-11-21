import { requireCurrentAccount } from "@/server/auth/authorization";
import { authErrorResponse, AuthFailure } from "@/server/auth/errors";
import { readAuthBody, requireMutationOrigin } from "@/server/auth/http";
import { consumeRateLimit } from "@/server/auth/rate-limit";
import { workflowProbeEnabled } from "@/server/jobs/config";
import { probeInput } from "@/server/jobs/contracts";
import { createProbeJob } from "@/server/jobs/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    if (!workflowProbeEnabled()) throw new AuthFailure("NOT_FOUND", 404);
    requireMutationOrigin(request);
    const account = await requireCurrentAccount(request.headers);
    await consumeRateLimit("workflow-probe", account.id, { maximum: 20, windowSeconds: 60 });
    const result = await createProbeJob(account, await readAuthBody(request, probeInput));
    return Response.json({ jobId: result.jobId, eventsUrl: `/api/jobs/${result.jobId}/events`, synthetic: true },
      { status: result.created ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
