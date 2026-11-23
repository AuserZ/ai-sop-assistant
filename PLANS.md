# Development plan by feature sprint

Source: [approved technical PRD](<AI SOP Assistant — Technical Product Req.md>), sections 0, 14–16, and [original product PRD](<PRD AI SOP Assistant.pdf>). This plan does not change either source. Status updated on 23 November 2026.

## Current state

- **Verified sprints:** `S01`–`S07` are **VERIFIED** against their recorded candidates (detailed S01–S07 history archived in [verification history](docs/verification/history.md)).
- **Latest closure (S07):** Published source `ae644f95ef1a155e047f0baabcd4af52f169e31d` (tree `264eff0116d6db120fadcb13173eea3b02a82615`) on `codex/s07-library-access`; [hosted run 45149286306](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45149286306) passed `foundation` `20/20` + `changes` `5/5` (with `paddleocr` `9/9` passed on `6a44efc` in [run 45146557698](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45146557698)); independent Security ([S07-security.md](docs/verification/S07-security.md)) and QA ([S07-qa.md](docs/verification/S07-qa.md)) PASS. [S07 evidence](docs/verification/S07.md).
- **Next permitted sprint:** **S08** — SOP deletion and reliable unindexing (`D4`). Not started yet.
- **Team & workflow cadence:** Project manager orchestrates fresh per-sprint specialist subagents (up to 3 concurrent; invoke DevOps only when Docker/Compose/CI/runtime files change), uses [sprint preflight checklist](docs/sprint-preflight-checklist.md) before coding, runs a 2-pass Security/QA cycle (Pass 1 pre-push review → Fix/Push/CI → Pass 2 single closure pass), and recommends `/compact` or a fresh chat between sprints ([development-team.md](docs/development-team.md), [coding-standards.md](docs/coding-standards.md)).
- **Standing constraints:** Preserve P0 order, 3-menu cap, protected PRDs, and all PRD section 16 open gates below. Open S14/pre-V01 item: 4 moderate dev-chain Node advisories (`GHSA-67mh-4wv8-2f99`); do not describe full audit as clean.

## Sprint sequence

Default execution order is S01–S16. Each sprint depends on the VERIFIED predecessor; earlier verified features remain regression dependencies. Missing external decisions may allow reversible scaffolding but never permit marking a provider-dependent feature VERIFIED.

| Sprint | Feature / demonstrable outcome | PRD phase | Primary mapping | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| S01 | Secure application runtime, database and CI foundation | 0 | ADR 01/02/09/14/15 | VERIFIED | [S01.md](docs/verification/S01.md) |
| S02 | Invitation-only sign-in and role authorization | 0 | U2/U4; U3 enforcement | VERIFIED | [S02.md](docs/verification/S02.md) |
| S03 | Durable private workflow jobs and safe progress proof | 0 | ADR 08/19; D3 foundation | VERIFIED | [S03.md](docs/verification/S03.md) |
| S04 | Admin private SOP upload | 1 | D2; D1 upload status; ADR 03 | VERIFIED | [S04.md](docs/verification/S04.md) |
| S05 | SOP extraction, OCR, previews and indexing | 1 | D3; ADR 04/05/11/21/22 | VERIFIED | [S05.md](docs/verification/S05.md) |
| S06 | Assisted verification and revision-bound activation | 1 | D3; ADR 17 | VERIFIED | [S06.md](docs/verification/S06.md) |
| S07 | SOP library search and authorized original access | 1 | D1/D5 | VERIFIED | [S07.md](docs/verification/S07.md) |
| S08 | SOP deletion and reliable unindexing | 1 | D4 | PLANNED | — |
| S09 | Verified ACTIVE hybrid retrieval and reranking | 2 | C2; ADR 10/23 | PLANNED | — |
| S10 | Evidence-validated procedural answers and citations | 2 | C2/C3/C4/C5; ADR 12 | PLANNED | — |
| S11 | Chat SSE and persisted current-session conversation | 3 | C1–C5; ADR 18/19 | PLANNED | — |
| S12 | Admin user directory and account management | 3 | U1/U2/U3/U4 | PLANNED | — |
| S13 | Responsive three-menu experience | 3 | C1/D1/D5/U1/U4; ADR 20 | PLANNED | — |
| S14 | Operational monitoring and security hardening | 4 | ADR 13/15; PRD sections 12–14 | PLANNED | — |
| S15 | Encrypted backups and verified disaster recovery | 4 | ADR 16; PRD section 13 | PLANNED | — |
| S16 | Approval-gated deployment and rollback capability | 4 | ADR 09/14; PRD sections 14/16 | PLANNED | — |

## Definition of done — applies to every sprint

Status flow: `PLANNED → IN_PROGRESS → IMPLEMENTED → VERIFYING → VERIFIED` (or `BLOCKED` with missing prerequisite). IMPLEMENTED means code exists; VERIFIED means every required acceptance check passed against the recorded revision.

