# S08 QA verification report — SOP deletion and reliable unindexing

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S08 — SOP deletion and reliable unindexing (`D4` with `C2`/`C3`/`D5` integrity; Phase 1 exit) |
| Candidate / branch | Working tree on `codex/s08-deletion-unindexing` (base `60dd204473c9f9b56e06d4cbbfd8f282252b5fb0`, 26 modified + 5 untracked files) |
| Owners / verifiers | Implementers: `fullstack-engineer` + `devops-engineer`; QA (including deferred security preflight/negative-boundary checks per 23 Nov 2026 instruction): `qa` |
| Versions / environment | Windows host, Node v24+, Vitest 5.1.1, Drizzle migration `0006_document_deletion.sql` (journal idx 6); local Docker unavailable (Compose/DB/Playwright verified statically in Pass 1) |
| Date / overall result | 23 November 2026 — **Pass 1 FAIL** (4 pre-push blockers found before CI) |

## Implemented changes reviewed (concise)

- **Storage fixture (DevOps):** `infra/storage-fixture/{gateway.mjs,gateway.test.mjs,verify-native.mjs}` — added server-side SigV4-only `DELETE` (denies browser `Origin` and unsigned/non-SigV4 `DELETE` with `403`) + native `DeleteObject` verification.
- **Schema & migration:** `drizzle/0006_document_deletion.sql`, `drizzle/meta/{0006_snapshot.json,_journal.json}`, `src/server/db/schema.ts` — `DELETED` tombstone columns/constraints (`sop_documents_deletion_binding`, `sop_documents_cleanup_due`), updated `app.enforce_sop_document_activation()`, new `app.block_deleted_document_artifacts()` trigger across 4 artifact tables, column-level `GRANT UPDATE` for `sop_runtime`.
- **Backend & UI:** `src/server/documents/{storage,contracts,http,service}.ts`, `src/app/api/documents/[id]/route.ts`, `src/server/verification/service.ts`, `src/server/ingestion/service.ts`, `src/server/jobs/dispatch.ts`, `src/components/documents/{client.ts,library-panel.tsx,upload-panel.tsx}`, `src/components/verification/{client.ts,review-workspace.tsx}`, `docs/{api-contracts.md,database.md}`.
- **Tests:** `tests/unit/deletion.test.ts`, `tests/integration/deletion.test.ts`, `tests/e2e/deletion.spec.ts` + `MemoryStorage.delete` adapter updates in 6 existing test files.

