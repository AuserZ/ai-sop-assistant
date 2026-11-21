# S03 independent QA

## Initial scope and candidate

The initial review below is preserved. Dated follow-ups at the end record later runtime and pruning evidence without rewriting earlier failures.

| Field | Recorded value |
| --- | --- |
| Sprint | S03 private workflow jobs and safe progress proof |
| Requirements | ADR 08/19; D3 job infrastructure; existing U4 owner/session enforcement |
| Predecessor | S02 recorded VERIFIED, including the authorized live account flow |
| Source | Uncommitted working copy on `codex/s03-workflow-jobs`, based on `b8d5a3306cf9fde7c158dd538b56b51234cdc638` |
| Independent verifier | QA agent `/root/s02_qa` |
| Date / environment | 20 November 2026, Windows PowerShell / Node; authorized synthetic checks only |
| Ownership | QA reads implementation/tests and owns only this report; lead/engineers own fixes, Docker, browser and fault execution |
| Current disposition | VERIFYING; final fault/recovery, native execution retention and hosted CI evidence remain open |

The approved technical PRD and original product PDF were read during the earlier review and remain unchanged. QA read the current repository/team/QA rules, current sprint acceptance and workflow contract, testing guidance, manifests, migrations, APIs, workflow export and verification code. The `verify-and-stop` skill governs this bounded verification; `investigate-first` informed evidence-first diagnosis. No application, test assertion, Docker resource, provider configuration or personal S02 account was changed by QA.

Key source references inspected:

| File / snapshot | SHA-256 |
| --- | --- |
| `drizzle/0002_workflow_jobs.sql` | `697a23d3f2909af1886d3866b39252579288cb902c32d8f2b2bbc475533c39ac` |
| `src/server/jobs/stream.ts` | `a54f3a4661f6ff58c07bd3b6ed5908f9ad96af490cc7759d041715474286be06` |
| `n8n/s03-probe.v1.json` | `b755d6d35866ee0121df94c6750d09503237c98c830952fd1644e7e3174c8fc3` |
| `tests/e2e/workflow-control.ts` | `5b292ed39f876b35c194489d8683becad395af59e0b349455eea0cf174472be9` |
| Initial runtime verifier, before cleanup fixes | `a72ade7b39aaa82e544d18e2cb367d8763c8ace0ee53570d530b52aab739fce4` |
| Verifier with demonstrated unframed-byte false pass | `7ae311aa7ce984c2c29e90797cb3a1901ad7032eef4f4c4a4130244eb8533edf` |
| Verifier with demonstrated duplicate-terminal false pass | `38a1c474afe8776495f4aacc69f543d1145cf291dca43682f8cc782080ef801e` |
| Verifier used for the final isolated 8 + 5 passing cases | `9a56d7abbe03bcabd7ad2cdec7aa9cb5cd6998cdc9b34d7d8c5cfeb80f150c38` |
| Subsequent verifier adding count-only inspector calls | `fdeccddfc28b8d0163bd6148877fd1034c62a7c8d13a93e665ddc65df89a67dc` |

The lead identified the last delta as inspector calls during paused queued work and after recovery cases, with collector/cleanup semantics unchanged. QA also inspected the added count-only inspector source. These are working-copy references, not a fabricated final commit or image identity. Final runtime/CI evidence must identify its actual candidate.

## Independent checks executed