1. Spawn fresh specialist subagents for the sprint; read [sprint preflight checklist](docs/sprint-preflight-checklist.md), inspect actual code/tests/manifests, map requirement IDs/ADRs, and assign bounded ownership (invoke DevOps only if Docker/Compose/CI/runtime files change).
2. Implement the smallest coherent increment with real success/failure automated tests; run `check:prd`, `lint`, `typecheck`, and unit tests cleanly before review.
3. **Pass 1 (Pre-push):** Independent Security and QA review the local candidate once (apply `validate-rag` for extraction/retrieval/answer changes).
4. Fix findings, push, and wait for hosted CI (single ~12-minute wait unless local Docker or authenticated `gh` is available).
5. **Pass 2 (Single closure pass):** Independent Security and QA verify the fix diff and green CI run together in one pass and write compact table receipts.
6. Run `node .codex/scripts/check-prd-integrity.mjs`, record compact evidence with [the sprint verification template](docs/sprint-verification-template.md) in `docs/verification/Sxx.md`, update `PLANS.md`/`AGENTS.md`, push closure, and recommend `/compact` or a fresh chat before the next sprint.

## Phase 0 — foundation and security

### S01 — secure application runtime and database foundation
**VERIFIED** (`59fa63f`, hosted `44485878184`, [S01.md](docs/verification/S01.md)). **Mapping:** ADR 01/02/09/14/15.
- [x] A clean source copy installs reproducibly and the application build/start smoke test succeeds.
- [x] Fresh database migrations and disposable PostgreSQL/pgvector integration checks pass; n8n credentials cannot modify authoritative application approvals.
- [x] Compose resolves with synthetic configuration; internal services are not publicly exposed and no secret appears in source/client/log output.
- [x] CI runs its declared lint/type/build and initial unit/integration checks; record exact commands and results.

### S02 — invitation-only authentication and authorization
**VERIFIED** (`1ce6fbe` + `964687c`, hosted `44548005713`, live invite confirmed, [S02.md](docs/verification/S02.md)). **Mapping:** U2/U4, U3 enforcement, ADR 06/07.
- [x] Intended-email invitation acceptance works; expired/reused/wrong-email/forged invitations and public signup fail.
- [x] Staff cannot invoke Admin operations, unauthenticated callers are denied, and ownership checks reject cross-user access.
- [x] Deactivation/session revocation prevents subsequent protected actions; stale role/session data cannot retain privileges.
- [x] Authentication cookies, CSRF/rate-limit behavior and invitation email rendering are checked with synthetic data.
- [x] One authorized real invitation was received and accepted; user sign-in and active account/session were confirmed. Injected delivery alone was not used to close this gate.

### S03 — durable private workflow jobs and safe progress proof
**VERIFIED** (`0396cf6`, hosted `44852222243`, [S03.md](docs/verification/S03.md)). **Mapping:** ADR 08/19; D3 job infrastructure.
- [x] Forged, expired, replayed and cross-job callbacks fail; duplicates do not create duplicate transitions/results.
- [x] Worker restart and queue interruption reconcile durable jobs without losing ownership or unbounded retries.
- [x] Captured browser stream contains only allowlisted progress before synthetic validation passes; no arbitrary node output or draft procedural content leaks.
- [x] Browser disconnect/proxy buffering/timeout paths are exercised; n8n editor, Redis and service credentials remain private.

**Phase 0 exit:** S01–S03 VERIFIED.

## Phase 1 — document features

### S04 — Admin private SOP upload
**VERIFIED** (`1ef8521`, hosted `45018939728`, live R2 checks passed, [S04.md](docs/verification/S04.md), [private-uploads.md](docs/private-uploads.md)). **Mapping:** D2, D1 upload-status groundwork, ADR 03.
- [x] Admin valid PDF/DOCX upload succeeds; Staff/anonymous upload and invalid signature/type/size/checksum fail.
- [x] Missing/incomplete or wrong-object finalization cannot create an eligible document or trusted processing result.
- [x] Duplicate finalization/request retries create one logical job; signed upload access expires and cannot target unrelated objects.
- [x] Original files remain private and UPLOADED/PROCESSING documents cannot be Staff evidence.

### S05 — SOP processing, OCR, previews and indexing
**VERIFIED** (`caf0fc7`, hosted `45102843612`, [S05.md](docs/verification/S05.md), [paddleocr-setup.md](docs/paddleocr-setup.md)). **Mapping:** D3, ADR 04/05/11/21/22 + temporary local PaddleOCR follow-up.
- [x] Synthetic native PDF, scanned PDF, mixed pages and DOCX complete with faithful digits/units/tables/section provenance.
- [x] OCR/conversion/embedding failure and malformed/oversized inputs retry only as allowed, then fail safely with restricted diagnostics.
- [x] Duplicate jobs and worker retries do not duplicate chunks; expired file references renew only through authorized backend access.
- [x] No processing result activates a source or exposes it to Staff retrieval. Exported workflow-contract tests and provider compatibility evidence are recorded separately.

