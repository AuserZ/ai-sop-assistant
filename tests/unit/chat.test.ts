import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  archiveConversation,
  conversationArchiveSchema,
  conversationDetailSchema,
  conversationListSchema,
  conversationRenameSchema,
  fetchConversations,
  parseRawSseFrame,
  renameConversation,
} from "../../src/components/chat/client";
import {
  parseSafeInlineTokens,
  parseSafeMarkdownBlocks,
} from "../../src/components/chat/safe-markdown";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { AuthFailure } from "../../src/server/auth/errors";
import {
  chatApiBounds,
  chatControlCharacterPattern,
  createChatEventStream,
  decodeConversationCursor,
  encodeConversationCursor,
  handleArchiveChatConversation,
  handleRenameChatConversation,
  noEvidenceFallbackMessage,
  readBoundedJsonBody,
  renameChatConversationInput,
  resolveSafeChatError,
  sendChatMessageInput,
  serializeChatEvent,
  type ChatStreamBatch,
  type ChatStreamEventContext,
} from "../../src/server/chat";
import { chatDispatchEnabled, chatDispatchUrl } from "../../src/server/jobs/config";
import {
  chatCallbackClaims,
  chatDispatchClaims,
  chatWorkflowVersion,
  parseEventCursor,
} from "../../src/server/jobs/contracts";
import { signDispatch, verifyChatCallback } from "../../src/server/jobs/signatures";

const textDecoder = new TextDecoder();

function makeContext(overrides: Partial<ChatStreamEventContext> = {}): ChatStreamEventContext {
  return {
    jobId: randomUUID(),
    conversationId: randomUUID(),
    requestId: randomUUID(),
    errorCode: null,
    errorRetryable: null,
    completedMessage: null,
    ...overrides,
  };
}

function makeAccount(): CurrentAccount {
  return {
    id: "user-staff-1",
    name: "Synthetic Staff",
    email: "staff@example.com",
    role: "STAFF",
    sessionId: "sess-1",
    sessionExpiresAt: new Date(Date.now() + 3600_000),
  };
}

