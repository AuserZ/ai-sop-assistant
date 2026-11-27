export const maxProviderResponseBytes = 256 * 1024;

export class ProviderResponseTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes?: number;

  constructor(maxBytes: number, observedBytes?: number) {
    super(`Provider response exceeded maximum allowed size of ${maxBytes} bytes.`);
    this.name = "ProviderResponseTooLargeError";
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

function parseDeclaredContentLength(response: Response): number | null {
  const headerValue = response.headers?.get("content-length");
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number = maxProviderResponseBytes,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const declaredBytes = parseDeclaredContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await response.body?.cancel("response_too_large").catch(() => undefined);
    throw new ProviderResponseTooLargeError(maxBytes, declaredBytes);
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("response_too_large").catch(() => undefined);
          throw new ProviderResponseTooLargeError(maxBytes, totalBytes);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (!(error instanceof ProviderResponseTooLargeError)) {
        await reader.cancel().catch(() => undefined);
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(combined);
  }

  const text = await response.text();
  const actualBytes = Buffer.byteLength(text, "utf8");
  if (actualBytes > maxBytes) {
    throw new ProviderResponseTooLargeError(maxBytes, actualBytes);
  }
  return text;
}
