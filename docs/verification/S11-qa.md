# S11 QA verification report — safe chat SSE and persisted current-session conversation

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S11 — Safe chat SSE and persisted current-session conversation (`C1`–`C5`, `ADR 08/18/19/20`, Phase 3) |
| Candidate / branch | `03ac8adc8413cd272052815df17a87083fdc06cc` (tree `4e44589608a0b6380c3126054680f1b683701462`) on `codex/s11-chat-sse` (base `07c9a3e6d248e8f90950a4c6a93d36d68bd5173c`) |
| Owners / verifiers | Implementers: `principal-devops-engineer` (`n8n/s11-chat.v1.json`, `infra/n8n/bootstrap.mjs`, Compose, workflow contract tests) + `principal-fullstack-engineer` (`0007` migration, backend SSE/internal stages, `/chat` UI + `SafeMarkdown`, docs, unit/DB/E2E tests); QA Pass 1 (`validate-rag` + security preflight): `qa` |
| Versions / environment | Drizzle migration `0007_chat_conversations.sql`; Windows 11 host, Node >=24, Next.js 16.4.6 (`webpack`), Vitest 5.1.1; local Docker runtime unavailable (`test:db`, `test:browser`, hosted CI, and `security-expert` deferred per 23 Nov 2026 instruction) |
| Date / overall result | 24 November 2026 — **Pass 1 PASS** (with minor test clock determinism `Q-S11-1` fixed in `03ac8ad`; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, `test:browser`, hosted CI, and `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **n8n Queue Mode workflow & Compose (`n8n/s11-chat.v1.json`, `infra/n8n/bootstrap.mjs`, `docker-compose.yml`, `infra/storage-fixture/compose.yml`, `tests/workflows/chat-contract.ts`, `tests/unit/chat-workflow.test.ts`):** 17-claim RS256 dispatch policy, staged RS256 callbacks (`claim` -> `retrieve` -> `generate` -> `validate`, plus `continueErrorOutput` -> `fail`) with empty `{}` bodies (zero SOP passages/drafts in n8n/Redis), `terminal === true` short-circuits, `followRedirects: false`, and bootstrap/Compose registration.
- **Database migration (`drizzle/0007_chat_conversations.sql`, `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json`, `src/server/db/schema.ts`):** `chat_conversations`, `chat_messages` (`UNIQUE (owner_id, request_key, role)`, `CHECK`s blocking unvalidated drafts & enforcing exact `No SOP found for this question` on `NO_EVIDENCE`, trigger `enforce_chat_message_owner`), `chat_message_sources` (trigger `enforce_chat_message_source_passed`, survives `sop_chunks` cleanup), `chat_turn_artifacts` (private server-only staging deleted on commit/fail/reconcile), extended `workflow_jobs`/`workflow_events`, and least-privilege `sop_runtime` grants (`REVOKE UPDATE` on messages/sources; zero `sop_n8n` access).
- **Safe SSE, internal callbacks & UI (`src/server/jobs/*`, `src/server/chat/*`, `src/app/api/chat/**`, `src/app/api/internal/chat/**`, `src/app/chat/page.tsx`, `src/components/chat/*`, `src/components/auth/session-status.tsx`, `tests/{unit,integration,e2e}/chat.*`):** Versioned allowlisted SSE (`v: 1`, `accepted`/`retrieving`/`reranking`/`generating`/`validating` progress only before deterministic + judge + live source + live account checks pass, `Last-Event-ID` cursor, `65_536`B backpressure, `stream_timeout`, live `ACTIVE` source recheck on emit), XSS-safe `SafeMarkdown` (no `dangerouslySetInnerHTML`), current-session persistence (`?c=`/`sessionStorage`, no P1 C7 reopen sidebar), `<= 3` menus, and separate `data-first-progress-ms`/`data-first-answer-ms`/`data-completed-ms` attributes.

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| n8n bootstrap syntax & Compose config | `node --check infra/n8n/bootstrap.mjs` + `docker compose -f docker-compose.yml -f infra/storage-fixture/compose.yml config --quiet` | **PASS** | Both exit `0`; `sop-s11-chat-v1` and env vars valid | Static config validation only |
| ESLint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` (exit `0`) | Static only |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` (exit `0`) | Static only |
| Unit & workflow-contract suite | `npm.cmd test` | **PASS** | `23/23` files, `119/119` tests (`chat.test.ts` `7/7`, `chat-workflow.test.ts` `4/4`, `answer-benchmark.test.ts` `50/50`) | Mocked/synthetic providers; no live PG/browser |
| Production build | `node ./node_modules/next/dist/bin/next build --webpack` | **PASS** | All 9 S11 API routes + `/chat` built cleanly (exit `0`) | No runtime smoke |
| Cross-boundary audit (n8n ↔ Next.js, `0007` DDL/grants, byte-level SSE, UI/E2E) | Line-by-line review of `s11-chat.v1.json`, `0007_chat_conversations.sql`, `stream.ts`, `service.ts`, `safe-markdown.tsx`, `chat.test.ts`, `chat.spec.ts` | **PASS (static)** | 17-claim RS256 dispatch & 5 callback stages match verbatim; `chat_turn_artifacts` never queried by SSE; mid-flight delete/deactivation withholds answer; existing E2E selectors unaffected | Live PG (`test:db`) and Playwright (`test:browser`) deferred |
| PG `test:db`, Playwright `test:browser`, hosted CI & `security-expert` | `npm run test:db`, `npm run test:browser`, GitHub Actions, deferred Security review | **NOT RUN (deferred)** | Deferred for intermediate sprints (`S08`–`S16`) per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S11-1` | **Minor** / Test clock boundary (`tests/workflows/chat-contract.ts:92`, `tests/unit/chat-workflow.test.ts:76,86`) | `iat: payload.iat + 4` checked against live `Date.now()` inside VM could tick by >=1s under 23-worker parallel load (`payload.iat + 4 <= now + 3` becoming `true`). Added deterministic `nowMilliseconds` (`payload.iat * 1000`) to `chatIngressAccepts`. | **VERIFIED FIXED** (`119/119` unit tests PASS) |

## Residual limits & open gates

- Real PostgreSQL + pgvector (`npm run test:db`), Playwright browser E2E (`npm run test:browser`), hosted CI, Pass 2 QA closure, and deferred `security-expert` review remain mandatory before marking S11 `VERIFIED` and entering V01.
- Unchanged PRD Section 16 open gates (verified live OpenAI model IDs & balance, Product/QA scoring rubric & p50/p95 sign-off, company data privacy/residency approval) remain open in [PLANS.md](../../PLANS.md).
