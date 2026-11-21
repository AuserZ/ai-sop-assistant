# S03 private workflow jobs

Implementation contract for ADR 08/19 and D3 job infrastructure, subordinate to the approved PRD. S02 is VERIFIED. This document defines the bounded S03 proof; it does not add another requirements baseline or close the PRD's progress-bridge gate before runtime evidence exists.

Status on 20 November 2026: implementation exists; unit28/28, database30/30 and actual Queue Mode/proxy browser10/10 checks pass. Final recovery/retention, independent review and hosted CI remain open; S03 is VERIFYING. The bridge remains provisional until those required gates pass. [Actual evidence](verification/S03.md)

## Outcome and bounds

One authenticated synthetic probe travels from Next.js through a real n8n production webhook, Redis Queue Mode and a worker. Signed callbacks update durable application state. Next.js streams only safe progress and a literal synthetic completion marker through a local reverse proxy. Worker/Redis/app interruption, replay and browser disconnects must recover within measured bounds.

There is no SOP upload, model/OCR/storage call, actual RAG answer, actual LLM judge, new product menu or production deployment in S03. The probe is explicitly enabled only for local synthetic verification; later document/chat features reuse the protected job services. Synthetic checks cannot establish answer accuracy or satisfy S10/V01 model-validation gates.

## Ownership

| Owner | Files / responsibility |
| --- | --- |
| Fullstack | `src/server/jobs/**`, runtime-gated `src/instrumentation.ts`, probe/event/internal job APIs, schema and new migration 0002, job unit/database/workflow tests, `n8n/s03-probe.v1.json`, package files |
| DevOps | Compose, local secret generation, `infra/n8n/**`, `infra/proxy/**`, Docker context/build support and CI; pinned runtime/import/proxy/recovery evidence |
| Lead | This contract, plan/guides, integration, browser proof and candidate closure |
| Security / QA | Independent scope-specific inspection and actual verification; no implementation edits |

Workers coordinate exact key names, credential IDs, token claims and workflow version before overlapping edits. The existing S02 personal test account, volumes and Resend key remain intact. No additional email is authorized by S03.

## Minimal durable state

Three new application tables are sufficient for this increment:

- Jobs bind immutable owner, synthetic kind, idempotency identity/input and current state. The same row is the durable outbox: current attempt identity/number, dispatch identity/deadline, delivery counters, next retry, committed lease/fence and claimed worker execution.
- Immutable events retain the attempt and sequence plus allowlisted progress or terminal fields. They supply durable replay and bounded attempt history.
- Nonce receipts prevent callback replay through atomic uniqueness/expiry checks.

Job creation and its initial event commit atomically. Repeating an owner's identical request returns the same job; conflicting input cannot reuse that identity. Another owner cannot observe that identity, even with Admin role. Session/account checks reuse S02's current-access guards.

A bounded dispatcher runs inside the existing Next.js server through runtime-gated instrumentation. It does no provider/configuration work during builds. One tick at a time claims a small batch through PostgreSQL leases, commits before network work and uses fixed service destinations with bounded timeouts. Multiple app processes coordinate through database fencing, not process memory.

Dispatch acknowledgments update only matching dispatch fields. They cannot regress a callback's running/terminal state, including when callback arrival precedes the HTTP acknowledgment. Recovery reclaims expired dispatch leases and fences abandoned attempts. Delivery and attempt retries are independently bounded; exhausted work produces one safe failure, not an unbounded loop. A browser connection is never the scheduler.

## Signed trust boundary

Use two independent RS256 key pairs: app dispatch-private / n8n dispatch-public, and n8n callback-private / app callback-public. Static configured keys and fixed algorithms select trust; token-provided keys or remote key URLs do not. Private keys stay in protected Compose files or encrypted n8n credentials, not workflow exports or Code nodes.

All authoritative job/attempt/event fields are inside signed JWT claims. HTTP request bodies must be exactly an empty JSON object, with bounded request/header sizes. This avoids unsigned duplicate payload authority and serialization-dependent body hashes. Claims bind protocol version, direction/purpose, issuer, audience, method, exact path, job, current attempt, workflow version, freshness and nonce. Callback claim requests also reference the dispatch identity stored by the app; worker execution binding is established under a database lock.

The app verifies signature/algorithm and claim policy, then atomically checks stored job/attempt/dispatch/deadline, consumes the nonce, changes state and appends the event. Callback-provided ownership or timing cannot replace stored authority. A stale attempt/execution cannot advance a new attempt. Replayed nonces fail; a duplicate logical event with a fresh valid nonce is harmless.

