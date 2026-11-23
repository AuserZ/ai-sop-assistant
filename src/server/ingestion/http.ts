import { z } from "zod";
import { authErrorResponse, AuthFailure } from "../auth/errors";
import { readAuthBody } from "../auth/http";
import type { IngestionCallbackPurpose } from "../jobs/contracts";
import { verifyIngestionCallback } from "../jobs/signatures";
import { emptyStageBody, extractStageBody, failStageBody } from "./contracts";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
  failIngestionStage,
  renewSourceRefStage,
  type IngestionStageOptions,
} from "./service";

export async function handleIngestionStageRequest(
  request: Request,
  jobId: string,
  stage: IngestionCallbackPurpose,
  options: IngestionStageOptions = {},
) {
  try {
    if (!z.uuid().safeParse(jobId).success) throw new AuthFailure("NOT_FOUND", 404);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new AuthFailure("INVALID_CONTENT_TYPE", 415);
    }

    const body = stage === "extract"
      ? await readAuthBody(request, extractStageBody)
      : stage === "fail"
        ? await readAuthBody(request, failStageBody)
        : await readAuthBody(request, emptyStageBody);

    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401);

    const claims = await verifyIngestionCallback(authorization.slice(7));
    const expectedPath = `/api/internal/ingestion/${jobId}/${stage}`;
    const parsedUrl = new URL(request.url);
    if (
      claims.jobId !== jobId ||
      claims.purpose !== stage ||
      claims.path !== expectedPath ||
      parsedUrl.pathname !== expectedPath ||
      parsedUrl.search ||
      request.method !== claims.method
    ) {
      throw new AuthFailure("INVALID_WORKFLOW_BINDING", 403);
    }

    let result: unknown;
    switch (stage) {
      case "claim":
        result = await claimIngestionStage(claims, options);
        break;
      case "renew-source-ref":
        result = await renewSourceRefStage(claims, options);
        break;
      case "extract":
        result = await extractIngestionStage(claims, (body as z.infer<typeof extractStageBody>).fileRefToken, {
          ...options,
          signal: request.signal,
        });
        break;
      case "chunk":
        result = await chunkIngestionStage(claims, options);
        break;
      case "embed":
        result = await embedIngestionStage(claims, { ...options, signal: request.signal });
        break;
      case "complete":
        result = await completeIngestionStage(claims, options);
        break;
      case "fail":
        result = await failIngestionStage(claims, body as z.infer<typeof failStageBody>, options);
        break;
    }

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
