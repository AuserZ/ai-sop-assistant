# S06 independent QA (working-tree checkpoint)

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S06 Assisted verification and atomic activation; D3, ADR 17, ADR 20/21 |
| Branch / base HEAD | `codex/s06-assisted-verification` @ `cbabecd50d40a5f45caa2c76bd66f7f42412a579` (uncommitted S06 working tree) |
| Working-tree S06 manifest | 25 modified/added files (excluding `docs/verification/`); ordered JSON SHA-256 `e4fd3beba92540089ddd47eeec4ae64dd1b3f9a08b9199b43de6430911de0fcd` |
| QA ownership / environment | Independent `qa`; read-only source/test audit and local host Node checks on Windows PowerShell (`Node v26.13.0`, `npm.cmd`). Only this report written; zero edits to implementation, migration, infra, CI, or test code. Docker Desktop pipe unavailable in sandbox — no Docker, `next build`, PostgreSQL/pgvector, n8n, or Playwright executed locally. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **FAIL / BLOCKED for S06 closure** — local static & unit checks pass (61/61 x2, 0 flakes), but source/assertion audit found **1 HIGH** stale-snapshot approval bypass across reprocessing (`Q-S06-1`), **2 MODERATE** defects/gaps (`Q-S06-2` neutralized PDF zoom via `max-w-full`, `Q-S06-3` missing worker-JWT/DOCX/ACTIVE-race test coverage), and **1 LOW** cluster (`Q-S06-4`). `npm run build`, PostgreSQL `0005` migration/`verify-db`, Playwright `verification.spec.ts` (including PDF.js worker loading in Next.js 16 standalone), and hosted CI remain **NOT RUN**. |

## Requirement-to-check matrix (`PLANS.md` S06)

| S06 acceptance criterion | Inspected implementation & tests | Local QA status | Runtime / CI gap |
| --- | --- | --- | --- |
| 1. Admin can approve a valid snapshot and reject questionable text; Staff/worker approval attempts fail (D3, ADR 17) | `drizzle/0005_assisted_verification.sql` (`enforce_sop_verification_record`, `enforce_sop_document_activation`), `src/server/verification/{contracts,http,service}.ts`, `src/app/api/documents/[id]/{review,preview,verify,reprocess}/route.ts`, `tests/unit/verification.test.ts`, `tests/integration/verification.test.ts`, `tests/e2e/verification.spec.ts` | **PARTIAL** — Unit contract/error checks PASS (3/3); DB triggers/service enforce active Admin + explicit confirmation + rejection notes. Missing integration test for worker Bearer JWT hitting `/verify`, Staff HTTP `/verify` in DB suite, and ingestion `complete`/`extract` hitting an `ACTIVE` document (`Q-S06-3`). | PostgreSQL `0005` migration + `tests/integration/verification.test.ts` + Playwright `verification.spec.ts` **NOT RUN**. |
| 2. Stale hash/job/snapshot, empty chunks, incomplete processing and concurrent changed-state approvals are rejected (ADR 17) | `src/server/verification/service.ts:243-305`, `drizzle/0005_assisted_verification.sql:81-174`, `tests/integration/verification.test.ts:323-412` | **FAIL (`Q-S06-1`)** — Because `reprocessDocument()` reuses the same `workflow_jobs.id`, `(expectedSha256, expectedJobId, expectedPipelineVersion)` remains identical after reprocessing completes; a stale pre-reprocess browser approval succeeds and activates the unseen reprocessed snapshot. Empty chunks, missing embeddings, hash/job/pipeline mismatch, and concurrent approve/reject are covered in source/DB tests. | PostgreSQL `verification.test.ts` **NOT RUN**. |
| 3. Reprocessing requires renewed verification; ACTIVE originals cannot be mutated in place. Replacement remains D6/P1 (D3, ADR 17) | `drizzle/0005_assisted_verification.sql:86-88`, `src/server/verification/service.ts:403-504`, `src/server/documents/service.ts:218`, `src/server/ingestion/service.ts:124,143,209,312,674,698`, `tests/integration/verification.test.ts:236-321,521-547` | **FAIL (`Q-S06-1`)** — `ACTIVE` immutability trigger (`IF OLD.status = 'ACTIVE' THEN RAISE`), append-only `sop_verification_records` grants (`REVOKE UPDATE, DELETE`), and reprocess reset to `UPLOADED` are solid in source, but `Q-S06-1` allows an unrefreshed pre-reprocess approval to activate a newly reprocessed snapshot once it reaches `PENDING_VERIFICATION`. | PostgreSQL trigger/grant tests (`verification.test.ts` + `documents.test.ts` + `ingestion.test.ts` regressions) **NOT RUN**. |
| 4. Review panels show real data/mappings and audit entries; approval and state updates commit consistently or roll back together (ADR 17/20/21) | `src/components/verification/{client.ts,pdf-preview.tsx,review-workspace.tsx}`, `src/app/documents/[id]/verify/page.tsx`, `src/components/documents/upload-panel.tsx`, `src/server/verification/service.ts:330-400`, `tests/integration/verification.test.ts:345-360`, `tests/e2e/verification.spec.ts` | **FAIL (`Q-S06-2`, `Q-S06-4`)** — Single-transaction commit/rollback hook is properly wired in `verifyDocument()`, and real pages/chunks/issues/history render cleanly with numeric/unit & search highlights. However, `<canvas className="... max-w-full">` neutralizes "Zoom in" visually (`Q-S06-2`), DOCX derivative preview & multi-page UI are untested (`Q-S06-3`), DOCX reprocess preview URL does not refresh (`Q-S06-4`), and PDF.js worker bundling in Next.js 16 standalone is unproven locally. | `npm run build`, PostgreSQL rollback test, and Playwright `verification.spec.ts` **NOT RUN**. |

