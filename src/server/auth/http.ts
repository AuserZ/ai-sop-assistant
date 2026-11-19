import type { ZodType } from "zod";
import { authConfiguration } from "./config";
import { AuthFailure } from "./errors";

export const maximumAuthBodyBytes = 4096;

export function requireMutationOrigin(request: Request, baseURL = authConfiguration().baseURL) {
  // Next's request URL can contain the internal bind address instead of the public host.
  if (request.headers.get("origin") !== baseURL || request.headers.get("host")?.toLowerCase() !== new URL(baseURL).host ||
      request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthFailure("INVALID_ORIGIN", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthFailure("INVALID_CONTENT_TYPE", 415);
  }
}

export async function readAuthBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const statedSize = request.headers.get("content-length");
  if (statedSize && (!/^\d+$/.test(statedSize) || Number(statedSize) > maximumAuthBodyBytes)) {
    throw new AuthFailure("INVALID_BODY", 413);
  }
  if (!request.body) throw new AuthFailure("INVALID_INPUT", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumAuthBodyBytes) {
        await reader.cancel();
        throw new AuthFailure("INVALID_BODY", 413);
      }
      chunks.push(value);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
    return parsed.data;
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure("INVALID_INPUT", 400);
  } finally {
    reader.releaseLock();
  }
}

export function sessionResponseHeaders(response: Response) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return headers;
}
