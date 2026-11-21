import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthFailure } from "../../src/server/auth/errors";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import type { JobDatabase, WorkflowEvent } from "../../src/server/jobs/service";
import { workflowBounds } from "../../src/server/jobs/contracts";
import { createJobEventStream, serializeWorkflowEvent } from "../../src/server/jobs/stream";

const { readEvents } = vi.hoisted(() => ({ readEvents: vi.fn() }));
vi.mock("../../src/server/jobs/service", () => ({ withOwnedEvents: readEvents }));

const jobId = randomUUID();
const account: CurrentAccount = { id: randomUUID(), name: "Synthetic", email: "stream@example.invalid", role: "STAFF", sessionId: randomUUID(), sessionExpiresAt: new Date("2030-01-01") };
const database = {} as JobDatabase;
let events: WorkflowEvent[];
let authorized: boolean;

function event(sequence: number, kind: WorkflowEvent["kind"] = "processing"): WorkflowEvent {
  return { id: randomUUID(), jobId, attemptId: randomUUID(), sequence, step: sequence, kind, createdAt: new Date() };
}

async function open(queueBudgetBytes: number, signal?: AbortSignal) {
  return createJobEventStream(new Request(`http://local.invalid/api/jobs/${jobId}/events`, { signal }), jobId, account, database, queueBudgetBytes);
}

async function settle() { await vi.advanceTimersByTimeAsync(0); }

beforeEach(() => {
  vi.useFakeTimers();
  authorized = true;
  events = [event(1, "accepted"), event(2)];
  readEvents.mockReset().mockImplementation(async (_account: CurrentAccount, _jobId: string, after: number,
    release: (batch: WorkflowEvent[], terminal: boolean) => unknown) => {
    if (!authorized) throw new AuthFailure("UNAUTHENTICATED", 401);
    return release(events.filter((value) => value.sequence > after).slice(0, 16), false);
  });
});

afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("ADR19 stream byte budgets, demand and cancellation", () => {
  it("stops database polling when the next frame cannot fit and resumes only after reader demand", async () => {
    const budget = serializeWorkflowEvent(events[0]).bytes.byteLength + 8;
    const response = await open(budget);
    await settle();
    const readsWhileBlocked = readEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(readEvents).toHaveBeenCalledTimes(readsWhileBlocked);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(`${jobId}:1`);
    await vi.advanceTimersByTimeAsync(workflowBounds.pollMilliseconds);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(`${jobId}:2`);
    expect(readEvents.mock.calls.length).toBeGreaterThan(readsWhileBlocked);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never adds a heartbeat larger than the remaining byte budget", async () => {
    events = [events[0]];
    const budget = serializeWorkflowEvent(events[0]).bytes.byteLength + 8;
    const releases: Array<{ available: number; bytes: number }> = [];
    const enqueue = ReadableStreamDefaultController.prototype.enqueue;
    vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue").mockImplementation(function (this: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) {
      releases.push({ available: this.desiredSize ?? 0, bytes: chunk.byteLength });
      enqueue.call(this, chunk);
    });
    const response = await open(budget);
    await vi.advanceTimersByTimeAsync(workflowBounds.heartbeatMilliseconds);
    expect(releases.every((release) => release.bytes <= release.available)).toBe(true);
    const reader = response.body!.getReader();
    let drainedBytes = (await reader.read()).value!.byteLength;
    await settle();
    const readsBeforeNextHeartbeat = readEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(workflowBounds.heartbeatMilliseconds);
    drainedBytes += (await reader.read()).value!.byteLength;
    expect(drainedBytes).toBe(serializeWorkflowEvent(events[0]).bytes.byteLength + new TextEncoder().encode(": heartbeat\n\n").byteLength);
    expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(readsBeforeNextHeartbeat);
    await reader.cancel();
  });

  it("emits the existing timeout DTO only through a fresh authorized release with capacity", async () => {
    events = [];
    const response = await open(512);
    const reader = response.body!.getReader();
    const pending = (async () => {
      const chunks: Uint8Array[] = [];
      while (true) { const value = await reader.read(); if (value.done) return new TextDecoder().decode(Buffer.concat(chunks)); chunks.push(value.value); }
    })();
    await vi.advanceTimersByTimeAsync(workflowBounds.streamMilliseconds);
    expect(await pending).toContain('event: stream_timeout\ndata: {"code":"STREAM_TIMEOUT","retryable":true}');
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overflow a stalled queue with a timeout frame", async () => {
    events = [events[0]];
    const budget = serializeWorkflowEvent(events[0]).bytes.byteLength + 8;
    const response = await open(budget);
    await vi.advanceTimersByTimeAsync(workflowBounds.streamMilliseconds + 1);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); }
    expect(chunks.reduce((size, chunk) => size + chunk.byteLength, 0)).toBeLessThanOrEqual(budget);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).not.toContain("S03_SYNTHETIC_VALIDATED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at the finite deadline even when no consumer ever frees a full queue", async () => {
    events = [events[0]];
    const budget = serializeWorkflowEvent(events[0]).bytes.byteLength;
    const response = await open(budget);
    await settle();
    const initialReads = readEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(workflowBounds.streamMilliseconds + 1);
    const reader = response.body!.getReader();
    await reader.read();
    await settle();
    expect((await reader.read()).done).toBe(true);
    expect(readEvents).toHaveBeenCalledTimes(initialReads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks authorization after pressure clears and releases no terminal marker after revocation", async () => {
    events = [events[0], event(2, "synthetic_completed")];
    const response = await open(serializeWorkflowEvent(events[1]).bytes.byteLength + 8);
    await settle();
    authorized = false;
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await vi.advanceTimersByTimeAsync(workflowBounds.pollMilliseconds);
    expect((await reader.read()).done).toBe(true);
    expect(first).not.toContain("S03_SYNTHETIC_VALIDATED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels timers and ignores a database result arriving after request abort", async () => {
    let releaseQuery!: () => void;
    const pending = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const implementation = readEvents.getMockImplementation()!;
    readEvents.mockImplementationOnce(implementation).mockImplementationOnce(async (...args: unknown[]) => {
      await pending;
      return implementation(...args);
    });
    const cancellation = new AbortController();
    const response = await open(512, cancellation.signal);
    await settle();
    cancellation.abort();
    releaseQuery();
    await settle();
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(true);
    const calls = readEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(workflowBounds.streamMilliseconds);
    expect(readEvents).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
