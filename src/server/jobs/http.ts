import { z } from "zod";
import { readAuthBody } from "../auth/http";
import { authErrorResponse, AuthFailure } from "../auth/errors";
import { emptyWorkflowBody } from "./contracts";
import { probeCallbackDelayMilliseconds, workflowProbeEnabled } from "./config";
import { verifyCallback } from "./signatures";
import { applyWorkflowCallback } from "./service";

export async function handleWorkflowCallback(request: Request, jobId: string, purpose: "claim" | "callback") {
  try {
    if (!workflowProbeEnabled()) throw new AuthFailure("NOT_FOUND", 404);
    if (!z.uuid().safeParse(jobId).success) throw new AuthFailure("NOT_FOUND", 404);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new AuthFailure("INVALID_CONTENT_TYPE", 415);
    }
    await readAuthBody(request, emptyWorkflowBody);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401);
    const claims = await verifyCallback(authorization.slice(7));
    const path = `/api/internal/jobs/${jobId}/${purpose}`;
    if (claims.jobId !== jobId || claims.purpose !== purpose || claims.path !== path || new URL(request.url).pathname !== path ||
        new URL(request.url).search || request.method !== claims.method) throw new AuthFailure("INVALID_WORKFLOW_BINDING", 403);
    const result = await applyWorkflowCallback(claims);
    const delay = probeCallbackDelayMilliseconds();
    if (delay) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); request.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, delay);
      request.signal.addEventListener("abort", finish, { once: true });
      if (request.signal.aborted) finish();
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
