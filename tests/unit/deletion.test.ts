import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMutationOrigin } from "../../src/server/auth/http";
import {
  calculateCleanupBackoffSeconds,
  documentBounds,
  documentCleanupStates,
  documentLifecycleStatuses,
} from "../../src/server/documents/contracts";
import {
  deleteDocument,
  DocumentRequestError,
  processingErrorCodeMessage,
} from "../../src/components/documents/client";
import { VerificationRequestError } from "../../src/components/verification/client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("S08/D4 SOP deletion contracts, backoff and client helpers", () => {
  it("exposes DELETED lifecycle status and cleanup states", () => {
    expect(documentLifecycleStatuses).toContain("DELETED");
    expect(documentCleanupStates).toEqual(["PENDING", "RUNNING", "COMPLETED", "FAILED"]);
    expect(documentBounds.cleanupLeaseSeconds).toBe(45);
    expect(documentBounds.cleanupBatchSize).toBe(5);
    expect(documentBounds.cleanupBackoffMaxSeconds).toBe(60);
  });

  it("caps cleanup retry backoff cleanly at 60 seconds without overflow", () => {
    expect(calculateCleanupBackoffSeconds(1)).toBe(2);
    expect(calculateCleanupBackoffSeconds(2)).toBe(4);
    expect(calculateCleanupBackoffSeconds(3)).toBe(8);
    expect(calculateCleanupBackoffSeconds(4)).toBe(16);
    expect(calculateCleanupBackoffSeconds(5)).toBe(32);
    expect(calculateCleanupBackoffSeconds(6)).toBe(60);
    expect(calculateCleanupBackoffSeconds(25)).toBe(60);
    expect(calculateCleanupBackoffSeconds(10_000)).toBe(60);
    expect(calculateCleanupBackoffSeconds(0)).toBe(2);
    expect(calculateCleanupBackoffSeconds(-5)).toBe(2);
    expect(calculateCleanupBackoffSeconds(Number.NaN)).toBe(2);
  });

  it("maps deletion and cleanup error codes to safe user-facing messages", () => {
    expect(new DocumentRequestError("DOCUMENT_DELETED").message).toContain("deleted");
    expect(new DocumentRequestError("CLEANUP_STORAGE_UNAVAILABLE").message).toContain("retry");
    expect(processingErrorCodeMessage("CLEANUP_STORAGE_UNAVAILABLE")).toContain("retry");
    expect(new VerificationRequestError("DOCUMENT_DELETED").message).toContain("deleted");
  });

  it("sends same-origin DELETE requests and validates tombstone responses", async () => {
    const documentId = randomUUID();
    const deletedAt = "2026-11-23T10:30:00.000Z";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          deleted: true,
          created: true,
          document: {
            id: documentId,
            status: "DELETED",
            deletedAt,
            cleanup: {
              state: "PENDING",
              attempts: 0,
              errorCode: null,
              completedAt: null,
            },
          },
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteDocument(documentId, new AbortController().signal);
    expect(result).toEqual({
      deleted: true,
      created: true,
      document: {
        id: documentId,
        status: "DELETED",
        deletedAt,
        cleanup: {
          state: "PENDING",
          attempts: 0,
          errorCode: null,
          completedAt: null,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/documents/${documentId}`);
    expect(init?.method).toBe("DELETE");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
  });

  it("surfaces safe DocumentRequestError codes on DELETE failure", async () => {
    const documentId = randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }),
      ),
    );

    await expect(
      deleteDocument(documentId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows bodyless same-origin DELETE in requireMutationOrigin while rejecting foreign origin, cross-site, non-JSON Content-Type and bodyless POST", () => {
    const baseURL = "http://127.0.0.1:3000";
    const host = new URL(baseURL).host;

    // Bodyless same-origin DELETE succeeds.
    expect(() =>
      requireMutationOrigin(
        new Request(`${baseURL}/api/documents/${randomUUID()}`, {
          method: "DELETE",
          headers: { Origin: baseURL, Host: host },
        }),
        baseURL,
      ),
    ).not.toThrow();

    // JSON same-origin DELETE also succeeds.
    expect(() =>
      requireMutationOrigin(
        new Request(`${baseURL}/api/documents/${randomUUID()}`, {
          method: "DELETE",
          headers: { Origin: baseURL, Host: host, "Content-Type": "application/json" },
        }),
        baseURL,
      ),
    ).not.toThrow();

    // Missing/foreign Origin, wrong Host, or cross-site Sec-Fetch-Site fail 403 INVALID_ORIGIN.
    const invalidOriginHeaders: Array<Record<string, string>> = [
      { Host: host },
      { Origin: "https://evil.example.invalid", Host: host },
      { Origin: baseURL, Host: "evil.example.invalid" },
      { Origin: baseURL, Host: host, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of invalidOriginHeaders) {
      expect(() =>
        requireMutationOrigin(
          new Request(`${baseURL}/api/documents/${randomUUID()}`, { method: "DELETE", headers }),
          baseURL,
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN", status: 403 }));
    }

    // DELETE with non-JSON Content-Type fails 415 INVALID_CONTENT_TYPE.
    expect(() =>
      requireMutationOrigin(
        new Request(`${baseURL}/api/documents/${randomUUID()}`, {
          method: "DELETE",
          headers: { Origin: baseURL, Host: host, "Content-Type": "text/plain" },
        }),
        baseURL,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTENT_TYPE", status: 415 }));

    // POST without Content-Type still fails 415 INVALID_CONTENT_TYPE.
    expect(() =>
      requireMutationOrigin(
        new Request(`${baseURL}/api/documents/upload-init`, {
          method: "POST",
          headers: { Origin: baseURL, Host: host },
        }),
        baseURL,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTENT_TYPE", status: 415 }));
  });
});