## Executed local commands and results

| Command | Result | Observed details |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` (before & after) | **PASS** | Both protected PRDs unchanged (`exit 0`). |
| `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` exited `0` (0 warnings). |
| `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` exited `0` (includes `pdfjs-dist@6.5.438` types & 4 new API routes). |
| `npm.cmd test` (Run 1, default parallel workers) | **PASS** | **15/15 files, 61/61 tests** passed in `12.43s` (`tests/unit/verification.test.ts` 3/3 in `28ms`; 0 flakes). |
| `npm.cmd test` (Run 2, back-to-back default parallel workers) | **PASS** | **15/15 files, 61/61 tests** passed in `9.62s` (`tests/unit/verification.test.ts` 3/3 in `28ms`; 0 flakes). |
| `node --test infra/n8n/local-secrets.test.mjs` | **PASS** | 1/1 passed (`1448ms`). |
| `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` | **PASS** | 7/7 passed (`480ms`). |
| `node infra/conversion/verify.mjs` | **PASS (static only)** | 3 static checks passed (`dockerChecksExecuted: false`). |
| `npm.cmd run build`, Docker Compose, fresh `0005` migration, `verify-db` (`tests/integration/*`), Playwright (`tests/e2e/*`), hosted CI | **NOT RUN** | Docker Desktop pipe blocked in QA sandbox; mandatory on the exact committed candidate before closing S06. |

## Defects and coverage gaps

### Q-S06-1 — HIGH: Stale pre-reprocess approval bypasses snapshot binding because `reprocessDocument()` reuses `workflow_jobs.id`

- **Location:** `src/server/verification/contracts.ts:13-22`, `src/server/verification/service.ts:252-258, 306-319, 448-488`, `src/components/verification/review-workspace.tsx:236-244`.
- **Reproducible scenario:**
  1. Document `D` completes ingestion (`job.id = J`, `attemptId = A1`, `sha256 = H`, `pipelineVersion = "document-ingestion-v1"`, `status = "PENDING_VERIFICATION"`).
  2. Admin A loads `/documents/D/verify`; client state holds `{ expectedSha256: H, expectedJobId: J, expectedPipelineVersion: "document-ingestion-v1" }`.
  3. Admin B triggers `POST /api/documents/D/reprocess`. `reprocessDocument()` (`service.ts:448-469`) updates the existing `workflow_jobs` row in place (`where(eq(workflowJobs.id, job.id))`), keeping `job.id = J` while rotating `attemptId = A2`, deleting old pages/chunks/issues, and re-running ingestion to `PENDING_VERIFICATION` (potentially producing different OCR text or issues).
  4. Admin A — without refreshing, still viewing the superseded extraction — submits `APPROVE` with `{ expectedSha256: H, expectedJobId: J, expectedPipelineVersion: "document-ingestion-v1" }`.
  5. `verifyDocument()` (`service.ts:252-258`) checks only `sha256`, `processedJobId`, and `processedPipelineVersion` — all three still match! And `resolvedIssueIds` (`service.ts:307-319`) silently updates 0 rows if old issue IDs no longer exist. Approval returns `200` and activates the unseen reprocessed snapshot.
- **Impact:** Violates S06 Acceptance Criteria #2 (*"Stale hash/job/snapshot ... approvals are rejected"*) and #3 (*"Reprocessing requires renewed verification"*).
- **Minimal fix:** Bind verification to a snapshot token that rotates on every reprocess/completion (e.g., expose `snapshotAttemptId` from `workflow_jobs.attemptId` — already rotated in `reprocessDocument()` at `service.ts:454` — or a deterministic chunk-snapshot digest / `expectedUpdatedAt`) in `ReviewDocumentDto` and `verifyDocumentInput`, verify exact match in `verifyDocument()` (`409 VERIFICATION_STALE_SNAPSHOT`), and reject unknown `resolvedIssueIds` (`409 VERIFICATION_STALE_SNAPSHOT`). Add a PostgreSQL integration test proving a pre-reprocess approval payload fails with `409` after reprocess completes.

### Q-S06-2 — MODERATE: PDF preview "Zoom in" is visually neutralized by `max-w-full` on `<canvas>`

- **Location:** `src/components/verification/pdf-preview.tsx:126-129, 233-238`; `tests/e2e/verification.spec.ts:67-70`.
- **Observation:** `PdfPreview` renders `<canvas className="mx-auto block max-w-full bg-white shadow-sm">` inside an `overflow-auto` scroll container. Because standard PDF pages (`612px` wide at `100%`) already exceed a ~`550px` half-width desktop review column or `320px` mobile viewport, `max-w-full` clamps CSS width to container width even at `100%`. Clicking **"Zoom in"** (`125%`, `150%`, `200%`) renders a larger backing buffer (`canvas.width`), but `max-w-full` clamps its displayed CSS width right back to the container width — producing zero visual enlargement and zero horizontal panning inside `overflow-auto`. `tests/e2e/verification.spec.ts:67-70` only asserts the `"125%"` label, not actual rendered canvas dimensions.
- **Minimal fix:** Remove `max-w-full` from `<canvas>` inside the `min-w-0 overflow-auto` container (explicitly sizing or letting intrinsic `canvas.width`/`canvas.height` scale inside the scroll box without overflowing the page document width), and assert in `verification.spec.ts` that `canvas.getBoundingClientRect().width` increases on "Zoom in" and restores on "Reset zoom".

### Q-S06-3 — MODERATE: Missing test coverage for worker approval rejection, DOCX preview, `ACTIVE` ingestion callbacks, and Staff HTTP `/verify` in DB suite

- **Location:** `tests/integration/verification.test.ts:241-244, 414-493`; `tests/e2e/verification.spec.ts:21-126`.
- **Gaps:**
  1. **Worker approval attempt (S06 criterion #1):** No integration test posts a signed n8n callback Bearer JWT to `POST /api/documents/[id]/verify` (verifying `401 UNAUTHENTICATED`) or checks `sop_n8n` DB denial against `sop_documents`/`sop_verification_records`.
  2. **Ingestion guards on `ACTIVE` docs:** `verification.test.ts:241` calls `claimIngestionStage` on a `COMPLETED` job, which rejects on `job.state !== "QUEUED"` (`ingestion/service.ts:201`) before reaching the new `doc.status === "ACTIVE"` guards in `claimIngestionStage` (`:209`), `extractIngestionStage` (`:312`), or `completeIngestionStage` (`:674`).
  3. **Staff HTTP `/verify` in DB suite:** `verification.test.ts:462-492` checks Staff HTTP `403` on `review`, `preview`, and `reprocess`, omitting HTTP `POST /verify` (covered only in E2E and service call).
  4. **DOCX derivative preview & multi-page / flagged-issue UI:** Neither `verification.test.ts` nor `verification.spec.ts` exercises `readDocumentPreview` on a DOCX `previewKey` (or `404 PREVIEW_NOT_AVAILABLE`), the DOCX derivative notice banner, multi-page `Next page`/`Previous page` navigation, flagged-issue checkbox resolution via UI, or `320px` reflow while `PENDING_VERIFICATION` (with full decision controls visible).

### Q-S06-4 — LOW: PDF.js worker standalone bundling gate, DOCX reprocess preview staleness, minor UI/a11y notes, and comment hygiene

- **PDF.js worker in Next.js 16 standalone (`src/components/verification/pdf-preview.tsx:68-71`, `Dockerfile:19-20`):** `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()` with `pdfjs-dist@6.5.438` and Next.js `16.4.6` standalone (`output: "standalone"`) is unverified locally (`npm run build` and Docker/Playwright NOT RUN). Must be proven in hosted CI build + Playwright (`canvas.width > 0 && height > 0`, `pageErrors === []`).
- **DOCX reprocess preview staleness (`pdf-preview.tsx:50-110`, `review-workspace.tsx:390`):** `PdfPreview` reloads only when `previewUrl` changes. After reprocessing a DOCX, `/api/documents/${doc.id}/preview` stays the same URL string, so the stale in-memory PDF stays displayed until a full reload unless keyed on snapshot/revision (`processedJobId`/`updatedAt`).
- **Issue jump vs search filter & a11y (`review-workspace.tsx:339-340, 450-459, 476-604`):** Clicking `"Page N"` on a flagged issue while `searchQuery` filters out page N jumps the PDF preview to page N while keeping the text panel on `filteredPages[0]`. Issue `"Page N"` jump buttons (`line 452`) omit `min-h-11` touch-target sizing, and `role="tab"`/`role="tabpanel"` omit `id`/`aria-controls`/`aria-labelledby`.
- **`antislop-code` hygiene:** Production files (`src/server/verification/*`, `src/components/verification/*`) are clean (1 concise regex intent comment in `contracts.ts:132`, 0 TODOs). `tests/integration/verification.test.ts` has 10 brief case-header comments (acceptable; minor trim optional).

## Remaining gates required before closing S06

1. Fix `Q-S06-1` (rotate/bind snapshot identity such as `expectedAttemptId` + reject unknown `resolvedIssueIds`), `Q-S06-2` (remove `max-w-full` zoom neutralization + assert rendered width change), and `Q-S06-3` (worker-JWT `/verify` denial, Staff HTTP `/verify` in DB suite, DOCX preview & `PREVIEW_NOT_AVAILABLE`, multi-page/flagged-issue/PENDING-320px UI coverage), plus `Q-S06-4` polish in scope.
2. Re-run `npm run check:prd`, `npm run lint`, `npm run typecheck`, `npm test` (x2), and infra tests on the committed candidate.
3. Execute full hosted CI (`paddleocr` + `foundation` jobs) on the exact committed SHA:
   - `npm run build` (confirming Next.js 16 standalone compiles and emits the `pdfjs-dist` worker cleanly)
   - Fresh `0000`–`0005` migrations + `verify-db` (`tests/integration/verification.test.ts` + all S01–S05 DB regressions, including `documents.test.ts:307` and `ingestion.test.ts:573,602` compatibility with `0005`)
   - Playwright `npm run test:browser` (`tests/e2e/verification.spec.ts` proving real PDF.js rendering, zoom, reject/reprocess/approve flow, audit history, 320px reflow, and Staff denial + S02–S05 E2E regressions)
   - `verify-workflow-runtime.mjs`, `verify-redirects.mjs`, `verify-native.mjs`, `conversion/verify.mjs --docker`, and `paddleocr/verify.mjs`
4. Complete independent S06 security review and independent QA re-verification of fixes + exact-SHA hosted CI evidence.
5. Keep all PRD section 16 external gates open (real SOPs, production deployment, D6/P1 replacement remains out of scope).


---

## S06 independent QA re-verification (`2da02bb`, pre-CI completion checkpoint)

### Candidate and verdict

| Field | Recorded value |
| --- | --- |
| Committed candidate | `2da02bbb63b1a5ed157489bbe9bd8d8b21d51969` on `codex/s06-assisted-verification` |
| Commit tree | `62f8c2863fc3074f7e958615a7d3efa8f5d793d2` |
| Hosted CI run | `45117819835` (in progress at this checkpoint — final CI closure check pending completion) |
| Environment | Windows PowerShell, Node `v26.13.0`, `npm.cmd`. Docker Desktop pipe blocked locally — no local `next build`, PostgreSQL/pgvector, n8n, or Playwright execution. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **LOCAL STATIC & UNIT QA PASS on `2da02bb` — FINAL S06 CLOSURE REMAINS GATED ON HOSTED CI RUN `45117819835`.** All `Q-S06-1`..`Q-S06-4` remediations are independently confirmed in committed source and local checks (61/61 unit tests PASS ×2, 0 flakes). |

### Per-finding re-verification status (`2da02bb`)

| Finding | Status | Verified evidence & remaining gate |
| --- | --- | --- |
| `Q-S06-1` (HIGH: stale pre-reprocess approval bypass via reused `job.id`) | **RESOLVED IN SOURCE (UNIT PASS; DB IN CI `45117819835`)** | `drizzle/0005_assisted_verification.sql` adds `processed_attempt_id` & `active_attempt_id` on `sop_documents`, `attempt_id` on `sop_verification_records`, binds exact `attempt_id` in `sop_documents_activation_binding` CHECK and both DB triggers (`enforce_sop_verification_record`, `enforce_sop_document_activation`), and grants `sop_runtime` column updates. `src/server/ingestion/service.ts:695` writes `processedAttemptId: job.attemptId`. `src/server/verification/{contracts,service}.ts` & `review-workspace.tsx` require `expectedAttemptId` and reject stale `attemptId` or unknown/stale `resolvedIssueIds` (`matchedIssues.total !== uniqueResolvedIds.length` -> `409 VERIFICATION_STALE_SNAPSHOT`). Covered in `tests/unit/verification.test.ts:19,35-36` (PASS) and `tests/integration/verification.test.ts:322-442` (pending CI `verify-db`). |
| `Q-S06-2` (MODERATE: `<canvas max-w-full>` neutralizing PDF zoom) | **RESOLVED IN SOURCE (E2E IN CI `45117819835`)** | `src/components/verification/pdf-preview.tsx:237` removed `max-w-full` on `<canvas>` inside the `min-w-0 overflow-auto` scroll container. `tests/e2e/verification.spec.ts:79-87` measures rendered `canvas.boundingBox().width` before and after clicking `"Zoom in"`, asserting strict width growth. |
| `Q-S06-3` (MODERATE: missing worker-JWT, Staff HTTP `/verify`, `ACTIVE` ingestion callbacks, DOCX preview, and UI coverage) | **RESOLVED IN SOURCE (DB/E2E IN CI `45117819835`)** | `tests/integration/verification.test.ts` adds signed n8n worker Bearer JWT on `POST /verify` -> `401` (`lines 568-588`), Staff HTTP `403` on all 4 endpoints (`review`, `preview`, `verify`, `reprocess` at `lines 613-656`), `extractIngestionStage`/`completeIngestionStage` on `ACTIVE` doc -> `409 DOCUMENT_ALREADY_ACTIVE` (`lines 290-319`), DOCX `readDocumentPreview` + `404 PREVIEW_NOT_AVAILABLE` (`lines 234-241`), and `UPDATE`/`DELETE` on `ACTIVE` `sop_chunks`/`sop_extraction_pages` -> `23514` (`prevent_active_snapshot_mutation()` trigger in `0005:187-205`, tested at `lines 704-715`). `tests/e2e/verification.spec.ts` adds `320px` reflow checks in both `PENDING_VERIFICATION` (`lines 95-97`) and `ACTIVE` (`lines 121-123`) states, plus rich DOCX derivative banner, canvas render, flagged-issue checkbox, `"Page 1"` jump, activation, and Staff `403` (`lines 125-171`). *Minor preserved limit:* Multi-page `Next page`/`Previous page` clicking is not exercised by single-page E2E fixtures. |
| `Q-S06-4` (LOW: DOCX preview cache staleness, jump/a11y polish, PDF.js standalone gate, `antislop-code`) | **RESOLVED IN SOURCE (STANDALONE BUILD/E2E IN CI `45117819835`)** | `service.ts:142,170` appends cache-busting `?v=${encodeURIComponent(previewVersion)}` (`processedAttemptId ?? updatedAt`) to `previewUrl` and bounds `storage.read` with `documentBounds.storageTimeoutMilliseconds` (`line 225`). `review-workspace.tsx:457-462` gives flagged-issue `"Page N"` buttons `min-h-11` and clears `searchQuery` on jump; `lines 492-605` wire `id`/`aria-controls`/`aria-labelledby` on tabs and tabpanels. `antislop-code` clean: 1 concise regex comment in prod code (`contracts.ts:136`), 4 concise comments in `verification.test.ts` (`lines 289,390,407,567`). Next.js 16 standalone `pdfjs-dist` worker emission/loading awaits hosted CI run `45117819835`. |

### Executed local commands on `2da02bb`

| Command | Result | Observed details |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` (before & after) | **PASS** | Both protected PRDs unchanged (`exit 0`). |
| `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` exited `0` (0 warnings). |
| `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` exited `0`. |
| `npm.cmd test` (Run 1, default parallel workers) | **PASS** | **15/15 files, 61/61 tests** passed in `15.82s` (`verification.test.ts` 3/3 in `46ms`; 0 flakes). |
| `npm.cmd test` (Run 2, back-to-back default parallel workers) | **PASS** | **15/15 files, 61/61 tests** passed in `9.87s` (`verification.test.ts` 3/3 in `27ms`; 0 flakes). |
| Hosted CI run `45117819835` (`npm run build`, `0005` migration/`verify-db`, Playwright `verification.spec.ts` + regressions) | **IN PROGRESS / NOT YET CLOSED** | Final independent QA closure verdict will follow once run `45117819835` completes on exact `2da02bb`. |



---

## S06 final closure independent QA (`14e2d54`)

### Candidate and verdict

| Field | Recorded value |
| --- | --- |
| Sprint | S06 — Assisted verification and atomic activation (`D3`, `ADR 17`, `ADR 20/21` per `PLANS.md`) |
| Published candidate | `14e2d54cade8dfe6b357caa7a1baad6dcafdcf28` on `codex/s06-assisted-verification` |
| Commit tree | `644ee407bcfa699a36892c54d1dff7b7562e0c46` |
| Delta from re-verified `2da02bb` | 3 files (`+20 / -14`): `Dockerfile` (`+1`), `src/components/verification/pdf-preview.tsx` (`+8/-5`), `tests/e2e/verification.spec.ts` (`+11/-9`) |
| Hosted CI passing run | `45122984069` (`https://github.com/AuserZ/ai-sop-assistant/actions/runs/45122984069`) — `status = completed`, `conclusion = success`, `run_attempt = 1`, `head_sha = 14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`, `created_at = 2026-11-23T06:16:22Z`, `updated_at = 2026-11-23T06:30:23Z` |
| Hosted CI jobs | `paddleocr` (`137520801499`, `06:16:25Z`–`06:19:27Z`, **9/9 steps `success`**) + `foundation` (`137520801816`, `06:16:25Z`–`06:30:23Z`, **20/20 steps `success`**) = **29/29 steps `success`** |
| Historical failed run | `45117819835` on `2da02bbb63b1a5ed157489bbe9bd8d8b21d51969` (`foundation` job `137504580056` passed Steps 1–13 including `0005` migration/`verify-db`, failed Step 14 Playwright because Next.js 16 standalone did not serve `pdf.worker.min.mjs` via `new URL(..., import.meta.url)` and canvas render raced zoom assertion; resolved cleanly by `14e2d54`) |
| Local environment | Windows PowerShell, Node `v26.13.0`, `npm.cmd`. Docker Desktop pipe remains access-denied locally (`NOT RUN` locally; runtime/DB/Playwright verified via exact-SHA hosted CI `45122984069`). |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **Independent QA PASS for S06 at `14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`.** All `Q-S06-1`..`Q-S06-4` findings and the `45117819835` standalone worker defect are resolved, with 0 weakened assertions and 29/29 passing hosted CI steps on the exact commit. |

### Independently verified delta (`2da02bb..14e2d54`)

1. `Dockerfile` (`+1`): copies `/app/node_modules/pdfjs-dist/build/pdf.worker.min.mjs` from `dependencies` stage into `./public/pdf.worker.min.mjs` with `--chown=node:node` so the Next.js standalone image serves the exact pinned PDF.js worker statically without bundler URL emission failure.
2. `src/components/verification/pdf-preview.tsx` (`+8/-5`): sets `pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"`, records `renderedState` (`{ page, zoom }`) only after `await task.promise` resolves, and exposes `data-rendered-page` and `data-rendered-zoom` on `<canvas>`.
3. `tests/e2e/verification.spec.ts` (`+11/-9`): checks `reviewLink.isVisible()` before clicking `"Refresh status"` (avoids race when already settled), asserts `GET /pdf.worker.min.mjs` returns HTTP `200`, waits for `data-rendered-zoom="100"` and `data-rendered-zoom="125"` before measuring `canvas.boundingBox().width`, and preserves strict `zoomedWidth > initialWidth` assertion (no assertions weakened).

### Independently executed local & GitHub REST API checks on `14e2d54`

| Check / Command | Result | Observed details |
| --- | --- | --- |
| `npm.cmd run check:prd` (before & after) | **PASS** | `AI SOP Assistant — Technical Product Req.md` and `PRD AI SOP Assistant.pdf` unchanged (`exit 0`). |
| `git rev-parse HEAD` & `HEAD^{tree}` | **PASS** | `14e2d54cade8dfe6b357caa7a1baad6dcafdcf28` / `644ee407bcfa699a36892c54d1dff7b7562e0c46` on `codex/s06-assisted-verification`; clean tracked working tree. |
| `git diff 2da02bb..14e2d54` | **PASS** | Strictly 3 files (`Dockerfile`, `pdf-preview.tsx`, `verification.spec.ts`, `+20/-14`); no security/DB/assertion regressions. |
| `npm.cmd test` | **PASS** | **15/15 files, 61/61 tests** passed in `42.48s` (`tests/unit/verification.test.ts` 3/3 in `151ms`, zero flakes). |
| GitHub REST API `GET .../actions/runs/45122984069` & `/jobs` | **PASS (API metadata)** | HTTP `200`: exact `head_sha = 14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`, `conclusion = success`, `paddleocr` `137520801499` **9/9 steps `success`** (PRD integrity, CPU OCR image build, offline OCR + sandbox failure checks), `foundation` `137520801816` **20/20 steps `success`** (`check:prd`, `lint`, `typecheck`, `npm test`, `local-secrets.test.mjs`, storage-fixture tests, infra scripts + static `conversion/verify.mjs`, `npm run build`, Step 13 Compose/smoke/`verify-native.mjs`/Docker `conversion/verify.mjs`/fresh `0000`–`0005` migrations/`verify-db`, Step 14 Playwright `test:browser` including `verification.spec.ts` + S02–S05 regressions, Step 15 `verify-workflow-runtime.mjs`, Step 16 `verify-redirects.mjs`, Step 17 disposable cleanup). |
| GitHub REST API `GET .../actions/jobs/137520801816/logs` | **HTTP 403 (unauthenticated limit)** | Unauthenticated REST log download returned HTTP `403`; QA independently verified run/job/step API metadata, exact `head_sha`, timestamps, and step conclusions, while raw CI log text was not decoded. |
| Local Docker / PostgreSQL / Playwright | **NOT RUN (local sandbox blocked)** | Local Docker Desktop pipe is access-denied; covered instead by exact-SHA hosted CI run `45122984069`. |

### S06 acceptance criteria mapping (`PLANS.md`)

| S06 acceptance criterion | QA status at `14e2d54` | Corroborating evidence |
| --- | --- | --- |
| 1. Admin can approve a valid snapshot and reject questionable text; Staff/worker approval attempts fail. | **PASS** | Verified in `src/server/verification/service.ts`, `src/app/api/documents/[id]/{review,preview,verify,reprocess}/route.ts`, `tests/unit/verification.test.ts` (PASS locally & CI), `tests/integration/verification.test.ts` (Admin approve/reject, Staff HTTP `403` on all 4 endpoints, signed n8n worker Bearer JWT `401` on `POST /verify`, CI Step 13 `verify-db` `success`), and `tests/e2e/verification.spec.ts` (Admin reject -> reprocess -> approve, Staff `403`, CI Step 14 `success`). |
| 2. Stale hash/job/snapshot, empty chunks, incomplete processing and concurrent changed-state approvals are rejected. | **PASS** | Verified via `expectedAttemptId` + `processed_attempt_id`/`active_attempt_id` + `resolvedIssueIds` membership checks (`409 VERIFICATION_STALE_SNAPSHOT`), `drizzle/0005_assisted_verification.sql` CHECK constraint and triggers (`enforce_sop_verification_record`, `enforce_sop_document_activation`), row-locked concurrent approval test, empty-chunk/incomplete-processing rejection, and `Q-S06-1` pre-reprocess stale `attemptId`/`resolvedIssueIds` regression tests (unit PASS + CI Step 13 `verify-db` `success`). |
| 3. Reprocessing requires renewed verification; ACTIVE originals cannot be mutated in place. Replacement remains D6/P1. | **PASS** | Verified via `POST /reprocess` returning document to `PROCESSING`/`PENDING_VERIFICATION` under new `attemptId`, `ACTIVE` reprocess rejection (`409`), `ACTIVE` ingestion callback rejection (`409 DOCUMENT_ALREADY_ACTIVE`), DB trigger `prevent_active_snapshot_mutation()` rejecting `UPDATE`/`DELETE` on `ACTIVE` `sop_chunks`/`sop_extraction_pages` (`23514`), and no D6/P1 replacement workflow added (CI Step 13 `verify-db` + Step 14 E2E `success`). |
| 4. Review panels show real data/mappings and audit entries; approval and state updates commit consistently or roll back together. | **PASS** | Verified via real PDF.js worker (`/pdf.worker.min.mjs` HTTP `200`), canvas zoom width growth (`data-rendered-zoom` `100` -> `125`), DOCX LibreOffice derivative preview + `404 PREVIEW_NOT_AVAILABLE` fallback, cache-busted `previewUrl?v=...`, flagged-issue checkbox + `"Page 1"` jump, `320px` reflow in `PENDING_VERIFICATION` & `ACTIVE`, audit history persistence, and single-transaction atomic activation/rollback tests (CI Step 13 `verify-db` + Step 14 Playwright `success`). |

### Residual limits and preserved external gates

- **Single-page E2E fixture limit:** `tests/e2e/verification.spec.ts` uses single-page `syntheticPdf()` and `syntheticRichDocx()` fixtures (`"Page 1 of 1"` with disabled boundary controls); multi-page `Next page`/`Previous page` click transitions were not directly exercised in Playwright.
- **Unauthenticated CI log limit:** GitHub REST log download returned HTTP `403` without credentials; run/job/step API metadata (`45122984069`, exact `head_sha = 14e2d54`, 29/29 steps `success`) was independently verified, while raw CI log text was not decoded.
- **Local Docker sandbox limit:** Docker Desktop pipe is access-denied locally (`NOT RUN` locally; verified via exact-SHA hosted CI `45122984069`).
- **Distinct sign-offs & PRD section 16 gates:** Independent S06 security review (`docs/verification/S06-security.md`) and project-manager sprint closure remain distinct from this QA verdict. All PRD section 16 external gates remain open (company privacy/residency, real SOP processing approval, production OCR/language/table/file-size policy, OpenAI billing/other models, backup/object recovery, deployment/rollback approval, V01/V02); document replacement remains D6/P1.
