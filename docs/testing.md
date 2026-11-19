# Testing and acceptance

The S01 foundation and S02 authentication provide package scripts, unit/database tests and authentication browser journeys. The matrix below also describes checks for later sprints. [Technical PRD, sections 0, 5–8, 14–16](<../AI SOP Assistant — Technical Product Req.md>)

## Commands and evidence

Run these commands from the project root with Node.js 24 or later and npm. On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`.

```powershell
npm ci
npm run check:prd
npm run lint
npm run typecheck
npm test
npm run build
```

The unit suite checks that application, migration and workflow credentials remain separate. A separate integration suite requires a migrated disposable PostgreSQL database with pgvector. Run it using the local Compose setup and see the verification report for checks executed on this host. [Local runtime](deployment.md) · [S01 verification](verification/S01.md)

All development/CI documents are synthetic. External provider calls need authorized scope and verified configuration; mocks are the normal failure/contract-test boundary. Use real disposable PostgreSQL/pgvector for database semantics. Do not infer query filtering or transaction correctness solely from mocks.

S02 uses real Better Auth handlers and PostgreSQL for invitation races/rollback, cookie and stale-session behavior, role/ownership, deactivation/login races, origin/body bounds and atomic shared limits. Email rendering/failure/timeout tests inject Resend; they do not send email. The browser suite requires a healthy local Compose app and `tests/e2e/seed.ts` run inside tooling with `SOP_SYNTHETIC_AUTH=1` and `BROWSER_FIXTURE_DIRECTORY` bound to the ignored host `.local-secrets` directory. Then run `npx playwright install chromium` and `npm run test:browser`. No public fixture route exists; no traces/videos or credential screenshots are recorded. See [authentication](authentication.md) for the fixture scope and the sprint report for actual results.

## Feature sprint verification

Follow the ordered feature sprints and definition of done in [PLANS.md](../PLANS.md). Add tests during implementation, then run a distinct verification pass against the finished sprint revision. Exercise success, failure and relevant regression paths through actual APIs/database/workflows/UI as applicable. Fix failures within the authorized scope and rerun affected checks before marking the sprint VERIFIED.

Record exact commands, candidate/environment/configuration, actual outcomes, sanitized artifacts and unresolved gates with [the sprint verification template](sprint-verification-template.md). Missing services/provider configuration or skipped mandatory checks are BLOCKED or NOT RUN, never PASS. Mocked-only contract checks do not establish live provider compatibility.

After S01–S16, run V01 against the identified release candidate, including all P0 tests, the 50-question benchmark, stream and source safety, security, latency, recovery and provider gates. Production approval remains separate. Run V02 after launch using observed pilot usage to assess the 60% weekly adoption target. V01 and V02 remain NOT RUN.

## Requirement and invariant matrix

| Area / IDs | Minimum observable cases | Intended layer |
| --- | --- | --- |
| Identity/RBAC, U1–U4 | Invite-only login, email/role-bound single use/expiry, Staff cannot mutate documents/users, active-status recheck, deactivation affects ongoing access, cross-user chat denied | Vitest + database + Playwright |
| D1/D2 uploads/storage | Real file signature/MIME/size/hash checks, invalid/oversized upload, private source references, expired/unauthorized links | Unit/integration/E2E |
| D3 extraction/jobs | Native/scanned/mixed PDF and DOCX; OCR timeout/failure, conversion failure, preserved digits/units/tables, duplicate jobs/callbacks, bounded retries | Integration + exported n8n contracts |
| Activation invariant | Hash/job/snapshot/reviewer agreement; stale approval denied; no worker auto-activation; pending/failed/rejected excluded | Database + workflow contracts |
| D4 deletion | Eligibility removed transactionally before cleanup; late callback/racing retrieval cannot revive deleted evidence; retries reconcile cleanup | Database + workflow contracts |
| C2 retrieval | ACTIVE eligibility inside each semantic and keyword query; non-ACTIVE high-scoring traps; RRF identity/deduplication; unknown rerank IDs rejected | PostgreSQL/pgvector integration + contracts |
| C3 citations / D5 | Every claim's real document/chunk/title/section mapping; genuine page provenance; no generated URLs; source revocation during/between requests | Unit/integration/E2E |
| C4 fallback | Exact `No SOP found for this question` and no citations for unsupported question; provider/internal outages yield distinct safe errors | Unit/contract/SSE |
| C5 procedure fidelity | Original order, numbers, units, conditions/table context; no plausible added step | Unit + RAG benchmark |
| Validation | Deterministic failure, unsupported quantity, missing/forged citation, judge disagreement/uncertainty/malformed output/timeout; no candidate released | Unit/contract/SSE |
| C1 chat/persistence | Owner-scoped current session, bounded context, fresh follow-up retrieval, retry does not duplicate messages; reopening C7 remains P1 | Database + Playwright |
| Stream safety | Capture outbound SSE bytes; before both checks pass only allowlisted progress; disconnect/reconnect/replay/backpressure/late callback/revocation preserve safety | SSE integration + Playwright |
| Security | File prompt injection, SSRF, malformed conversion input, privilege escalation, replayed webhooks, secret redaction, non-public internal ports | Focused adversarial/infrastructure checks |
| Recovery | Restore app+n8n databases, pgvector, original encryption key and object access; reconcile queue/jobs; synthetic chat smoke | Isolated restore drill |

Use Vitest for unit/database integration, Playwright for browser journeys, reviewed versioned n8n JSON with mocked providers for workflow contracts, and focused security/dependency checks as required by the PRD. Establish exact test filenames/layout through implementation; avoid tests that merely mirror code or match documentation wording.

## Golden benchmark

Version a 50-question dataset and scoring rubric. Include exact title/code lookup, paraphrase, multi-section procedures, follow-ups, unsupported questions, inactive/deleted sources, near-duplicates/conflicts, scanned digits/units/tables, forged citations, injection and revoked source links. Keep source fixtures and expected supporting evidence synthetic and immutable within a dataset version.

Record candidate commit, dataset/scoring version, source/pipeline/workflow versions, actual configured models, retrieval parameters, individual judgments, citation support, invented-step counts, and stage timings. Release gates are at least 43/50 correct (≥85%), 100% valid supporting citations, and 0 invented steps in this set. Rerun before release-changing model/retrieval/workflow changes. Optional Ragas tooling does not replace the explicit rubric or source checks.

Measure first progress, first meaningful validated answer, and completion separately. Preserve the under-30-second usefulness goal and 3-second-start/10-second-finish technical targets. The product owner/QA must agree p50/p95 interpretation and tradeoffs; do not count an `accepted` event as answer start. Pilot weekly adoption target ≥60% requires pilot observations, not CI.

## Release evidence

For each changed requirement, report exact executed commands, environment/configuration, results, skipped checks, evidence paths and remaining risks. CI must run implemented lint/type/unit/integration/E2E/contract/security checks. No fabricated percentages, green checks, latency guarantees or universal hallucination-elimination claims. Use [verify-release](../.agents/skills/verify-release/SKILL.md) for readiness and [deployment](deployment.md) for the approval gate.
