import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { authConfiguration } from "../../src/server/auth/config";
import { requireOwner, requireRole, type CurrentAccount } from "../../src/server/auth/authorization";
import { authErrorResponse } from "../../src/server/auth/errors";
import { maximumAuthBodyBytes, readAuthBody, requireMutationOrigin, sessionResponseHeaders } from "../../src/server/auth/http";
import { invitationAcceptanceInput, signInInput } from "../../src/server/auth/validation";

const secret = randomUUID();
const account: CurrentAccount = { id: "owner", name: "Synthetic", email: "owner@example.invalid", role: "ADMIN", sessionId: "session", sessionExpiresAt: new Date() };

describe("U2/U4 auth trust boundaries", () => {
  it("requires a fixed safe origin and one adequate server credential source", () => {
    expect(authConfiguration({ AUTH_BASE_URL: "https://sop.example.invalid", AUTH_SECRET: secret }).secureCookies).toBe(true);
    expect(authConfiguration({ AUTH_BASE_URL: "http://127.0.0.1:3000", AUTH_SECRET: secret }).secureCookies).toBe(false);
    for (const baseURL of ["http://example.invalid", "https://sop.example.invalid/other", "https://user:password@sop.example.invalid", "https://sop.example.invalid/?host=other"]) {
      expect(() => authConfiguration({ AUTH_BASE_URL: baseURL, AUTH_SECRET: secret })).toThrow();
    }
    expect(() => authConfiguration({ AUTH_BASE_URL: "https://sop.example.invalid", AUTH_SECRET: "short" })).toThrow();
    expect(() => authConfiguration({ AUTH_BASE_URL: "https://sop.example.invalid", AUTH_SECRET: secret, AUTH_SECRET_FILE: "unused" })).toThrow();
    expect(() => authConfiguration({ AUTH_SECRET: secret })).toThrow();
  });

  it("rejects cross-site, absent-origin and simple mutations despite forged forwarding", () => {
    const baseURL = "http://127.0.0.1:3000";
    const request = (headers: Record<string, string>) => new Request(`${baseURL}/api/auth/sign-in/email`, { method: "POST", headers: { host: new URL(baseURL).host, ...headers } });
    expect(() => requireMutationOrigin(request({ origin: baseURL, "content-type": "application/json" }), baseURL)).not.toThrow();
    const invalidHeaders: Record<string, string>[] = [{}, { origin: "null", "content-type": "application/json" }, { origin: "https://evil.invalid", "x-forwarded-host": "127.0.0.1:3000" }, { origin: baseURL, "content-type": "text/plain" }, { origin: baseURL, "content-type": "application/json", "sec-fetch-site": "cross-site" }];
    for (const headers of invalidHeaders) {
      expect(() => requireMutationOrigin(request(headers), baseURL)).toThrow();
    }
    expect(() => requireMutationOrigin(request({ origin: baseURL, "content-type": "text/plain" }), baseURL)).toThrow("INVALID_CONTENT_TYPE");
  });

  it("accepts canonical browser Host and Origin when Next uses an internal bind URL", () => {
    for (const baseURL of ["http://127.0.0.1:3000", "https://sop.example.invalid"]) {
      const request = new Request("http://0.0.0.0:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { host: new URL(baseURL).host, origin: baseURL, "content-type": "application/json" },
      });
      expect(() => requireMutationOrigin(request, baseURL)).not.toThrow();
    }
    const uppercaseHost = new Request("http://0.0.0.0:3000/api/auth/sign-in/email", {
      method: "POST", headers: { host: "SOP.EXAMPLE.INVALID", origin: "https://sop.example.invalid", "content-type": "application/json" },
    });
    expect(() => requireMutationOrigin(uppercaseHost, "https://sop.example.invalid")).not.toThrow();
  });

  it("rejects foreign, malformed or missing Host even when forwarding claims the canonical origin", () => {
    const baseURL = "http://127.0.0.1:3000";
    for (const host of [undefined, "", "evil.invalid", "127.0.0.1:9999", "127.0.0.1:3000.evil.invalid", "127.0.0.1:3000,evil.invalid", "evil.invalid@127.0.0.1:3000"]) {
      const headers = new Headers({ origin: baseURL, "content-type": "application/json", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" });
      if (host !== undefined) headers.set("host", host);
      const request = new Request("http://0.0.0.0:3000/api/auth/sign-in/email", { method: "POST", headers });
      expect(() => requireMutationOrigin(request, baseURL)).toThrow("INVALID_ORIGIN");
    }
  });

  it("bounds streamed bytes without trusting content-length and validates credentials before hashing", async () => {
    const oversized = new Request("https://sop.example.invalid", { method: "POST", body: "x".repeat(maximumAuthBodyBytes + 1) });
    await expect(readAuthBody(oversized, signInInput)).rejects.toMatchObject({ status: 413 });
    const forgedRole = new Request("https://sop.example.invalid", { method: "POST", body: JSON.stringify({ email: "staff@example.invalid", password: "synthetic", role: "ADMIN" }) });
    await expect(readAuthBody(forgedRole, signInInput)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(invitationAcceptanceInput.safeParse({ token: "a".repeat(43), email: " Staff@Example.Invalid ", name: "Test", password: "x".repeat(12) }).success).toBe(true);
    expect(invitationAcceptanceInput.safeParse({ token: "a".repeat(43), email: "staff@example.invalid", name: "Test", password: "short" }).success).toBe(false);
  });

  it("enforces owner isolation for Admin and Staff independently of role privileges", () => {
    expect(() => requireRole({ ...account, role: "STAFF" }, "ADMIN")).toThrow();
    for (const role of ["ADMIN", "STAFF"] as const) {
      expect(() => requireOwner({ ...account, role }, "other-owner")).toThrow();
      expect(() => requireOwner({ ...account, role }, account.id)).not.toThrow();
    }
  });

  it("preserves all session cookies while dropping stale body headers and sensitive failures", async () => {
    const response = new Response("sensitive", { headers: { "Content-Length": "9" } });
    response.headers.append("Set-Cookie", "session=one; HttpOnly");
    response.headers.append("Set-Cookie", "other=two; HttpOnly");
    const headers = sessionResponseHeaders(response);
    expect(headers.getSetCookie()).toHaveLength(2);
    expect(headers.has("content-length")).toBe(false);
    expect(headers.get("cache-control")).toBe("no-store");
    const failure = authErrorResponse(new Error("secret-password@example.invalid"));
    expect(await failure.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("refuses synthetic Admin bootstrap outside explicit nonproduction loopback mode", { timeout: 15_000 }, () => {
    const refusedEnvironments: Array<Pick<NodeJS.ProcessEnv, "NODE_ENV"> & { SOP_SYNTHETIC_AUTH: string; AUTH_BASE_URL: string }> = [
      { NODE_ENV: "production", SOP_SYNTHETIC_AUTH: "1", AUTH_BASE_URL: "http://127.0.0.1:3000" },
      { NODE_ENV: "test", SOP_SYNTHETIC_AUTH: "", AUTH_BASE_URL: "http://127.0.0.1:3000" },
      { NODE_ENV: "test", SOP_SYNTHETIC_AUTH: "1", AUTH_BASE_URL: "https://sop.example.invalid" },
    ];
    for (const environment of refusedEnvironments) {
      const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/seed-synthetic-admin.ts"], {
        encoding: "utf8",
        env: { ...process.env, AUTH_SECRET_FILE: "", AUTH_SECRET: secret, ...environment },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Synthetic Admin fixture failed.");
      expect(result.stderr).not.toContain(secret);
    }
  });
});
