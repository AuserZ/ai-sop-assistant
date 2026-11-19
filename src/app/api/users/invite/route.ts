import { requireCurrentAccount, requireRole } from "@/server/auth/authorization";
import { authErrorResponse } from "@/server/auth/errors";
import { readAuthBody, requireMutationOrigin } from "@/server/auth/http";
import { issueInvitation } from "@/server/auth/invitations";
import { invitationInput } from "@/server/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireMutationOrigin(request);
    const actor = await requireCurrentAccount(request.headers);
    requireRole(actor, "ADMIN");
    const invitation = await issueInvitation(actor, await readAuthBody(request, invitationInput));
    return Response.json(invitation, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
