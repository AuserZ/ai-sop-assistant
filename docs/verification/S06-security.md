# S06 independent security review

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S06 assisted verification and atomic activation; D3, ADR 17, ADR 20/21 |
| Base / branch | S05 verified closure `cbabecd` (`caf0fc7`); uncommitted working copy on `codex/s06-assisted-verification` |
| Reviewed working snapshot | 25 modified/new S06 files (excluding this report); SHA-256 manifest `76a8c521a7c50772de27560426e546f4c2c3c281488c639e4e6a3a954b77b1a0` |
| Key reviewed files (SHA-256) | `drizzle/0005_assisted_verification.sql` (`bae4b426...`), `src/server/db/schema.ts` (`e9607d78...`), `src/server/verification/contracts.ts` (`dda80658...`), `src/server/verification/service.ts` (`d84dd7ad...`), `src/server/verification/http.ts` (`f425c824...`), `src/server/documents/service.ts` (`127a16e2...`), `src/server/ingestion/service.ts` (`95134dcb...`), `src/components/verification/pdf-preview.tsx` (`674af789...`), `src/components/verification/review-workspace.tsx` (`6e55ef03...`), `src/components/verification/client.ts` (`bf7dda8c...`), `package.json` (`4578e028...`) |
| New dependency | `pdfjs-dist@6.5.438` (zero transitive dependencies; `sha512-vg8Pw1x+AFKy4...` in `package-lock.json`) |
| Reviewer ownership / environment | Independent `security-expert`; read-only source, SQL, lockfile, `pdfjs-dist` bundle inspection, and in-memory Node/tsx adversarial checks. Only this report created. No code/index/ref edit, no Docker/DB execution, no network/provider call, no real-key or real-SOP read. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict (source & in-memory scope) | **PASS with 3 LOW defense-in-depth recommendations** (zero CRITICAL/HIGH/MODERATE demonstrated security blockers). Runtime unit, PostgreSQL migration/`verify-db`, Playwright E2E, and exact published-candidate hosted CI remain mandatory before S06 closure; no production, real-SOP, or provider approval is granted. |

Governed by `AGENTS.md`, `AI SOP Assistant — Technical Product Req.md`, `PRD AI SOP Assistant.pdf`, `.agents/README.md`, `.agents/security-expert.md`, and `docs/security.md`. Neither protected PRD nor its integrity baseline was modified.

## Findings (ranked by impact and exploitability)

No CRITICAL, HIGH, or MODERATE vulnerability or authorization/activation bypass was demonstrated in S06. The three items below are LOW defense-in-depth and operational hardening recommendations.

### R-S06-1 — LOW (defense-in-depth): DB triggers lock `sop_documents` once `ACTIVE` but do not block `UPDATE`/`DELETE` on active `sop_chunks` or `sop_extraction_pages`

- **Location:** `drizzle/0005_assisted_verification.sql:81-185` (`bae4b426...`).
- **Affected requirement / ADR:** PRD section 5 ("Never mutate a currently ACTIVE original in place"; approved immutable snapshot), ADR 17.
- **Cause:** `enforce_sop_document_activation()` blocks any `UPDATE` on `app.sop_documents` when `OLD.status = 'ACTIVE'`, and `REVOKE UPDATE, DELETE ON TABLE app.sop_verification_records FROM sop_runtime` locks the audit log append-only. However, `sop_runtime` retains table-level `UPDATE`/`DELETE` on `app.sop_chunks` and `app.sop_extraction_pages` (via `bootstrap.sql:21-22`), with no DB-level trigger rejecting mutations to rows bound to an `ACTIVE` document's `active_job_id`.
- **Impact:** No demonstrated exploit in S06 (all application/ingestion/reprocess routes reject `status === "ACTIVE"` and require `RUNNING` jobs before deleting/inserting chunks). Adding a DB-level guard ensures even a future application bug cannot silently alter or erase active retrieval chunks while the document remains `ACTIVE`.
- **Minimal fix:** Add a `BEFORE UPDATE OR DELETE` trigger on `app.sop_chunks` and `app.sop_extraction_pages` raising `23514` if `EXISTS (SELECT 1 FROM app.sop_documents d WHERE d.id = OLD.document_id AND d.status = 'ACTIVE' AND d.active_job_id = OLD.job_id)`. (Fully compatible with S07 D4 deletion because D4 commits `status = 'DELETED'` first before async chunk cleanup.)

