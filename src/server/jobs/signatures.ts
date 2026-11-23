import { createPublicKey, randomUUID } from "node:crypto";
import { errors, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { callbackClaims, ingestionBounds, ingestionCallbackClaims, sourceRefClaims, workflowBounds } from "./contracts";
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

export async function verifyIngestionCallback(token: string, publicKey = callbackPublicKey()) {
  if (token.length > 8192) throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401);
  try {
    const verified = await jwtVerify(token, await importSPKI(publicKey, "RS256"), {
      algorithms: ["RS256"], issuer: "sop-n8n", audience: "sop-app", typ: "JWT",
      clockTolerance: ingestionBounds.clockToleranceSeconds,
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    const claims = ingestionCallbackClaims.parse(verified.payload);
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp - claims.iat > ingestionBounds.callbackTokenSeconds || claims.exp <= claims.iat ||
        claims.iat > now + ingestionBounds.clockToleranceSeconds || claims.iat < now - ingestionBounds.callbackTokenSeconds ||
        claims.nbf > claims.iat) throw new Error("Invalid time window.");
    return claims;
  } catch { throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401); }
}

export async function signSourceRefToken(
  binding: { jobId: string; documentId: string; sourceSha256: string; attemptId: string; executionId: string },
  privateKey = dispatchPrivateKey(),
  lifetimeSeconds: number = ingestionBounds.sourceRefTokenSeconds,
) {
  const now = Math.floor(Date.now() / 1000);
  const clampedLifetime = Math.min(Math.max(1, lifetimeSeconds), ingestionBounds.sourceRefTokenSeconds);
  const payload = sourceRefClaims.parse({
    v: 1,
    iss: "sop-app",
    aud: "sop-app-source-ref",
    purpose: "source_read",
    ...binding,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + clampedLifetime,
  });
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(await importPKCS8(privateKey, "RS256"));
}

export async function verifySourceRefToken(token: string, privateKey = dispatchPrivateKey()) {
  if (token.length > 4096) throw new AuthFailure("INVALID_SOURCE_REF", 401);
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  try {
    const verified = await jwtVerify(token, await importSPKI(publicKeyPem, "RS256"), {
      algorithms: ["RS256"],
      issuer: "sop-app",
      audience: "sop-app-source-ref",
      typ: "JWT",
      clockTolerance: 0,
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    const claims = sourceRefClaims.parse(verified.payload);
    if (claims.exp - claims.iat > ingestionBounds.sourceRefTokenSeconds || claims.exp <= claims.iat || claims.nbf > claims.iat) {
      throw new AuthFailure("INVALID_SOURCE_REF", 401);
    }
    return claims;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AuthFailure("SOURCE_REF_EXPIRED", 401);
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure("INVALID_SOURCE_REF", 401);
  }
}
