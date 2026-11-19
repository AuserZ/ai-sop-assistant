# Sprint verification report template

Use this template after an authorized feature sprint is implemented, following [PLANS.md](../PLANS.md) and the [testing matrix](testing.md). Create `docs/verification/Sxx.md` only when there is actual work/evidence to report. When copying this template into that deeper directory, adjust relative links accordingly. Do not edit the [approved technical PRD](<../AI SOP Assistant — Technical Product Req.md>) or original product PDF.

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint ID and feature | Not recorded |
| Original requirement IDs / ADRs | Not recorded |
| Phase, dependencies and acceptance checklist | Not recorded |
| Implementation owner and verifier | Not recorded |
| Candidate commit or exact working-copy identifier | Not recorded |
| Image/workflow/pipeline/schema/configuration versions, if applicable | Not recorded |
| Environment, fixture/dataset versions, configured models, if applicable | Not recorded |
| Verification date and time | Not recorded |
| Overall result | NOT RUN |

Identify the revision actually checked. Record applicable provider entitlement/configuration and approved scope without secrets. If there is no Git commit yet, use an explicit working-copy identifier and integrity/artifact references; do not invent a commit or imply repeatability that is missing.

## Implemented outcome

Describe the feature's observable behavior, affected files and contracts/migrations/workflows, requirement mapping, and the completed acceptance scenarios. Record any scope reduction or unresolved dependency; do not equate a written plan or mocked interface with completed behavior.

## Executed checks

Use PASS, FAIL, BLOCKED or NOT RUN for applicable checks. NOT APPLICABLE needs a concrete reason and cannot waive a mandatory acceptance gate. Add one row per actual command/scenario; leave future checks explicitly NOT RUN.

| Check / requirement | Exact command or exercised scenario | Result | Sanitized evidence / artifact | Failure or limitation |
| --- | --- | --- | --- | --- |
| Feature success and failure cases | Not run | NOT RUN | None | Not recorded |
| Relevant unit / database / workflow / browser regressions | Not run | NOT RUN | None | Not recorded |
| Applicable lint / type / build / security checks | Not run | NOT RUN | None | Not recorded |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | NOT RUN | None | Not recorded |

For relevant features include role/ownership/deactivation, verified ACTIVE filtering in both queries, idempotency, OCR/conversion failures, citation/source mapping, judge failures and captured stream safety. Link actual logs/results rather than copying sensitive output. Screenshots alone cannot prove server authorization or absence of prevalidation SSE bytes.

## Failed checks, fixes and reruns

For each failure record its triggering scenario, affected requirement, fix/revision and subsequent executed checks/results. Unresolved required failures or missing external configuration keep the sprint in VERIFYING or BLOCKED. If code changes after a successful run, rerun the affected checks against the new revision.

## Benchmark and operations, when applicable

For release-affecting model/retrieval/workflow changes, record the actual 50-question dataset/rubric and model/configuration versions, correct answers out of 50, valid supporting citations, invented-step count and per-case evidence. Required thresholds: ≥43 correct, 100% valid supporting citations and 0 invented procedural steps in that set. Distinguish first progress, first meaningful answer and completion timings with the agreed p50/p95 interpretation.

For recovery/deployment features, link real isolated restore, smoke and rollback evidence plus immutable artifact identities. Keep production approval separate. For final candidate or pilot reviews, follow V01/V02 in the plan; never fill pilot adoption before observation or claim model-training/privacy controls without evidence.

## Closure

| Closure item | Recorded result |
| --- | --- |
| Every sprint acceptance item checked against the candidate | NOT RUN |
| Required checks passed; failures fixed and affected checks rerun | NOT RUN |
| Open gates/risks and owners recorded | NOT RUN |
| Affected docs/contracts and PLANS.md status updated | NOT RUN |
| Original PRD integrity confirmed after changes | NOT RUN |
| Final sprint status | NOT RUN |
| Next proposed authorized feature / required decision | Not recorded |

Mark VERIFIED only after all applicable required checks pass. Report what changed, which files changed, actual checks/results, remaining risks and next proposed work. This report does not authorize unrelated implementation, real SOP processing, provider charges, or deployment.