### R-S06-2 — LOW (defense-in-depth): `/preview` lacks a server-side storage read timeout and anti-framing/CORP headers

- **Location:** `src/server/verification/service.ts:221` (`d84dd7ad...`) and `src/server/verification/http.ts:31-40` (`f425c824...`).
- **Affected requirement / ADR:** PRD section 12 (private source access, bounded I/O), ADR 03, ADR 21.
- **Cause:**
  1. `readDocumentPreview()` passes only `request.signal` to `storage.read(target.storageKey, target.maximumBytes, signal)` without an explicit server-side timeout (unlike `finalizeDocumentUpload` in `src/server/documents/service.ts:261`, which bounds storage I/O at `documentBounds.storageTimeoutMilliseconds = 30_000`). Behind `infra/proxy/nginx.conf:26` (`proxy_read_timeout 35s`) the proxy cuts off stalled requests, but direct calls have no server timeout.
  2. `GET /api/documents/[id]/preview` sets `Content-Type: application/pdf`, `Content-Disposition: inline`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox`, but omits `X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy: same-origin`.
- **Impact:** Defense-in-depth gap only (`Content-Security-Policy: sandbox` already isolates `/preview` into an opaque origin with scripts disabled, and `SameSite` session cookies protect against cross-site embedding).
- **Minimal fix:** Pass `AbortSignal.any([signal, AbortSignal.timeout(documentBounds.storageTimeoutMilliseconds)])` to `storage.read(...)` in `readDocumentPreview()`, and add `"X-Frame-Options": "DENY"` and `"Cross-Origin-Resource-Policy": "same-origin"` to `/preview` response headers (compatible with `PdfPreview`'s same-origin `fetch` and `<a target="_blank" rel="noopener noreferrer">`).

### R-S06-3 — LOW (operational / boundary consistency): `verify` route 4 KB body cap is tighter than Zod's 200-UUID + 2,000-char contract, and `reconcileJobs` omits `ne(status, "ACTIVE")`

- **Location:** `src/server/verification/http.ts:48` vs `src/server/verification/contracts.ts:9,21`; `src/server/jobs/dispatch.ts:38,72`.
- **Affected requirement / ADR:** ADR 08, ADR 17.
- **Cause:**
  1. `handleVerificationRequest` parses `POST /verify` with `readAuthBody(request, verifyDocumentInput)` (`maximumAuthBodyBytes = 4096` in `src/server/auth/http.ts:5`), whereas `verifyDocumentInput` allows `notes` up to 2,000 characters and `resolvedIssueIds` up to 200 UUIDs (~8–16 KB JSON). This fails closed (`413 INVALID_BODY`) rather than opening a DoS vector, but an Admin resolving >~95 issues or writing long multi-byte notes will receive `413`.
  2. `reconcileJobs()` in `src/server/jobs/dispatch.ts:38,72` updates `sop_documents` on job timeout/retry without `ne(sopDocuments.status, "ACTIVE")` (unlike `src/server/ingestion/service.ts:124,143,698`). Unreachable in S06 because `ACTIVE` jobs are `COMPLETED`, but if a future multi-pipeline job ever timed out against an `ACTIVE` document, `enforce_sop_document_activation` would raise `23514` and roll back the entire `reconcileJobs` batch.
- **Minimal fix:** Either add an explicit `maxBytes` parameter (e.g., `16_384`) for `POST /verify` or lower `resolvedIssueIds` max to match the 4 KB cap; add `ne(sopDocuments.status, "ACTIVE")` to the two `sopDocuments` updates in `src/server/jobs/dispatch.ts:38,72`.

## Checks actually executed

| Check | Result / provenance | Evidence and limits |
| --- | --- | --- |
| Protected PRD integrity (`node .codex/scripts/check-prd-integrity.mjs`) | **PASS** (independent) | Both `AI SOP Assistant — Technical Product Req.md` (`12a5c10f...`) and `PRD AI SOP Assistant.pdf` (`a84d9cb7...`) pass before and after report creation. |
| SQL migration & schema audit (`drizzle/0005_assisted_verification.sql`, `src/server/db/schema.ts`) | **PASS** with `R-S06-1` (independent) | Verified CHECK constraints, append-only `REVOKE UPDATE, DELETE` on `sop_verification_records`, both triggers (`enforce_sop_verification_record`, `enforce_sop_document_activation`), column-level `GRANT UPDATE`, and `sop_n8n` isolation. Real PostgreSQL execution remains required in `verify-db`. |
| In-memory adversarial Node/tsx harness (`contracts.ts`, `service.ts`, `http.ts`) | **PASS** (independent) | Verified 14 Zod contract cases (rejects `explicitConfirmation: false`/missing, `REJECT` without/blank notes, control chars, >2000 notes, >200 UUIDs, unknown keys like `status: "ACTIVE"`, uppercase SHA); 10 mocked-DB service guards (rejects `ACTIVE`, non-`PENDING_VERIFICATION`, stale SHA/jobId, non-`COMPLETED` job, 0 chunks, invalid embeddings, reprocess on `ACTIVE`/`PROCESSING`/stale SHA); CSRF foreign `Origin` (`403`), `Sec-Fetch-Site: cross-site` (`403`), non-JSON `Content-Type` (`415`); `splitReviewHighlights` XSS preservation and linear performance (`33ms` on 55 KB repeated-digit input). |
| XSS sink scan across all 79 files in `src/` & `pdfjs-dist@6.5.438` bundle inspection | **PASS** (independent) | `0` dangerous sinks (`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `eval(`, `new Function`, `javascript:`). Verified `node_modules/pdfjs-dist@6.5.438` (0 transitive deps, `sha512` lock integrity): `isEvalSupported` removed, worker contains `0` `eval(`/`new Function` calls, `enableXfa` defaults `false`, `PdfPreview` renders `<canvas>` only without `AnnotationLayer`/`ScriptingManager` or external CDN URLs. |
| Secret & publication hygiene scan across all 25 S06 files | **PASS** (independent) | `0` secret-pattern hits (PEM, non-synthetic `sk-*`, `re_*`, JWT, `X-Amz-Signature`, `AKIA*`). Pattern scanning is bounded and does not compare against private key files (not read). |
| Unit tests, PostgreSQL migration/`verify-db`, Playwright E2E, hosted CI | **NOT RUN by security** | Mandatory runtime proof must be executed and recorded before S06 closure. |