describe("S11 chat SSE serialization, safety, and contracts (C1-C5, ADR 18/19)", () => {
  it("emits strictly allowlisted progress frames with zero draft or arbitrary string leakage", () => {
    const draftSecret = "UNVALIDATED_DRAFT_STEP_1_DO_NOT_LEAK_999";
    const context = makeContext({
      errorCode: "RAW_PROVIDER_EXCEPTION: " + draftSecret,
      completedMessage: {
        id: randomUUID(),
        validationStatus: "PASSED",
        content: draftSecret,
        isProcedural: true,
        timings: null,
        sources: [],
        allSourcesActive: false,
      },
    });

    for (const stage of ["accepted", "retrieving", "reranking", "generating", "validating"] as const) {
      const frame = serializeChatEvent({ jobId: context.jobId, sequence: 1, kind: stage }, context);
      const wire = textDecoder.decode(frame.bytes);
      expect(frame.terminal).toBe(false);
      expect(frame.eventName).toBe(stage);
      expect(wire).toContain(`id: ${context.jobId}:1\n`);
      expect(wire).toContain(`event: ${stage}\n`);
      expect(wire).not.toContain(draftSecret);
      expect(wire).not.toContain("RAW_PROVIDER_EXCEPTION");

      const parsed = parseRawSseFrame(wire);
      expect(parsed?.type).toBe("progress");
      if (parsed?.type === "progress") {
        expect(parsed.data).toEqual({
          v: 1,
          requestId: context.requestId,
          conversationId: context.conversationId,
          jobId: context.jobId,
          stage,
        });
      }
    }
  });

  it("emits completed only when PASSED and all cited sources remain ACTIVE; revoking a source falls back to no_evidence", () => {
    const docId = randomUUID();
    const chunkId = randomUUID();
    const messageId = randomUUID();

    const activeContext = makeContext({
      completedMessage: {
        id: messageId,
        validationStatus: "PASSED",
        content: "1. Lock main breaker.\n2. Verify 0 V reading.",
        isProcedural: true,
        timings: {
          retrievalMs: 12,
          generateMs: 18,
          deterministicCheckMs: 1,
          judgeMs: 15,
          citationResolveMs: 4,
          totalMs: 50,
        },
        sources: [
          {
            documentId: docId,
            chunkId,
            sopTitle: "SOP-101 Electrical Isolation",
            section: "Section 4.1",
            pageStart: 2,
            pageEnd: 2,
            sourcePath: `/api/documents/${docId}/source?section=Section+4.1&page=2`,
          },
        ],
        allSourcesActive: true,
      },
    });

    const completedFrame = serializeChatEvent(
      { jobId: activeContext.jobId, sequence: 6, kind: "completed" },
      activeContext,
    );
    expect(completedFrame.terminal).toBe(true);
    expect(completedFrame.eventName).toBe("completed");
    const parsedCompleted = parseRawSseFrame(textDecoder.decode(completedFrame.bytes));
    expect(parsedCompleted?.type).toBe("completed");
    if (parsedCompleted?.type === "completed") {
      expect(parsedCompleted.data.messageId).toBe(messageId);
      expect(parsedCompleted.data.sources).toHaveLength(1);
    }

    const revokedContext = makeContext({
      completedMessage: {
        ...activeContext.completedMessage!,
        allSourcesActive: false,
      },
    });

    const revokedFrame = serializeChatEvent(
      { jobId: revokedContext.jobId, sequence: 6, kind: "completed" },
      revokedContext,
    );
    const revokedWire = textDecoder.decode(revokedFrame.bytes);
    expect(revokedFrame.terminal).toBe(true);
    expect(revokedFrame.eventName).toBe("no_evidence");
    expect(revokedWire).not.toContain("Lock main breaker");
    expect(revokedWire).not.toContain(docId);
    const parsedRevoked = parseRawSseFrame(revokedWire);
    expect(parsedRevoked?.type).toBe("no_evidence");
    if (parsedRevoked?.type === "no_evidence") {
      expect(parsedRevoked.data.message).toBe(noEvidenceFallbackMessage);
      expect(parsedRevoked.data.sources).toEqual([]);
    }
  });

  it("separates provider/validation failures from no_evidence and strips unknown raw errors", () => {
    const rawLeak = "OpenAI 500: sk-secret-key-leak draft text";
    const unknownMapped = resolveSafeChatError(rawLeak, null);
    expect(unknownMapped.errorCode).toBe("CHAT_WORKFLOW_FAILED");
    expect(unknownMapped.message).not.toContain(rawLeak);
    expect(unknownMapped.message).not.toBe(noEvidenceFallbackMessage);
    expect(unknownMapped.retryable).toBe(true);

    const validationMapped = resolveSafeChatError("ANSWER_VALIDATION_FAILED", false);
    expect(validationMapped.errorCode).toBe("ANSWER_VALIDATION_FAILED");
    expect(validationMapped.retryable).toBe(false);
    expect(validationMapped.message).not.toBe(noEvidenceFallbackMessage);

    const context = makeContext({
      errorCode: rawLeak,
      errorRetryable: true,
    });
    const frame = serializeChatEvent({ jobId: context.jobId, sequence: 5, kind: "failed" }, context);
    const wire = textDecoder.decode(frame.bytes);
    expect(frame.terminal).toBe(true);
    expect(wire).not.toContain("sk-secret-key-leak");
    const parsed = parseRawSseFrame(wire);
    expect(parsed?.type).toBe("failed");
    if (parsed?.type === "failed") {
      expect(parsed.data.errorCode).toBe("CHAT_WORKFLOW_FAILED");
      expect(parsed.data.message).not.toBe(noEvidenceFallbackMessage);
    }
  });

  it("enforces Last-Event-ID cursor format and cross-job rejection", () => {
    const jobId = randomUUID();
    const otherJobId = randomUUID();
    expect(parseEventCursor(null, jobId)).toBe(0);
    expect(parseEventCursor(`${jobId}:0`, jobId)).toBe(0);
    expect(parseEventCursor(`${jobId}:4`, jobId)).toBe(4);
    expect(() => parseEventCursor(`${otherJobId}:2`, jobId)).toThrow("INVALID_EVENT_CURSOR");
    expect(() => parseEventCursor("not-a-cursor", jobId)).toThrow("INVALID_EVENT_CURSOR");
  });

  it("handles SSE backpressure, heartbeat, stream_timeout, abort, and mid-stream auth revocation safely", async () => {
    const account = makeAccount();
    const jobId = randomUUID();
    const conversationId = randomUUID();
    const requestId = randomUUID();

    // 1. Timeout + heartbeat path
    const timeoutResponse = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${jobId}/events`),
      jobId,
      {
        account,
        streamMilliseconds: 80,
        pollMilliseconds: 15,
        heartbeatMilliseconds: 20,
        loadBatchImpl: async (_acc, _id, _after, release) => {
          release({
            conversationId,
            events: [],
            context: {
              jobId,
              conversationId,
              requestId,
              errorCode: null,
              errorRetryable: null,
              completedMessage: null,
            },
            terminal: false,
          });
        },
      },
    );

    expect(timeoutResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(timeoutResponse.headers.get("x-accel-buffering")).toBe("no");
    expect(timeoutResponse.headers.get("cache-control")).toBe("no-store, no-transform");
    const timeoutBody = await timeoutResponse.text();
    expect(timeoutBody).toContain(": heartbeat\n\n");
    expect(timeoutBody).toContain("event: stream_timeout\n");
    expect(timeoutBody).toContain('"code":"STREAM_TIMEOUT"');

    // 2. Backpressure + ordered multi-event flush
    const allEvents = [
      { id: randomUUID(), jobId, attemptId: randomUUID(), sequence: 1, step: 0, kind: "accepted" as const, createdAt: new Date() },
      { id: randomUUID(), jobId, attemptId: randomUUID(), sequence: 2, step: 1, kind: "retrieving" as const, createdAt: new Date() },
      { id: randomUUID(), jobId, attemptId: randomUUID(), sequence: 3, step: 6, kind: "no_evidence" as const, createdAt: new Date() },
    ];
    const bpResponse = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${jobId}/events`),
      jobId,
      {
        account,
        queueBudgetBytes: 340,
        pollMilliseconds: 10,
        loadBatchImpl: async (_acc, _id, after, release) => {
          const remaining = allEvents.filter((event) => event.sequence > after);
          release({
            conversationId,
            events: remaining,
            context: {
              jobId,
              conversationId,
              requestId,
              errorCode: null,
              errorRetryable: null,
              completedMessage: null,
            },
            terminal: remaining.length === 0,
          });
        },
      },
    );
    const bpText = await bpResponse.text();
    expect(bpText).toContain("event: accepted\n");
    expect(bpText).toContain("event: retrieving\n");
    expect(bpText).toContain("event: no_evidence\n");
    expect(bpText).toContain(noEvidenceFallbackMessage);

    // 3. Mid-stream revocation stops stream without leaking subsequent terminal answer
    let polls = 0;
    const revokedResponse = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${jobId}/events`),
      jobId,
      {
        account,
        pollMilliseconds: 10,
        loadBatchImpl: async (_acc, _id, after, release) => {
          polls++;
          if (polls === 1) {
            release({
              conversationId,
              events: [],
              context: { jobId, conversationId, requestId, errorCode: null, errorRetryable: null, completedMessage: null },
              terminal: false,
            } satisfies ChatStreamBatch);
            return;
          }
          if (polls === 2 && after === 0) {
            release({
              conversationId,
              events: [allEvents[0]],
              context: { jobId, conversationId, requestId, errorCode: null, errorRetryable: null, completedMessage: null },
              terminal: false,
            });
            return;
          }
          throw new AuthFailure("UNAUTHENTICATED", 401);
        },
      },
    );
    const revokedText = await revokedResponse.text();
    expect(revokedText).toContain("event: accepted\n");
    expect(revokedText).not.toContain("event: completed\n");
    expect(revokedText).not.toContain("event: no_evidence\n");

    // 4. Client abort closes stream cleanly
    const abortController = new AbortController();
    const abortResponse = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${jobId}/events`, {
        signal: abortController.signal,
      }),
      jobId,
      {
        account,
        pollMilliseconds: 20,
        loadBatchImpl: async (_acc, _id, _after, release) => {
          release({
            conversationId,
            events: [],
            context: { jobId, conversationId, requestId, errorCode: null, errorRetryable: null, completedMessage: null },
            terminal: false,
          });
        },
      },
    );
    abortController.abort();
    const abortedText = await abortResponse.text();
    expect(abortedText).toBe("");
  });

  it("renders numbered steps and strips XSS/HTML/javascript links safely in SafeMarkdown", () => {
    const malicious = [
      "1. Verify **121.0 °C** for `20 min` before `<script>alert(1)</script>`.",
      "2. Do not open [evil](javascript:alert(1)) or <img src=x onerror=alert(1)>.",
      "- Keep log signed.",
      "Note: see [phishing](https://evil.example/sop).",
    ].join("\n");

    const blocks = parseSafeMarkdownBlocks(malicious);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      kind: "ordered-list",
      items: [
        {
          stepNumber: 1,
          text: "Verify **121.0 °C** for `20 min` before `<script>alert(1)</script>`.",
        },
        {
          stepNumber: 2,
          text: "Do not open [evil](javascript:alert(1)) or <img src=x onerror=alert(1)>.",
        },
      ],
    });
    expect(blocks[1]).toEqual({ kind: "unordered-list", items: ["Keep log signed."] });
    expect(blocks[2]).toEqual({
      kind: "paragraph",
      text: "Note: see [phishing](https://evil.example/sop).",
    });

    const step1Tokens = parseSafeInlineTokens(
      "Verify **121.0 °C** for `20 min` and <script>alert(1)</script>",
    );
    expect(step1Tokens).toEqual([
      { kind: "text", text: "Verify " },
      { kind: "strong", text: "121.0 °C" },
      { kind: "text", text: " for " },
      { kind: "code", text: "20 min" },
      { kind: "text", text: " and <script>alert(1)</script>" },
    ]);

    const linkTokens = parseSafeInlineTokens("[click](javascript:alert(1))");
    expect(linkTokens).toEqual([{ kind: "text", text: "[click](javascript:alert(1))" }]);
  });

  it("validates exact 17-key S11 dispatch claims, RS256 callback JWTs, input bounds, and chat dispatch config", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const now = Math.floor(Date.now() / 1000);
    const jobId = randomUUID();
    const conversationId = randomUUID();
    const requestKey = randomUUID();
    const attemptId = randomUUID();
    const dispatchNonce = randomUUID();

    const dispatchPayload = chatDispatchClaims.parse({
      v: 1,
      workflow: chatWorkflowVersion,
      purpose: "dispatch",
      iss: "sop-app",
      aud: "sop-n8n",
      method: "POST",
      path: "/webhook/sop-s11-chat-v1",
      jobId,
      conversationId,
      requestKey,
      attemptId,
      attemptNumber: 1,
      dispatchNonce,
      jti: dispatchNonce,
      iat: now,
      nbf: now,
      exp: now + 60,
    });
    expect(Object.keys(dispatchPayload)).toHaveLength(17);

    const callbackPayload = chatCallbackClaims.parse({
      v: 1,
      workflow: chatWorkflowVersion,
      purpose: "validate",
      iss: "sop-n8n",
      aud: "sop-app",
      method: "POST",
      path: `/api/internal/chat/${jobId}/validate`,
      jobId,
      conversationId,
      requestKey,
      attemptId,
      attemptNumber: 1,
      dispatchNonce,
      executionId: "exec-s11-1",
      jti: `${attemptId}:exec-s11-1:validate`,
      iat: now,
      nbf: now,
      exp: now + 30,
    });
    const token = await signDispatch(callbackPayload, keys.privateKey);
    const verified = await verifyChatCallback(token, keys.publicKey);
    expect(verified.purpose).toBe("validate");
    expect(verified.jobId).toBe(jobId);

    // Reject expired or overlong TTL callback JWTs
    const overlongToken = await signDispatch({ ...callbackPayload, exp: now + 120 }, keys.privateKey);
    await expect(verifyChatCallback(overlongToken, keys.publicKey)).rejects.toThrow(AuthFailure);

    // Input schema bounds
    expect(
      sendChatMessageInput.safeParse({
        requestKey: randomUUID(),
        question: "   ",
      }).success,
    ).toBe(false);
    expect(
      sendChatMessageInput.safeParse({
        requestKey: randomUUID(),
        question: "What are the sterilization steps?",
        extra: "forbidden",
      }).success,
    ).toBe(false);

    // Dispatch config
    expect(chatDispatchEnabled({ CHAT_DISPATCH_ENABLED: "1" })).toBe(true);
    expect(
      chatDispatchEnabled({ CHAT_DISPATCH_ENABLED: "1", NEXT_PHASE: "phase-production-build" }),
    ).toBe(false);
    expect(chatDispatchUrl({ CHAT_DISPATCH_URL: "http://n8n:5678/webhook/sop-s11-chat-v1" })).toBe(
      "http://n8n:5678/webhook/sop-s11-chat-v1",
    );
    expect(() =>
      chatDispatchUrl({ CHAT_DISPATCH_URL: "http://n8n:5678/webhook/wrong-path" }),
    ).toThrow();
  });

  it("validates S17 conversation cursor codec, rename bounds, CSRF mutation guards, and client helpers (C7)", async () => {
    const convId = randomUUID();
    const microTimestamp = "2026-11-28T04:15:30.123456Z";
    const encoded = encodeConversationCursor({ updatedAt: microTimestamp, id: convId });
    expect(decodeConversationCursor(encoded)).toEqual({ updatedAt: microTimestamp, id: convId });

    // Malformed / tampered / calendar-rollover cursors must fail closed to null (QA-S17-01)
    expect(decodeConversationCursor("")).toBeNull();
    expect(decodeConversationCursor("not-valid-json")).toBeNull();
    expect(decodeConversationCursor("a".repeat(300))).toBeNull();
    expect(decodeConversationCursor("abc+def/=")).toBeNull();
    expect(
      decodeConversationCursor(
        Buffer.from(JSON.stringify({ updatedAt: "not-a-date", id: convId })).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeConversationCursor(
        Buffer.from(
          JSON.stringify({ updatedAt: "2026-02-31T00:00:00.000000Z", id: convId }),
        ).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeConversationCursor(
        Buffer.from(JSON.stringify({ updatedAt: "0000-01-01T00:00:00Z", id: convId })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeConversationCursor(
        Buffer.from(
          JSON.stringify({ updatedAt: microTimestamp, id: convId, extra: true }),
        ).toString("base64url"),
      ),
    ).toBeNull();

    // Rename schema bounds & control-character rejection (SEC-S17-02)
    expect(renameChatConversationInput.safeParse({ title: "  Valve calibration  " })).toMatchObject({
      success: true,
      data: { title: "Valve calibration" },
    });
    expect(renameChatConversationInput.safeParse({ title: "   " }).success).toBe(false);
    expect(renameChatConversationInput.safeParse({ title: "x".repeat(121) }).success).toBe(false);
    expect(renameChatConversationInput.safeParse({ title: "sop\u0000null" }).success).toBe(false);
    expect(renameChatConversationInput.safeParse({ title: "sop\u001besc" }).success).toBe(false);
    expect(
      renameChatConversationInput.safeParse({ title: "Valid", ownerId: "forged" }).success,
    ).toBe(false);
    expect(chatControlCharacterPattern.test("sop\u0000search")).toBe(true);
    expect(chatControlCharacterPattern.test("sop\u001bsearch")).toBe(true);
    expect(chatControlCharacterPattern.test("SOP-101 Valve Check")).toBe(false);

    // Cross-origin PATCH / DELETE rejected before touching database (CSRF guard)
    const previousAuthBaseUrl = process.env.AUTH_BASE_URL;
    const previousAuthSecret = process.env.AUTH_SECRET;
    process.env.AUTH_BASE_URL = "http://127.0.0.1:3000";
    process.env.AUTH_SECRET = "s17-unit-synthetic-secret-value-at-least-32-chars";
    try {
      const crossOriginPatch = await handleRenameChatConversation(
        new Request(`http://127.0.0.1:3000/api/chat/conversations/${convId}`, {
          method: "PATCH",
          headers: {
            Host: "127.0.0.1:3000",
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: "Hijacked" }),
        }),
        convId,
      );
      expect(crossOriginPatch.status).toBe(403);

      const nonJsonPatch = await handleRenameChatConversation(
        new Request(`http://127.0.0.1:3000/api/chat/conversations/${convId}`, {
          method: "PATCH",
          headers: {
            Host: "127.0.0.1:3000",
            Origin: "http://127.0.0.1:3000",
            "Content-Type": "text/plain",
          },
          body: "plain text",
        }),
        convId,
      );
      expect(nonJsonPatch.status).toBe(415);

      const crossOriginDelete = await handleArchiveChatConversation(
        new Request(`http://127.0.0.1:3000/api/chat/conversations/${convId}`, {
          method: "DELETE",
          headers: {
            Host: "127.0.0.1:3000",
            Origin: "https://evil.example",
          },
        }),
        convId,
      );
      expect(crossOriginDelete.status).toBe(403);

      const nonJsonDelete = await handleArchiveChatConversation(
        new Request(`http://127.0.0.1:3000/api/chat/conversations/${convId}`, {
          method: "DELETE",
          headers: {
            Host: "127.0.0.1:3000",
            Origin: "http://127.0.0.1:3000",
            "Content-Type": "text/plain",
          },
        }),
        convId,
      );
      expect(nonJsonDelete.status).toBe(415);

      await expect(
        readBoundedJsonBody(
          new Request(`http://127.0.0.1:3000/api/chat/conversations/${convId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x".repeat(chatApiBounds.maximumBodyBytes + 100) }),
          }),
          renameChatConversationInput,
          chatApiBounds.maximumBodyBytes,
        ),
      ).rejects.toMatchObject({ code: "INVALID_BODY", status: 413 });
    } finally {
      if (previousAuthBaseUrl === undefined) delete process.env.AUTH_BASE_URL;
      else process.env.AUTH_BASE_URL = previousAuthBaseUrl;
      if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousAuthSecret;
    }

    // Client schemas & helpers
    const summary = {
      id: convId,
      title: "SOP-101 Valve Check",
      createdAt: "2026-11-28T04:00:00.000Z",
      updatedAt: "2026-11-28T04:15:30.123Z",
    };
    expect(
      conversationListSchema.parse({ conversations: [summary], nextCursor: encoded }).nextCursor,
    ).toBe(encoded);
    expect(conversationRenameSchema.parse({ conversation: summary }).conversation.id).toBe(convId);
    expect(
      conversationArchiveSchema.parse({
        archived: true,
        conversationId: convId,
        archivedAt: "2026-11-28T04:20:00.000Z",
      }).archived,
    ).toBe(true);
    expect(
      conversationDetailSchema.parse({
        conversation: summary,
        messages: [],
        activeJobId: null,
      }).activeJobId,
    ).toBeNull();

    const originalFetch = globalThis.fetch;
    try {
      const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/chat/conversations?")) {
          return Response.json({ conversations: [summary], nextCursor: encoded });
        }
        if (init?.method === "PATCH") {
          return Response.json({ conversation: { ...summary, title: "Updated Title" } });
        }
        if (init?.method === "DELETE") {
          return Response.json({
            archived: true,
            conversationId: convId,
            archivedAt: "2026-11-28T04:20:00.000Z",
          });
        }
        return new Response(null, { status: 404 });
      });
      globalThis.fetch = fetchSpy;

      const listRes = await fetchConversations({ limit: 10, cursor: encoded, query: "Valve" });
      expect(listRes.conversations).toHaveLength(1);
      expect(listRes.nextCursor).toBe(encoded);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("limit=10");
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("q=Valve");

      const renamed = await renameConversation(convId, "Updated Title");
      expect(renamed.title).toBe("Updated Title");

      const archived = await archiveConversation(convId);
      expect(archived.conversationId).toBe(convId);

      // 401 maps to UNAUTHENTICATED
      globalThis.fetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
      await expect(fetchConversations()).rejects.toThrow("UNAUTHENTICATED");
      await expect(renameConversation(convId, "X")).rejects.toThrow("UNAUTHENTICATED");
      await expect(archiveConversation(convId)).rejects.toThrow("UNAUTHENTICATED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
