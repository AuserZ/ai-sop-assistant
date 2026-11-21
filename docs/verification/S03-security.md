# S03 independent security review

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Date | 20–21 November 2026, Asia/Jakarta; final local evidence and frozen source checked on 21 November |
| Requirements | ADR 08/19; D3 job infrastructure; U4 current access; technical PRD sections 0, 3, 8 and 12–14 |
| Branch / base | `codex/s03-workflow-jobs`; reviewed working copy based on `b8d5a3306cf9fde7c158dd538b56b51234cdc638`, then published as `0396cf606b8e34a805a038b273a103687a691ce1`; S02 closure `14ab58698f7432a96727bb01442ec71d0fea9ad6` |
| Reviewed source snapshot | SHA-256 `5f9ebfb3cf3fe586216aad78c661f44009c6e217828b3db169ea1b7b7d914cc8`, covering the 41 files listed below, including final native helpers and CI |
| Reviewer / ownership | Independent security specialist. Fullstack/DevOps/lead own implementation, runtime operations and fixes. This reviewer owns only this report. |
| Result | SCOPED REVIEW COMPLETE. R1, F2 and R3 are resolved against the inspected source and recorded local evidence, with limits below. No open demonstrated S03 security defect remains. Subsequent exact-candidate hosted CI PASS is attributed to the lead and independent QA below; sprint acceptance remains with them. |

This report does not mark S03 VERIFIED or authorize deployment, real SOP processing, provider calls, additional email or policy decisions. The lead and QA retain sprint acceptance responsibility. [Sprint evidence](S03.md) and [S03 contract](../workflow-jobs.md) remain the execution references.

## Findings, fixes and verification

### R1 — MODERATE: native callback nodes followed redirects by default