## Reviewed controls by trust boundary

### 1. Database activation, audit & immutability (`drizzle/0005_assisted_verification.sql`)
- `sop_documents_status`, `sop_documents_activation_binding`, and `sop_documents_rejection_binding` enforce exact state-column invariants (`ACTIVE` requires matching non-null `active_job_id == processed_job_id`, `active_pipeline_version == processed_pipeline_version`, `verified_by`, `verified_at`, null `rejection_reason`; non-`ACTIVE` forbids `active_*`; `REJECTED` requires non-empty `rejection_reason`).
- `app.sop_verification_records` is append-only (`REVOKE UPDATE, DELETE ... FROM sop_runtime`), requires `before_status = 'PENDING_VERIFICATION'`, and enforces decision/status/notes invariants via CHECKs and `enforce_sop_verification_record()` (active `ADMIN` reviewer + `COMPLETED` `document_ingestion` job + matching `PENDING_VERIFICATION` document snapshot).
- `enforce_sop_document_activation()` blocks ANY `UPDATE` when `OLD.status = 'ACTIVE'`, requires `PENDING_VERIFICATION` origin, active `ADMIN`, matching `COMPLETED` job, nonempty chunks with zero null/non-1536 embeddings, and a matching `sop_verification_records` row with `r.created_at >= OLD.updated_at` (blocking reuse of stale records from prior cycles).
- Column-level `GRANT UPDATE (active_job_id, active_pipeline_version, verified_by, verified_at, rejection_reason)` preserves S04's `42501` immutability on `sha256`, `original_key`, `size_bytes`, `mime_type`, `uploaded_by`, `title`, and `file_name`.
- `sop_n8n` retains zero access to `sop_app`; n8n/internal ingestion callbacks (`src/server/ingestion/service.ts`) add defense-in-depth `status !== "ACTIVE"` checks and have zero code path to activate, reject, or insert `sop_verification_records`.

