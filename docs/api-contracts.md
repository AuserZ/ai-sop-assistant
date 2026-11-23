# API contract guide

Authority: [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), sections 7–10. S01 implements health endpoints. S02 implements the allowlisted authentication, current-account and invitation endpoints documented in [authentication](authentication.md). The document/chat/user-directory endpoints and SSE events below remain proposals.

## Browser-facing boundary

Next.js owns authentication, current-account checks, RBAC, ownership, input validation, safe errors, source signing, and browser SSE. Browser calls never expose n8n endpoints or secrets. Backend-authorized direct object uploads are the file-byte transport exception; authorization/finalization remain backend operations.

| Proposed endpoint | Access | Expected behavior |
| --- | --- | --- |
| `/api/auth/*` | Implemented allowlist in the authentication guide | Better Auth credentials/session; no open registration |
| `GET /api/documents` | Active Admin/Staff; implemented in S07 | Searchable SOP library (`q`, `limit`, `cursor`); Staff strictly `status = 'ACTIVE'` in SQL `WHERE` (`diagnostics: null`); Admin sees all states (`UPLOADED`, `PROCESSING`, `PENDING_VERIFICATION`, `ACTIVE`, `REJECTED`, `FAILED`) with diagnostics; `Cache-Control: private, no-store` |
| `POST /api/documents/upload-init` | Admin; implemented in S04 | Validate metadata, issue short-lived private upload authorization |
| `POST /api/documents/{id}/process` | Admin; implemented in S04/S05 | Finalize actual object integrity and acknowledge an idempotent asynchronous job |
| `GET /api/documents/{id}` | Admin (owner-scoped); implemented in S04/S06 | Upload intent and ingestion/verification status polling for the uploading Admin |
| `GET /api/documents/{id}/source` | Active Admin/Staff; implemented in S07 | Reauthorize role/account and live document status (Staff `ACTIVE`-only, non-ACTIVE/missing both `404 NOT_FOUND`), audit access without logging tokens, and issue a 60s (`sourceLinkTtlSeconds = 60`) session-bound signed link with `{ page, section }` context |
| `GET /api/documents/{id}/source/content` | Active Admin/Staff + token holder; implemented in S07 | Constant-time HMAC verification (`403 SOURCE_LINK_INVALID`, `410 SOURCE_LINK_EXPIRED`), live session match (`accountId`) and live DB `ACTIVE`/`sha256` recheck (`404 NOT_FOUND`), streaming original bytes with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` |
| `GET /api/documents/{id}/review`, `GET /api/documents/{id}/preview`, `POST /api/documents/{id}/verify`, `POST /api/documents/{id}/reprocess` | Admin; implemented in S06 | Assisted verification workspace, same-origin PDF/derivative preview, atomic revision-bound approval/rejection, and controlled reprocessing |
| `DELETE /api/documents/{id}` | Admin | Commit tombstone/eligibility removal, then schedule cleanup |
| `POST /api/chat/messages` | Admin/Staff + conversation owner | Backend-owned SSE progress and checked terminal outcome |
| `GET /api/chat/conversations` | Owner | Proposed saved-conversation access; past reopening is C7/P1 |
| `GET /api/users` | Admin | User directory |
| `POST /api/users/invite` | Admin; implemented in S02 | Expiring, single-use, intended-email-and-role invitation; one authorized live delivery/acceptance/sign-in verified |
| `PATCH /api/users/{id}` | Admin | Role/status changes with deactivation safeguards |

Choose exact DTOs, versioning, response codes, pagination, and safe errors during implementation; do not silently present these examples as final decisions. Validate incoming metadata, callback payloads, and model outputs with Zod. Require effective deactivation on protected operations and rate-limit login, invites, upload, chat, and access-token issuance.

### S07 SOP library and signed original source access contract

- `GET /api/documents` accepts strict query parameters `q` (optional trimmed substring, ≤100 chars, no control chars, `%`/`_`/`\` escaped for PostgreSQL `ILIKE ... ESCAPE '\'`), `limit` (1–50, default 25), and opaque base64url keyset `cursor` (`(created_at desc, id desc)` with microsecond timestamp fidelity). List rows never expose object storage keys (`originalKey`, `previewKey`), `sha256`, or signed URLs.
- `GET /api/documents/{id}/source` accepts strict query parameters `disposition` (`"inline" | "attachment"`, default `"inline"`), optional `page` (1–5000), and optional `section` (trimmed 1–200 chars, no control chars). It derives a dedicated 32-byte HMAC-SHA256 signing key via `crypto.hkdfSync("sha256", AUTH_SECRET, "", "ai-sop-assistant:document-source-link:v1", 32)`, issues a v1 token bound to `{ documentId, accountId, role, statusAtIssue, sha256, disposition, page, section, iat, exp }` with `sourceLinkTtlSeconds = 60`, returns `{ source: { documentId, title, fileName, mimeType, disposition, url, expiresAt, ttlSeconds: 60, context: { page, section } } }`, and records `document.source_authorized` in `app.audit_events` without logging the token or URL.
- **Residual bearer/access window:** The signed token is valid for at most 60 seconds (`sourceLinkTtlSeconds = 60`), is bound to the issuing account (`accountId`) and document `sha256`, and `GET /api/documents/{id}/source/content` re-verifies both the live session/account state (`requireCurrentAccount` + DB `FOR SHARE` lock) and the live `app.sop_documents` row (`status = 'ACTIVE'` for non-Admin, matching `sha256`) before reading storage bytes. Consequently, account deactivation, session revocation, cross-user token replay, or document status transition away from `ACTIVE` revokes access immediately before content delivery begins; the only residual window is an already in-flight HTTP response stream after headers and bytes have begun transmitting.

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