- **Location / candidate:** initial `n8n/s03-probe.v1.json:149`, `:228`, `:307`, `:421` and `:500`; all five HTTP Request nodes use type version 4.2.
- **Requirement:** PRD section 12 service/credential boundaries; S03 fixed-destination signed-callback contract, ADR 08.
- **Trigger / evidence:** the original nodes specified timeout/response options but no redirect policy. In pinned n8n 2.48.6, HTTP Request versions at least 4 follow redirects when that option is absent. The source also selects its legacy cross-origin credential-forwarding default for versions below 4.4. [Pinned implementation](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts#L336)
- **Impact:** a redirect could move the signed service request away from the reviewed fixed endpoint. No actual token disclosure, cross-origin forwarding or attacker-controlled redirect has been demonstrated. The current fixed private destination limits exposure, but does not satisfy the explicit no-follow contract by itself.
- **Minimal fix / owner:** fullstack set `parameters.options.redirect.redirect.followRedirects=false` on every callback HTTP node, preserving other options. Updated export SHA-256 is `b755d6d35866ee0121df94c6750d09503237c98c830952fd1644e7e3174c8fc3`.
- **Verification so far:** this reviewer inspected all five explicit false values and independently passed the exported-workflow unit checks. The engineer reported the export assertion failing before the fix and passing afterward.
- **Publication evidence:** DevOps/lead report the corrected native publication and all five active HTTP nodes explicitly disabling redirects. Editing the bind-mounted source alone would not establish that result.
- **Controlled evidence:** DevOps' `infra/n8n/verify-redirects.mjs` exited 0. The default native HTTP 4.2 control contacted the 301 and 307 sources once each and the destination twice. The explicit no-follow control contacted each source once and the destination zero times. Forwarded synthetic canary count was zero in both runs, so credential disclosure is not claimed. This uses a separate inactive native CLI workflow and synthetic header, not actual signing keys or Queue Mode.
- **Method confirmation:** DevOps reran both controls with POST and strict `{}` bodies, matching callbacks. Exit 0 and the same counts: default destination 2; no-follow destination 0; each source 1; forwarded canary 0. The helper's inactive synthetic workflow is retained in the disposable n8n database; its fixture container and temporary file are removed. Status: FIX VERIFIED IN SOURCE, ACTIVE PUBLICATION AND ATTRIBUTED NATIVE CONTROL.

### F2 — HIGH functional blocker: nonce pruning requested a revoked privilege

- **Location / failing candidate:** initial `src/server/jobs/dispatch.ts:30` used `SELECT ... FOR UPDATE SKIP LOCKED` within nonce deletion; `drizzle/0002_workflow_jobs.sql:77` deliberately revokes UPDATE on nonce receipts. The initial failing runtime is identified in [S03 evidence](S03.md).
- **Requirement:** ADR 08, D3 durable reconciliation, S03 bounded retry/recovery acceptance; least-privilege database boundary.
- **Trigger / evidence:** DevOps reported the initial real PostgreSQL suite failing 28/30, including permission error 42501 in nonce cleanup. PostgreSQL requires UPDATE privilege for a locking SELECT. [PostgreSQL 18 SELECT privileges](https://www.postgresql.org/docs/18/sql-select.html)
- **Impact:** reconciliation fails under the intended runtime identity. `startWorkflowDispatcher` awaits reconciliation before dispatch, so this failure would also prevent that tick from dispatching work. The app was intentionally not started against the known failing candidate; this is not an observed unauthorized-access exploit.
- **Minimal fix / owner:** fullstack removed only the explicit receipt-subquery locking clause. Cleanup retains the 100-row bound and both expiry predicates; nonce UPDATE remains denied. Job/outbox row locking remains intact. Corrected dispatch source SHA-256 is `191f040b80aa87167a1af85d2fe5899de615c994ad792aeaa3e8a4fd306f1b85`.
- **Verification:** source correction inspected. DevOps reported the corrected real PostgreSQL suite PASS 30/30 (3 foundation, 15 auth, 12 jobs), exit 0, 11.32 seconds, with the dispatcher disabled during the suite. The lead subsequently reported actual Queue Mode success and validation-failure probes through the app dispatcher; its tick runs reconciliation before dispatch. These runtime results are attributed, not commands executed by this reviewer. Status: FIX VERIFIED IN REPORTED DATABASE/PROBE RESULTS.
- **Related recovery:** the lead's final strict six-case runtime run passed, recorded below. Passing nonce cleanup alone would not establish that result.

The second initial database failure concerned a test assuming the first stream chunk already contained `started`; a valid first chunk can contain only `accepted`. The corrected test reads to the required semantic event while retaining the event assertion. This is a harness issue, not a demonstrated authorization defect.

### R3 — MODERATE runtime retention gap: orphaned payload cleanup required native recovery

- **Location / initial candidate:** `docker-compose.yml:7` n8n environment had save-none and pruning settings but no explicit queue-recovery interval; `infra/n8n/inspect-execution-storage.mjs` supplies count-only observations. Current app/tooling images are recorded below.
- **Requirement:** PRD section 12 n8n execution-data minimization; ADR 08 and S03 native recovery/pruning acceptance. This is an operational gap, not an approved production retention policy.
- **Observed evidence:** DevOps snapshots at 13:06:59Z and 13:09:46Z found one running probe execution with one data row and one actual three-segment JWT-pattern occurrence; authorization and private-key markers are separate predicates. At the second observation, created/started age was 373 seconds. Redis had no Bull job hash/list/zset entries or JWT occurrence. Main/worker Docker logs had zero JWT, bearer or private-key markers. No raw bearer or key value was printed. This exceeds the synthetic workflow's 60-second timeout and cannot be described as secret-free execution storage.
- **Cause / policy boundary:** pinned n8n pruning excludes `new`, `running` and `waiting`; reducing age or hard-delete buffer alone cannot delete a still-running execution. [Pinned database predicate](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/%40n8n/db/src/repositories/execution.repository.ts#L739), [official pruning documentation](https://docs.n8n.io/hosting/scaling/execution-data/).
- **Impact:** an abandoned operational request payload remained after application recovery. Service bearers are short-lived (60 seconds), and no valid-token disclosure, private-key exposure, cross-user access or actual SOP data retention is demonstrated. Save flags alone do not establish a cleanup bound.
- **Minimal resolution / owner:** use supported native queue recovery to transition missing-queue `new`/`running` executions to `crashed`, then exercise native pruning. The exact tag schedules recovery at leader startup and periodically; `N8N_EXECUTIONS_QUEUE_RECOVERY_INTERVAL` defaults to 180 minutes. Recommend a normal S03 operational interval of one minute, then observe the periodic transition and pruning; a restart alone proves startup recovery, not the periodic bound. Do not edit n8n tables directly. [Pinned recovery](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/cli/src/scaling/scaling.service.ts#L779), [pinned interval configuration](https://github.com/n8n-io/n8n/blob/n8n%402.48.6/packages/%40n8n/config/src/configs/executions.config.ts#L30).
- **Fix and startup evidence:** DevOps set the shared normal `N8N_EXECUTIONS_QUEUE_RECOVERY_INTERVAL` to one minute. The source matches the pinned supported name/unit. After isolated main/worker recreation, the retained running row became crashed at 13:16:25Z; its payload still contained one JWT/auth marker, zero private-key markers. Main live/ready returned 200 and the worker was healthy. This verifies startup terminalization, not periodic recovery or payload deletion.
- **Periodic evidence:** DevOps confirmed unchanged main container `5e8e4dda…`, started 20 November 13:13:00Z, restart count 0, across the final six-case run. Crashed execution count increased from one after startup recovery to two after faults, without another main restart. This supports periodic recovery under the normal one-minute setting; the exact transition latency was not measured.
- **Transient terminal storage:** at 20 November 13:21:55Z, DevOps counted 11 terminal payload rows with 45 JWT-pattern occurrences: canceled 1, crashed 2, error 2 and success 6; nine were soft-deleted. QA independently observed the same payload/JWT totals at 13:22:50Z. Thus save-none does not mean no transient JWT-bearing execution storage. Payload private-key markers were zero. Redis had no job/JWT entries at the final sample, and both Docker and native event-log token/key marker counts were zero.
- **Native deletion:** on 21 November at 01:41:58Z, DevOps observed empty probe execution groups and direct `execution_data` counts of zero payloads, JWT-bearing rows, private-key-marker rows and orphans. The same main/configuration remained in place; no accelerated experiment, direct table writes or configuration restoration was used. QA independently repeated the final inspector at 01:43:11.571Z with the same zero counts and no deferred log scan.
- **Independent security check:** at 01:43:16.168Z, this reviewer used a project/workspace-label-guarded `BEGIN READ ONLY` PostgreSQL query in the disposable project. Counts were execution entities 0, direct probe payloads 0, JWT-bearing payloads 0, private-key-marker rows 0 and orphan payloads 0. This independently verifies payload disappearance rather than inferring it from deleted parent records.
- **Effective normal settings / limits:** DevOps checked pinned `GlobalConfig` in main and worker: pruning enabled, max age 1 hour, max count 100, hard-delete buffer 1 hour, soft task 60 minutes, hard task 15 minutes, queue recovery 1 minute, and completed/failed Bull retention 0. The observed before/after window is about 12 hours 20 minutes; exact deletion time and a tighter retention SLA were not measured. Thresholds, safety buffers and scheduling can add delay. This neither proves zero transient persistence nor approves a production retention policy. Status: FIX VERIFIED; STARTUP/PERIODIC RECOVERY AND NORMAL NATIVE DELETION OBSERVED.

## Reviewed boundaries

| Boundary | Source / assessment | Verification limit |
| --- | --- | --- |
| Immutable owned job and idempotency | `service.ts:30`; migration 0002 identity trigger, owner/request and event uniqueness. Job creation plus initial event is transactional; conflicting input cannot reuse an owner's request identity. | Corrected database suite PASS is attributed to DevOps; subsequent hosted regressions PASS is attributed to the lead/QA. |
| Signed direction and policy | `signatures.ts:11`, `contracts.ts:25`, `http.ts:9`. Callback verification pins RS256, configured public key, issuer, audience and JWT type; requires bounded time claims and strict signed fields. Exact job/purpose/path/method and empty-body checks reject unsigned duplicate authority. No remote key lookup is used. | Independent unit/workflow checks and attributed native Queue Mode/browser results support this increment; future workflow/provider changes need their own review. |
| Replay, execution and attempt fencing | `service.ts:53`; current attempt/number/dispatch nonce and database deadline are checked under a job lock. Nonce receipt, state and immutable event commit together. Claimed execution and ordered steps constrain progression; fresh-nonce duplicate events are harmless. | Database and recovery evidence is recorded below. No claim of exact-once network delivery. |
| Durable dispatch | `dispatch.ts:36`; committed leases precede network work, batch size and retries are bounded, response redirects are errors, and acknowledgement updates use matching attempt/lease predicates without replacing state. Instrumentation is runtime gated and avoids build execution. | Corrected database/probe and worker/Redis/app interruption checks passed locally and subsequently in the attributed hosted run. |
| Safe synthetic stream | `stream.ts:8`, `service.ts:105`. Only stored enum fields and literal synthetic terminal DTOs serialize. There is no candidate answer, document URL, arbitrary worker message or real judge verdict in the stream. | This proves neither real grounding nor an independent LLM judge. Those remain later sprints. |
| Current authorization at release | `service.ts:14`, `:105`; user and live session are checked under shared locks, then job ownership is checked before synchronous enqueue. Admin has no ownership bypass. | Actual revocation/proxy checks passed. Bytes already authorized and enqueued cannot be recalled from buffers/network; the guarantee is a fresh check at enqueue, not zero transit time after revocation. |
| Backpressure/cancellation | Revised `stream.ts:26` budgets all frames, stops polling while blocked, has a finite hard deadline, and suppresses late results after abort/revocation. Seven focused pressure regressions passed independently using an intentionally smaller internal budget and mocked database boundary. | Normal synthetic jobs cannot fill the default 64 KiB queue. Unit pressure proof must not be described as a completed runtime load test. |
| Native n8n policy gate | Export uses credential-backed Webhook/JWT nodes and explicit fail-closed IF/error paths; no Code, Wait or provider node. The ingress condition validates verified claims and empty body/query; `Only Run If` is not used as authorization. | n8n's native verification does not enforce every app claim; application checks remain necessary. |
| Secrets and private services | Compose gives app dispatch-private/callback-public only. Bootstrap alone mounts callback-private/dispatch-public, imports through a mode-0600 tmpfs file, removes it and withholds CLI output. Main/worker use operational DB credentials and stable encryption key; Code/env/file capabilities are restricted. Proxy alone publishes loopback port and denies `/api/internal/`. | Actual private-service, native import, role-denial and retention results supplement inspection. Real key files were not read by this reviewer. |
| Scoped fault/fixture controls | `tests/e2e/workflow-control.ts:12` requires explicit local synthetic configuration, validates stored actor/target emails against `.invalid` fixture identities before deactivation, and limits status reads to fixture-owned jobs. Runtime script checks project/workspace labels before service actions. | The script was inspected, not executed by this reviewer. Runtime owner must use the documented fresh synthetic project. |
| Private browser fixture mount | CI and runtime controls bind only `.local-secrets/browser-fixtures`; parent secret directory and S02 Resend key are not supplied to tooling. Browser traces/videos/screenshots are disabled. | No private fixture or actual key contents were read. No broad final-image secret scan was performed by this reviewer. |

The fixed callback URLs use the internal app host and validated job identity; no user-controlled callback URL, workflow selection or provider endpoint is accepted. The probe is gated to explicit loopback HTTP configuration. No new product menu or public fixture-control API was added.

QA demonstrated verifier-only false passes and cleanup gaps, then independently passed eight adversarial collector cases and five cleanup/deadline cases after the lead's fixes. The final runtime run used strict DTO/framing/cursor checks, rejected post-terminal bytes, required clean EOF and restored owned services. This does not imply the application emitted any injected trap. See [QA evidence](S03-qa.md).

The final count inspector marks a native-log scan `DEFERRED_PAUSED` when the actual owned container is paused; it does not call that scan clean. The final unpaused main/worker observations included Docker logs and anchored regular `n8nEventLog*.log` files with zero JWT/bearer/private-key markers. Config, credential and key files are excluded. Those samples do not establish that arbitrary future nodes can never log sensitive data.

DevOps passed the final paused-helper regression on 21 November: the paused worker's native file scan was explicitly deferred, Docker logs were inspected, and the worker was unpaused and healthy afterward. The final helper source was frozen following that check.

## Actual checks and evidence provenance

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Required guides, approved PRDs, S03 plan/contract and actual code/workflow/infra/test inspection | PASS | The complete protected PRDs were read earlier in this assignment; integrity confirms the same originals. Relevant security, API, workflow and testing guides were consulted. |
| `node node_modules/vitest/vitest.mjs run tests/unit/jobs.test.ts tests/unit/jobs-workflow.test.ts tests/unit/jobs-stream.test.ts` | PASS, independent | Three files, 14/14 tests, 3.08 seconds; executed at 13:53 local on 20 November. Includes signature/time/body policy, exported graph and seven pressure/cancellation cases. |
| `node --test infra/n8n/local-secrets.test.mjs` | PASS, independent | One test passed, 939 ms. It copies the generator into a guarded fresh temporary directory and creates only synthetic values; proves preservation, independent RSA identities, repeatability and missing-private-key failure. Unix permission assertions are not exercised on Windows. |
| Initial target PostgreSQL suite | FAIL, reported by DevOps | 28/30 overall; all 18 prior tests and ten new cases passed. F2 and the semantic-first-chunk harness issue are preserved above. |
| Corrected target PostgreSQL suite | PASS, reported by DevOps through lead | 30/30, exit 0, 11.32 seconds; 3 foundation, 15 auth and 12 jobs. Dispatcher disabled during the suite. Current app image `sha256:6533dffa38bee875df47284568a1766b4b88908d2d1d8dcfac9db7e3b2df6a34`; tooling `sha256:ca9c7f3024752cbbaf83dfb7fb6770ae5d7b05e48dbdf9afc3e53e9caa2666c8`. |
| Initial private runtime prerequisites | PASS, reported by DevOps | Pinned n8n main/worker and authenticated Redis healthy; native credential/workflow import/publication completed; unauthenticated webhook 401; n8n operational role denied app DB connection with 42501. These are attributed results, not operations independently executed here. |
| Published corrected redirect configuration and native option control | PASS, reported by DevOps | Active native history contains all five explicit false redirect flags. Native GET and POST/strict-`{}` 301/307 positive/default and negative/no-follow controls passed. This is separate from Queue Mode proof. |
| Actual owned probe / proxy / browser regression | PASS, reported by lead | All 10 local browser cases passed in 1.1 minutes against the corrected app/proxy, including actual Queue Mode success, safe validation failure, finite slow-reader, disconnect/resume and ownership denial. Independent QA subsequently confirmed the hosted 10-case result. |
| Worker/Redis/app interruption, revocation and timeout | PASS, reported by lead | Final strict `node scripts/verify-workflow-runtime.mjs`, exit 0: pause 24.391s; in-flight worker loss 50.321s; Redis interruption 19.606s; app restart 27.662s; live deactivation 9.302s; actual 60s timeout/reconnect 72.358s. All touched services restored. Script SHA-256 `fdeccddfc28b8d0163bd6148877fd1034c62a7c8d13a93e665ddc65df89a67dc`. |
| Execution/queue/log inspection | PASS within recorded scope, attributed to DevOps/QA | Transient running and terminal JWT-bearing rows were observed and disclosed; final Redis job/JWT counts and unpaused Docker/native event-log marker counts were zero. Paused scans were explicitly deferred. R3 preserves the before/after evidence and limits. |
| Normal native execution pruning | PASS, independently checked | 21 November 01:43:16.168Z: read-only guarded SQL independently found probe entities/payloads/JWT-bearing rows/key-marker rows/orphan rows all zero. DevOps/QA independently agree; normal configuration remained unchanged and no accelerated experiment was used. |
| Full lint/types/unit and secret-generation checks | PASS, attributed to lead/QA | Lead repeated lint/types, 28/28 units (7.87s), isolated secret test 1/1 and PRD integrity on 21 November. QA independently repeated 28 units and the isolated generator test earlier. No new broad rerun was performed by this reviewer against unchanged application hashes. |
| Dependency audit | MIXED, attributed to lead on 21 November | `npm audit --omit=dev --omit=optional` PASS, zero vulnerabilities; `npm audit --omit=dev` FAIL, four moderate and zero high/critical findings in the existing Drizzle/esbuild optional-peer chain. This preserves the tracked S14/pre-V01 risk and is not a clean production-audit claim. |
| Hosted CI | PASS, subsequently attributed to lead and independent QA | Exact candidate `0396cf606b8e34a805a038b273a103687a691ce1`; [run 44852222243 / job 136685999286](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44852222243/job/136685999286) SUCCESS, all 18 steps. Lead/QA decoded 28 unit, 30 database, 10 browser and six recovery cases, native POST controls and cleanup. This reviewer did not rerun hosted checks. |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS before and after final report update | Both protected originals match the recorded baseline, including the final 21 November report edit. |

The independent deletion check was an in-memory `node` stdin wrapper: it resolved and validated the explicitly named project's PostgreSQL container, then invoked `docker exec -i <owned-postgres> psql -X -q -A -t -U sop_bootstrap -d sop_n8n -v ON_ERROR_STOP=1`. Its `BEGIN READ ONLY` query separately counted probe `execution_entity` rows and direct `execution_data` rows filtered by `workflowData->>'id'`, JWT/private-key markers and missing parent records; all returned zero. It made no data writes or service lifecycle changes.

No real SOP, model/OCR/storage or Resend call was made by this reviewer. No Docker mutation, build, type generation, provider key read, production action or permission change was performed. The synthetic generator test reads only its newly generated temporary keys, not workspace key files.

## Source snapshot

SHA-256 each exact file below. Sort paths lexicographically by ordinal character values and concatenate `path + NUL + lowercase_file_hash + LF` as UTF-8, then SHA-256 that manifest. This gives `5f9ebfb3cf3fe586216aad78c661f44009c6e217828b3db169ea1b7b7d914cc8`. The report and other docs are excluded. This working-copy snapshot is not a claim about a future commit or an older built image.

```text
.dockerignore
.github/workflows/ci.yml
Dockerfile
docker-compose.yml
drizzle/0002_workflow_jobs.sql
drizzle/meta/0002_snapshot.json
drizzle/meta/_journal.json
infra/n8n/bootstrap.mjs
infra/n8n/inspect-execution-storage.mjs
infra/n8n/local-secrets.test.mjs
infra/n8n/redis-entrypoint.sh
infra/n8n/redis-health.sh
infra/n8n/verify-redirects.mjs
infra/proxy/nginx.conf
n8n/s03-probe.v1.json
package-lock.json
package.json
scripts/local-secrets.mjs
scripts/verify-workflow-runtime.mjs
src/app/api/internal/jobs/[id]/callback/route.ts
src/app/api/internal/jobs/[id]/claim/route.ts
src/app/api/jobs/[id]/events/route.ts
src/app/api/jobs/probe/route.ts
src/instrumentation.ts
src/server/db/schema.ts
src/server/jobs/config.ts
src/server/jobs/contracts.ts
src/server/jobs/dispatch.ts
src/server/jobs/http.ts
src/server/jobs/service.ts
src/server/jobs/signatures.ts
src/server/jobs/stream.ts
tests/e2e/auth.spec.ts
tests/e2e/seed.ts
tests/e2e/workflow-control.ts
tests/e2e/workflow.spec.ts
tests/integration/jobs.test.ts
tests/unit/jobs-stream.test.ts
tests/unit/jobs-workflow.test.ts
tests/unit/jobs.test.ts
tests/workflows/probe-contract.ts
```

| Selected file | SHA-256 |
| --- | --- |
| `src/server/jobs/stream.ts` | `a54f3a4661f6ff58c07bd3b6ed5908f9ad96af490cc7759d041715474286be06` |
| `src/server/jobs/dispatch.ts` | `191f040b80aa87167a1af85d2fe5899de615c994ad792aeaa3e8a4fd306f1b85` |
| `src/server/jobs/service.ts` | `19ecb03f1aca08e3a0fc83fcc0fadac9b8c398fc362678bcf9db2a3c2a3d074a` |
| `src/server/jobs/signatures.ts` | `222942dde285da3c40ed143cc30d0c9723ec5954ca432605af9f087877008d8f` |
| `n8n/s03-probe.v1.json` | `b755d6d35866ee0121df94c6750d09503237c98c830952fd1644e7e3174c8fc3` |
| `docker-compose.yml` | `48f1861bb758c53f2a7a8ff877f641689195f2811a132930b95a35873ee159f9` |
| `infra/n8n/bootstrap.mjs` | `cc68866c0ef684e1e2968a3ba39e0fceb69314087da6ef672a09c587934103c8` |
| `infra/n8n/inspect-execution-storage.mjs` | `37a61822eae4cc48d2e6d2dde0d199b3eb5df2429b9c5119510e44d370fcfdfd` |
| `infra/n8n/verify-redirects.mjs` | `4e2b39410934f93daa41741025fd9f42e717b51c079ba55887153dc20b78726f` |
| `infra/proxy/nginx.conf` | `6e4d20131eb1c6a7646cd7c5877e8d92c21fb9ef8eea2d9ed6f2a9a00496fc2f` |
| `.github/workflows/ci.yml` | `c75e466c731437f1af1cbb324855202f27163ffd2bb5b4058fb2122d31959395` |
| `scripts/verify-workflow-runtime.mjs` | `fdeccddfc28b8d0163bd6148877fd1034c62a7c8d13a93e665ddc65df89a67dc` |
| `tests/e2e/workflow-control.ts` | `5b292ed39f876b35c194489d8683becad395af59e0b349455eea0cf174472be9` |

## Subsequent publication and hosted confirmation

The local review above was completed before hosted CI. A later bounded, read-only publication check independently confirmed candidate `0396cf606b8e34a805a038b273a103687a691ce1` and tree `fd1089ec8f50cf0b124fec320c2b9d39c879be6b` through local Git blobs and the public GitHub connector. The public branch ref matched. All 41 committed files reproduced the frozen manifest exactly, with no working-copy differences.

Both committed protected originals matched their baseline SHA-256 values: technical PRD `d91d6eacc6e390b6f5bf4bb3018d801b2f39b4ae9f4d64f6b1097d0b7a4a2dc1`; PDF `a84d9cb74ae572a6b9e2943137277adc732567169f5d5110de29734af0c6ea5e`. LICENSE was byte-identical to original commit `da80bde363f773e565d1c1dde9b78b400ad56054`, and that commit plus S02 closure remained ancestors. The 146 tracked paths contained no private fixture/secret-directory, environment-file, dependency/build-output or key-file paths. A bounded tracked-text scan found no high-confidence private-key PEM, provider-token or JWT literals. The unchanged binary PDF was hash-checked rather than text-scanned. No actual key file was read; this is not an exhaustive secret-detection guarantee.

The lead and independent QA subsequently reported [hosted run 44852222243](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44852222243) / job `136685999286` SUCCESS for this exact candidate, with all 18 steps passing, including the test/control counts above and disposable-service cleanup. This appendix records their terminal evidence; it does not recast the earlier local review as a hosted check independently executed by this reviewer. The frozen 41-file implementation manifest is unchanged by this later documentation update.

After the timestamped zero-payload check, a subsequent existing happy probe passed 1/1 in 10.1 seconds and created one new soft-deleted success payload with six JWT occurrences at 01:46:35Z. DevOps again observed zero orphan/private-key markers, Redis jobs/JWTs and Docker/native-log token/key markers. This preserves the distinction between deletion of the earlier 11 payloads and ongoing transient storage for new work.

## Handoff

R1, F2 and R3 retain their original failures, fixes and actual verification. The scoped security review is complete with no open demonstrated S03 security defect. Publication was independently confirmed and subsequent exact-candidate hosted CI PASS is attributed above. The lead/QA own S03 acceptance and the later documentation closure commit. Existing moderate Drizzle/esbuild tooling advisories remain a separate tracked S14/pre-V01 risk, not a clean-audit claim.

The synthetic judge stub and terminal marker do not establish C2–C5 answer correctness or replace later evidence/judge/benchmark gates. Production bootstrap, Admin MFA, production retention, real-data/provider decisions and deployment remain outside this review. The user's later Cloudflare R2 selection is an S04 planning decision; no S04 implementation was reviewed or started here. S04 must not start before the lead records S03 VERIFIED. Only this report was created by the security reviewer.