### 2. Verification APIs, RBAC, CSRF & private preview (`src/server/verification/*`, `src/app/api/documents/[id]/*`)
- All four routes (`/review`, `/preview`, `/verify`, `/reprocess`) enforce `requireCurrentAccount`, `requireRole(account, "ADMIN")`, `lockCurrentAdmin` inside DB transactions (blocking Staff `403` and deactivated/revoked Admins `401`), UUID validation, global + per-account DB rate limits, and `Cache-Control: no-store`.
- `POST /verify` and `POST /reprocess` enforce `requireMutationOrigin` (exact `Origin`, `Host`, `Sec-Fetch-Site !== "cross-site"`, `application/json`) and strict Zod schemas.
- `verifyDocument` locks `sop_documents` and `workflow_jobs` `FOR UPDATE`, binds `(expectedSha256, expectedJobId, expectedPipelineVersion)`, scopes `resolvedIssueIds` to `(documentId, jobId)` and unresolved rows, inserts `sop_verification_records` + updates `sop_extraction_pages` + `sop_documents` + `audit_events` in a single atomic transaction (rolling back cleanly on failure).
- `/review` returns only same-origin `/api/documents/<uuid>/preview` (never raw storage keys, buckets, or presigned URLs); `/preview` streams validated `%PDF-` bytes with `Content-Disposition: inline` (no untrusted filename reflection), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and `Content-Security-Policy: sandbox`.
- `reprocessDocument` blocks `ACTIVE` (`409 DOCUMENT_ALREADY_ACTIVE`) and `UPLOADED`/`PROCESSING` (`409 DOCUMENT_ALREADY_PROCESSING`), requires matching `expectedSha256`, preserves append-only `sop_verification_records`, clears prior snapshot artifacts, rotates `attemptId`/`dispatchNonce`, and requires renewed verification.

### 3. Verification UI & browser rendering (`src/components/verification/*`, `src/app/documents/[id]/verify/page.tsx`)
- Untrusted SOP titles, filenames, page text, chunk text, issue summaries, and verification notes render strictly through React text escaping; `HighlightedText` uses React `<mark>`/`<span>` text children with zero `dangerouslySetInnerHTML`.
- `PdfPreview` uses `pdfjs-dist@6.5.438` bundled worker (eval-free, `enableXfa: false`, no external CDN fetches, canvas-only rendering without `AnnotationLayer` or `ScriptingManager`), and `<a href={previewUrl} target="_blank" rel="noopener noreferrer">` points only to same-origin `/api/documents/<uuid>/preview`.
- Displays explicit OCR non-accuracy warning and DOCX approximate-pagination notice; never auto-corrects digits/units or auto-activates.
- Route `/documents/[id]/verify` lives under `List Document SOP`; no fourth navigation menu added.

## Required runtime/CI gates before S06 closure

1. Run and verify passing: `npm run lint`, `npm run typecheck`, `npm test` (including `tests/unit/verification.test.ts`), `npm run build`, PostgreSQL migration `0005` + `verify-db` (including `tests/integration/verification.test.ts`: Staff `403`, deactivated Admin `401`, direct SQL `ACTIVE` bypass blocked, `sop_verification_records` `42501` append-only, `ACTIVE` in-place mutation blocked, `42501` column immutability preserved, atomic rollback, concurrent verify conflict, reprocess renewed-verification flow), Playwright E2E (`tests/e2e/verification.spec.ts`), and exact published-candidate hosted CI.
2. Consider addressing the 3 LOW hardening items (`R-S06-1`..`R-S06-3`) before or alongside S07.
3. Open PRD section 16 gates (company real-SOP approval, OCR benchmarks, S07/S08 retrieval & deletion, storage recovery, retention/MFA, V01/V02) remain open.


---

## S06 remediation re-verification (`2da02bbb`)

- **Date:** 23 November 2026 (Asia/Jakarta).
- **Exact committed candidate:** `2da02bbb63b1a5ed157489bbe9bd8d8b21d51969` (tree `62f8c2863fc3074f7e958615a7d3efa8f5d793d2`) on `codex/s06-assisted-verification` (`249` tracked files, `26` changed since `cbabecd`).
- **Result (committed source & in-memory scope):** **PASS — all 3 LOW security recommendations (`R-S06-1`..`R-S06-3`) and `Q-S06-1` snapshot-attempt binding verified fixed in exact committed candidate `2da02bbb`.** Hosted CI run `45117819835` is currently in progress; final S06 closure verification awaits CI completion.

### Remediated controls matrix (`2da02bbb`)

