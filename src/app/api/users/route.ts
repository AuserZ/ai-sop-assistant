import { listDirectoryUsers } from "../../../server/auth/accounts";
import { requireCurrentAccount, requireRole } from "../../../server/auth/authorization";
import { AuthFailure, authErrorResponse } from "../../../server/auth/errors";
import { authLimits, consumeRateLimit } from "../../../server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readSearchParamsObject(request: Request): Record<string, string> {
  const { searchParams } = new URL(request.url);
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new AuthFailure("INVALID_INPUT", 400);
    }
    result[key] = value;
  }
  return result;
}

export async function GET(request: Request) {
  try {
    const actor = await requireCurrentAccount(request.headers);
    requireRole(actor, "ADMIN");
    await consumeRateLimit("users-global", "all", authLimits.global);
    await consumeRateLimit("users:list", actor.id, authLimits.userList);
    const directory = await listDirectoryUsers(actor, readSearchParamsObject(request));
    return Response.json(directory, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
