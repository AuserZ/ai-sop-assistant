# n8n workflow guide

Authority: [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), sections 3, 6–10, 12–14. `n8n/` is reserved for future version-controlled workflow JSON. No workflows are exported or deployable yet.

## Orchestration boundary

Run n8n main and workers in Redis Queue Mode, separate from the Next.js modular monolith. Keep editor/webhooks restricted and internal calls authenticated. n8n operational persistence has a separate database/schema and credentials. Protect and recover the same `N8N_ENCRYPTION_KEY` alongside that database.

Next.js owns user/role authorization, account status, document activation and deletion eligibility, authorized private-file access, chat ownership/persistence and browser SSE. Workers orchestrate extraction, OCR, chunking, embedding, retrieval, ranking, generation and validation. Give workers only scoped extraction/chunk/job database privileges; workflow success cannot approve a document or bypass backend final checks.

Use job/document/request/trace IDs and short-lived authorized file references in payloads. Never queue full document binaries in Redis or retain them in routine execution logs. Minimize/prune execution data and redact passages, prompts, signed links, credentials and raw provider errors.

## Planned workflow responsibilities

| Responsibility | Expected behavior / failure handling |
| --- | --- |
| Ingestion | Fetch authorized object; native extraction; necessary OCR; isolated DOCX preview; provenance-preserving normalization/chunking; embeddings; authenticated status callback |
| Retrieval and answer validation | Fresh verified ACTIVE semantic+keyword queries, RRF, known-ID reranking, evidence-only generation, deterministic checks, independent judge; checked terminal result |
| Cleanup/reconciliation | Backend has already removed eligibility; retry physical chunks/objects cleanup, reconcile stale jobs and avoid stale callbacks reviving deleted content |

The table describes responsibilities, not a chosen number of JSON workflows or fixed names. Establish exact workflow boundaries and versioned contracts during implementation. Provider/model operations must use verified project access; synthetic mocks are the default for CI.

## Contract and retry rules

Requests and callbacks require signed authentication, timestamp/nonce freshness, replay protection, and schema validation. Correlate job/stage/request identities, validate current state, and make duplicate deliveries harmless. Use bounded transient retries/backoff; permanent format/quality failures become FAILED with safe Admin diagnostics. Do not retry indefinitely or create duplicate active chunks.

PostgreSQL stores durable job state. Reconcile after worker/Redis restart. File references expire; renew only through backend-authorized access to the intended object. Validate object references to prevent SSRF or arbitrary bucket access. Reject deleted/stale-snapshot work before changing eligible state.

## Browser progress and S11 chat workflow (`sop-s11-chat-v1`)

Queue Mode bridges to Next.js via RS256-signed dispatch (`POST /webhook/sop-s11-chat-v1`, exact 17 claims, `workflow: "s11-chat-v1"`, `exp - iat <= 60s`, body `{}`) and staged internal callbacks (`POST /api/internal/chat/{jobId}/{claim,retrieve,generate,validate,fail}`, `iss: "sop-n8n"`, `aud: "sop-app"`, nonce replay protection in `app.workflow_nonce_receipts`, body `{}`). Each callback returns `200 { ok: true, terminal: boolean }` so n8n stops cleanly on `no_evidence` or terminal failure.

Only allowlisted progress metadata (`accepted`, `retrieving`, `reranking`, `generating`, `validating`) crosses to the browser before validation. Next.js never forwards arbitrary node output, exception bodies, draft answers, or token deltas; unvalidated drafts live strictly in server-only `app.chat_turn_artifacts` and are deleted immediately on terminal commit, failure, or reconciliation. Next.js rechecks live account status and live ACTIVE source eligibility before emitting `completed`, persists final messages idempotently via `UNIQUE (owner_id, request_key, role)`, and emits exact `No SOP found for this question` on insufficient/revoked evidence or a distinct static safe error on provider/validation failure.

## Export and verification

Commit reviewed JSON under `n8n/` after workflows exist. Remove credentials, embedded secrets, environment-specific signed references and real execution/document samples. Record workflow/pipeline versions with evaluation and deployment artifacts. Verify credential references can be bound securely in the target environment rather than committing credential values.

Contract tests with mocked providers must cover authenticated/replayed callbacks, duplicate jobs, native/OCR/mixed-page paths, OCR/conversion failure, bounded retries, unknown rerank IDs, source revocation, judge uncertainty/failure, malformed provider output and zero prevalidation answer leakage. Test against actual exported JSON and the pinned runtime; do not claim workflow validation when only a diagram exists.