| Item | Status | Committed file & blob SHA-256 | Independent verification evidence |
| --- | --- | --- | --- |
| `R-S06-1` (LOW — active snapshot immutability) | **FIX VERIFIED IN SOURCE** | `drizzle/0005_assisted_verification.sql:187-211` (`090dec3e2f0a307917bdfba76a74b8246ed7503a4a2bf4aa422b1949740b28b0`) | `app.prevent_active_snapshot_mutation()` (`BEFORE UPDATE OR DELETE` on `app.sop_chunks` and `app.sop_extraction_pages`) raises `23514` whenever parent `sop_documents` has `status = 'ACTIVE'` and `active_job_id = OLD.job_id`; `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO sop_runtime`. Compatible with S07 D4 tombstone-first deletion. |
| `R-S06-2` (LOW — `/preview` timeout & anti-framing/CORP headers) | **FIX VERIFIED IN SOURCE** | `src/server/verification/service.ts:225-226` (`a473aece84aa40dbe7fd44834394401a56851f862dac1e16a89b99d7bab47dca`); `src/server/verification/http.ts:66-74` (`7c07451c467adfc8b282031c085e3d85ee2c49852a418819648b404e5177ef37`) | `readDocumentPreview()` wraps `storage.read` with `AbortSignal.any([signal, AbortSignal.timeout(documentBounds.storageTimeoutMilliseconds)])`. `/preview` now sets `"X-Frame-Options": "DENY"` and `"Cross-Origin-Resource-Policy": "same-origin"` alongside `application/pdf`, `inline`, `no-store`, `nosniff`, and `Content-Security-Policy: sandbox`. |
| `R-S06-3` (LOW — `/verify` body limit & `reconcileJobs` ACTIVE guard) | **FIX VERIFIED IN SOURCE** | `src/server/verification/http.ts:11-42,83,86` (`7c07451c...`); `src/server/jobs/dispatch.ts:38,72` (`c49f26e19bc458360ef506188f37d9bfb9be45a546df2ae80d4a5a564fe4ad8b`) | `readVerificationBody()` enforces `maximumVerificationBodyBytes = 16_384` (header + streamed bytes) for `/verify` and `/reprocess`. Both `sopDocuments` updates in `reconcileJobs()` now filter `ne(sopDocuments.status, "ACTIVE")`. |
| `Q-S06-1` (`attempt_id` snapshot binding & strict `resolvedIssueIds`) | **FIX VERIFIED IN SOURCE & IN-MEMORY** | `drizzle/0005_assisted_verification.sql` (`090dec3e...`); `src/server/db/schema.ts` (`7ba965df...`); `src/server/verification/contracts.ts` (`c41f296b...`); `src/server/verification/service.ts:257-341,503-508` (`a473aece...`); `src/server/ingestion/service.ts:695` (`18c4ac6d...`) | `processed_attempt_id`/`active_attempt_id`/`attempt_id` enforced across CHECKs, `enforce_sop_verification_record()`, `enforce_sop_document_activation()`, column-level `GRANT UPDATE` (preserving `42501` immutability on source-identity columns), `completeIngestionStage()`, `verifyDocument()`, and `reprocessDocument()`. In-memory Node/tsx harness verified: missing/invalid `expectedAttemptId` rejected by Zod; mismatched `expectedAttemptId` (doc or job) and foreign/stale `resolvedIssueIds` (`matchedIssues.total !== uniqueResolvedIds.length`) all rejected with `409 VERIFICATION_STALE_SNAPSHOT`. |

### Publication, secret & PRD integrity recheck (`2da02bbb`)

- `node .codex/scripts/check-prd-integrity.mjs`: **PASS** before and after this checkpoint (`AI SOP Assistant — Technical Product Req.md` `12a5c10f...`, `PRD AI SOP Assistant.pdf` `a84d9cb7...` match both working tree and committed `2da02bbb` blobs).
- Committed tree hygiene (`git ls-tree -r 2da02bbb`): `249` tracked files, `0` forbidden paths, `0` non-synthetic secret-pattern hits across all `26` changed files since `cbabecd`.
- **Pending closure gate:** Hosted CI run `45117819835` (executing on exact `2da02bbb`) must complete with all required jobs passing (`paddleocr`, `foundation` including `verify-db` and Playwright E2E) before final S06 closure verification. PRD section 16 gates remain open.


---

## Final S06 closure security verification (`14e2d54`)

