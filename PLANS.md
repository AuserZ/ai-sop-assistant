# Development plan by feature sprint

Source: [approved technical PRD](<AI SOP Assistant — Technical Product Req.md>), sections 0, 14–16, and [original product PRD](<PRD AI SOP Assistant.pdf>). This plan does not change either source. Status updated on 23 November 2026.

## Current state

S05 SOP extraction, OCR, previews and indexing is **VERIFIED** on 23 November 2026 for published source `caf0fc7d8e8bb879f1162d1d32c174248022ee31` (tree `ac923727099f080f3923954e573cdcd9f19ca041`) on `codex/s05-document-processing`. [Hosted run 45102843612](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45102843612) passed all 29 step entries (`paddleocr` job `137457390869` 9/9 + `foundation` job `137457391121` 20/20): 58/58 unit tests, 9-input PaddleOCR CLI/stdin/HTTP-server/12-bounds verifier, Docker LibreOffice/Poppler conversion verifier, fresh `0004` PostgreSQL/pgvector migrations + `verify-db`, full Compose stack + 3-document Playwright D3 E2E (native PDF, scanned PDF via real PaddleOCR, rich DOCX via LibreOffice preview + Staff 403), workflow recovery, redirect controls and cleanup. Independent Security ([S05-security.md](docs/verification/S05-security.md)) and QA ([S05-qa.md](docs/verification/S05-qa.md)) issued final PASS for both S05a and full S05 closure; raw GitHub log download was unauthenticated 403 so step-level API metadata is verified, and CI's loopback synthetic embedding fixture remains distinct from S05a's standalone live OpenAI `text-embedding-3-small` (1,536-dim) compatibility receipt. Next permitted sprint is S06 (`codex/s06-assisted-verification`). All PRD section 16 external gates remain open. [S05 evidence and limits](docs/verification/S05.md)

S04 private Admin uploads are **VERIFIED** on22 November2026 for published source `1ef852166cda0e07c231ddd4834cf053442bb1dd`. [Hosted run45018939728](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45018939728), job137197322521, passed all19 step entries: lint/types/build,40 units,48 PostgreSQL checks,15 browser journeys, native storage controls, six actual recovery cases/native POST controls and cleanup. Independent QA decoded the exact-checkout logs; security independently bound the47-source manifest/publication and final evidence. Live synthetic R2 PDF/DOCX/exact20MB, exact original bytes and the lead's final UI gate also pass. Next permitted sprint is S05. Company privacy/residency, object recovery and production file-policy gates remain open. [S04 evidence and limits](docs/verification/S04.md)

S05a historical checkpoints (22 November): local PaddleOCR CPU build/8 cases/11 bounds + hosted `45026670726` on `4f1bf000b004e8a488a73268aed6635e8cb88423` + standalone live OpenAI `text-embedding-3-small`/1,536 synthetic request (`17` tokens, `1,536` finite values). Now superseded by full S05 VERIFIED closure above. [Approved follow-up and setup](docs/paddleocr-setup.md)

S03 is **VERIFIED** on 21 November 2026 for published source `0396cf606b8e34a805a038b273a103687a691ce1`. [Hosted run44852222243](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44852222243), job136685999286, passed all18 steps: lint/types/build, 28 unit tests, isolated secret generation, 30 PostgreSQL tests, 10 browser tests, six actual recovery/timeout cases, native POST301/307 controls and cleanup. QA independently checked the exact source and decoded logs; security confirmed the frozen41-file manifest, publication boundaries and original PRD/license/history integrity. Local native recovery/pruning removed the earlier JWT-bearing payloads under unchanged normal settings; transient payload retention remains explicit. Phase0 is complete for the recorded candidates. Next permitted sprint: S04 Admin private uploads using the user's selected Cloudflare R2; bucket/configuration and recovery-policy gates remain open. [S03 evidence](docs/verification/S03.md)

