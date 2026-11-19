# API contract guide

Authority: [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), sections 7–10. S01 implements health endpoints. S02 implements the allowlisted authentication, current-account and invitation endpoints documented in [authentication](authentication.md). The document/chat/user-directory endpoints and SSE events below remain proposals.

## Browser-facing boundary

Next.js owns authentication, current-account checks, RBAC, ownership, input validation, safe errors, source signing, and browser SSE. Browser calls never expose n8n endpoints or secrets. Backend-authorized direct object uploads are the file-byte transport exception; authorization/finalization remain backend operations.

| Proposed endpoint | Access | Expected behavior |
| --- | --- | --- |
| `/api/auth/*` | Implemented allowlist in the authentication guide | Better Auth credentials/session; no open registration |
| `GET /api/documents` | Active Admin/Staff | Admin lifecycle listing; Staff ACTIVE-only; title search |
| `POST /api/documents/upload-init` | Admin | Validate metadata, issue short-lived private upload authorization |
| `POST /api/documents/{id}/process` | Admin | Finalize actual object integrity and acknowledge an idempotent asynchronous job |
| `GET /api/documents/{id}` | Admin/Staff | Authorized metadata; Staff only ACTIVE |
| `GET /api/documents/{id}/source` | Admin/Staff | Reauthorize role/status and resolve original access; no permanent public URL |
| `POST /api/documents/{id}/verify` | Admin | Approve/reject the exact successful processed revision |
| `DELETE /api/documents/{id}` | Admin | Commit tombstone/eligibility removal, then schedule cleanup |
| `POST /api/chat/messages` | Admin/Staff + conversation owner | Backend-owned SSE progress and checked terminal outcome |
| `GET /api/chat/conversations` | Owner | Proposed saved-conversation access; past reopening is C7/P1 |
| `GET /api/users` | Admin | User directory |
| `POST /api/users/invite` | Admin; implemented in S02 | Expiring, single-use, intended-email-and-role invitation; live sender gate remains open |
| `PATCH /api/users/{id}` | Admin | Role/status changes with deactivation safeguards |

Choose exact DTOs, versioning, response codes, pagination, and safe errors during implementation; do not silently present these examples as final decisions. Validate incoming metadata, callback payloads, and model outputs with Zod. Require effective deactivation on protected operations and rate-limit login, invites, upload, chat, and access-token issuance.

## Answer and SSE semantics

Proposed answer kinds are `supported`, `no_evidence`, and `service_error`. A supported result carries checked text plus document/chunk identity, SOP title, genuine section/page mapping. The backend resolves source access. A no-evidence result has exactly `No SOP found for this question` and an empty sources list. Provider downtime, rate limit, timeout, internal failure, or broken orchestration yields a distinct safe service error.

| Proposed SSE event | Allowed content |
| --- | --- |
| `accepted` | Request/conversation IDs |
| `retrieving`, `reranking`, `generating`, `validating` | Allowlisted stage metadata reflecting actual execution |
| `completed` | Only a deterministically checked and independently judged answer, message/source IDs, timings |
| `no_evidence` | Exact fallback and no sources |
| `failed` | Safe stable error code and retryability |

These names/fields are illustrative. A versioned wire schema, event ordering/replay rules, request idempotency, disconnect/backpressure/timeouts, and reconnect behavior require implementation and contract tests. Never forward arbitrary workflow strings or generated token deltas. Recheck user/source eligibility at final release; prevent duplicate terminal persistence on retry.

## Private n8n boundary

Proposed ingestion request: job/document/pipeline/trace IDs with short-lived authorized file-read references. Proposed callback: authenticated stage/state, issue/page counts, and safe failure/completion metadata, idempotent by job/stage identity. No full file binary in the Redis job payload.

Proposed chat request: request/conversation IDs, normalized question, bounded history, and backend-derived authorization scope. Proposed result: checked answer/fallback/error, actual source IDs, timings/usage. Next.js retains final authorization and durable persistence.

Require private networking plus signed request/callback authentication, timestamps/nonces and replay protection. Define exact signing/envelope/retry semantics during implementation. Treat a callback as untrusted until authenticated and schema-validated; it cannot approve documents, grant roles, or bypass final eligibility checks. See [n8n workflows](n8n-workflows.md).