## Executed checks (Pass 1 — pre-push)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (`PASS`) | — |
| Lint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` exit `0` | — |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` exit `0` | — |
| Unit tests | `npm.cmd test` | **PASS** | `17/17` files, `73/73` tests passed (incl. `deletion.test.ts` 5/5) | Mocked fetch; no live DB/browser |
| Storage fixture tests & syntax | `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` + `node --check` on `gateway.mjs` & `verify-native.mjs` | **PASS** | `8/8` tests passed; both syntax checks exit `0` | Local Docker unavailable; native container test runs in CI |
| Drizzle JSON & migration audit | Static audit of `0000`–`0006`, `0006_snapshot.json`, `_journal.json`, S06 `verification.test.ts` compatibility | **PASS** (migration) / **FAIL** (DB test) | `0006` preserves `ACTIVE->UPLOADED` (`23514`) & `sha256` (`42501`); **Q-S08-3** fails in `deletion.test.ts:814` | Live Postgres runs in CI `verify-db` |
| Security preflight & negative boundaries | Audit of RBAC, CSRF `requireMutationOrigin`, Staff existence oracle, tombstone irreversibility, storage `DELETE` boundary, backup note | **FAIL** | Storage `DELETE` (`403` on `Origin`/unsigned), Staff oracle & tombstone DB triggers solid; **Q-S08-1** breaks browser & HTTP `DELETE` (`415`/`403 INVALID_ORIGIN`) | No live runtime execution in Pass 1 |
| S08 AC #1: Staff/anonymous delete fails; Admin removes eligibility immediately even if storage cleanup fails | `http.ts`, `service.ts`, `deletion.test.ts:302–529`, `deletion.spec.ts:96–133` | **FAIL** | Logic & DB purge-before-storage-delete verified; blocked by **Q-S08-1** (HTTP `DELETE` `415`/`403 INVALID_ORIGIN`) | Hosted CI not yet run |
| S08 AC #2: Duplicate deletion, cleanup retries & worker restarts converge without losing tombstone or reviving evidence | `service.ts:777–1045`, `deletion.test.ts:530–615`, `deletion.spec.ts:126` | **PASS** (code) / **NOT RUN** (CI) | Lease fencing (`FOR UPDATE SKIP LOCKED`, 45s lease, backoff cap 60s), `FAILED->PENDING` requeue, tombstone preserved | Requires CI `verify-db` + Playwright |
| S08 AC #3: Concurrent extraction/activation/source requests cannot reuse deleted snapshot; historical source unavailable | `ingestion/service.ts`, `verification/service.ts`, `jobs/dispatch.ts`, `deletion.test.ts:617–751`, `deletion.spec.ts:130–144` | **FAIL** | Service & trigger guards solid; blocked by **Q-S08-2** (`dispatchIngestionJobs` missing `destination` arg in `deletion.test.ts:725`) and **Q-S08-4** (Playwright search race) | Requires CI `verify-db` + Playwright |
| S08 AC #4: Integration checks prove deleted chunks excluded from eligible data access | `queryEligibleActiveChunks`, `resolveDocumentCitationAvailability`, `deletion.test.ts:407–460` | **PASS** (code) / **NOT RUN** (CI) | Strictly joins `status = 'ACTIVE'` + active job/pipeline/sha256; Staff gets `UNAVAILABLE` (no existence oracle) | S09/S11 will repeat through real retrieval/SSE |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & minimal fix | Rerun verdict |
| --- | --- | --- | --- |
| **Q-S08-1** | **Critical** / API CSRF & browser `DELETE` (`src/server/auth/http.ts:13`, `src/components/documents/client.ts:163`, `tests/e2e/deletion.spec.ts:96`, `tests/integration/deletion.test.ts:168,312–380`) | `requireMutationOrigin()` unconditionally requires `Host` AND `Content-Type: application/json` (`415 INVALID_CONTENT_TYPE`). Browser `requestDocument(..., "DELETE")` and `deletion.spec.ts:96` send no `Content-Type` (fail `415` in real browser/CI), and `deletion.test.ts` `signInCookie` + delete requests omit `Host` (fail `403 INVALID_ORIGIN` on line 174 before testing `401`/`403 FORBIDDEN`/`404`). **Minimal fix:** Allow bodyless `DELETE` without `Content-Type` in `requireMutationOrigin` (still enforcing `Origin`, `Host`, non-`cross-site` `Sec-Fetch-Site`, and rejecting any non-JSON `Content-Type` with `415` + unit test in `tests/unit/auth.test.ts`); add `Host: new URL(baseUrl).host` to `signInCookie` and all `handleDocumentDeleteRequest` requests in `tests/integration/deletion.test.ts`. | OPEN (Pass 1) |
| **Q-S08-2** | **Critical** / CI `verify-db` (`tests/integration/deletion.test.ts:725–731`) | Calls `dispatchIngestionJobs(database, mockFetch)` without the 4th `destination` arg; JS evaluates default `ingestionDispatchUrl()` which throws `TypeError: Invalid URL` in `verify-db` (`docker-compose.yml` sets neither `INGESTION_DISPATCH_URL` nor `WORKFLOW_DISPATCH_URL`). **Minimal fix:** Pass explicit `sign` and `destination` args (`async () => "synthetic-dispatch-jwt", "http://n8n-main:5678/webhook/sop-s05-ingestion-v1"`) and assert `expect(dispatchedUrls).toEqual([])`. | OPEN (Pass 1) |
| **Q-S08-3** | **Critical** / CI `verify-db` (`tests/integration/deletion.test.ts:814–816`) | Asserts `update app.sop_documents set title = 'Tampered'` as `sop_runtime` rejects with `23514`, but `title` has no `UPDATE` grant for `sop_runtime`, so PostgreSQL raises `42501` (`insufficient_privilege`) before the trigger runs. **Minimal fix:** Assert `42501` for `title`, and assert `23514` on a `sop_runtime`-granted column (e.g. `deleted_by` or `processing_error_code = 'TAMPERED'`). | OPEN (Pass 1) |
| **Q-S08-4** | **High** / CI Playwright race (`tests/e2e/deletion.spec.ts:85–88,105–109,138–141,148–162`) | `documentId` is already row #1 of the unfiltered `/documents` list before `Search` finishes; asserting `library-row-${documentId}` visible resolves immediately while prior specs' `Review and verify` links remain in DOM (`navLinks.length > 3` failure at `:162`) and in-flight search can overwrite optimistic `DELETED` row state at `:117`. **Minimal fix:** After each `Search` click, await `expect(page.getByTestId("library-count-status")).toHaveText(...)` (`1 SOP document shown for "${tag}".` / `0 SOP documents shown for "${tag}".`). | OPEN (Pass 1) |

## Non-blocking observations & residual limits

- **Lock-order note (non-blocking):** `deleteDocument` locks `sop_documents` then `workflow_jobs`, whereas `claimIngestionStage`/`completeIngestionStage` lock `workflow_jobs` then `sop_documents`; under simultaneous race PG aborts one transaction cleanly (`40P01`) without corrupting data.
- **Orphan preview window (non-blocking):** If a DOCX preview finishes uploading between `deleteDocument` commit and `extractIngestionStage` tx2 rollback, the preview object stays unreferenced in storage (`previewKey` never saved; `/preview` returns `404`).
- **Pass 1 limits:** Local Docker/PostgreSQL/Playwright unavailable; Pass 2 will verify the fix diff and hosted CI run (`foundation` including `verify-native.mjs`, `verify-db`, `test:browser`) in a single closure pass. See `PLANS.md` for unchanged PRD section 16 open gates.
- **Pass 1 status:** **FAIL** — fix **Q-S08-1..Q-S08-4** before pushing to CI.
