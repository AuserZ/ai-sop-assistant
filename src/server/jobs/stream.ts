import { randomUUID } from "node:crypto";
import { authErrorResponse, AuthFailure } from "../auth/errors";
import { requireCurrentAccount, type CurrentAccount } from "../auth/authorization";
import { getDatabase } from "../db/client";
import { parseEventCursor, syntheticMarker, workflowBounds } from "./contracts";
import { withOwnedEvents, type JobDatabase, type WorkflowEvent } from "./service";

export function serializeWorkflowEvent(event: WorkflowEvent) {
  const common = { jobId: event.jobId, synthetic: true };
  const terminal = event.kind === "synthetic_completed" || event.kind === "failed";
  const name = event.kind === "synthetic_completed" ? "completed" : event.kind === "failed" ? "failed" : "progress";
  const data = event.kind === "synthetic_completed" ? { ...common, kind: "synthetic_probe", marker: syntheticMarker } :
    event.kind === "failed" ? { ...common, code: "SYNTHETIC_WORKFLOW_FAILED", retryable: false } : { ...common, stage: event.kind };
  return { bytes: new TextEncoder().encode(`id: ${event.jobId}:${event.sequence}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`), terminal };
}

function waitForPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function createJobEventStream(request: Request, jobId: string,
  account?: CurrentAccount, database: JobDatabase = getDatabase(), queueBudgetBytes: number = workflowBounds.streamQueueBytes) {
  const currentAccount = account ?? await requireCurrentAccount(request.headers);
  let cursor: number;
  try { cursor = parseEventCursor(request.headers.get("last-event-id"), jobId); }
  catch { throw new AuthFailure("INVALID_EVENT_CURSOR", 400); }
  await withOwnedEvents(currentAccount, jobId, cursor, () => undefined, database);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const openedAt = Date.now();
  const heartbeat = new TextEncoder().encode(": heartbeat\n\n");
  const timeout = new TextEncoder().encode('event: stream_timeout\ndata: {"code":"STREAM_TIMEOUT","retryable":true}\n\n');
  if (!Number.isSafeInteger(queueBudgetBytes) || queueBudgetBytes < 1 || queueBudgetBytes > workflowBounds.streamQueueBytes) {
    throw new RangeError("Invalid internal stream queue budget.");
  }
  let lastFrameAt = openedAt;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const abort = () => stop();
  function stop(close = true) {
    if (finished) return;
    finished = true;
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", abort);
    cancellation.abort();
    if (close) streamController.close();
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      deadlineTimer = setTimeout(() => stop(), workflowBounds.streamMilliseconds);
      deadlineTimer.unref();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) stop();
    },
    async pull(controller) {
      if (finished) return;
      try {
        while (!signal.aborted && !finished) {
          if ((controller.desiredSize ?? 0) < heartbeat.byteLength) return;
          let emitted = false;
          let backpressured = false;
          await withOwnedEvents(currentAccount, jobId, cursor, (events, terminal) => {
            if (finished || signal.aborted) return;
            // Reserve one poll interval for an authorized timeout before the hard close.
            if (Date.now() - openedAt >= workflowBounds.streamMilliseconds - workflowBounds.pollMilliseconds) {
              if ((controller.desiredSize ?? 0) >= timeout.byteLength) controller.enqueue(timeout);
              stop();
            } else {
              for (const event of events) {
                const frame = serializeWorkflowEvent(event);
                if ((controller.desiredSize ?? 0) < frame.bytes.byteLength) { backpressured = true; break; }
                controller.enqueue(frame.bytes);
                cursor = event.sequence;
                emitted = true;
                lastFrameAt = Date.now();
                if (frame.terminal) { stop(); break; }
              }
              if (terminal && !events.length) stop();
              if (!emitted && !backpressured && !finished && Date.now() - lastFrameAt >= workflowBounds.heartbeatMilliseconds) {
                if ((controller.desiredSize ?? 0) >= heartbeat.byteLength) {
                  controller.enqueue(heartbeat);
                  lastFrameAt = Date.now(); emitted = true;
                } else backpressured = true;
              }
            }
          }, database);
          if (finished || backpressured || emitted || (controller.desiredSize ?? 0) <= 0) return;
          await waitForPoll(workflowBounds.pollMilliseconds, signal);
        }
        stop();
      } catch {
        // A revoked owner or unavailable database must not receive another frame.
        stop();
      }
    },
    cancel() { stop(false); },
  }, { highWaterMark: queueBudgetBytes, size: (chunk) => chunk.byteLength });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no", "X-Request-Id": randomUUID(),
  } });
}

export async function jobStreamResponse(request: Request, jobId: string) {
  try { return await createJobEventStream(request, jobId); }
  catch (error) { return authErrorResponse(error); }
}
