import { publicAccount, requireCurrentAccount } from "@/server/auth/authorization";
import { authErrorResponse } from "@/server/auth/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const account = await requireCurrentAccount(request.headers);
    return Response.json({ user: publicAccount(account) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
