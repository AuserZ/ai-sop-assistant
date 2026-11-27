# Pre-V01 Pass 2 QA Closure Report (`S08`–`S16`)

## Candidate and verified runs

| Field | Recorded value |
| --- | --- |
| Scope | Pre-V01 Security + Runtime CI + Pass 2 QA closure across `S08`–`S16` (`D4`, `C1`–`C5`, `U1`–`U4`, `ADR 08/09/10/12/13/14/15/16/18/19/20/23`, PRD §§3–14 & 16) |
| Branch / candidate commit | `codex/pre-v01-security-ci-closure` @ `61ababf676e224bff7387062ecafdf8032fb7db9` |
| Tree SHA | `aed0d3fda5d512eccfcd0296c404f07957d93cf7` |
| Hosted CI run (`61ababf`) | [`46019256848`](https://github.com/AuserZ/ai-sop-assistant/actions/runs/46019256848) — **`success`** (`changes` success, `foundation` success all 19 steps incl. `verify-db` 13 PG18 suites / 89 tests, Playwright `test:browser` 9 specs / 22 tests, `verify-workflow-runtime.mjs`, `verify-redirects.mjs`; `backup-drill` success all 11 steps incl. PG18/Node24 ABI, `sop_backup` encrypted dump, `escrow-keys.mjs` create/verify/recover + `cmp -s`, isolated PG18 `run-restore.mjs`, restored `n8n-main` boot; `paddleocr` skipped — unchanged from run [`46017116217`](https://github.com/AuserZ/ai-sop-assistant/actions/runs/46017116217) where `paddleocr` passed 9/9) |
| Security re-review | [S08-S16-security.md](S08-S16-security.md) — **PASS (`7/7` findings CLOSED, `0` new findings)** |
| Pass 2 QA verifier | Independent `qa` subagent (read-only audit; `0` blocking/major/minor defects) |
| Date | 27 November 2026 |

## Executed checks (local + hosted CI)

| Check | Result | Evidence |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged |
| `node scripts/verify-hardening.mjs` | **PASS** | `10` manifests checked, `0` violations |
| `node scripts/security-scan-artifacts.mjs` | **PASS** | `249` files scanned incl. `.next/static`, `0` findings |
| `npm audit --omit=dev --audit-level=high` | **PASS** | `0` high/critical prod vulns (`4` moderate dev-chain `esbuild` `GHSA-67mh-4wv8-2f99` via `drizzle-kit` remain transparently tracked) |
| `npm run lint` & `npm run typecheck` | **PASS** | `0` warnings, `0` errors |
| `npm test` (unit + Tier A RAG benchmark) | **PASS** | `30/30` files, `199/199` tests; Tier A synthetic benchmark **`50/50`** (`34/34` `100%` valid citations, `0` invented steps, `16/16` exact `"No SOP found for this question"`) |
| Infra tests (`local-secrets`, `storage-fixture`) | **PASS** | `1/1` + `8/8` pass |
| Disposable PG 18 + pgvector `test:db` | **PASS** | `13/13` suites, `89/89` tests (local Docker + CI `46019256848`), incl. `sop_backup` `42501` privilege enforcement and `SEC-S12-01` invite concurrency |
| Full-stack Playwright `test:browser` | **PASS** | `9` specs / `22/22` tests (local Docker + CI `46019256848`), incl. 20 MB upload boundary under tightened `SEC-S14-01` CSP, byte-level SSE safety, 3-menu/320px responsive journeys |
| Workflow runtime & redirect checks | **PASS** | `verify-workflow-runtime.mjs` + `verify-redirects.mjs` green in CI `46019256848` |
| Isolated PG 18 DR backup/escrow/restore drill | **PASS** | `backup-drill` green locally (`1.43s` dump, `8.81s` restore, `n8n-main` boot `exit 0`) and in CI `46019256848` (`11/11` steps) |

## Real defects caught & closed during Pre-V01 closure (`c3754c7..61ababf`)

- `SEC-S16-01`, `SEC-S15-01`, `SEC-S12-01`, `SEC-S14-01`, `SEC-S16-02`, `SEC-S14-02`, `SEC-S09-01`: all `7/7` closed and re-verified PASS by `security-expert`.
- `drizzle/0007_chat_conversations.sql`: restored `TG_OP = 'UPDATE'`, 9 immutable identity columns, and `0003` `document_ingestion` source binding inside `app.keep_workflow_job_identity()` *(informational note: existing local dev DB volumes migrated on pre-`725823d` `0007` need a volume reset or one-time `CREATE OR REPLACE FUNCTION` because Drizzle does not re-run edited applied migrations)*.
- `src/server/chat/service.ts`: replaced raw `Date` SQL interpolation with Drizzle `lte(chatMessages.createdAt, userMessage.createdAt)`.
- `src/server/answers/generator.ts`: per-line `sanitizePassageText` preserving numbered-step and Markdown pipe-table `\n` boundaries.
- `src/server/retrieval/rewrite.ts`: `isLikelyFollowUpQuestion` preventing unrelated self-contained questions from inheriting prior-turn SOP anchors.
- `.dockerignore`, `.github/workflows/ci.yml` (`backup-drill`), `src/app/api/users/**` relative imports, integration/E2E test isolation (`seed.ts` per-suite synthetic accounts keeping `authLimits.signIn` `10/60s` untouched).

## Per-sprint closure verdicts (`S08`–`S16`)

| Sprint | Status after closure | Verified evidence (`61ababf` + CI `46019256848` + Security PASS) | Exact open external / live gates before `VERIFIED` / `V01` |
| --- | --- | --- | --- |
| **S08** (`D4`) | **VERIFIED** *(Phase 1 exit `S04`–`S08` complete)* | Unit `deletion.test.ts`, `storage-fixture` `DELETE`, CI `verify-db` `deletion`/`retrieval`/`answers`/`chat` delete-race tests, CI Playwright `deletion.spec.ts` + 20 MB `documents.spec.ts`, Security PASS | None blocking S08 (approved backup retention vs live deletion policy remains PRD §16 / S15 / V01). |
| **S09** (`C2`, `ADR 10/23`) | **IMPLEMENTED** *(CI + Security + QA PASS; external gate open)* | Unit `retrieval.test.ts` (`17/17`), `benchmark-dataset.test.ts`, CI `verify-db` dual-branch PG/pgvector ACTIVE-only + races, `SEC-S09-01` closed, Security PASS | Live OpenAI reranker & rewrite model IDs (no silent ADR 23 substitute), API balance/entitlement, and live-provider compatibility check (`text-embedding-3-small` verified 22 Nov). |
| **S10** (`C2`–`C5`, `ADR 12`) | **IMPLEMENTED** *(CI + Security + QA PASS; external gate open)* | Unit `answers.test.ts` (`15/15`), Tier A synthetic benchmark `50/50` (`100%` valid citations, `0` invented steps), CI `verify-db` `answers.test.ts`, `SEC-S09-01` closed, Security PASS | Live OpenAI answer & judge model IDs/entitlement, Product/QA scoring rubric & p50/p95 sign-off, and **Tier B live-model 50-question golden benchmark**. |
| **S11** (`C1`–`C5`, `ADR 18/19`) | **VERIFIED** *(runtime/SSE/persistence scope; live-model recheck in S09/S10 & V01)* | Unit `chat`/`chat-workflow`, CI `verify-db` `chat.test.ts`, CI Playwright `chat.spec.ts` (byte-level SSE safety through Next.js+nginx+n8n, citations, exact fallback, separate timing attrs), `verify-workflow-runtime.mjs`, `verify-redirects.mjs`, Security PASS | Live OpenAI end-to-end chat & p50/p95 latency recheck gated under **S09/S10 & V01**. |
| **S12** (`U1`–`U4`) | **VERIFIED** | Unit `users`/`auth`, CI `verify-db` `users.test.ts` (incl. `SEC-S12-01` concurrency & live deactivation revoking session/SSE/chat/60s source), CI Playwright `users.spec.ts`, Security PASS | Launch/V01 gates only: production account recovery runbook & Resend sender-domain operational readiness (`U5`/`U6` deferred). |
| **S13** (`C1/D1/D5/U1/U4`, `ADR 20`) | **VERIFIED** *(runtime/UI scope; live-model recheck in V01)* | Unit `shell.test.ts`, CI Playwright all 9 specs incl. `s13-experience.spec.ts` (`1280×800` + `320×667`, keyboard, strictly 3 Admin / 2 Staff menus, RBAC, XSS sanitization, SSE/citations/session persistence), Security PASS | Full live-provider end-to-end recheck runs in **V01**. |
| **S14** (`ADR 13/15`, PRD §§12–14) | **IMPLEMENTED** *(CI + Security + QA PASS; load/policy gates open)* | `verify-hardening` (`10` manifests), `security-scan-artifacts` (`249` files), `npm audit --omit=dev`, unit `ops-hardening`/`observability`/`security-adversarial`, CI `verify-db` `hardening.test.ts`, live `read_only: true` `app`/`migrate`, `SEC-S14-01`/`SEC-S14-02` closed, Security PASS | Real target-VPS load test (`scripts/load-benchmark.mjs`) validating `20 MB` / `4 vCPU / 8 GB` / worker & OCR concurrency; PRD §16 retention (90-day audit proposed), Admin MFA, and company privacy/residency/no-training approvals; `4` moderate dev-chain `esbuild` advisories tracked. |
| **S15** (`ADR 16`, PRD §13) | **IMPLEMENTED** *(CI + Security + QA PASS; offsite/policy gates open)* | Unit `backup-recovery` (`20/20`), `SEC-S15-01` (`sop_backup` read-only role proven live in CI `database.test.ts`), CI `backup-drill` (`46019256848`) live PG18/Node24 ABI + encrypted dump + escrow create/verify/recover + isolated PG18 restore + restored `n8n-main`, Security PASS | Live offsite R2 backup bucket/upload/download & failure-alert webhook verification; full restored-stack `drill.mjs` smoke run (`app`/`proxy`/`n8n-worker` + R2 object access + synthetic auth/upload/verify/retrieval/chat checks); approved backup retention (30-day provisional) & protected key-escrow custody. |
| **S16** (`ADR 09/14`, PRD §§14/16) | **IMPLEMENTED** *(CI + Security + QA PASS; live rehearsal/owners open)* | Unit `deploy-rollback` (`16/16`), `verify-hardening`, release + backup Compose config green in CI `46019256848`, `SEC-S16-01`/`SEC-S16-02` closed, Security PASS | Live GHCR digest-pinned build/manifest run via `deploy.yml`; configured GitHub `production` environment manual-approval reviewers; live non-prod VPS deploy + checked-answer SSE smoke + rollback rehearsal; named Launch/Rollback/Support/Pilot owners replacing `TBD` in `docs/deployment.md`. |
