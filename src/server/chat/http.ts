import type { ZodType } from "zod";
import { requireCurrentAccount } from "../auth/authorization";
import { authErrorResponse, AuthFailure } from "../auth/errors";
import { maximumAuthBodyBytes, requireMutationOrigin } from "../auth/http";
import { consumeRateLimit } from "../auth/rate-limit";
import { getDatabase } from "../db/client";
import { chatDispatchEnabled } from "../jobs/config";
import type { ChatCallbackPurpose } from "../jobs/contracts";
import { dispatchChatJobs } from "../jobs/dispatch";
import type { JobDatabase } from "../jobs/service";
import { verifyChatCallback } from "../jobs/signatures";
import {
  chatApiBounds,
  chatEmptyStageBody,
  chatIdInput,
  chatRateLimits,
  sendChatMessageInput,
} from "./contracts";
import {
  claimChatStage,
  createChatTurn,
  failChatStage,
  generateChatStage,
  getOwnedConversation,
  listOwnedConversations,
  retrieveChatStage,
  validateChatStage,
  type ChatStageOptions,
} from "./service";
import { createChatEventStream } from "./stream";

export async function readBoundedJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  maximumBytes: number,
): Promise<T> {
  const statedSize = request.headers.get("content-length");
  if (statedSize && (!/^\d+$/.test(statedSize) || Number(statedSize) > maximumBytes)) {
    throw new AuthFailure("INVALID_BODY", 413);
  }
  if (!request.body) throw new AuthFailure("INVALID_INPUT", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
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

function acceptsEventStream(request: Request): boolean {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/event-stream");
}

export async function handlePostChatMessage(
  request: Request,
  options: { database?: JobDatabase; dispatchNow?: boolean } = {},
) {
  try {
    requireMutationOrigin(request);
    const database = options.database ?? getDatabase();
    const account = await requireCurrentAccount(request.headers, database);
    await consumeRateLimit("chat:send", account.id, chatRateLimits.send, database);

    const body = await readBoundedJsonBody(
      request,
      sendChatMessageInput,
      chatApiBounds.maximumBodyBytes,
    );
    const created = await createChatTurn(account, body, { database });

    if ((options.dispatchNow ?? true) && chatDispatchEnabled()) {
      void dispatchChatJobs(database).catch(() => undefined);
    }

    if (acceptsEventStream(request)) {
      return await createChatEventStream(request, created.jobId, { account, database });
    }

    return Response.json(
      {
        conversationId: created.conversationId,
        jobId: created.jobId,
        requestId: created.requestId,
        messageId: created.messageId,
        streamUrl: created.streamUrl,
      },
      {
        status: 202,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleGetChatJobEvents(
  request: Request,
  jobId: string,
  options: { database?: JobDatabase } = {},
) {
  try {
    const database = options.database ?? getDatabase();
    const account = await requireCurrentAccount(request.headers, database);
    await consumeRateLimit("chat:stream", account.id, chatRateLimits.stream, database);
    return await createChatEventStream(request, jobId, { account, database });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleListChatConversations(
  request: Request,
  options: { database?: JobDatabase } = {},
) {
  try {
    const database = options.database ?? getDatabase();
    const account = await requireCurrentAccount(request.headers, database);
    await consumeRateLimit("chat:read", account.id, chatRateLimits.read, database);

    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    let limit: number = chatApiBounds.defaultConversationListLimit;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) throw new AuthFailure("INVALID_INPUT", 400);
      limit = Number(rawLimit);
      if (limit < 1 || limit > chatApiBounds.maximumConversationListLimit) {
        throw new AuthFailure("INVALID_INPUT", 400);
      }
    }

    const result = await listOwnedConversations(account, { database, limit });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleGetChatConversation(
  request: Request,
  conversationId: string,
  options: { database?: JobDatabase } = {},
) {
  try {
    const database = options.database ?? getDatabase();
    const account = await requireCurrentAccount(request.headers, database);
    await consumeRateLimit("chat:read", account.id, chatRateLimits.read, database);

    const detail = await getOwnedConversation(account, conversationId, database);
    return Response.json(detail, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleInternalChatStage(
  request: Request,
  jobId: string,
  stage: ChatCallbackPurpose,
  options: ChatStageOptions = {},
) {
  try {
    if (!chatIdInput.safeParse(jobId).success) throw new AuthFailure("NOT_FOUND", 404);
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      throw new AuthFailure("INVALID_CONTENT_TYPE", 415);
    }

    await readBoundedJsonBody(request, chatEmptyStageBody, maximumAuthBodyBytes);

    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthFailure("INVALID_WORKFLOW_SIGNATURE", 401);
    }

    const claims = await verifyChatCallback(authorization.slice(7));
    const expectedPath = `/api/internal/chat/${jobId}/${stage}`;
    const parsedUrl = new URL(request.url);
    if (
      claims.jobId !== jobId ||
      claims.purpose !== stage ||
      claims.path !== expectedPath ||
      parsedUrl.pathname !== expectedPath ||
      parsedUrl.search ||
      request.method !== claims.method
    ) {
      throw new AuthFailure("INVALID_WORKFLOW_BINDING", 403);
    }

    const stageOptions: ChatStageOptions = { ...options, signal: request.signal };
    let result: unknown;
    switch (stage) {
      case "claim":
        result = await claimChatStage(claims, stageOptions);
        break;
      case "retrieve":
        result = await retrieveChatStage(claims, stageOptions);
        break;
      case "generate":
        result = await generateChatStage(claims, stageOptions);
        break;
      case "validate":
        result = await validateChatStage(claims, stageOptions);
        break;
      case "fail":
        result = await failChatStage(claims, stageOptions);
        break;
    }

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