### S06 — assisted verification and atomic activation
**VERIFIED** (`14e2d54`, hosted `45122984069`, [S06.md](docs/verification/S06.md)). **Mapping:** ADR 17; D3 activation invariant.
- [x] Admin can approve a valid snapshot and reject questionable text; Staff/worker approval attempts fail.
- [x] Stale hash/job/snapshot, empty chunks, incomplete processing and concurrent changed-state approvals are rejected.
- [x] Reprocessing requires renewed verification; ACTIVE originals cannot be mutated in place. Replacement remains D6/P1.
- [x] Review panels show real data/mappings and audit entries; approval and state updates commit consistently or roll back together.

### S07 — searchable SOP library and original access
**VERIFIED** (`ae644f9`, hosted `45149286306`, [S07.md](docs/verification/S07.md)). **Mapping:** D1/D5 and U4.
- [x] Search/table metadata and original access work for Admin/Staff according to role and current account state.
- [x] Guessed IDs, non-ACTIVE sources, unauthorized previews, expired links and deactivated sessions fail safely.
- [x] Signed link issuance rechecks source status; test/document the residual bearer-access window until link expiry.
- [x] Browser tests cover search, open/download, keyboard operation and usable narrow-screen behavior; no fourth menu is added.

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

## Verification after authorized launch — V02 pilot acceptance

**Status:** NOT RUN. **Prerequisites:** V01 PASS, required manual deployment approval, identified pilot team/owner/date, approved real-data processing and passing post-deployment smoke checks.

- [ ] Run protected production health/functional smoke checks within the authorized scope; confirm current source availability, access controls and safe answer delivery.
- [ ] Observe the pilot against the agreed rubric, latency measures and support process. Record actual problems and re-open relevant feature verification when fixes change behavior.
- [ ] Measure weekly active pilot staff against the agreed eligible pilot roster and observation window; target at least 60%. Owner must define measurement/retention before collection; no analytics dashboard or fourth menu is implied.
- [ ] Record product/QA/security/operations acceptance and unresolved risks with owners. Do not claim universal correctness from benchmark or pilot results.

## Phase 5 — deferred feature backlog

Only after P0 acceptance and an explicit request, plan separate feature sprints for C6 thumbs feedback, C7 reopening past chats, D6 immutable file replacement/reverification, and U5 password-reset enhancements. No P1 sprint is scheduled or authorized now. D7 owner/review metadata and U6 SSO remain P2. Excluded integrations, AI SOP drafting, formal approval chains, dashboards and native apps remain out of scope.

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

| Gate | Owner / required evidence |
| --- | --- |
| Company approval for confidential OpenAI/OCR processing, privacy, residency, and no model training | Product/Security approval and provider controls before real SOPs |
| Pilot team, owner, launch date, document types and languages | Product owner confirmation |
| Cloudflare R2 configuration and object recovery | Selected 21–22 Nov 2026; private config, public URL off/no custom domains, live synthetic object/browser/original-byte checks PASS (disabled dev-domain probe unobserved due expired TLS). Jurisdiction, company policy and object recovery remain open |
| OpenAI balance, exact reranker/answer/judge models and entitlements | Embedding follow-up 22 Nov: `text-embedding-3-small`/1,536 dims verified (`200`, 17 tokens, 1,536 finite values). Balance and reranker/answer/judge choices/access remain open |
| OCR provider, limits and table quality | Temporary local PaddleOCR Docker setup approved 22 Nov; production provider/languages/table acceptance remain open (Google processor/region gates apply if resumed) |
| Queue Mode progress/SSE bridge | RESOLVED by VERIFIED S03 (signed callbacks, durable PG events, bounded Next.js SSE); production load/latency remains later work |
| Scoring rubric and p50/p95 versus latency targets | Product/QA agreement and measurement |
| Chat/audit deletion, retention, backup expiry, Admin MFA | Security/Product policy (proposed 90-day audit / 30-day backup not approved policy) |
| Account recovery and Resend sender domain | Product/Engineering operational decision |
| File/page limits, VPS sizing, worker/OCR concurrency | Load-test evidence (20 MB and 4 vCPU/8 GB are assumptions) |

## Recording progress

Keep `PLANS.md` compact (archive finished sprint narrative in `docs/verification/Sxx.md` and [history.md](docs/verification/history.md)). Record requirement IDs, exact candidate SHAs, commands/results, residual limits, and open gates in `docs/verification/Sxx.md` using [sprint-verification-template.md](docs/sprint-verification-template.md). Keep protected PRDs and baseline hashes unchanged.
