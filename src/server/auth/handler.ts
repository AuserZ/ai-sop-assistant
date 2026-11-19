import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "../db/client";
import { authUsers } from "../db/schema";
import { getAuthentication } from "./authentication";
import { publicAccount, requireCurrentAccount } from "./authorization";
import { acceptInvitation } from "./invitations";
import { AuthFailure, authErrorResponse } from "./errors";
import { readAuthBody, requireMutationOrigin, sessionResponseHeaders } from "./http";
import { authLimits, consumeRateLimit } from "./rate-limit";
import { invitationAcceptanceInput, signInInput } from "./validation";

export async function handleAuthentication(request: Request) {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/auth/get-session") {
      await consumeRateLimit("session-global", "all", authLimits.global);
      const account = await requireCurrentAccount(request.headers);
      return Response.json({ user: publicAccount(account), session: { id: account.sessionId, expiresAt: account.sessionExpiresAt } }, { headers: { "Cache-Control": "no-store" } });
    }
    const allowed = ["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/invitations/accept"];
    if (request.method !== "POST" || !allowed.includes(path)) throw new AuthFailure("NOT_FOUND", 404);
    requireMutationOrigin(request);
    if (path === "/api/auth/invitations/accept") {
      const result = await acceptInvitation(await readAuthBody(request, invitationAcceptanceInput));
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const authentication = getAuthentication();
    const delegatedHeaders = new Headers(request.headers);
    delegatedHeaders.delete("content-length");
    if (path === "/api/auth/sign-out") {
      await readAuthBody(request, z.object({}).strict());
      const account = await requireCurrentAccount(request.headers);
      await consumeRateLimit("sign-out", account.id, authLimits.session);
      const response = await authentication.handler(new Request(request.url, { method: "POST", headers: delegatedHeaders, body: "{}" }));
      if (!response.ok) throw new AuthFailure("SERVICE_UNAVAILABLE", 503);
      return Response.json({ success: true }, { headers: sessionResponseHeaders(response) });
    }
    await consumeRateLimit("sign-in-global", "all", authLimits.global);
    const body = await readAuthBody(request, signInInput);
    await consumeRateLimit("sign-in-email", body.email, authLimits.signIn);
    const response = await authentication.handler(new Request(request.url, { method: "POST", headers: delegatedHeaders, body: JSON.stringify(body) }));
    if (!response.ok) throw new AuthFailure(response.status >= 500 ? "SERVICE_UNAVAILABLE" : "INVALID_CREDENTIALS", response.status >= 500 ? 503 : 401);
    const result = await response.json() as { user?: { id?: string } };
    const [user] = await getDatabase().select().from(authUsers).where(and(eq(authUsers.id, result.user?.id ?? ""), eq(authUsers.active, true)));
    if (!user) throw new AuthFailure("INVALID_CREDENTIALS", 401);
    return Response.json({ user: publicAccount(user) }, { headers: sessionResponseHeaders(response) });
  } catch (error) {
    return authErrorResponse(error);
  }
}
