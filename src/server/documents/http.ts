import { requireCurrentAccount, requireRole } from "../auth/authorization";
import { AuthFailure, authErrorResponse } from "../auth/errors";
import { readAuthBody, requireMutationOrigin } from "../auth/http";
import { consumeRateLimit } from "../auth/rate-limit";
import {
  documentIdInput,
  documentSourceContentQueryInput,
  emptyDocumentBody,
  formatContentDisposition,
  uploadInput,
  verifyDocumentSourceToken,
} from "./contracts";
import {
  authorizeDocumentSource,
  deleteDocument,
  finalizeDocumentUpload,
  getDocumentUploadStatus,
  initializeDocumentUpload,
  listDocuments,
  readDocumentSourceContent,
  reconcileDocumentDeletions,
} from "./service";

function readSearchParamsObject(
  request: Request,
  duplicateErrorCode = "INVALID_INPUT",
  duplicateErrorStatus = 400,
): Record<string, string> {
  const { searchParams } = new URL(request.url);
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new AuthFailure(duplicateErrorCode, duplicateErrorStatus);
    }
    result[key] = value;
  }
  return result;
}

export async function handleDocumentRequest(request: Request, operation: "init" | "process" | "status", id?: string) {
  try {
    if (operation !== "status") requireMutationOrigin(request);
    const account = await requireCurrentAccount(request.headers);
    requireRole(account, "ADMIN");
    await consumeRateLimit("document-global", "all", { maximum: 120, windowSeconds: 60 });
    await consumeRateLimit(`document-${operation}`, account.id, { maximum: operation === "status" ? 120 : 20, windowSeconds: 60 });
    const headers = { "Cache-Control": "no-store" };
    if (operation === "init") {
      const { created, ...response } = await initializeDocumentUpload(account, await readAuthBody(request, uploadInput));
      return Response.json(response, { status: created ? 202 : 200, headers });
    }
    if (!documentIdInput.safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);
    if (operation === "status") return Response.json(await getDocumentUploadStatus(account, id!), { headers });
    await readAuthBody(request, emptyDocumentBody);
    const { created, ...response } = await finalizeDocumentUpload(account, id!);
    return Response.json(response, { status: created ? 202 : 200, headers });
  } catch (error) { return authErrorResponse(error); }
}

export async function handleDocumentDeleteRequest(request: Request, id: string) {
  try {
    requireMutationOrigin(request);
    const account = await requireCurrentAccount(request.headers);
    requireRole(account, "ADMIN");
    await consumeRateLimit("document-global", "all", { maximum: 120, windowSeconds: 60 });
    await consumeRateLimit("document-delete", account.id, { maximum: 30, windowSeconds: 60 });
    if (!documentIdInput.safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);
    const result = await deleteDocument(account, id);
    void reconcileDocumentDeletions().catch(() => undefined);
    return Response.json(result, {
      status: result.created ? 202 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleDocumentLibraryRequest(request: Request) {
  try {
    const account = await requireCurrentAccount(request.headers);
    await consumeRateLimit("document-global", "all", { maximum: 120, windowSeconds: 60 });
    await consumeRateLimit("document-list", account.id, { maximum: 120, windowSeconds: 60 });
    const query = readSearchParamsObject(request);
    return Response.json(await listDocuments(account, query), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleDocumentSourceRequest(request: Request, id: string) {
  try {
    const account = await requireCurrentAccount(request.headers);
    await consumeRateLimit("document-global", "all", { maximum: 120, windowSeconds: 60 });
    await consumeRateLimit("document-source", account.id, { maximum: 60, windowSeconds: 60 });
    if (!documentIdInput.safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);
    const query = readSearchParamsObject(request);
    return Response.json(await authorizeDocumentSource(account, id, query), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleDocumentSourceContentRequest(
  request: Request,
  id: string,
  options?: { nowSeconds?: number; signingKey?: Buffer },
) {
  try {
    if (!documentIdInput.safeParse(id).success) throw new AuthFailure("NOT_FOUND", 404);
    const query = readSearchParamsObject(request, "SOURCE_LINK_INVALID", 403);
    const parsedQuery = documentSourceContentQueryInput.safeParse(query);
    if (!parsedQuery.success) throw new AuthFailure("SOURCE_LINK_INVALID", 403);
    const claims = verifyDocumentSourceToken(parsedQuery.data.token, id, options);
    const account = await requireCurrentAccount(request.headers);
    if (account.id !== claims.accountId) throw new AuthFailure("FORBIDDEN", 403);
    await consumeRateLimit("document-global", "all", { maximum: 120, windowSeconds: 60 });
    await consumeRateLimit("document-source", account.id, { maximum: 60, windowSeconds: 60 });
    const content = await readDocumentSourceContent(
      account,
      id,
      parsedQuery.data,
      undefined,
      undefined,
      { ...options, signal: request.signal },
    );
    return new Response(new Uint8Array(content.bytes), {
      status: 200,
      headers: {
        "Content-Type": content.mimeType,
        "Content-Length": String(content.bytes.byteLength),
        "Content-Disposition": formatContentDisposition(content.disposition, content.fileName),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