| Field | Independently verified value |
| --- | --- |
| Published candidate | `14e2d54cade8dfe6b357caa7a1baad6dcafdcf28` on `codex/s06-assisted-verification` |
| Commit tree SHA-1 | `644ee407bcfa699a36892c54d1dff7b7562e0c46` |
| Commits since `cbabecd` | `2da02bb` (S06 implementation + remediations) -> `14e2d54` (3-file standalone PDF.js worker & E2E timing fix) |
| Hosted CI run | `45122984069` (attempt 1, `2026-11-23T06:16:22Z`–`06:30:23Z`), `head_sha = 14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`, `conclusion = success` |
| Hosted CI jobs (public REST API) | `paddleocr` (`137520801499`): `9/9` steps `success`; `foundation` (`137520801816`): `20/20` steps `success` |
| Final S06 security verdict | **PASS for bounded S06 closure** (`14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`); zero demonstrated security or publication blockers remain. Lead owns sprint closure; no production, provider, or real-SOP authorization is granted. |

### Closure checks executed

1. **Delta audit (`git diff 2da02bb..14e2d54`):** Only 3 files changed (`+20/-14` lines):
   - `Dockerfile:21` (`e84dec661e64d79669e66b9b1b57f75528307916585be5e78b0337ee2581fc14`): copies only the single static `pdf.worker.min.mjs` asset from the pinned `pdfjs-dist@6.5.438` (`sha512`) `dependencies` stage into `./public/pdf.worker.min.mjs` with non-root `--chown=node:node`. No unintended files, configs, source maps, or secrets are exposed; no auth, origin, or CSP bypass is introduced.
   - `src/components/verification/pdf-preview.tsx` (`1f239e2825b4ff67966333d715dd02128137ffc82552c01a66653998e82a83f9`): points `workerSrc` to same-origin `"/pdf.worker.min.mjs"` (no external CDN), tracks `renderedState` after `task.promise`, and exposes only numeric `data-rendered-page`/`data-rendered-zoom` attributes on `<canvas>` (no SOP text or secrets).
   - `tests/e2e/verification.spec.ts` (`cbd6138b638f4ed07cb0442ab9f0cdb20b48cd207f676b9ee59821daaa733070`): asserts `/pdf.worker.min.mjs` returns `200` and synchronizes canvas assertions on `data-rendered-zoom`.
2. **Security blob preservation (`14e2d54`):** Confirmed all 7 previously re-verified S06 security files (`drizzle/0005_assisted_verification.sql`, `src/server/db/schema.ts`, `src/server/verification/{contracts,http,service}.ts`, `src/server/jobs/dispatch.ts`, `src/server/ingestion/service.ts`) remain byte-identical (`7/7` exact SHA-256 match) in `14e2d54`.
3. **Publication, secret & PRD integrity (`14e2d54`):** Inspected all `249` tracked paths (`27` changed since `cbabecd`): `0` forbidden paths and `0` non-synthetic secret-pattern hits. `node .codex/scripts/check-prd-integrity.mjs` passed before and after this update (`AI SOP Assistant — Technical Product Req.md` `12a5c10f505ba7a02d4d48114da05ecc7e8b36a8959610f0e80cc3fa582add47`, `PRD AI SOP Assistant.pdf` `a84d9cb74ae572a6b9e2943137277adc372567169f5d5110de29734af0c6ea5e`).
4. **Hosted CI metadata (`45122984069`):** Independently queried GitHub public REST API (`/actions/runs/45122984069` and `/jobs`), confirming `head_sha = 14e2d54cade8dfe6b357caa7a1baad6dcafdcf28`, `conclusion = success`, `paddleocr` `137520801499` (`9/9` steps `success`), and `foundation` `137520801816` (`20/20` steps `success`).

### Explicit limits & open PRD section 16 gates

- **Unauthenticated CI log limit:** Public GitHub REST API returned HTTP `403` on `/actions/jobs/137520801816/logs`; step-level API metadata is independently verified by security while raw job log bodies were not decoded by this reviewer.
- **Residual hardening & scan limits:** Root `Dockerfile` uses floating `node:24-bookworm-slim` (pre-existing from S01); automated image/dependency vulnerability scans and existing 4 moderate Node advisories remain tracked for S14 / pre-V01. Pattern secret scanning does not compare against private credential files (not read by security).
- **Open PRD section 16 gates:** S07/S08 retrieval, source links, and D4 deletion, company approval for confidential SOP processing with local PaddleOCR and OpenAI (privacy/residency/no-training), OCR language/table/numeral benchmarks, production storage provider/recovery, chat/audit retention, backup expiry, Admin MFA, account recovery, and V01/V02 acceptance remain open.
