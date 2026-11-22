import { requireCurrentAccount, requireRole } from "../auth/authorization";
import { AuthFailure, authErrorResponse } from "../auth/errors";
import { readAuthBody, requireMutationOrigin } from "../auth/http";
import { consumeRateLimit } from "../auth/rate-limit";
import { documentIdInput, emptyDocumentBody, uploadInput } from "./contracts";
import { finalizeDocumentUpload, getDocumentUploadStatus, initializeDocumentUpload } from "./service";

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