S01 is **VERIFIED** for candidate `59fa63f7df02489a6730b02f6cbbb2383c255503`. Local Docker evidence and [hosted run 44485878184](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44485878184) passed all required foundation checks, including 3 unit tests, 3 PostgreSQL/pgvector integration tests and cleanup. The user selected [AuserZ/ai-sop-assistant](https://github.com/AuserZ/ai-sop-assistant); native Git publication succeeded after browser sign-in on branch `codex/s01-foundation`, preserving the existing `master` history/license. [S01 verification report](docs/verification/S01.md)

The user authorized continued P0 development on 19 November 2026 and requested a project manager, principal fullstack engineer, security expert and QA, then added a principal DevOps engineer. The user explicitly authorizes the project manager to invoke these agents as development orchestrator. The main agent leads the four specialist roles, scheduling at most three child threads concurrently; role definitions and the execution agreement are recorded in [development team](docs/development-team.md). Current follow-ups cover orchestration instructions and bounded Docker/S01 runtime verification. Continue permitted work from the earliest unfinished acceptance item, preserving VERIFIED predecessor dependencies and every separate PRD approval gate. P1/P2 remain deferred.

Earlier Docker/publication blockers are resolved for native Git and the verified candidate. Initial local esbuild `ETXTBSY` did not recur on one unchanged build retry; its root cause remains unproven. Local test containers/networks were removed while retaining synthetic volume/images/secrets; hosted cleanup also removed its disposable volume. Independent publication review confirmed byte-identical protected PRDs, preserved license and excluded secrets/build/dependencies. QA independently confirmed the exact hosted candidate and all 14 successful job steps.

Open dependency risk from S01: production audit PASS with zero findings; full audit FAIL with four moderate findings in the dev-only Drizzle/esbuild tooling chain (GHSA-67mh-4wv8-2f99). Security found no demonstrated S01 serve-mode exposure and no additional mandatory S01 closure failure. Track compatible tooling remediation and re-audit under S14 before V01; do not describe the full audit as clean.

The 19 November `continue` authorized S02 on `codex/s02-authentication`, based on published S01 revision `b16e2a6ffaf39cd58a14392bc56d760925b906a6`. Fullstack implemented auth/API/schema/tests/transport; DevOps supported scoped runtime configuration; root owned UI/template/integration/docs; security/QA independently reviewed. The user chose antislop during development with existing styling. The later explicit live-email authorization and successful closure are recorded below. The latest 20 November `continue` now authorizes S03 after that prerequisite; no delivery timebox is invented.

S02 is **VERIFIED** on 20 November 2026 for application source `1ce6fbeaa8da5d4bff1a6baf8b8896efefa04fbb` plus browser correction `964687cd111ab60bdb5af20973f9ea6cef075957`. [Replacement hosted run 44548005713](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44548005713) passed all 15 steps, including 14 unit, 18 PostgreSQL and six browser tests and cleanup, independently checked by QA. One authorized live invitation returned HTTP201; the user confirmed receipt, acceptance and sign-in. The lead's final database read confirms consumed invitation, active STAFF account and a post-acceptance active session. No second email was sent. [S02 evidence](docs/verification/S02.md). The production dependency audit still reports four existing moderate tooling advisories through Better Auth optional peers; the standalone image excludes those CLI packages, but the audit must not be described as clean.

Follow-up on 19–20 November: domain/recipient, confirmed sender, provider key and private receipt stay in ignored local configuration. The app mounts the key read-only; the user confirmed the Resend dashboard status. Public DNS lookup alone did not establish that status. The failed documentation-head run `44543410142` and subsequent successful test-only correction remain recorded. The live invitation was provider-accepted at 21:54:45 Asia/Jakarta on 19 November; the temporary synthetic Admin session was closed. The user subsequently confirmed receipt/acceptance/sign-in, and the lead rechecked final database state at 07:54 Asia/Jakarta on 20 November. Production bootstrap/recovery and the remaining release gates are unchanged. S03 may now follow in phase order.

Initial team setup verification passed: the lead and independent QA parsed the original ten agent definitions, confirmed the initial four requested roles with inherited model/permissions and the existing three-child capacity, and checked relative links and PRD gates. Strict Codex startup configuration passed. Current product checks and limitations are recorded in the 19 November [S01 recheck](docs/verification/S01.md); the two original PRD hashes remain unchanged.

Detailed specialties, jobs, workflows, do/don't rules, handoffs and completion criteria are recorded in [`.agents/README.md`](.agents/README.md) and five role guides, including the principal DevOps engineer. Five team entry points reference those guides. The project manager's delegation authority is explicit. Earlier setup validation passed for all 11 Codex definitions, five role-guide structures/references, 84 relative links, strict startup and PRD integrity; evidence and limits are recorded in [team setup evidence](docs/development-team.md). No later application sprint is started by the current configuration/verification work.

Coding preference recorded on 19 November 2026: use `caveman` for concise coding communication and `antislop-code` for sparse, useful comments. Prefer clear domain names and straightforward code; comments explain non-obvious reasons or constraints. Shared rules are in `AGENTS.md`, `.agents/README.md` and [coding standards](docs/coding-standards.md). This instruction-only update does not refactor existing code or change sprint acceptance/status.

Each sprint delivers one feature or necessary operational capability, including its backend, persistence, n8n integration and interface where applicable. Work follows the PRD phase order. Sprint duration, team capacity, owners and calendar dates are not provided; assign a timebox at sprint kickoff rather than inventing a delivery date. If a feature does not fit, split it into named increments with their own checks, preserving phase gates and requirement IDs.

Tests are written and run during development, then a distinct verification pass runs after the sprint implementation is finished. Verification and fixes belong inside the sprint. A final release-candidate verification follows all development sprints; pilot adoption is checked separately after an authorized launch.

## Setup verification — 18 November 2026

| Check actually performed | Result |
| --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS: original technical Markdown and product PDF match SHA-256 values captured before setup |
| Integrity checker from nested working directory; missing/altered synthetic sources in an isolated temporary directory | PASS: correct root resolution and nonzero failure for missing/changed sources; original files untouched |
| `codex --strict-config app-server --print-startup-config` | PASS on installed CLI 0.167.0 |
| Project TOML parsed and validated against current official Codex JSON schema | PASS; validation tooling installed only in a temporary directory |
| Six standalone agent TOMLs parsed and required fields checked | PASS; no model/provider/permission override fields |
| Three skill YAML frontmatters, names/descriptions and unfinished-scaffold checks | PASS using a Node equivalent of the bundled skill validator's checks; Python is unavailable, so the Python validator itself was not run |
| Optional hooks JSON parsed and empty hook table schema checked | PASS; no lifecycle commands enabled |
| `codex execpolicy check` for `git status --short`, `docker compose down -v`, and `gh workflow run deploy.yml` | PASS: allow, prompt, prompt respectively; commands evaluated only, not executed |
| Relative links in editable Markdown guides/skills | PASS: 63 links resolve |

No product behavior was changed, so original requirement priorities remain unchanged. Application tests, runtime Compose validation, live providers, actual workflow execution, RAG benchmarks and deployment checks were not run: their implementation/environment does not exist yet. The checksum check detects edits rather than preventing writes; empty hooks do not provide automatic enforcement. Project-layer loading depends on user trust and client support. Next proposed task: the scoped Phase 0 foundation implementation, with unresolved gates below preserved.

## Sprint-plan verification — 18 November 2026

Documentation checks actually run for this planning change:

- PASS: inline Node consistency checks found 16 uniquely ordered sprint headings/table entries, correct phase order, predecessor dependencies and 64 unchecked sprint acceptance items. Every sprint has development scope and post-development verification.
- PASS: all 14 P0 IDs parsed from the approved technical PRD's traceability section have sprint mappings; deferred P1/P2 scope remains separate.
- PASS: all 14 relative Markdown links in the four changed/added documents resolve; sprint status remains PLANNED and V01/V02 remain NOT RUN.
- PASS: `node .codex/scripts/check-prd-integrity.mjs` before/after edits confirmed both original source files are unchanged.

Affected files: `PLANS.md`, `AGENTS.md`, `docs/testing.md`, and the new `docs/sprint-verification-template.md`. No product implementation or product test was executed. Dates/timeboxes/capacity and all listed external decisions remain unresolved. Next proposed development task: S01, secure application runtime and database foundation.

## Sprint sequence

The default execution order is S01 through S16. Each sprint depends on the VERIFIED predecessor; earlier verified features remain regression dependencies. A missing external decision may allow reversible scaffolding, but it does not permit marking the provider-dependent feature VERIFIED. This plan does not authorize starting every sprint or deploying; carry out the scope the user requests.

| Sprint | Feature / demonstrable outcome | PRD phase | Primary mapping | Status |
| --- | --- | --- | --- | --- |
| S01 | Secure application runtime, database and CI foundation | 0 | ADR 01/02/09/14/15 | VERIFIED |
| S02 | Invitation-only sign-in and role authorization | 0 | U2/U4; U3 access enforcement | VERIFIED |
| S03 | Durable private workflow jobs and safe progress proof | 0 | ADR 08/19; D3 foundation | VERIFIED |
| S04 | Admin private SOP upload | 1 | D2; D1 upload status; ADR 03 | VERIFIED |
| S05 | SOP extraction, OCR, previews and indexing | 1 | D3; ADR 04/05/11/21/22 | VERIFIED |
| S06 | Assisted verification and revision-bound activation | 1 | D3; ADR 17 | IN_PROGRESS |
| S07 | SOP library search and authorized original access | 1 | D1/D5 | PLANNED |
| S08 | SOP deletion and reliable unindexing | 1 | D4 | PLANNED |
| S09 | Verified ACTIVE hybrid retrieval and reranking | 2 | C2; ADR 10/23 | PLANNED |
| S10 | Evidence-validated procedural answers and citations | 2 | C2/C3/C4/C5; ADR 12 | PLANNED |
| S11 | Chat SSE and persisted current-session conversation | 3 | C1–C5; ADR 18/19 | PLANNED |
| S12 | Admin user directory and account management | 3 | U1/U2/U3/U4 | PLANNED |
| S13 | Responsive three-menu experience | 3 | C1/D1/D5/U1/U4; ADR 20 | PLANNED |
| S14 | Operational monitoring and security hardening | 4 | ADR 13/15; PRD sections 12–14 | PLANNED |
| S15 | Encrypted backups and verified disaster recovery | 4 | ADR 16; PRD section 13 | PLANNED |
| S16 | Approval-gated deployment and rollback capability | 4 | ADR 09/14; PRD sections 14/16 | PLANNED |

## Definition of done — applies to every sprint

Status flow: `PLANNED → IN_PROGRESS → IMPLEMENTED → VERIFYING → VERIFIED`. Use `BLOCKED` with the missing prerequisite when execution or verification cannot proceed. IMPLEMENTED means code exists; only VERIFIED means the sprint's required checks have passed against the recorded revision.

Before work, inspect actual manifests, migrations, Compose, APIs, tests and workflow JSON; identify the requirement IDs, exact feature scope, dependencies and open gates. Select an implementation owner, a verifier and a timebox at kickoff. A separate human or subagent is not required by this plan; record who actually verifies, and delegate only when requested by the user or applicable instructions.

After development is finished:

1. Run the feature's automated success and failure cases, relevant regression tests, lint/type/build checks and applicable database/workflow/browser/security checks. Run checks against the finished revision; a previous green run is insufficient if relevant code changed afterward.
2. Exercise the feature through its real API/UI/workflow boundary as applicable, using synthetic documents. Capture actual results and sanitized evidence. Mocked provider contracts do not establish live provider compatibility or production readiness.
3. Inspect authorization, source eligibility, secrets, idempotency and answer-release safety where touched. For extraction/retrieval/answer changes apply `validate-rag`; use `verify-release` for final candidate readiness.
4. Fix failures within the authorized feature scope and rerun the affected checks. Missing infrastructure, skipped mandatory tests or required unresolved provider gates block verification; do not label them PASS or silently waive them.
5. Run `node .codex/scripts/check-prd-integrity.mjs`, record changed files and actual commands/results, update the implementation guides, and save a report using [the sprint verification template](docs/sprint-verification-template.md). Evidence paths and checks must be real before recording completion.
6. Mark the sprint VERIFIED only when its acceptance checklist and all applicable required checks pass. A later change that invalidates evidence reopens the affected verification; rerun relevant regressions and the benchmark when release-affecting models/retrieval/workflows change.

Proposed report location after execution: `docs/verification/Sxx.md`, with a distinct report for each sprint and candidate revision. These reports do not exist yet. Do not add empty reports or fabricate check results in advance. Production deployment approval remains the PRD's separate release gate.

## Phase 0 — foundation and security

### S01 — secure application runtime and database foundation

**Outcome:** A developer can run the Next.js modular monolith and disposable infrastructure with executable CI checks. **Depends on:** existing instructions/setup integrity. **Mapping:** ADR 01/02/09/14/15; enables all P0 requirements.

Development scope:

- Establish compatible versions, package manager/lockfile and domain boundaries; scaffold App Router + TypeScript without a separate backend.
- Add PostgreSQL/pgvector and Drizzle migrations; establish separate n8n operational persistence and scoped service roles. Add only schemas needed by this and subsequent authorized increments.
- Define synthetic local Compose services/private networks, protected secret handling, health checks and resource-limited conversion infrastructure. No production provider/region choice is implied.
- Add real lint/type/build/Vitest/database-test scripts and GitHub Actions; seed synthetic fixtures and document executable commands.

Verify after development:

- [x] A clean source copy installs reproducibly and the application build/start smoke test succeeds.
- [x] Fresh database migrations and disposable PostgreSQL/pgvector integration checks pass; n8n credentials cannot modify authoritative application approvals.
- [x] Compose resolves with synthetic configuration; internal services are not publicly exposed and no secret appears in source/client/log output.
- [x] CI runs its declared lint/type/build and initial unit/integration checks; record exact commands and results.

### S02 — invitation-only authentication and authorization

**Outcome:** Invited active Staff/Admin users can sign in; protected server operations enforce current access. **Depends on:** S01. **Mapping:** U2/U4, U3 enforcement, ADR 06/07. User-management menu completion belongs to S12.

Kickoff: 19 November 2026, branch `codex/s02-authentication`; predecessor S01 VERIFIED. Scope is Better Auth/Drizzle identity, invitation-only acceptance, current-account/RBAC/owner guards, shared durable limits, CSRF/session safety, Resend/React Email integration and synthetic verification. Public account bootstrap, directory/status mutation UI, password reset and SSO remain deferred as defined above. Local and hosted verification pass 14 unit, 18 PostgreSQL and six Chromium tests; independent security/QA rechecked the corrected standalone origin boundary. Live delivery/acceptance/sign-in now pass with user confirmation and final database evidence. S02 VERIFIED on 20 November. [S02 report](docs/verification/S02.md).

Development scope:

- Implement Better Auth/Drizzle identity, secure sessions, login/logout, invitation acceptance and Admin-authorized invite issuance through Resend/React Email.
- Bind invitations to email/role, expiry and single use; disable public registration and never send passwords.
- Centralize current-account/role checks and owner-scoped access; establish rate limits, CSRF controls and deactivation/session invalidation semantics.
- Use a synthetic development Admin fixture; document initial production Admin provisioning as an implementation proposal requiring review, not open public bootstrap access. Track sender-domain and operational recovery gates without building U5/P1.

Verify after development:

- [x] Intended-email invitation acceptance works; expired/reused/wrong-email/forged invitations and public signup fail.
- [x] Staff cannot invoke Admin operations, unauthenticated callers are denied, and ownership checks reject cross-user access.
- [x] Deactivation/session revocation prevents subsequent protected actions; stale role/session data cannot retain privileges.
- [x] Authentication cookies, CSRF/rate-limit behavior and invitation email rendering are checked with synthetic data.
- [x] One authorized real invitation was received and accepted; user sign-in and active account/session were confirmed. Injected delivery alone was not used to close this gate.

### S03 — durable private workflow jobs and safe progress proof

Kickoff: 20 November 2026, branch `codex/s03-workflow-jobs`, base S02 closure `14ab58698f7432a96727bb01442ec71d0fea9ad6`; S02 VERIFIED. The user's `continue` authorizes this next sprint in phase order. Begin with a synthetic job through real n8n Queue Mode and a protected progress bridge; validate security, retries/reconciliation, disconnects and proxy behavior before choosing a working contract. No actual RAG, model/OCR/storage call, new product menu, real SOP or deployment is included. Root owns integration/contracts/docs; fullstack owns assigned job/schema/API/workflow/test files, DevOps owns assigned Compose/runtime/CI scripts, security/QA independently review. Exact ownership follows inspection; no delivery timebox is invented.

Verification closure on 21 November: candidate0396cf6 passes [hosted run44852222243](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44852222243), all18 steps, independently checked by QA. Units 28/28, real PostgreSQL 30/30, browser 10/10 and all six actual recovery cases PASS, including live deactivation and the real60s proxy timeout/reconnect. Earlier failures/fixes remain recorded. Native POST301/307 and all five published redirect settings pass. Supported one-minute recovery and unchanged normal native pruning removed the earlier retained payloads; security and QA independently read zero direct payload/JWT/orphan counts. Transient storage under native buffering remains explicit. S03 VERIFIED; S04 may now follow. [Evidence](docs/verification/S03.md)

**Outcome:** Next.js can submit a synthetic job through n8n Queue Mode, safely receive progress, and recover duplicate/interrupted delivery. **Depends on:** S02. **Mapping:** ADR 08/19; D3 job infrastructure.

Development scope:

- Run restricted n8n main/workers with Redis and separate operational persistence; establish a stable protected encryption key.
- Add durable job/request identities, authenticated signed requests/callbacks, timestamp/nonce replay defenses, bounded retries and state reconciliation.
- Version a synthetic workflow export without credentials or full file binaries. Backend owns state authorization; workers cannot approve documents or assign roles.
- Spike the end-to-end progress bridge through Queue Mode and proxy to backend-owned SSE with synthetic output. Compare a working mechanism against requirements and record the result; callbacks/pub-sub remain a proposal until proven.

Verify after development:

- [x] Forged, expired, replayed and cross-job callbacks fail; duplicates do not create duplicate transitions/results.
- [x] Worker restart and queue interruption reconcile durable jobs without losing ownership or unbounded retries.
- [x] Captured browser stream contains only allowlisted progress before synthetic validation passes; no arbitrary node output or draft procedural content leaks.
- [x] Browser disconnect/proxy buffering/timeout paths are exercised; n8n editor, Redis and service credentials remain private.

**Phase 0 exit:** S01–S03 VERIFIED, real executable checks in CI, protected auth/data boundaries, and evidence of a safe working progress bridge. A mocked transport alone does not close the bridge gate.

## Phase 1 — document features

### S04 — Admin private SOP upload

Kickoff:21 November2026 on `codex/s04-private-uploads`, base S03 closure `93a71e8b93392c7740fd5b097548b28e1747b1d3`; predecessor S03 VERIFIED for0396cf6/hosted44852222243. User continuation and R2 selection carry the next P0 slice forward. Scope is private Admin upload-init/finalization, exact-byte validation/sealing, explicit quota reservations, status UI and one parked ingestion intent; no S05 processing. Root owns contracts/UI/browser/integration, fullstack owns backend/schema/tests/root packages, DevOps owns fixture/config/CI, security/QA independently review. Timebox unset. Supplied bucket/endpoint/scoped credentials and live synthetic provider checks now pass; jurisdiction/recovery/company policy remain open. [Contract and tests](docs/private-uploads.md)

**Outcome:** Admin can upload an accepted synthetic PDF/DOCX to private storage and start one durable ingestion job. **Depends on:** S03. **Mapping:** D2 and D1 upload-status groundwork, ADR 03. **External gate:** selected storage/project access and tested file limits; adapters can be scaffolded while this remains open.

Resume22 November: user confirmed the public development URL disabled and Custom Domains empty. Standalone real R2 tampering/race/replay/hash/CORS/expiry/private-S3 checks passed, with the disabled public-domain HTTP probe explicitly unobserved due to expired TLS; no TLS checks were bypassed. The one standalone synthetic canary was deleted. Final six-case recovery is running after the documented n8n restart-policy and Redis-only test-horizon corrections. Actual app R2 verification will use fresh project `ai-sop-s04-r2-verify-20261122` and a separate database, reusing the checked images; this avoids moving fixture records/quota/object identities between storage backends. Retain the old synthetic S04 volume/networks and all personal S02 state. No provider app startup or hosted S04 CI is recorded yet.

Follow-up22 November: final six recovery cases/native POST controls passed and were independently reconciled. Fresh provider startup/migrations/seeding and small PDF/DOCX browser acceptance passed. The actual20MB case exposed an insufficient15s seal budget: a verified read took11.220s and separate PUT10.699s. Coordinated storage30s/lease45s/client35s preserves proxy35s and all other caps;40 updated units, lint/types/integrity pass. Rebuild,48DB, live20MB/original-byte proof and exact hosted CI are pending. The expired failed upload remains reserved/retained; no quota/data reset is authorized. Earlier startup/image/client-hash checkpoints remain historical evidence, not verification of this timing follow-up.

Final local checkpoint22 November: app rebuild CLI0, updated48/48 DB and actual20MB/browser/canonical-original proof passed. All3 originals match exact size/SHA/MIME and one undispatched parked job each; negative SHA has no canonical doc/job. Label cursor defect was fixed in base CSS; finalc9c9 app differs only in CSS from the successful provider artifact, with69 other production inputs identical. Lead's full real-provider UI gate passed at18:39 Jakarta, after recording private observer/sign-in timeout history. Six provider services healthy/two one-shots0, only loopback3000; previous9 fixture containers and volumes retained. Exact hosted CI and independent closure are the remaining S04 gates. Earlier pending checkpoints above are historical.

Closure22 November: S04 VERIFIED for1ef8521 after hosted45018939728 and independent QA/security PASS. Exact committed-byte build and every mandatory regression pass; the sole local-build/Git input distinction is the unchanged tsconfig final newline, with normalized text/JSON equality documented. All four acceptance items below pass. Earlier pending states above remain historical; S05 may now start under the continuing P0 authorization, preserving its provider/configuration and company-data gates.

Development scope:

- Implement authenticated upload-init/finalization contracts and upload UI within document management, using backend-issued short-lived direct-upload authorization.
- Validate name/type, MIME plus signature, requested/actual size, quota and object checksum before accepting processing.
- Persist document hash/uploader/state and a unique job equivalent to `(document_id, sha256, pipeline_version)`; acknowledge asynchronously.
- Show honest upload/job states and safe errors. Treat 20 MB as an initial assumption pending testing, not approved production policy.

Verify after development:

- [x] Admin valid PDF/DOCX upload succeeds; Staff/anonymous upload and invalid signature/type/size/checksum fail.
- [x] Missing/incomplete or wrong-object finalization cannot create an eligible document or trusted processing result.
- [x] Duplicate finalization/request retries create one logical job; signed upload access expires and cannot target unrelated objects.
- [x] Original files remain private and UPLOADED/PROCESSING documents cannot be Staff evidence.

### S05 — SOP processing, OCR, previews and indexing

Kickoff22 November2026 after recorded S04 VERIFIED closuref81a8d3. User's latest instruction approves PaddleOCR locally in Docker instead of Google OCR for now; this temporary follow-up is recorded in [the setup guide](docs/paddleocr-setup.md), leaving both original PRDs intact. Scope S05a: separate offline CPU image, pinned public models/dependencies, bounded local-image CLI and actual synthetic OCR/sandbox/failure proof. DevOps owns the new worker/Compose and scoped CI; lead owns integration/docs, security and QA independently review. Timebox unset. No S04 object/job/volume reset. Full S05 acceptance below remains unchecked until the complete pipeline and required provider evidence pass.

**Outcome:** Uploaded documents produce faithful mapped text, previews, chunks and embeddings, ready for human verification. **Depends on:** S04. **Mapping:** D3, ADR 04/05/11/21/22 with the recorded temporary OCR-provider follow-up. **External gates:** verified OpenAI embedding model/dimensions, accepted local PaddleOCR quality/resource evidence, and production OCR/language decisions; Google processor region/limits/quality if resumed. No real SOPs without company approval.

Development scope:

- Implement native PDF/DOCX extraction, scanned/empty/mixed-page detection and necessary OCR fallback using the user's temporary local PaddleOCR choice; preserve the original Google decision and explicit follow-up history.
- Preserve original PDFs; generate DOCX derivative previews through isolated resource-limited LibreOffice, with honest source-versus-derivative page mappings.
- Preserve headings, procedure ordering, digits/units/conditions and table headers/cells; structure-aware chunking uses recursive oversized-section fallback without paraphrasing evidence.
- Store source/job/pipeline/chunk identity, text hashes, search data and verified-model embeddings; flag quality issues and transition to PENDING_VERIFICATION, never ACTIVE.

Verify after development:

- [x] Synthetic native PDF, scanned PDF, mixed pages and DOCX complete with faithful digits/units/tables/section provenance.
- [x] OCR/conversion/embedding failure and malformed/oversized inputs retry only as allowed, then fail safely with restricted diagnostics.
- [x] Duplicate jobs and worker retries do not duplicate chunks; expired file references renew only through authorized backend access.
- [x] No processing result activates a source or exposes it to Staff retrieval. Exported workflow-contract tests and provider compatibility evidence are recorded separately.

Closure 23 November 2026: **S05 VERIFIED** for `caf0fc7d8e8bb879f1162d1d32c174248022ee31` after hosted run `45102843612` (`29/29` steps PASS) and independent QA/Security PASS. S06 may now proceed. [S05 evidence](docs/verification/S05.md)

### S06 — assisted verification and atomic activation

Kickoff 23 November 2026 on `codex/s06-assisted-verification` after S05 VERIFIED closure. Scope: Admin-only assisted verification review UI (original PDF / DOCX derivative preview on left + extracted pages/sections/chunks/issues on right with navigation/search/zoom/flags), explicit approve/reject with notes and controlled reprocessing, server-owned atomic revision-bound activation (`ACTIVE`/`REJECTED`) with audit trail, and n8n/Staff inability to mutate activation. Timebox unset.

**Outcome:** Admin can compare original/preview with extraction and approve the exact matching snapshot for retrieval. **Depends on:** S05. **Mapping:** ADR 17; D3 activation invariant.

Development scope:

- Build original/preview and extracted-text review panels with meaningful navigation/search/zoom, source mappings and suspicious digit/unit/table/blank-page flags.
- Implement explicit approve/reject with notes and controlled reprocessing. OCR confidence never means automatic correctness.
- Atomically bind activation to immutable original hash, successful job/pipeline snapshot, nonempty chunks and an Admin verification record.
- Record reviewer/time/decision/issues and before/after state; n8n cannot mutate authoritative activation.

Verify after development:

- [ ] Admin can approve a valid snapshot and reject questionable text; Staff/worker approval attempts fail.
- [ ] Stale hash/job/snapshot, empty chunks, incomplete processing and concurrent changed-state approvals are rejected.
- [ ] Reprocessing requires renewed verification; ACTIVE originals cannot be mutated in place. Replacement remains D6/P1.
- [ ] Review panels show real data/mappings and audit entries; approval and state updates commit consistently or roll back together.

### S07 — searchable SOP library and original access

**Outcome:** Users can find eligible SOPs by title and open/download authorized originals; Admin sees processing diagnostics. **Depends on:** S06. **Mapping:** D1/D5 and U4.

Development scope:

- Implement the List Document SOP table with title/type/uploader/date/status, title search and useful loading/empty/error states.
- Staff queries and metadata/source routes expose only verified ACTIVE documents; Admin can inspect processing/rejected/failed states and existing upload/review actions.
- Resolve private original/preview access through backend reauthorization and short-lived signed links, with genuine section/page context.
- Keep source access separate from historical citation snapshots; do not issue permanent public links or trust generated URLs.

Verify after development:

- [ ] Search/table metadata and original access work for Admin/Staff according to role and current account state.
- [ ] Guessed IDs, non-ACTIVE sources, unauthorized previews, expired links and deactivated sessions fail safely.
- [ ] Signed link issuance rechecks source status; test/document the residual bearer-access window until link expiry.
- [ ] Browser tests cover search, open/download, keyboard operation and usable narrow-screen behavior; no fourth menu is added.

### S08 — deletion and reliable unindexing

**Outcome:** Admin deletion immediately removes evidence eligibility and reliably cleans up indexes/private files. **Depends on:** S07. **Mapping:** D4 with C2/C3/D5 integrity.

Development scope:

- Implement an Admin delete action whose transaction commits a DELETED tombstone before any asynchronous physical cleanup.
- Reconcile chunk/vector, original and preview cleanup with idempotent retries and meaningful Admin status.
- Reject stale ingestion/verification callbacks that could restore deleted eligibility; invalidate current source resolution.
- Mark historical citations unavailable and document that approved backup retention may outlast live deletion.

Verify after development:

- [ ] Staff/anonymous delete fails; Admin deletion removes eligibility immediately even if storage cleanup fails.
- [ ] Duplicate deletion, cleanup retries and worker restarts converge without losing the tombstone or reviving evidence.
- [ ] Concurrent extraction/activation/source requests cannot reuse a deleted snapshot; historical source access becomes unavailable.
- [ ] Integration checks prove deleted chunks are excluded from eligible data access; S09/S11 later repeat the race through actual retrieval/answer delivery.

**Phase 1 exit:** S04–S08 VERIFIED with native/scanned/mixed PDF/DOCX, OCR failure, job idempotency, revision-bound approval, private source access and deletion/retry-race evidence. No unverified document becomes eligible.

## Phase 2 — evidence retrieval and answers

### S09 — verified ACTIVE hybrid retrieval and reranking

**Outcome:** A query returns ranked original passages only from currently verified ACTIVE SOPs. **Depends on:** S08. **Mapping:** C2, ADR 10/23. **External gate:** actual enabled embedding/reranker model IDs; no silent substitute for ADR 23's selected label.

Development scope:

- Implement semantic pgvector and keyword PostgreSQL full-text queries with identical verified ACTIVE snapshot constraints inside both branches.
- Fuse/deduplicate with RRF; rerank only supplied chunk IDs and retrieve the unchanged original passages afterward.
- Support bounded history as query-rewrite input, never as evidence. Persisted conversation integration follows in S11.
- Begin the versioned 50-question synthetic dataset, supporting-source expectations and agreed scoring/latency rubric; record experiments without treating tuning assumptions as final values.

Verify after development:

- [ ] Each actual database query rejects high-scoring pending/failed/rejected/deleted/stale-snapshot traps before candidate selection.
- [ ] Fusion/deduplication retain correct identity; unknown/duplicate/malformed reranker IDs fail closed and never alter evidence text.
- [ ] Follow-up rewriting still retrieves fresh original evidence; prior answers and injected file instructions cannot act as sources.
- [ ] Delete/reprocess races, provider outage and empty/weak evidence paths behave safely; record real database and mocked-provider contract results separately.

### S10 — validated procedural answers and citations

**Outcome:** Supported questions return faithful cited procedures; unsupported questions get the exact fallback; unsafe drafts are withheld. **Depends on:** S09. **Mapping:** C2/C3/C4/C5, ADR 12. **External gates:** verified answer/judge model access and scoring rubric.

Development scope:

- Generate structured claims and numbered procedural steps solely from retrieved original passages, preserving order, quantities, units, conditions and provenance.
- Add deterministic source-ID/schema/claim/status/quantity checks followed by an independent claim-level LLM judge; fail closed on uncertainty or disagreement.
- Return exactly `No SOP found for this question` with no citations when evidence is insufficient. Provider/transport/internal/check-service failure is a distinct safe service error.
- Keep candidate answers private; resolve citation identity through the backend and recheck source eligibility before accepting any supported result.

Verify after development:

- [ ] Supported answers have correct procedure order and valid supporting document/chunk/title/section mappings, with no invented steps or quantities.
- [ ] Missing/forged citations, incorrect units, dropped conditions, injected instructions, inactive sources and malformed output are rejected.
- [ ] Judge failure/uncertainty/timeout and provider rate-limit/outage never release a candidate or masquerade as evidence absence.
- [ ] Run `validate-rag` and the initial 50-question benchmark: ≥43 correct, 100% valid supporting citations and 0 invented steps in that set; record models/workflows/configuration and stage timings.

**Phase 2 exit:** S09–S10 VERIFIED, including both real search branches, deterministic and independent-judge failures, exact fallback/citation behavior and benchmark evidence. A passing benchmark does not establish universal correctness. Browser SSE integration must still pass S11.

## Phase 3 — chat and complete product experience

### S11 — safe chat SSE and current-session persistence

**Outcome:** An authorized user can chat, follow up, and see truthful progress followed by one checked final outcome and current-session history. **Depends on:** S10 and the proven S03 bridge. **Mapping:** C1–C5, ADR 18/19.

Development scope:

- Implement authenticated Next.js-owned SSE with a versioned allowlisted event contract; no arbitrary n8n strings or generated token deltas.
- Persist owner-scoped conversations/messages/validation/source references with request idempotency; bound recent context and perform fresh retrieval for every question.
- Handle disconnect/reconnect, replay, backpressure, timeout and late callbacks; recheck current user/source eligibility at release and source-link issuance.
- Build chat input, current-session history, safe final Markdown/citations, progress and error/fallback states. Past-conversation reopening remains C7/P1.

Verify after development:

- [ ] Capture actual outbound SSE bytes through Next.js/proxy/n8n: no draft procedural content arrives before deterministic checks and judge PASS.
- [ ] Repeated requests, reconnect/replay and worker callbacks yield one logical final message; cross-user access is denied.
- [ ] Delete/retire/deactivate during a request prevents unauthorized final answer/source release; provider and validation failure expose only safe terminal outcomes.
- [ ] Browser tests cover current-session history, follow-ups, valid citations, exact fallback and safe errors; measure progress, first meaningful answer and completion separately.

### S12 — Admin user management

**Outcome:** Admin can invite, list, update roles and deactivate/reactivate users without engineering help. **Depends on:** S11 and S02 authorization. **Mapping:** U1/U2/U3/U4.

Development scope:

- Implement the Admin-only directory with name/email/role/status and protected invite, role-change and active-status APIs/UI.
- Reuse S02 invitation delivery and current-account/session enforcement, with audit and safe errors.
- Apply deactivation safeguards and verify ongoing sessions/streams/download authorization lose access as required.
- Keep password-reset enhancements U5/P1 and SSO U6/P2 deferred; resolve operational recovery/sender-domain readiness as launch gates.

Verify after development:

- [ ] Admin list/invite/role/deactivate/reactivate journeys work with actual persisted state and intended-email invitation rules.
- [ ] Staff/anonymous requests and crafted direct API mutations are denied; role changes do not grant stale-session privileges.
- [ ] Deactivation blocks protected access during active usage; reactivation restores only currently authorized capabilities.
- [ ] Duplicate/expired invitations, invalid input, email failures and audit redaction behave safely; no passwords are emailed.

### S13 — responsive three-menu experience

**Outcome:** The complete P0 experience works on current desktop/mobile browsers with exactly the approved menus. **Depends on:** S12 and prior document/chat interfaces. **Mapping:** C1/D1/D5/U1/U4, ADR 20.

Development scope:

- Integrate exactly Chat, List Document SOP and User Management; Staff sees only permitted navigation/actions and server checks remain authoritative.
- Complete responsive navigation/tables, stacked mobile verification panels and usable PDF/extraction interactions with the confirmed frontend stack.
- Validate keyboard focus/labels, forms, readable errors and honest loading/empty/retry states across the integrated journeys.
- Keep document verification within documents and exclude dashboards, feedback, past-chat reopen and replacement UI.

Verify after development:

- [ ] Playwright journeys cover invite/login, Admin upload→review→activate, Staff find/chat/download, Admin delete and user deactivation.
- [ ] Desktop/mobile layouts and keyboard use work without inaccessible actions, clipped essential content or a fourth menu.
- [ ] Navigation visibility and direct-route/API tests agree on current roles; user-controlled content is sanitized.
- [ ] Recheck SSE, citations and current-session persistence through the finished UI; no placeholder controls or fake metrics imply completion.

**Phase 3 exit:** S11–S13 VERIFIED; all 14 original P0 feature IDs have working user journeys and test evidence. Full-system release acceptance still requires Phase 4 and final verification.

## Phase 4 — operational capabilities

### S14 — monitoring and security hardening

**Outcome:** Operators can detect failures and the integrated system enforces tested private service/data boundaries. **Depends on:** S13. **Mapping:** ADR 13/15; PRD sections 12–14.

Development scope:

- Complete redacted structured Pino logging, request/job/trace correlation, stage/usage/OCR metrics and queue/resource/disk/DB/provider monitoring.
- Harden rate limits, scoped credentials, private ports/networks, callback replay protection, execution-data pruning and conversion resource/outbound restrictions.
- Add focused adversarial checks, dependency/image scans and bounded-concurrency/load tests; validate initial file/page/VPS/concurrency assumptions.
- Implement approved retention/deletion/MFA policy where required after decisions are recorded; do not invent policy defaults or a compliance certification.

Verify after development:

- [ ] Injection, forged sources, cross-user/role attacks, SSRF/file-reference abuse, malicious conversion inputs and webhook replay cannot bypass controls.
- [ ] Logs/client bundles/workflow exports/CI artifacts contain no passages, prompts, secrets or signed URLs; execution pruning is exercised.
- [ ] Provider/DB/worker faults yield safe failures, bounded retries, observable diagnostics and recovery behavior.
- [ ] Load/security results identify resource limits and remaining risks; unresolved mandatory policy/provider gates block release acceptance.

### S15 — encrypted backups and verified recovery

**Outcome:** Application/n8n state and private document access can be recovered in an isolated drill. **Depends on:** S14. **Mapping:** ADR 16; PRD section 13. **External gates:** offsite provider/recovery configuration, retention policy and protected key access.

Development scope:

- Schedule encrypted logical dumps of application and n8n databases every six hours to private offsite storage; verify success/upload and failure alerting.
- Securely escrow the original n8n encryption key and required secret/configuration bindings; document original/preview object recovery policy.
- Build an isolated restore runbook including pgvector, n8n credentials, transient Redis/job reconciliation and synthetic functional smoke checks.
- Document the monthly restore drill procedure. Thirty-day retention, six-hour potential loss and four-to-eight-hour recovery remain policy/provisional values until reviewed/measured as applicable.

Verify after development:

- [ ] Backup artifacts are decryptable, private and offsite; failed dump/encryption/upload triggers an actionable safe alert.
- [ ] An isolated restore recovers both databases, pgvector and n8n credentials using the original key; object access works.
- [ ] Restored synthetic auth/upload/verification/retrieval/chat and ACTIVE-only/stream-safety checks pass; duplicate/stale queued jobs reconcile.
- [ ] Record artifacts, restore timing and any data-loss/recovery gaps without claiming unmeasured guarantees; do not overwrite production to test recovery.

### S16 — controlled deployment and rollback

**Outcome:** A versioned release can be deployed and rolled back through a reviewed approval-gated process. **Depends on:** S15. **Mapping:** ADR 09/14; PRD sections 14/16.

Development scope:

- Build immutable images and reviewed n8n JSON artifacts; pin deployed versions and record schema/configuration compatibility.
- Implement GitHub Actions deployment with a manual production approval gate, protected secrets and reviewed migrations.
- Provide health/functional smoke checks, deployment failure handling and a retained known-good version; distinguish image rollback from schema/data recovery.
- Rehearse deployment/rollback on an authorized synthetic non-production environment. Production release remains dependent on the final candidate verification below and the separate approval gate.

Verify after development:

- [ ] Build/deploy artifacts are immutable and traceable to code/workflow/schema/configuration versions; CI failure prevents promotion.
- [ ] The production job cannot bypass manual approval; credentials are scoped/redacted and internal services stay private.
- [ ] Non-production deploy smoke checks and rollback rehearsal pass, including migration compatibility and synthetic checked-answer SSE.
- [ ] Launch/rollback/support owners and runbook actions are identified; changed artifacts or migrations trigger relevant re-verification.

**Phase 4 development exit:** S14–S16 VERIFIED. Proceed to V01; development completion alone does not mean the release candidate or pilot has been accepted.

## Verification after all development — V01 release candidate

**Status:** NOT RUN. **Prerequisites:** S01–S16 VERIFIED; exact candidate commit/images/workflows/schema/configuration identified; all mandatory real-provider/privacy/operational gates resolved with evidence. Use [verify-release](.agents/skills/verify-release/SKILL.md) and record a candidate-specific report after execution.

- [ ] Run the implemented lint/type/build, unit, disposable PostgreSQL/pgvector integration, workflow-contract, Playwright and relevant security suites against the complete candidate. A skipped mandatory suite blocks acceptance.
- [ ] Demonstrate all 14 P0 requirements C1–C5, D1–D5 and U1–U4 end to end with synthetic evidence. Verify both query branches are ACTIVE-only and no user/document/chat/webhook bypass exists.
- [ ] Recheck byte-level stream safety, source/citation revocation, duplicate jobs/messages, OCR/conversion failure, malformed reranking and judge failure across real runtime boundaries. No answer before deterministic checks and independent judge PASS.
- [ ] Run the frozen 50-question golden benchmark on the actual configured candidate models/workflows: at least 43/50 correct, 100% valid supporting citations and 0 invented procedural steps. Record per-case judgments and dataset/model/configuration versions.
- [ ] Record first progress, first meaningful validated answer, completion and agreed p50/p95. Assess the under-30-second business goal and 3-second-start/10-second-finish technical targets; progress does not count as answer start. Missed targets remain visible and cannot be silently waived.
- [ ] Verify live-provider entitlement/compatibility and source access with authorized synthetic data; mocked-only evidence cannot close those gates. Before company data, record privacy/residency/no-training approval and applicable provider controls.
- [ ] Confirm isolated backup restore and deployment/rollback evidence still applies to the candidate; rerun affected checks after relevant changes.
- [ ] Confirm pilot/support/launch/rollback owners, sender-domain/account recovery, retention/backup policy and other section 16 decisions are recorded. Recheck original PRD hashes.

If any required check fails, record FAIL or BLOCKED, fix the affected authorized feature and rerun its checks plus impacted regressions. Re-run benchmark for relevant model/retrieval/workflow changes. Mark V01 PASS only for the verified candidate; subsequent relevant changes invalidate the corresponding evidence. V01 PASS is prelaunch technical acceptance and does not replace production approval or prove future pilot adoption.

## Verification after authorized launch — V02 pilot acceptance

**Status:** NOT RUN. **Prerequisites:** V01 PASS, required manual deployment approval, identified pilot team/owner/date, approved real-data processing and passing post-deployment smoke checks.

- [ ] Run protected production health/functional smoke checks within the authorized scope; confirm current source availability, access controls and safe answer delivery.
- [ ] Observe the pilot against the agreed rubric, latency measures and support process. Record actual problems and re-open relevant feature verification when fixes change behavior.
- [ ] Measure weekly active pilot staff against the agreed eligible pilot roster and observation window; target at least 60%. Owner must define measurement/retention before collection; no analytics dashboard or fourth menu is implied.
- [ ] Record product/QA/security/operations acceptance and unresolved risks with owners. Do not claim universal correctness from benchmark or pilot results.

P0 technical acceptance (V01), production approval, and pilot acceptance (V02) are distinct recorded outcomes. No adoption metric can pass before pilot observations exist.

## Phase 5 — deferred feature backlog

Only after P0 acceptance and an explicit request, plan separate feature sprints for C6 thumbs feedback, C7 reopening past chats, D6 immutable file replacement/reverification, and U5 password-reset enhancements. No P1 sprint is scheduled or authorized now. Resolve operational recovery readiness before rollout without silently promoting U5. D7 owner/review metadata and U6 SSO remain P2. Excluded integrations, AI SOP drafting, formal approval chains, dashboards and native apps remain out of scope.

## Requirement map

| Priority | IDs | Sprint / verification mapping |
| --- | --- | --- |
| P0 | C1 | S11/S13; V01 |
| P0 | C2 | S06/S08/S09/S10/S11; V01 |
| P0 | C3 | S07/S10/S11; V01 |
| P0 | C4 | S10/S11; V01 |
| P0 | C5 | S05/S10/S11; V01 |
| P0 | D1 | S04/S07/S13; V01 |
| P0 | D2 | S04/S05; V01 |
| P0 | D3 | S03/S05/S06; V01 |
| P0 | D4 | S08 with S09/S11 regressions; V01 |
| P0 | D5 | S07/S10/S13; V01 |
| P0 | U1 | S12/S13; V01 |
| P0 | U2 | S02/S12; V01 |
| P0 | U3 | S02/S12 with S11 revocation regressions; V01 |
| P0 | U4 | S02/S12/S13 and every protected feature; V01 |
| P1 deferred | C6, C7, D6, U5 | Phase 5; no scheduled sprint |
| P2 deferred | D7, U6 | No implementation milestone authorized |

## Open gates — preserved from technical PRD section 16

These gates remain open to the extent recorded below. Partial follow-up decisions do not close missing configuration, policy or verification. Use reversible scaffolding and synthetic fixtures while those prerequisites remain unresolved.

Storage follow-up decision,21–22 November2026: the user selected **Cloudflare R2**, supplied bucket/account endpoint and individual scoped credential files, and confirmed public development access disabled with no custom domains. Local CORS and live synthetic object/browser/original-byte checks pass. Jurisdiction/location, company privacy approval, production limits and object recovery policy remain open. This records follow-up decisions without changing either protected PRD.

| Gate | Owner / required evidence |
| --- | --- |
| Company approval for confidential OpenAI/OCR processing, privacy, residency, and no model training | Product/Security approval and provider controls before real SOPs |
| Pilot team, owner, launch date, document types and languages | Product owner confirmation |
| Cloudflare R2 configuration and object recovery | Supplied private configuration, user-confirmed public off/empty domains and full live synthetic object/browser/original-byte checks pass. Disabled development-domain HTTP probe remains unobserved due expired TLS, with no bypass. Jurisdiction/location, company policy and object recovery remain open. |
| OpenAI balance, exact reranker/answer/judge models and entitlements | Embedding follow-up22 November: user selected text-embedding-3-small/1,536 dimensions; catalog200 and one synthetic17-token embedding returned200/exact finite dimensions. Balance and reranker/answer/judge choices/access remain open; ADR23's name is not proof of availability. |
| OCR provider, limits and table quality | User approved temporary local PaddleOCR Docker setup on22 November, replacing Google for this local increment only. Offline runtime and synthetic quality/resource checks required; production provider/languages/table acceptance remain open. Original Google processor/region gates apply if Google is resumed. |
| Queue Mode progress/SSE bridge | RESOLVED for this implementation by VERIFIED S03: signed callbacks, durable PostgreSQL events and bounded authenticated Next.js SSE polling; production load/latency evidence remains later work |
| Scoring rubric and p50/p95 versus latency targets | Product/QA agreement and measurement |
| Chat/audit deletion, retention, backup expiry, Admin MFA | Security/Product policy; proposed 90-day audit and 30-day backup periods are not approved policy |
| Account recovery and Resend sender domain | Product/Engineering operational decision |
| File/page limits, VPS sizing, worker/OCR concurrency | Load-test evidence; 20 MB and 4 vCPU/8 GB are assumptions |

## Recording progress

For each authorized task record requirement IDs, scope, affected files, commands actually run and results, evidence locations, unresolved gates, and the next proposed phase. Mark a milestone complete only after its exit checks pass. Record approved decisions here or in the relevant guide; keep the original PRDs and their integrity baseline unchanged.

Use the sprint table as the status index, the feature checklists as acceptance criteria and the report template for actual evidence. Keep blocked checks visible until they can run against the candidate. [Verification template](docs/sprint-verification-template.md)