| Check | Exact command / exercised scenario | Result and limit |
| --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` before inspection and before report creation | PASS for both original files |
| Unit suite | `npm.cmd test` | PASS: 28/28, six files, 6.40 seconds; includes all 14 existing authentication tests plus job/JWT/workflow and seven stream-pressure cases |
| Secret generation | `node --test infra/n8n/local-secrets.test.mjs` | PASS: 1/1, approximately 1.41 seconds. Uses an isolated temporary workspace; preserves old synthetic credentials, checks independent matching RSA identities, output redaction and refusal to replace a lost private key |
| Verifier syntax | `node --check scripts/verify-workflow-runtime.mjs` | PASS after the reviewed changes |
| Whitespace | `git -c core.autocrlf=false diff --check` | PASS before this report |
| Initial collector adversarial check | `node -` harness loading the unmodified `collect` function and helpers from source into `node:vm`; mocked fetch and native Response | FAIL on `7ae311aa…`: an unframed answer-like data fragment was ignored and completion accepted. No actual network, browser, Docker, database or private fixture was used |
| Intermediate collector check | Same isolated source-execution method | 4/5 PASS on `38a1c474…`; a second terminal frame after the first completion was still accepted |
| Final collector adversarial check | Same isolated source-execution method against `9a56d7ab…` | PASS: 8/8, described below; no watchdog fired |
| Final cleanup/deadline checks | `node -` harness executing actual async `serviceAction`, `restoreRuntime`, `check` and `until` helpers from `9a56d7ab…`; mocked Compose, service state and clock | PASS: 5/5, described below. Does not substitute for actual Docker recovery |

The isolated harnesses extract the named source functions without editing them and replace only their external dependencies. They do not run the script's top-level fixture loading or fault actions. Stream checks require rejection through the actual verification-error class, with specific framing errors where applicable, so an unrelated harness error cannot count as a passing negative case.

## Verifier findings, fixes and reruns

### QA-S03-01: failure paths could leave controlled services or collectors active

Initial source paused the worker before `createProbe` and entered its recovery `try/finally` only afterward in the app-restart case. A failed setup request could leave the worker paused. Worker kill and Redis stop also preceded local recovery blocks; a partially successful CLI action could escape restoration. The outer finalizer originally only logged out, and several collectors lacked cancellation on failure.

The lead registered touched services before the mutation command, added case-level and global restoration, canceled tracked collectors, required initially running/unpaused services and preserved a failing result if cleanup itself fails. The later async start waits for scoped inspected health, allowing a transient unhealthy state but rejecting stopped/dead services or expiry. All action calls are awaited. These fixes preserve explicit project/workspace ownership checks.

Isolated passing cases on `9a56d7ab…`:

- Setup failure after a successful pause cancels the collector and restores the worker.
- A pause command that mutates state and then throws still restores the worker.
- Cleanup failure cannot print PASS and retains the touched service for an outer restoration attempt.
- An on-time matching predicate is accepted.
- A matching predicate that finishes after its deadline is rejected.

Actual final Docker health/restoration proof remains separately required; the isolated cases prove control flow with mocked external operations.

### QA-S03-02: capture parser could hide bytes and duplicate terminals

The first isolated negative scenario demonstrated a false pass because frames without an `event:` line were skipped before safety validation. The next source fixed that grammar but canceled at the first completion, making its one-terminal assertion unable to see a duplicate terminal later in the same response. Neither finding established that the application emitted those bytes; these were defects in the verification tool.

The final parser accepts only its exact heartbeat comment, exact event line structure, strict DTO key sets and allowed stages/literals. It requires a positive safe integer cursor for the expected job, rejects reordered/duplicate sequences, enforces the remaining global deadline, waits for clean EOF after completion and rejects later data or transport failure. Byte/event limits and malformed JSON are fatal verification errors rather than reconnect reasons.

Final isolated collector outcomes on `9a56d7ab…`, all PASS:

| Scenario | Required observed behavior |
| --- | --- |
| Valid literal-only progress/completion plus heartbeat | Accepted only after clean EOF |
| Unframed procedural trap | Rejected |
| Duplicate data line in a frame | Rejected |
| Incomplete frame at EOF before terminal | Rejected with the incomplete-frame error |
| Second terminal frame | Rejected |
| Unexpected frame after terminal | Rejected |
| Incomplete bytes after terminal | Rejected |
| Transport failure after terminal | Rejected instead of reported successful completion |

This closes the demonstrated parser false passes for the checked source and isolated scenarios. The final full runtime run must use the stricter verifier.

## Requirement and evidence matrix

| Area | Meaningful coverage inspected | Current evidence / remaining gate |
| --- | --- | --- |
| Owned idempotent jobs | Concurrent same-owner creation, conflicting inputs, cross-owner Admin denial, immutable identity trigger | Unit/static inspection complete; real PostgreSQL final rerun is owned by DevOps |
| Signed callbacks | Fixed direction/key/algorithm, strict required claims, freshness/body/path binding, replay nonce race and execution/attempt fencing | JWT/workflow units PASS; native HTTP and PostgreSQL proof belongs to runtime evidence |
| Durable dispatch | Competing batch claims, bounded retries, lost leases, stale attempt rejection, completion-before-ack without state regression | Real database assertions inspected; final actual run must be recorded |
| Ordered synthetic outcome | Deterministic negative scenario fails; no skip from claim to completion; one literal synthetic completion after explicit stub gates | Units PASS; lead reports actual workflow browser success; no real judge or SOP answer is claimed |
| Owner/session release | User/session locks on each event release, foreign/future cursor denial, cancellation/reconnect and deactivation | Native stream and real database assertions inspected; final revoked-stream/proxy check remains required |
| Native stream pressure | Seven tests use actual WHATWG ReadableStream queuing with mocked storage and a fake clock, including blocked polling, heartbeat/timeout budgets, hard close, revocation and abort | PASS in the 28-test unit run; these do not establish database, proxy or OS-buffer behavior |
| Slow browser reader | Real browser pauses one reader while another observes completion, then drains and counts the delayed result | Lead reports 10/10 browser tests PASS: six authentication plus four workflow cases. This is attributed, not a QA-executed browser run |
| Faults and cleanup | Scoped worker pause/loss, Redis interruption, app restart, revoked stream, and a subsequently added actual proxy timeout/reconnect case | Initial lead run reportedly passed four cases before a revocation/cleanup failure; final six-case run is pending after health and verifier corrections |
| Storage/log privacy | Native execution save/pruning settings, count-only DB/Redis/log inspection and credential boundaries | Native retention gate OPEN; details below |
| Hosted regression gate | Lint/types/build, unit, real database, workflow/browser and scoped runtime checks | S03 hosted CI NOT RUN during this review; earlier S02 hosted results do not establish S03 acceptance |

The finite normal probe emits far less than the 65,536-byte production queue budget. A slow browser completing that finite probe cannot demonstrate that the production queue actually filled. Combined native-stream pressure tests and finite real proxy observations provide their stated, separate bounds. They do not establish large-answer/S11 load behavior or a production latency guarantee.

## Boundaries and open runtime evidence

Static inspection confirms that fixture control mounts only `.local-secrets/browser-fixtures`, not the parent directory containing personal/provider configuration. Before deactivation it checks both stored target and actor emails against the expected synthetic `.invalid` identities, then uses current Admin/session guards. Job status access is limited to stored fixture ownership. The fault script validates its explicitly named Compose project and working-directory labels before controlling a service. The proxy blocks browser access to internal callback routes; n8n, Redis, PostgreSQL and app have no direct published host port in this topology.

QA inspected `infra/n8n/inspect-execution-storage.mjs`: it checks project/workspace ownership, executes read-only scoped SQL, reads project-local Redis/log data and emits counts rather than payloads or key values. Its output is an observation, not by itself proof that all retained JWT rows were removed. Only the private-key/log assertions are immediate failures in that inspector.

The lead reports that count-only inspection found a JWT-bearing abandoned running execution row. Native pruning excludes running rows, so a declared save/prune setting is insufficient. The team is using the supported native crash-recovery interval, then verifying transition to crashed and subsequent pruning. This is an OPEN retention/recovery gate, not an observed browser/public disclosure. Do not report it PASS until actual transition and removal evidence exists. No direct internal-table mutation is accepted as a shortcut.

The two initial database failures remain preserved in the main sprint report: nonce pruning incorrectly requested UPDATE privilege through `FOR UPDATE`, and a stream test assumed a semantic event aligned with its first byte chunk. The fixes retain least privilege and read until the semantic boundary; neither an edited test nor an earlier partial pass establishes the final database result without rerunning it.

No RAG retrieval, SOP ingestion, real judge, provider/model entitlement, citation fidelity, source fallback, company document processing or production deployment is verified by S03. Those gates remain in their planned phases. S02 personal/provider state was not read or modified by QA during this review.

## Initial disposition

Independent unit, isolated secret-generation, parser, cleanup and deadline checks have passing results with the recorded limits. Demonstrated verifier defects were reported to the lead and rechecked after fixes. Final native crash recovery/pruning, final six-case fault execution, candidate security evidence and hosted CI remain required before the project-manager lead can mark S03 VERIFIED. S04 is not authorized by this report.

Only this assigned evidence file was edited by QA. Original PRD integrity and whitespace checks are rerun after report creation.

## Local runtime and pruning follow-up: 21 November 2026

The lead supplied the completed strict runtime run from 20 November: process exit 0 with all six checks passing. QA independently reread the final verifier source and its cleanup, frame, cursor, timeout/reconnect and account-denial checks. These physical fault actions were executed by the lead, not QA. Their durations include each check's restoration work and are observations, not production recovery guarantees.

| Lead-executed strict runtime check | Result | Measured duration |
| --- | --- | --- |
| Queued work waits for a paused worker, then completes | PASS | 24.391 seconds |
| In-flight worker loss fences the abandoned attempt and recovers | PASS | 50.321 seconds |
| Redis interruption preserves durable work | PASS | 19.606 seconds |
| App restart preserves the job and reconnect cursor | PASS | 27.662 seconds |
| Live account deactivation closes the stream and denies further access | PASS | 9.302 seconds |
| Actual proxy stream timeout and durable reconnect | PASS | 72.358 seconds, exercising the configured 60-second stream timeout |

The executed host verifier is SHA-256 `fdeccddfc28b8d0163bd6148877fd1034c62a7c8d13a93e665ddc65df89a67dc`. Its delta from the isolated-tested `9a56d7ab…` adds count-only inspector calls; the reviewed collector and cleanup semantics remain unchanged. The application stream `a54f3a46…`, workflow graph `b755d6d3…` and migration `697a23d3…` remain unchanged. The earlier four-pass/one-failure runtime run and verifier false-pass reproductions above remain historical failure evidence; this final strict run supplies the subsequent recovery verification.

### Independent normal-configuration storage snapshot

QA coordinated a stable read-only window with DevOps and independently ran:

```powershell
$env:SOP_WORKFLOW_TEST_PROJECT = 'ai-sop-s03-verify-20261120'
node infra/n8n/inspect-execution-storage.mjs
```

The command exited 0 at `2026-11-21T01:43:11.571Z`. Inspector SHA-256: `37a61822eae4cc48d2e6d2dde0d199b3eb5df2429b9c5119510e44d370fcfdfd`. QA inspected the source first: project/workspace ownership guards precede reads; SQL uses `BEGIN READ ONLY`; direct `execution_data` counts filter the probe workflow independently of the execution-entity join and count orphan rows. Only aggregate counts are printed. No service or database mutation, provider call, S02 personal-data access or key-value output was performed by QA.

| Independently observed field | Result |
| --- | --- |
| Probe execution-entity groups | Empty array |
| Direct probe payload rows | 0 |
| Direct payload rows with JWT / private-key marker | 0 / 0 |
| Orphan probe payload rows | 0 |
| Redis hash rows / JWT occurrences / authorization-marked hashes | 0 / 0 / 0 |
| Redis list / sorted-set items | 0 / 0; two metadata keys remain |
| Docker logs: n8n main and worker | JWT, bearer and private-key marker counts all 0 |
| Native event files: main and worker | Both files actually scanned; JWT, bearer and private-key marker counts all 0 |
| Deferred paused scans in this final snapshot | None |

The inspector deliberately emits only `status: DEFERRED_PAUSED` for a paused service's native file scan; it does not fill that missing observation with zero counts. The final snapshot above ran unpaused and returned actual native-file counts. DevOps owns the separate paused-branch integration regression.

QA's earlier independent snapshot at `2026-11-20T13:22:50.523Z` observed eleven JWT-bearing terminal payload rows with 45 JWT occurrences, including two crashed execution rows, plus nine soft-deleted rows. Docker/native log marker counts were already zero. The final direct-data/orphan check establishes that those probe payloads are now physically absent, rather than hidden only by the entity join or soft deletion. The observation gap is approximately 12 hours 20 minutes; the exact deletion time was not measured.

DevOps reports the same n8n-main container `5e8e4dda…`, started on 20 November at approximately 13:13 UTC with restart count 0 and base configuration only. The earlier crashed-row count increased from its startup baseline of one to two while that main stayed running, supporting periodic recovery rather than a new startup cleanup. Reported effective settings are age 1 hour, hard-delete buffer 1 hour, soft-prune interval 60 minutes, hard-prune interval 15 minutes and queue-recovery interval 1 minute. These configuration/identity observations are attributed to DevOps; QA independently executed the final aggregate snapshot. No accelerated pruning experiment or direct internal-table mutation was needed or started.

Local disposition: the demonstrated verifier defects have passing isolated checks and a subsequent strict six-case runtime pass. The native recovery/pruning observation now supports closing that bounded local evidence gap. This does not claim zero transient JWT storage, an exact deletion deadline, universal log absence or an approved production retention policy. Final candidate checks, security disposition and hosted S03 CI must still be recorded before sprint closure; hosted CI remains NOT RUN at this follow-up. No S04 or deployment follows from this report.

Only this QA report was edited. PRD integrity and `git diff --check` were rerun after the append.
