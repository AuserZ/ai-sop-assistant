import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { callbackClaims, workflowBounds } from "./contracts";
import { callbackPublicKey, dispatchPrivateKey } from "./config";
import { AuthFailure } from "../auth/errors";

export async function signDispatch(payload: JWTPayload, privateKey = dispatchPrivateKey()) {
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(await importPKCS8(privateKey, "RS256"));
}

export async function verifyCallback(token: string, publicKey = callbackPublicKey()) {
  if (token.length > 8192) throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401);
  try {
    const verified = await jwtVerify(token, await importSPKI(publicKey, "RS256"), {
      algorithms: ["RS256"], issuer: "sop-n8n", audience: "sop-app", typ: "JWT",
      clockTolerance: workflowBounds.clockToleranceSeconds,
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    const claims = callbackClaims.parse(verified.payload);
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp - claims.iat > workflowBounds.tokenSeconds || claims.exp <= claims.iat ||
        claims.iat > now + workflowBounds.clockToleranceSeconds || claims.iat < now - workflowBounds.tokenSeconds ||
        claims.nbf > claims.iat) throw new Error("Invalid time window.");
    return claims;
  } catch { throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401); }
}