n8n's built-in Webhook verifies the fixed credential's signature/algorithm and exposes verified `jwtPayload`; it does not enforce every application claim. Explicit fail-closed workflow gates and the backend claim transaction enforce purpose/audience/issuer/time/identity. Do not use Webhook's `Only Run If` as authorization: the pinned implementation continues after expression errors. Keep workflow error-continuation disabled. Built-in JWT signing uses encrypted credentials, so Code-node environment/file access can remain blocked.

The exact token field names and route DTOs are established by implementation/tests, without weakening these checks. Do not claim native verification of unsupported header fields such as `kid`; a uniquely pinned key and explicit claim policy define the scope. No credential rotation framework or generic user-controlled workflow dispatcher is included.

## Provisional progress bridge

The spike uses signed callbacks, durable PostgreSQL events and bounded Next.js polling. Compared with Redis pub/sub, this avoids a second application broker client and subscribe/catch-up races while retaining restart replay. It adds a bounded database polling cost and visibility delay. Keep the design provisional until actual Queue Mode, proxy bytes, interruption and stream tests pass; observed limits may require revision.

SSE reads only stored safe DTOs. Worker strings, exception bodies, draft answers, tokens, URLs and arbitrary metadata never reach stream serialization. The synthetic terminal marker is emitted only after ordered, explicit synthetic checks; it is labeled as a probe result and never as a real SOP answer or independent LLM-judge result.

Every release rechecks current owner, active account and live session. Resume cursors include job identity and sequence, so malformed, foreign-job and future cursors can be rejected. Pull-based flow and finite batches bound buffering; disconnect/cancel removes stream timers without canceling or duplicating durable work. Timeout/provider/database failures produce safe closure, not fabricated progress. Reconnect replays authorized durable events and preserves a single terminal outcome.

## Runtime proof

The proposed runtime uses pinned n8n main/one worker, authenticated private Redis, the existing separate n8n database and an unbuffered local proxy. The proxy owns loopback port 3000; Next.js stays internal at port 3000, preserving the canonical auth origin. Production TLS and deployment approval remain later gates. n8n editor/webhooks, Redis and PostgreSQL have no host port binding.

Main and worker share a stable encryption key. A trusted one-shot preparation step imports credential values from private temporary files into encrypted n8n persistence, imports/publishes the secret-free workflow and removes temporary plaintext. Fresh instance owner/project initialization and exact-version CLI behavior require real proof; configuration validity alone is insufficient. No direct mutation of n8n internal tables is authorized as a shortcut.

Minimize success/error/manual/progress execution saving, disable optional external telemetry and enable pruning. Inspect actual queue/wait/log/database behavior: settings alone do not prove absence of retained bearer data. No Code, Wait, provider or binary node is needed for the initial graph. Future nodes require a separate security review appropriate to their data.

Required evidence before VERIFIED:

1. Actual Queue Mode worker execution and working private imports/publication; no inline/main execution assumption.
2. Concurrent request idempotency and nonce replay; wrong key/direction/algorithm/time/claims/body; stale attempt, execution and cross-job denial; no early-ack regression.
3. Worker pause/restart, Redis interruption and app interruption recover durable owned jobs within bounded retries, with stale-attempt fencing.
4. Anonymous/foreign-owner and revoked/deactivated sessions cannot receive later stream data; actual proxy-captured bytes exclude injected draft/content/URL fields and premature terminal markers.
5. Slow reader/backpressure, disconnect, reconnect/cursor and timeout paths preserve bounded state and one durable terminal result.
6. Private ports/mounts, n8n app-database denial, stable key recovery, secret-free workflow exports, execution pruning and sanitized logs are checked against the actual candidate.
7. Existing S02 tests plus actual lint/types/unit/database/browser/workflow and hosted CI pass. No skipped required check is relabeled PASS.

## Primary references

- [n8n Queue Mode](https://docs.n8n.io/hosting/scaling/queue-mode/) describes main/Redis/worker responsibilities and shared encryption-key requirements.
- [JWT node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.jwt/) and [JWT credentials](https://docs.n8n.io/integrations/builtin/credentials/jwt/) document credential-backed signing/verification; algorithm must be explicitly pinned.
- [Pinned Webhook verification](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/nodes-base/nodes/Webhook/utils.ts#L322) and [Only Run If behavior](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/nodes-base/nodes/Webhook/Webhook.node.ts#L291) were inspected by the security reviewer.
- [Next.js instrumentation](https://nextjs.org/docs/app/guides/instrumentation) defines the server-instance lifecycle hook; the implementation must keep startup bounded and build-time configuration absent.
