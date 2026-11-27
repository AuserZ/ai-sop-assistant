import { updateAccountAccess } from "../../../../server/auth/accounts";
import { requireCurrentAccount, requireRole } from "../../../../server/auth/authorization";
import { AuthFailure, authErrorResponse } from "../../../../server/auth/errors";
import { readAuthBody, requireMutationOrigin } from "../../../../server/auth/http";
import { authLimits, consumeRateLimit } from "../../../../server/auth/rate-limit";
import { accountAccessInput, targetUserIdInput } from "../../../../server/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireMutationOrigin(request);
    const actor = await requireCurrentAccount(request.headers);
    requireRole(actor, "ADMIN");
    await consumeRateLimit("users-global", "all", authLimits.global);
    await consumeRateLimit("users:update", actor.id, authLimits.userUpdate);
    const { id } = await context.params;
    const parsedId = targetUserIdInput.safeParse(id);
    if (!parsedId.success) throw new AuthFailure("NOT_FOUND", 404);
    const changes = await readAuthBody(request, accountAccessInput);
    const updated = await updateAccountAccess(actor, parsedId.data, changes);
    return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
