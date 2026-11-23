import type { ZodType } from "zod";
import { requireCurrentAccount, requireRole } from "../auth/authorization";
import { AuthFailure, authErrorResponse } from "../auth/errors";
import { requireMutationOrigin } from "../auth/http";
import { consumeRateLimit } from "../auth/rate-limit";
import { documentIdInput } from "../documents/contracts";
import { reprocessDocumentInput, verifyDocumentInput } from "./contracts";
import { getDocumentReview, readDocumentPreview, reprocessDocument, verifyDocument } from "./service";

type VerificationOperation = "review" | "preview" | "verify" | "reprocess";
const maximumVerificationBodyBytes = 16_384;

async function readVerificationBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const statedSize = request.headers.get("content-length");
  if (statedSize && (!/^\d+$/.test(statedSize) || Number(statedSize) > maximumVerificationBodyBytes)) {
    throw new AuthFailure("INVALID_BODY", 413);
  }
  if (!request.body) throw new AuthFailure("INVALID_INPUT", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumVerificationBodyBytes) {
        await reader.cancel();
        throw new AuthFailure("INVALID_BODY", 413);
      }
      chunks.push(value);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
    return parsed.data;
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure("INVALID_INPUT", 400);
  } finally {
    reader.releaseLock();
  }
}

export async function handleVerificationRequest(
  request: Request,
  id: string,
  operation: VerificationOperation,
) {
  try {
    if (operation === "verify" || operation === "reprocess") {
      requireMutationOrigin(request);
    }
    const account = await requireCurrentAccount(request.headers);
    requireRole(account, "ADMIN");
    await consumeRateLimit("verification-global", "all", { maximum: 180, windowSeconds: 60 });
    await consumeRateLimit(`verification-${operation}`, account.id, {
      maximum: operation === "review" || operation === "preview" ? 120 : 30,
      windowSeconds: 60,
    });
    if (!documentIdInput.safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);

    if (operation === "preview") {
      const preview = await readDocumentPreview(account, id, undefined, undefined, request.signal);
      return new Response(new Uint8Array(preview.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "sandbox",
        },
      });
    }

    const headers = { "Cache-Control": "no-store" };
    if (operation === "review") {
      return Response.json(await getDocumentReview(account, id), { headers });
    }
    if (operation === "verify") {
      const body = await readVerificationBody(request, verifyDocumentInput);
      return Response.json(await verifyDocument(account, id, body), { headers });
    }
    const body = await readVerificationBody(request, reprocessDocumentInput);
    return Response.json(await reprocessDocument(account, id, body), { status: 202, headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}
