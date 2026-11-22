import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processUpload } from "../../src/components/documents/client";

const document = { id: randomUUID(), title: "Synthetic upload", fileName: "synthetic.pdf", mimeType: "application/pdf",
  sizeBytes: 1, sha256: "0".repeat(64), uploadStatus: "ACCEPTED", status: "UPLOADED", failureCode: null,
  job: { id: randomUUID(), state: "WAITING_FOR_PIPELINE" } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("D2 bounded document metadata requests", () => {
  it("accepts a valid response at29s within the server's30s storage window", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const responseTimer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(Response.json({ document }));
      }, 29_000);
      const abort = () => { clearTimeout(responseTimer); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    })));
    const outcome = processUpload(document.id, new AbortController().signal).then(
      (value) => ({ accepted: true, document: value.document }), () => ({ accepted: false }),
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await outcome).toMatchObject({ accepted: true, document });
  });

  it("aborts an unavailable service after allowing the server's30s window", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    let settled = false;
    const outcome = processUpload(document.id, new AbortController().signal).then(
      () => "unexpected success", (error: unknown) => error,
    ).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await outcome).toMatchObject({ name: "TimeoutError" });
  });
});
