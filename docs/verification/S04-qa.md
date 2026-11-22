# S04 independent QA

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / requirements | S04 private Admin uploads; D2, D1 upload status, ADR03 |
| Phase / predecessor | Phase1; S03 VERIFIED for0396cf6, closure base93a71e8 |
| Candidate | Published `1ef852166cda0e07c231ddd4834cf053442bb1dd` on `codex/s04-private-uploads`; tree `64a1946be0983098bfc4a6f12b4513a6681fd9cb`; base `93a71e8b93392c7740fd5b097548b28e1747b1d3` |
| Verifier / ownership | Independent QA; implementation and assertions read-only; this report assigned by lead |
| Environment | Windows, Node/npm host unit suite; no Docker mutation, build/typegen, provider request or real-key read by QA |
| Date | Initial21 November2026; final local/provider/UI and exact hosted-CI reconciliation22 November2026, Asia/Jakarta; original unit run18:24 and file snapshot18:26:01 are historical |
| Result | Independent QA PASS for S04 candidate `1ef8521`; exact hosted run45018939728 succeeded, and required local/provider/UI evidence is reconciled. Lead owns sprint closure after independent security handoff. |

The initial sections preserve a bounded early review while source was changing; subsequent dated sections record fix checks and final evidence. The latest status above and final sections supersede earlier pending states without relabeling failures. The initial unit run is not a frozen final-candidate verification. The protected PRDs, shared/QA guides, current plan/checklist, testing guide and [upload contract](../private-uploads.md) govern the review. Both original PRDs remain unchanged. Root owns UI/browser tests and, after the fullstack agent became unavailable, the remaining backend/test fixes. DevOps owns the storage fixture and CI. QA has not changed implementation or tests.

## Checks actually executed

| Check / command | Result | Evidence and limit |
| --- | --- | --- |
| `npm.cmd test` | PASS | Vitest5.1.1:7 files,35/35 tests,16.14s; start18:24:00. Includes7 document unit groups plus28 existing regression tests. No database, browser or actual R2 request is exercised by this command. |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS | Both protected sources unchanged before review and at18:26, before report creation; post-report result recorded below. |
| Actual contracts/config/storage/format/service, API boundary, migration/probe changes, UI and tests | Independently inspected | Source observations and coverage review; execution is distinguished below. |
| Installed Playwright request API contract | Confirmed test defect | `node_modules/playwright-core/types/types.d.ts:22680` explicitly says `headers()` omits security/cookie headers and directs callers to `allHeaders()`. |
| Database integration, actual API/browser/storage fixture | NOT RUN by QA in this pass | Runtime resources remain coordinated by root/DevOps. Source/test existence does not establish passing behavior. |
| Lint/typecheck/build/hosted CI | NOT RUN by QA in this pass | No finished source/image candidate yet; host build/typegen prohibited for this assignment. |
| Live private R2 synthetic upload/seal/header/key/expiry checks | NOT RUN by QA | Root separately reported HeadBucket/CORS setup/readback and OPTIONS204 with no object written. Those partial checks do not prove object upload/sealing or private-bucket status. |

## Requirement-to-check matrix

| Requirement / boundary | Existing meaningful checks inspected | Current result / remaining evidence |
| --- | --- | --- |
| D2 accepted PDF/DOCX metadata, actual bytes/type/size/hash | Units reject strict-schema/type/name/hash/size violations; actual async iterable rejects byte20000001 and destroys the body; PDF/DOCX controls invoke real validator | Unit PASS for current35-test run. Malformed/macro OOXML bypass remains open as R-S04-1; final parser fix and regressions must rerun. |
| D2 bounded archive handling | ZIP duplicate/traversal/encryption/macro-name, metadata inflation/entity declarations, archive budgets | Unit PASS for implemented cases. This proves bounded format checks, not safe contents, extraction or macro execution prevention beyond tested declarations. |
| D2 / ADR03 presigned scope | Actual pinned presigner with explicit synthetic credentials asserts exact `content-length;content-type;host;if-none-match`, <=120s and expired authorization rejection | Unit PASS without network calls. Native fixture and live R2 key/header/signature/expiry denial remain separate gates. |
| D2 authorization and owner isolation | DB tests use current account/session locks, Staff/foreign owner/stale role/session, demotion/revocation during sealing; browser cases check anonymous/Staff API denial | Static coverage present; runtime NOT RUN by QA. No authorization PASS inferred from hidden controls. |
| D2 quota/idempotency/original integrity | DB tests cover duplicate initiation, conflicting metadata, concurrent aggregate2x quota, immutable final object despite staged replay, one parked job, ambiguous PUT and DB rollback recovery | Static coverage present; runtime NOT RUN. Four-concurrent-retry expectation currently conflicts with the2-finalizer bound (Q-S04-2). |
| D1 current upload status and expiry | Safe DTO/status restoration/reload tests, expired presigner unit | R-S04-2 stale locked-row serialization remains open. Dedicated real-DB expired-intent/status/finalize and same-intent simultaneous-finalizer cases are still missing at this snapshot; root accepted adding them. |
| D2 timeout/fencing/resource recovery | DB tests delay storage, replace a stale lease, fill2 process slots, advance the15s deadline even when storage ignores abort | Static coverage present; runtime NOT RUN. Barrier cleanup must execute after failed assertions too (Q-S04-3). |
| D2 / ADR03 parked ingestion isolation | DB test asserts `WAITING_FOR_PIPELINE`, no deadline/run lease, unchanged dispatcher/reconciler state and rejected probe callback/SSE; schema pins original/job identity | Static coverage present; DB/runtime NOT RUN. No S05 processor, extracted text, ACTIVE eligibility or trusted answer is claimed. |
| D1 upload UI and accessibility | Four browser cases: real PDF/DOCX direct uploads/status reload,320px reflow/focus/Enter, validation/service-error retry, anonymous/Staff denial | Inspected; NOT RUN. Cookie assertion can falsely pass (Q-S04-1). No skipped/new nonasserting cases found. |
| D2 safe request handling and limits | DB API case checks anonymous/Staff/cross-origin, forged key and oversized JSON with safe error DTO; implementation reuses durable global/account limiter | Static coverage present. Dedicated document limiter exhaustion/concurrency evidence is not present in this snapshot; inherited limiter tests alone do not execute this route's limits. |
| ADR03 private storage/configuration | Explicit quota and real R2 endpoint restrictions; fixture requires loopback and explicit flag; direct UI PUT uses credentials omit/redirect error; fixture rejects credentials/foreign origins | Source/unit observations only. Actual private/public-access confirmation, browser wire headers and live synthetic transfer evidence remain required. |

## Findings and handoff

### Q-S04-1 — cookie-leak browser assertion can falsely pass

At inspected `tests/e2e/documents.spec.ts:34`, the request listener records `Boolean(request.headers()["cookie"])`. Playwright omits cookie/security headers from that API, so an actual Cookie header can be invisible to this assertion. The test does positively assert exactly one PUT, which avoids an empty-array pass, but does not repair the header omission.

Use awaited `request.allHeaders()` and wait for all PUT observations before evaluating origin/cookie assertions. Record booleans rather than cookie values or full signed URLs. Root accepted ownership. Status: OPEN; no browser execution or repaired-cookie proof yet.

### Q-S04-2 — accepted-retry test exceeds the intended concurrency bound

At inspected `tests/integration/documents.test.ts:106`, four accepted finalization calls start together inside `Promise.all`. The actual service checks `activeFinalizers >=2` before checking accepted state, so the third/fourth calls reject `UPLOAD_BUSY`; the current all-success expectation conflicts with that deliberate bound.

This is a static predicted failure, not an executed DB result. Keep the concurrency assertion: expect only bounded busy rejections under contention, retry after capacity frees, and verify every successful/retried result returns the same single job with no extra storage write. Root accepted the fix. Status: OPEN.

### Q-S04-3 — delayed-operation tests clean up only after successful assertions

The lease-replacement, process-concurrency and deadline cases at inspected DB-test lines186/202/214 release their barriers on the success path. A failed assertion or replacement call can leave work suspended into later checks; the fake-time case also changes timer ownership.

Release every barrier in `finally`, await settled operations and restore timers even when the assertion fails. Root accepted ownership. Status: OPEN; no cleanup rerun yet.

### Security findings and coverage additions

Independent [security evidence](S04-security.md) reproduces malformed/macro-declaring OOXML acceptance (R-S04-1, moderate) and stale initiation status/authorization from an unlocked old row (R-S04-2, low). QA inspected the same source hashes below; neither fix existed at this snapshot. These findings are attributed to security, not re-executed by QA. Root took ownership of fixes and red/green regressions when the fullstack agent became unavailable.

QA also requested dedicated expired-intent/status/finalize rejection and same-intent simultaneous-finalizer cases; root accepted adding them. No mandatory gate is waived by the early unit pass. Tests must run again after relevant fixes.

## Inspected snapshot

SHA-256 over exact bytes at18:26:01, after the unit run. Concurrent edits were permitted, so these hashes identify inspected files and do not retroactively freeze every file loaded by the earlier test process.

| File | SHA-256 |
| --- | --- |
| `src/server/documents/format.ts` | `7a598989dab1de43d58cef970563a46d950bafed07814b0d6520ac006861287d` |
| `src/server/documents/service.ts` | `3519d1ad3b49edaa9f4c012d8c90a35ab486b40053a06ad67be4985f50709473` |
| `src/server/documents/storage.ts` | `595a7148cfef939b3161ecf35dfc48481203d335cb96f8fa07c0f4b691d17c08` |
| `src/components/documents/upload-panel.tsx` | `0978c0679e478bc748cab94e1a9b72961562b392942ebd309831bda89d93d503` |
| `tests/unit/documents.test.ts` | `3e0c72b0deec228e6f3db07a747aaccee24b904e9e29b1dca84c50c589a19d83` |
| `tests/integration/documents.test.ts` | `ed3d19b7a7eea2cda1a0f3ffb02d5ba26e35330dff26dfe340866920e4ac7388` |
| `tests/e2e/documents.spec.ts` | `7b85a5ddaffa7afa4e358bb4659e96d2e816755ecf2028c8fd0bd0b84244745a` |
| `drizzle/0003_private_uploads.sql` | `e4f5791e68c0f3813c16f360f155b7bd1aee5223efdb3735f300695b99e0299d` |

## Closure

Early assigned unit/coverage review is complete. S04 acceptance is BLOCKED: fixes and affected regressions, finished source/schema/image/fixture identity, coordinated real-DB/browser/native-fixture/live-private-R2 checks, hosted CI and independent final reviews remain required. Production file/quota/retention/recovery policy is not approved by this review. No real SOP processing, S05 or deployment is authorized here.

Post-report `node .codex/scripts/check-prd-integrity.mjs`: PASS for both protected sources. No protected file or baseline was edited.

## Follow-up — 21 November2026,23:41–23:44 Asia/Jakarta

This follow-up supersedes the initial open source/test findings without erasing their history. Observed HEAD is `868dca58d785540000bf3c1b81f70a1f4c91f20a` on `codex/s04-private-uploads`, with uncommitted S04 implementation/tests. Host Node26.13.0, npm11.20.0. This remains a working-copy review, not a finished hosted/image candidate.

| Check | Actual result / attribution | Limit |
| --- | --- | --- |
| Independent `npm.cmd test` | PASS:8 files,38/38 tests,24.73s; start23:41:20. Includes9 format/storage tests and the locked-row service regression. | No database/browser/provider request; mocked transaction read ordering does not prove actual PostgreSQL contention. |
| Independent exact-boundary harness below | PASS:20,000,000 bytes; all5 xref offsets and declared content-stream length agree; actual validator accepts boundary and rejects20,000,001 bytes with `UPLOAD_SIZE_MISMATCH`. | Structural fixture and actual-validator proof, not a PDF renderer, browser, storage transport or live R2 proof. |
| Fifth document browser case | Source reviewed: exact20MB synthetic file, saved heading, UUID/status API200 and exactsize/hash/UPLOADED/ACCEPTED/parked-job assertions;60s test bound and45s success wait. | NOT RUN by QA. Root owns coordinated15-browser-test execution. |
| Q-S04-1 cookie check | FIX VERIFIED IN SOURCE: PUT observations use `request.allHeaders()`, collect promises and await them before asserting exactly1 transfer and no Cookie. Only origin/boolean is retained. | Actual browser wire-header observation pending; raw cookies/signed URLs are not recorded. |
| Q-S04-2 bounded accepted retries | FIX VERIFIED IN SOURCE:4 calls remain concurrent; rejected outcomes must be `UPLOAD_BUSY`, then retry after settled capacity; all4 map to the same job with1 write. Separate held-two-finalizers case asserts third-call busy. | Real-DB run attributed below, not independently rerun by QA. |
| Q-S04-3 barrier cleanup | FIX VERIFIED IN SOURCE: lease replacement/concurrency/deadline cases release in `finally`, await outcomes/settled work and restore fake timers. New simultaneous-finalizer case also releases/settles in `finally`. | No independent injected-assertion-failure experiment in this pass. |
| R-S04-1 / R-S04-2 | Corrected source hashes exactly match security's independently verified hashes. Actual unit suite rejects malformed/comment/wrong-namespace/entity-obscured macro metadata and accepts valid numeric entities; service regression returns newly locked ACCEPTED without another upload grant. | Original failure reproductions and focused security rechecks remain attributed to [security](S04-security.md). Neither format validation nor parked status proves extraction/ACTIVE eligibility. |
| Earlier requested coverage additions | Added actual DB scenarios for expired intent/status/finalization with retained reservation, same-intent simultaneous finalizer, and document-init20-invalid-request per-account limit then429 safe DTO. | Source inspected; dedicated limiter test is sequential per-account evidence, not an upload-global-limit concurrency measurement. |
| Real PostgreSQL/migrations | Attributed to DevOps via lead and [S04 report](S04.md):48/48 in39.26s, including18 document cases; migrations0000–0003 twice with4 ledger rows, dispatcher stopped. | QA did not mutate/run Docker or rerun DB; saved-image identities/final source/runtime reconciliation remain lead-owned. |
| PRD integrity | Independent checker PASS before and after this follow-up report update. | Neither protected source/baseline edited. |

The PDF generator builds a visible one-page synthetic document with a catalog/page/font/content stream, actual object offsets, xref/trailer and EOF. It pads the content stream and adjusts the amount until exact byte count converges. It rejects requested sizes outside its stated range. The positive boundary case uses this generated document; the existing invalid-size browser case separately selects20,000,001 bytes and asserts no initiation request. No skip or assertion weakening was found in the five document browser cases.

The exact boundary PDF SHA-256 is `b2a81673a1f7e90adc535af1d5754d7091a42647b86f57d57e4abc3f80579494`. The independent in-memory command was executed as follows; it writes no fixture files and uses no provider configuration:

```powershell
@'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syntheticPdf } from './tests/fixtures/document-files.ts';
import { validateDocumentObject } from './src/server/documents/format.ts';
const bytes = syntheticPdf(20_000_000);
assert.equal(bytes.length, 20_000_000);
const trailer = bytes.subarray(-1024).toString('ascii');
const xrefOffset = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(trailer)?.[1]);
assert.equal(bytes.subarray(xrefOffset, xrefOffset + 5).toString(), 'xref\n');
const xref = bytes.subarray(xrefOffset).toString('ascii').split('\n');
assert.equal(xref[1], '0 6');
for (let object = 1; object <= 5; object++) {
  const offset = Number(xref[object + 2].slice(0, 10));
  assert.equal(bytes.subarray(offset, offset + 8).toString(), `${object} 0 obj\n`);
}
const streamStart = bytes.indexOf('stream\n') + 7;
const streamEnd = bytes.indexOf('endstream', streamStart);
const declaredLength = Number(/\/Length (\d+)/.exec(bytes.subarray(0, streamStart).toString('ascii'))?.[1]);
assert.equal(streamEnd - streamStart, declaredLength);
const expected = { sizeBytes: bytes.length, mimeType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') };
await validateDocumentObject({ bytes, contentType: expected.mimeType }, expected, new AbortController().signal);
const oversized = Buffer.concat([bytes, Buffer.from('x')]);
await assert.rejects(validateDocumentObject({ bytes: oversized, contentType: expected.mimeType }, { ...expected, sizeBytes: oversized.length, sha256: createHash('sha256').update(oversized).digest('hex') }, new AbortController().signal), { code: 'UPLOAD_SIZE_MISMATCH' });
console.log(JSON.stringify({ fixtureBytes: bytes.length, sha256: expected.sha256, xrefOffsets: 'PASS:5', contentStreamLength: 'PASS', actualValidatorExactBoundary: 'PASS', actualValidatorNextByteRejected: 'PASS' }));
'@ | node --import tsx --input-type=module -
```

Inspected file hashes at23:42:10, after the38-test run:

| File | SHA-256 |
| --- | --- |
| `src/server/documents/format.ts` | `4e4d97d0f7c486107d820abaeda97524a600266a6559dacc2f6fbc4cb12a1112` |
| `src/server/documents/service.ts` | `577c34b3680e9b15a6049e8ba5754e2cf29cb87ca1de901fd4e93764ead395d5` |
| `src/server/documents/storage.ts` | `595a7148cfef939b3161ecf35dfc48481203d335cb96f8fa07c0f4b691d17c08` |
| `src/components/documents/upload-panel.tsx` | `0978c0679e478bc748cab94e1a9b72961562b392942ebd309831bda89d93d503` |
| `tests/unit/documents.test.ts` | `f927682dc5e88954a47aad1f8b17195098480eed9157162a14065851996ac22f` |
| `tests/unit/document-service.test.ts` | `efeca9ec71ca6523010a710361a8ecb61fc3cd312c4da4790eb2d40cbbf4735a` |
| `tests/integration/documents.test.ts` | `268127fcad9cbd0bf3956814ff406d91033dd97a99c07fa0b2fbd241b7079d59` |
| `tests/e2e/documents.spec.ts` | `a5612bc51f1a63835f57f862b9dd840a761b8549438c9e6e40cd4a6184bf757b` |
| `tests/fixtures/document-files.ts` | `ad896655c0623fb147c57ee9f98b38f8e47f2e2d0af69719521f7cd506cc704e` |
| `drizzle/0003_private_uploads.sql` | `e4f5791e68c0f3813c16f360f155b7bd1aee5223efdb3735f300695b99e0299d` |

Q-S04-1–3 no longer require source changes at this snapshot. The earlier missing-expiry/simultaneous/route-limit scenarios are present. Current bounded QA review is complete; final S04 acceptance remains pending actual integrated/browser/live-provider/private-access/final CI evidence and candidate reconciliation. No provider/secret access, Docker mutation, implementation/test edit or host build/typegen occurred in this follow-up.

## Follow-up: 22 November 2026, resumed source and assertion review

Observed HEAD remains `868dca58d785540000bf3c1b81f70a1f4c91f20a` on `codex/s04-private-uploads`, with the S04 implementation still uncommitted. This checkpoint covers the main/worker restart additions, extended Redis-outage assertions and two ignored live-provider verification helpers. It does not supersede the need for a finished source/CI candidate. Only this report was assigned for editing; implementation, test assertions, Git index, Docker services and provider configuration remain untouched by this QA pass.

The full technical PRD, all four original product-PDF pages, plan, shared/QA/testing guides, S04 checklist/contract and existing evidence were read. The first inline PDF reader extracted all four pages, then used an incompatible cleanup method; rerunning with the PDF.js loading task's `destroy()` completed successfully. Neither protected original nor its integrity baseline changed.

| Check actually performed | Result | Boundary |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS before review/report edit | Both protected originals unchanged. |
| `node --check scripts/verify-workflow-runtime.mjs` | PASS | Syntax only; no Docker command or workflow was executed by QA. |
| `node --check .local-secrets/s04-r2-live-check.mjs` | PASS | Syntax only; no imports, credential/configuration reads or provider call. |
| `node --check .local-secrets/s04-r2-browser-check.mjs` | PASS | Syntax only; browser/provider execution remains lead-owned. |
| Exact helper functions in an isolated in-memory VM | PASS: seven assertion controls | Actual `status`/`denied` function text was extracted with the installed TypeScript parser; mocked fetch supplied synthetic responses. No top-level helper initialization or private-file access was evaluated. |
| Exact workflow collector in an isolated in-memory VM | PASS: immediate completion control; reproduced deadline rejection after an event-loop block | Actual collector/guards/constants were extracted; mocked SSE and a scaled monotonic clock isolate a possible scheduling artifact. This is not the cause of the observed 136.092-second Redis recovery described below. |
| Current live receipt, with private object prefix omitted from review output | Independently read: FAIL at development-URL read, `cleaned:false` | Prior real-provider checks are recorded by the lead's receipt, not executed by QA. |
| Current application-provider receipt | NOT PRESENT at this checkpoint | No live app upload/sealing/browser-provider PASS inferred. |

### New source assertions

The Compose diff adds `restart: unless-stopped` only to `n8n-main` and `n8n-worker`. Existing isolation, secrets, ports, users and resource limits are unchanged. The Redis case requires both services healthy with that policy before interruption, at least 12 seconds of outage after an observed dispatch attempt, increased restart counts, different start times and healthy services afterward. Only Redis is explicitly restarted in that case; automatic queue-process restart evidence is gathered before cleanup can manually start the worker.

The collector still rejects failed frames and malformed/unsafe content, requires exactly one validated synthetic completion and a judge-stub progress event, checks monotonic cursors and retains the 64-event/65,536-byte capture limits. Its 100,000-millisecond monotonic deadline is unchanged at this inspected snapshot. Naming and comments in this narrow diff are clear; no decorative or narrated-step comments were introduced.

The browser-provider helper independently verifies exactly two actual PUT observations using awaited `allHeaders()`, HTTPS/configured storage hosts and no Cookie header. It checks PDF/DOCX exact DTO sizes/hashes, UPLOADED/ACCEPTED status, WAITING_FOR_PIPELINE, repeated finalization returning the same job, probe-stream denial, wrong-SHA rejection with no accepted status/job and Staff denial. These assertions do not directly read server-only original bytes or count database rows; those claims need complementary backend/storage evidence. No app-owned object deletion exists in the helper.

The live-storage helper's 400 compatibility path requires both `InvalidArgument` and the exact `Authorization` message within a bounded diagnostic. It does not accept arbitrary 400 errors for the other tampering cases. Resume mode rejects null/non-object prior receipts, requires the specific earlier failure, an uncleaned owned UUID prefix and a previously successful 200/412 race. It resumes that identity and freshly rechecks its bytes; it does not create a new canary in resume mode. Cleanup targets only its one owned standalone synthetic canary after the remaining checks succeed. App originals/reservations are retained separately.

The seven in-memory assertion controls passed: exact 400 authorization denial accepted; wrong code rejected; wrong message rejected; matching fields beyond the 4,096-character diagnostic cap rejected; HTTP 200 rejected; 400 rejected when a tamper case permits only 403; ordinary allowed 403 accepted. Fetch options also retained redirect refusal and a timeout signal. The VM never evaluated the helper's private configuration/credential reads or made a real request.

### Q-S04-4: Redis verifier window excludes observed valid third-attempt completion

The lead/DevOps report the post-policy run as worker-pause PASS in 38.129 seconds, worker-loss PASS in 66.943 seconds, then Redis collector FAIL at its original 100-second bound. The Redis case proved both queue processes automatically restarted from count 0 to 1 and became healthy. These runtime observations are attributed evidence, not Docker actions independently executed by this QA agent.

The decisive supplied database timeline is:

| Observation | Recorded result |
| --- | --- |
| Probe created | 22 November, 06:52:28.766 Asia/Jakarta |
| Retries | +60.918 seconds and +121.001 seconds |
| Third-attempt dispatch accepted | 06:54:33.900 Asia/Jakarta |
| Started / completed | +127.599 seconds / +136.092 seconds |
| Terminal database state | COMPLETED; attempt 3; dispatch count 1; one completion |
| Redis return / worker start / main start | 06:52:46.939 / 06:52:48.087 / 06:52:49.212 Asia/Jakarta |

This observed completion genuinely exceeded 100 seconds. A separate isolated scheduling experiment showed that synchronous Docker calls can also delay SSE consumption: with already-buffered valid frames and the unchanged 100,000 constant under a 1,000-times scaled clock, the immediate control consumed two events, while a 150-millisecond synchronous block consumed none and raised the deadline error. That experiment establishes a possible mechanism in this script; it does not explain away this database timeline. Exact service-readiness and HTTP-failure classifications were not captured and remain unknown.

`src/server/jobs/contracts.ts` currently permits three attempts of 60,000 milliseconds. QA supports a narrowly explicit Redis-only 200,000-millisecond collector window: 180,000 for that configured retry horizon plus 20,000 reconciliation/transport allowance. Every other collector must retain the original 100,000 default. This is a bounded test expectation for the deliberate extended outage, not an application deadline change, production timing promise or PRD latency waiver. Preserve failed-frame rejection, validated terminal/cursor/byte/event checks and automatic-restart assertions. Record and review any separate health-wait change rather than changing global waits silently. The proposed correction and full six-case/native-POST rerun remain pending at this checkpoint.

### Live-provider evidence boundary

The sanitized receipt dated 22 November 06:58:36.082 Asia/Jakarta records allowed-origin preflight 204, foreign-origin preflight 403, all six tampering denials 403, conditional race 200/412, replay 412, successful authorized exact-byte read and unsigned S3 denial 400 with the exact authorization-field check. It then stops at the provided public development URL. The lead reports `CERT_HAS_EXPIRED`; QA did not issue that HTTP request or independently inspect a TLS diagnostic. The receipt remains FAIL with `cleaned:false`, without expiry or cleanup results. Dashboard-disabled confirmation, S3 denial and an unavailable development-domain HTTP check must stay distinct. No TLS verification bypass or public re-enablement is approved by this review.

### Inspected source hashes

| File | SHA-256 |
| --- | --- |
| `docker-compose.yml` | `3c760ac94d927cef0c063383aeebe07e460a2bd98c8e32e13c8ed8649a01ddad` |
| `scripts/verify-workflow-runtime.mjs` | `118f2fad83d674c9ff2cea8452fff74dccbc55a4c17032552c7e41b53247989c` |
| `.local-secrets/s04-r2-live-check.mjs` | `d5d4db6e4862a0a3028b1cce810fe8d6169f4cc910b9fa4ad199151bc78abc2f` |
| `.local-secrets/s04-r2-browser-check.mjs` | `b37061bea09d6abddb59b3d7b960d3f3c64d8b44f25b7258d2084b8a58196ee4` |

Private helpers/receipts remain ignored. Only their reviewed source hashes and sanitized results are recorded here. Full S04 acceptance remains BLOCKED by the current fault-verification failure, unfinished live-provider checks, absent app-provider receipt and exact final hosted CI/candidate reconciliation. No S05, real SOP processing, production policy or deployment is approved.

## Final local recovery reconciliation: 22 November 2026

This independent follow-up supersedes the preceding pending recovery/source checkpoint without deleting its failures. The observed working-copy basis is still HEAD `868dca58d785540000bf3c1b81f70a1f4c91f20a` on `codex/s04-private-uploads`; final publication identity remains pending. QA reread the required guides, full protected technical PRD, all four original product-PDF pages, complete plan, testing guide, S04 contract/checklist and the current evidence. Implementation and assertions were inspected read-only. No index, service, database or provider configuration was changed; no actual credential/configuration file was read. Only this assigned report is edited.

### Independently checked source and artifacts

| Check actually performed | Result | Scope / limit |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS before this follow-up | Both protected originals unchanged. |
| `node --check scripts/verify-workflow-runtime.mjs` | PASS | Parses only; QA did not execute its Docker or network controls. |
| `node --check .local-secrets/s04-r2-browser-check.mjs` and `node --check .local-secrets/s04-r2-original-check.mjs` | PASS | Parses only; top-level imports, private-file access and provider calls were not evaluated. |
| TypeScript AST audit of the current recovery verifier | PASS | Six collector call sites; exactly one third-argument call in the extended Redis case. Default remains100,000ms; Redis uses3×60,000+20,000=200,000ms. The12,000ms outage,65,536-byte capture and64-event limits remain. |
| Saved final recovery stdout | Independently inspected: all six PASS | Actual execution belongs to DevOps. The log does not independently encode the process exit code; exit0 is attributed to the DevOps handoff. |
| Saved native POST stdout | Independently inspected: PASS | Default301/307 reached destination twice; explicit no-follow reached it zero times; both had zero forwarded canaries. No new native HTTP request was made by QA. |
| Encoding-aware JSON audit of both saved logs | PASS | Both files have an actual UTF-16LE BOM. Six distinct recovery PASS records and the exact automatic-restart/budget fields were asserted; both redirect modes and canary counts were asserted. An initial UTF-8-only QA parser found zero records and failed before the BOM-aware correction; no product test or assertion was weakened. |
| Sanitized live R2 canary receipt | Independently inspected: PASS_WITH_LIMIT | Same637-byte canary, six403 tampering denials,200/412 race,412 replay, exact authorized hash,204/403 CORS controls, true2s-expiry403, exact unsigned400 authorization-field rejection and final DELETE204. Public-domain HTTP remains unobserved due to expired TLS. |
| Fresh provider runtime receipt | Independently inspected: PASS at22 November12:07:16.858 Asia/Jakarta | Fresh project `ai-sop-s04-r2-verify-20261122`; only `127.0.0.1:3000` published. This receipt is lead-executed evidence, not a Docker inspection performed by QA. |
| Application-provider and sealed-original receipts | NOT PRESENT when checked | No live application upload, stored-original or hosted-CI PASS is inferred from the prepared helpers or runtime startup. |

The source audit inspected the actual `collect` declaration and call expressions rather than executing top-level verifier setup. The optional parameter defaults to `recoveryMilliseconds`; only the Redis case passes the calculated budget. All five other calls retain the default. Queue recovery still requires increased restart counts, different start times and healthy services after an outage exceeding the vendor reconnect threshold, without manually starting either queue process inside that case. The queue-health wait is unchanged. Failed frames, unsafe/unexpected fields, duplicate/reordered cursors, over-budget captures, missing judge-stub progress and multiple/missing terminal completions remain failures. No production attempt, retry, lease, token, HTTP or SSE bound was raised.

The saved final run records:

| Actual case | Result | Recorded duration |
| --- | --- | --- |
| Worker pause | PASS |29.573s |
| In-flight worker loss | PASS |57.852s |
| Extended Redis interruption | PASS |90.704s |
| App restart and reconnect cursor | PASS |26.403s |
| Account deactivation | PASS |8.449s |
| Actual60s proxy timeout/reconnect | PASS |75.530s |

The automatic-recovery record explicitly states200,000ms=180,000ms+20,000ms, main restart count1→2, worker0→1, both healthy and no manual queue-process starts. These are measured synthetic-runtime observations. They do not turn the earlier136.092-second recovery into a100-second pass, establish a production recovery guarantee or prove a real LLM judge/SOP answer.

The final count-only snapshot retains19 JWT-bearing execution payload rows with84 JWT occurrences, zero orphan payload rows and zero private-key markers. One queue hash contains zero JWT occurrences; all available final Docker/native log counts are zero for JWT/Bearer/private-key markers. The paused-worker log was explicitly deferred in the earlier paused snapshot. This proves neither zero execution persistence nor a fixed pruning deadline; QA did not inspect payload contents or change pruning.

### Provider assertion fidelity

The current browser helper uses three positive files: a PDF, a DOCX and an exact20,000,000-byte PDF. It requires exactly `files.length` actual browser PUT observations from awaited `allHeaders()`, each using HTTPS and a configured storage host without a Cookie header. Exact API size/hash, UPLOADED/ACCEPTED state, parked job, repeat-finalization identity, probe-stream rejection, checksum422/no accepted record and Staff403 remain asserted. The large-file180s observer budget covers the existing client120s direct-transfer and metadata windows; it changes no backend15s storage deadline. These are source observations until the actual application receipt exists.

The complementary original-byte helper uses receipt-bound UUIDs and a guarded provider-project identity. Its one-off database reader has a single runtime-credential mount, private database network, no log driver, nonroot/read-only/drop-capability/no-new-privilege/resource restrictions and parameter-bound static SELECTs. Successful execution must confirm that query container is removed. It then compares each server-only original's actual S3 content length, MIME and streamed SHA against the browser receipt and database row, requires one undispatched parked job, verifies no document/job for the failed checksum, and checks unsigned access to the known original. It does not delete app-owned objects or release reservations. QA found no demonstrated assertion blocker in these inspected sources; execution remains required.

The standalone canary's PASS_WITH_LIMIT is accurate: the optional disabled development-domain probe records `HTTP_NOT_OBSERVED`/`CERT_HAS_EXPIRED`, without disabling TLS or counting that transport failure as authorization success. Dashboard-disabled/empty-domain confirmation, an actual private-S3 known-object denial, and unavailable public-domain HTTP evidence remain distinct. No company privacy, residency, recovery, retention or production-file-limit approval follows from this synthetic check.

### Exact inspected identities

| File / artifact | SHA-256 |
| --- | --- |
| `docker-compose.yml` | `3c760ac94d927cef0c063383aeebe07e460a2bd98c8e32e13c8ed8649a01ddad` |
| `scripts/verify-workflow-runtime.mjs` | `5f088a15386a1f8d81f4f7466c7309070a40999229db9f0d0614c236baf84bf2` |
| `src/server/jobs/contracts.ts` | `0dd36e38903e6467a36d9726e83092799969d7f967fa4d74ad17277bd9bc029b` |
| Ignored browser-provider helper | `92e74f0875394e706e27ba2b76f1bc7cf6227a851f62568b1326b87cfaacd62c` |
| Ignored sealed-original helper | `0242e14441aa58c060cf38c2bd33b035ec541e95ab22ba29a37bf17e901884d5` |
| Sanitized standalone R2 receipt | `40ee97982d0e94e7c7e79dcdad96421d8e4e2f6bc3a7bcf1353a11dd0c1e8e84` |
| Sanitized fresh provider-runtime receipt | `94d43e5e492156fc1ebb94b3463b02998e98b5fcbd00abb1cd2540b40c715439` |
| Saved recovery stdout, original UTF-16LE bytes | `1b9f1f455cb8c4ce50799025f6e5e8c79085c081051658b6699a28037dca4d78` |
| Saved native POST stdout, original UTF-16LE bytes | `9ebcac54f26eb46b72b45f317d097c658327a546dac852199878d501fc073c56` |

The corrected local recovery evidence no longer blocks S04. Remaining mandatory checks are the actual application/private-original provider results, exact finished hosted candidate and final evidence reconciliation. Existing unchanged unit/database/browser runs were not repeated by this pass. S04 is not yet VERIFIED, and S05/real-data processing/deployment remain gated.

## Large-file deadline correction: 22 November 2026

The lead reports two real-provider20MB finalization failures under the original15s storage window, with no accepted original/job. Separate measured staging GET and standalone PUT observations were11.220s and10.699s; a second PUT without Expect took9.789s, and Continue acknowledgement was133ms. These are attributed lead measurements, not provider calls performed by QA. They support investigating the combined verification/sealing window; they do not establish a transfer guarantee or justify disabling transport protections. The SDK transport defaults were retained.

The scoped correction changes storage15→30s, finalization fence30→45s and document-client metadata25→35s. The existing35s proxy read timeout,120s direct PUT timeout,20,000,000-byte cap, two-finalizer limit, reservations, authorization/immutable identity, ingestion isolation and all workflow/callback/SSE limits are unchanged. These are implementation/test limits subordinate to the PRD, not an approval of production file policy or a change to chat-answer latency targets. The prior44-file manifest, local production image/70-file manifest and UI client hash are historical snapshots after these production-file changes; a rebuilt candidate and affected checks are required.

### Focused independent verification

| Check actually performed | Result | Limit |
| --- | --- | --- |
| Four-file diff/source review | PASS; no demonstrated source blocker | Reviewed contract constants, client deadline, revised DB case and new client unit file; no implementation/assertion/index edit by QA. |
| `npx.cmd vitest run tests/unit/document-client.test.ts` | PASS2/2,622ms; start12:37:17 Asia/Jakarta | Mocked fetch and controlled timers only. No browser, database, provider or actual credential/configuration access. |
| New29s response case | PASS in the targeted run | A valid complete DTO arriving at29s is accepted. The previous25s client deadline would abort before that response, so this is a behavior-sensitive regression. |
| New unavailable-response case | PASS in the targeted run | The request is still pending at30s and raises `TimeoutError` after advancing to36s. This proves the tested lower/upper interval, not an independently measured exact35s wall-clock timeout. The previous25s limit would settle too early and fail. |
| Revised actual-DB deadline case | Source inspected; execution pending | Storage ignores abort while held. Finalization must remain pending at29s, fail with `UPLOAD_STORAGE_UNAVAILABLE` at30s, leave no document/job and expose FAILED status. Barrier release, timer restoration and awaited outcome remain in `finally`. |
| Protected PRD integrity | PASS before this review; post-report result checked separately | Both originals/baselines remain unchanged. |

The client tests replace `AbortSignal.timeout` with a controller scheduled through the fake `setTimeout`; they exercise the real `processUpload` request/schema wrapper with mocked fetch. Both the deadline and response/abort behavior follow the controlled clock, and cleanup clears timers, restores real timers/spies and unstubs globals after every case. The tests do not call the network or certify native-browser timeout scheduling. Their fixture is a synthetic response DTO; it is not evidence of stored-file validation or acceptance.

The database case fakes only JavaScript `setTimeout`/`clearTimeout`. Date, performance and PostgreSQL `clock_timestamp()` remain real. It therefore tests the application deadline and actual persisted failure/no-acceptance result, not45s of database wall-clock lease expiry. The separate stale-fence/replacement case still exercises rejection after explicit database lease expiry. Source inspection confirms the45s fence exceeds the30s storage window, retaining the15s fence margin and fresh post-I/O authorization/fence checks. Actual PostgreSQL execution is still needed after rebuilding the changed candidate.

| Current changed file | SHA-256 |
| --- | --- |
| `src/server/documents/contracts.ts` | `86ed3af17cad9aa1a015ea89b4f6f15911fad7b0d3d4b7bd3c1ba854056f1d21` |
| `src/components/documents/client.ts` | `42fb6992480f5eef9caa03c2d74b8c44482aeb92ff5aa590133aa6fbbcf60baf` |
| `tests/integration/documents.test.ts` | `d27e45635f5cf855550883268312765628d283c886ce6120229fa0d1d01ec131` |
| `tests/unit/document-client.test.ts` | `7a36a8face29e219c950b15b39347db84a8904d87a99750f3bdde6910ea55d0e` |

The lead plans the full40-unit/48-DB checks, rebuilt app and a new valid20MB provider trial while retaining the expired failed intent, staging bytes and reservations. Those outcomes and final45-file publication/CI evidence remain pending here. No old green result is presented as proof of the changed server/client deadline. This focused review does not close S04.

### Direct abort-signal assertion and updated freeze

Security identified a useful fidelity gap in the first revised database assertion: the outer finalization promise can remain unsettled while database cleanup is waiting, even after a timeout has fired. Pending outcome at29s alone therefore does not directly prove that the storage deadline has not already aborted.

The final test now forwards the actual third `AbortSignal` argument through `SyntheticStorage.read` into `beforeRead`, captures that exact signal, and asserts `aborted === false` after29,000ms and `aborted === true` after the next1,000ms. It retains the outer pending/failure assertions, no-document/no-job and FAILED-status checks, barrier release, real-timer restoration and awaited cleanup. QA inspected these precise source changes; an undefined or incorrectly captured signal cannot satisfy the boolean assertions. This makes an early abort observable independently of database-cleanup scheduling. Fake JavaScript timing versus real Date/PostgreSQL clock remains the limitation described above.

The current integration file SHA-256 is `cadd9e97b627eb222ea10e4360c4a4ca615c4c2b7a602a974ea8936374c51250`; it supersedes the preceding `d27e4563…` test snapshot. No additional suite, provider request, runtime or database action was executed by QA for this strengthening; the actual48-test database rerun remains DevOps-owned and pending at this checkpoint.

The lead reports a concurrent unit/lint/typecheck attempt with39/40 units because an existing VM100ms cap triggered. An unchanged standalone unit rerun then passed40/40 in7.23s, with that cap retained; lint, TypeScript, PRD integrity and whitespace also passed. These are attributed lead executions, not fresh QA suite runs, and no cause of timing variance beyond the recorded concurrency/cap observation is asserted. The earlier unsuccessful run is not erased.

The public ESLint configuration adds only `.local-secrets/**` to its existing global ignores. Source, tests and public configuration remain under the existing Next.js/TypeScript rules; no public-source pattern or rule was newly suppressed. Private diagnostic helpers remain separately parsed/reviewed and outside publication. Current `eslint.config.mjs` SHA-256 is `86eea8fb9263826aea7e60658ebe7f496112db70d8a5cd45ff4bb6169967b84d`.

Final staged implementation/test/configuration count is now46 files, pending security's final manifest and exact hosted candidate. The30s contract,35s client and new client-unit hashes in the preceding table are unchanged. Rebuilt-image, actual20MB provider, real database and hosted-CI results are still required; this source-only follow-up does not approve S04 or reuse the historical44-file/image/UI-client fingerprints as current evidence.

## Updated database and actual-provider evidence: 22 November 2026

QA resumed after the reported reset window and independently inspected the specifically permitted sanitized build, database, browser-provider and original-byte receipts. This pass read no actual key, environment configuration, account fixture or private raw log, and performed no Docker, database or provider operation. The executions belong to the lead and DevOps; the receipt consistency and public-source comparisons below were performed by QA.

| Evidence | Independently checked result | Provenance and limit |
| --- | --- | --- |
| Controlled deadline build,05:43:12.153–05:44:04.072Z | PASS, exit0, sourceUnchanged=true; app index `96a51f9116fa7059b83edad3dd7b239489430e3b723b55ef5009b4f3d1a0d958`;70-production-input manifest `6ea5253735eeb6459e20ea3b843a134b185cb3391597d8aab663ad19cf2811b8` | The92 recorded admitted-file pairs include the corrected30s contract,35s client, new client units and strengthened direct-signal DB test. A later CSS-only change is reconciled below. QA did not build or inspect a running image. |
| Updated real database run,05:44:18.323–05:44:50.513Z | PASS in the saved receipt; PostgreSQL start, DB command and stop each exit0; DB command21.841s | DevOps reports48/48 tests in16.83s:18 document,12 job,15 auth and3 foundation. Receipt image index `484b3d2e7401bfed6aba9b00caed9fcfd4366b67ab40012d7e0d0651e35e1b4f` matches the controlled build. No dispatcher, provider call or migration ran; the old synthetic database/volume was retained and all nine services stopped. QA did not independently rerun this suite or infer fresh-migration proof. |
| Actual application browser/provider run,11:11:23.673Z (18:11:23.673 Asia/Jakarta) | PASS; three accepted files of637,1134 and20,000,000 bytes; three actual browser PUTs; no browser cookies sent; app objects/reservations retained | The helper starts an empty accepted array and performs all three uploads in one loop, with no resume/skip path. Saved success requires exact API hashes/sizes, UPLOADED/ACCEPTED state, one parked job, repeated finalization returning the same job, probe-stream404, wrong-SHA422 with FAILED/no canonical state/job and Staff403. Those assertion paths were source-reviewed; actual browser/network execution is the lead's. |
| Retained-original run,11:12:30.409Z (18:12:30.409 Asia/Jakarta) | PASS; raw app-receipt SHA matches exactly; three original-byte/hash/MIME comparisons, one parked job each, negative no document/job, unsigned statuses400/400/400, read-only query container removed, app objects retained | The reviewed helper requires actual bounded S3 streams and exact size/MIME/SHA, parked jobs with zero dispatches, and the exact Authorization diagnostic for a400 denial. QA inspected the saved receipt and helper, without issuing SELECTs or signed/unsigned requests. The lead separately attests the provider run used the rebuilt deadline app image. |

The original15s/20MB failures, old runtime/image identities, original100s recovery failures and136.092s third-attempt timeline remain historical evidence above. The later successful receipts do not erase those failures or establish a general provider latency guarantee. The strengthened DB test now has an executed48-case run, while its fake JavaScript clock versus real PostgreSQL clock limitation remains unchanged. The independent2-case client run and attributed standalone40-unit run remain distinct.

### Receipt identities and reproducible consistency checks

| Permitted ignored receipt/helper | SHA-256 of actual bytes |
| --- | --- |
| `s04-budget-build-receipt.json` | `61b58ca90ff934cec4d61b107a825145805bc6011cde88140ad79300f42a7790` |
| `s04-budget-db-receipt.json` | `fcd61efb83b8979623ef5d43a213999a42c40ec8a4c6cf299b1a07ebde832507` |
| `s04-r2-app-receipt.json` | `6f1e105cfc53818e0554d877bd2d26299d9d589dc14cf1fe40b8e37a029931ef` |
| `s04-r2-original-receipt.json` | `f9d134a76c34c5525f0cbbafd4de63e7795431476c0e77fe65f3c9e2c2e11625` |
| Subsequently permitted `s04-cursor-build-receipt.json` | `3667a357b2501013c180d059790ec69e49924a9535089630fccadf9fae72f00a` |
| Current `s04-r2-browser-check.mjs` | `8d60ea5ac7a2a9f8b84f049324185a3f2b34cffbfed4d67b310143b2ea6e7235` |
| Unchanged `s04-r2-original-check.mjs` | `0242e14441aa58c060cf38c2bd33b035ec541e95ab22ba29a37bf17e901884d5` |

QA ran these Node assertions through PowerShell here-strings, using only the permitted sanitized receipts and public files. The raw-byte receipt link, success fields, counts, negative result and manifest differences passed. No helper's top-level provider/runtime setup was executed.

```javascript
const fs = require('fs');
const assert = require('assert/strict');
const crypto = require('crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const appBytes = fs.readFileSync('.local-secrets/s04-r2-app-receipt.json');
const app = JSON.parse(appBytes);
const original = JSON.parse(fs.readFileSync('.local-secrets/s04-r2-original-receipt.json'));
assert.equal(app.result, 'PASS');
assert.equal(original.result, 'PASS');
assert.equal(original.appReceiptSHA256, hash(appBytes));
assert.deepEqual(app.accepted.map(file => file.sizeBytes), [637, 1134, 20000000]);
assert.equal(app.actualBrowserPuts, 3);
assert.equal(app.browserCookiesSent, false);
assert.equal(app.retainedAppObjectsAndReservations, true);
assert.equal(original.verifiedOriginals, 3);
assert.equal(original.exactStoredBytesAndHashes, true);
assert.equal(original.singleParkedJobs, true);
assert.equal(original.negativeHasNoDocumentOrJob, true);
assert.deepEqual(original.unsignedStatuses, [400, 400, 400]);
assert.equal(original.readonlyQueryContainerRemoved, true);
assert.equal(original.appObjectsRetained, true);
const build = JSON.parse(fs.readFileSync('.local-secrets/s04-budget-build-receipt.json'));
assert.deepEqual(build.source.pairs.filter(([file, expected]) =>
  hash(fs.readFileSync(file)) !== expected).map(([file]) => file), ['src/app/globals.css']);
```

### Subsequent CSS artifact and remaining gate

The lead's UI check found default cursors on associated labels and added only `label[for] { cursor: pointer; }` plus `label[for]:has(+ :disabled) { cursor: not-allowed; }` in the Tailwind base layer. QA inspected the staged diff and current CSS SHA-256 `33299e7f63cae3a1dcffa49830f6725feccae4bc10b145ccfbae1ca243a072e6`. An independent comparison of all92 prior build-input pairs found this CSS file as the only difference: all69 other production inputs and all22 test inputs still match. There is no backend/client logic or assertion change to invalidate the matching database/provider evidence. This source comparison does not itself prove browser cursor behavior.

The lead subsequently permitted only the sanitized cursor-build receipt. QA independently checked its PASS/CLI exit0, sourceUnchanged=true, final app index `c9c9b062f540ae4a9402e0e6a934479192cc6ed3eb659af3754e95a6cff65f61` and amd64 manifest `ab33a09bee732c8daf60b31f3bf711cd90f02be02072c1df984a585dbac23e91`. All92 recorded source hashes match the current files. Recomputing SHA-256 of the sorted pair arrays exactly reproduces admitted manifest `ec2b463128ef9ae5830781a440f44474bafb8dbc818b4d870a958a707c2a327a` and70-production-input manifest `23a5e08fb27318a939a3831d2b8a6a1095082b86fdc4ba6a233600d01f5afa5f`; the recorded prior manifest matches `6ea52537…` above. The receipt confirms69 unchanged non-CSS production inputs, zero build secrets/arguments, nonroot `node`, no sensitive image environment names, old services stopped and volume retained. Its runtime CSS check records enabled pointer/disabled not-allowed and excluded private paths absent; built CSS SHA-256 is `1134f84d9cf52d6f51ba2e488b248d05e34d6c1afe0b2f9696d6f99130a6573d`. These are independently checked saved attestations, not a Docker/browser operation by QA. The lead's completed real-UI check remains required. The preceding46-file manifest/image is historical; staged source count is now47.

The browser helper's180s large-file observer is a harness ceiling, not a guarantee that all maximum client windows fit:35s initialization +120s direct PUT +35s finalization can total190s before hashing/render overhead. A slow otherwise-valid run could therefore fail the observer; this cannot create a false success, and the recorded actual three-file run passed. The earlier coverage claim concerned the previous metadata windows and does not change the current app deadlines.

Mandatory exact published-candidate hosted CI and final UI/evidence reconciliation remain NOT RUN at this checkpoint. The optional disabled public-domain HTTP probe remains HTTP_NOT_OBSERVED/CERT_HAS_EXPIRED with TLS verification enabled; actual private-S3 denial and user dashboard confirmation remain separate. Company policy/production-file-limit approval, real-data processing, deployment and S05 are not authorized by these synthetic results. No unchanged local suite was repeated for this receipt/CSS review, and S04 is not yet VERIFIED.

## Final lead UI and current runtime reconciliation: 22 November 2026

The lead froze47 source/test/configuration changes and completed the nondelegatable real-R2 UI delivery gate at11:39:48.617Z (18:39:48.617 Asia/Jakarta), then recorded current provider-runtime metadata at11:40:33.093Z. QA was specifically permitted to read only `.local-secrets/s04-ui/receipt.json` and `.local-secrets/s04-r2-current-runtime-receipt.json` for this follow-up, alongside public reports/source. No screenshot, key/configuration, private browser fixture or other new private file was read, and no suite/provider/runtime operation was repeated.

| Evidence independently inspected | Result and correspondence | Limit |
| --- | --- | --- |
| UI receipt, SHA-256 `9270f3c1094e12b45315ed155a4c6c81250a28abf5a318d46b42ffdadcda55a5` | PASS,13 recorded checks and5 screenshot paths; receipt timestamp matches [S04-ui.md](S04-ui.md) | The lead personally inspected the five screenshots. QA checked receipt/report consistency, not the images or browser session. |
| Final UI assertions | Receipt records account loading,320/768/1280 reflow, Tab/visible focus, title-label pointer/focus, account error Retry, disabled-label not-allowed, pending/disabled actions, injected-transfer-error Retry/recovery, reload/Check upload,200% text/320×300 saved view, account/sign-in navigation, Staff denial and no uncaught page errors | Controlled delays/failures prove observed UI states, not a provider outage. Native chooser click-through, measured contrast and full item-by-item antislop gate are attributed to the lead's public report. Coverage is measured Chromium behavior, not universal accessibility or physical-device proof. |
| Current-runtime receipt, SHA-256 `6c9cdf6144c16a3f1c6d7d87ff4d12ddf7999b3667a08d30e92c2583a8c762ce` | PASS; project `ai-sop-s04-r2-verify-20261122`; app index exactly matches final cursor-build `c9c9b062…`;8 owned containers=6 healthy services+2 successful one-shots; only `127.0.0.1:3000` published | Saved runtime attestation checked by QA, not a Docker inspection or provider call by QA. |
| Runtime isolation | Actual R2 enabled, individual read-only credential mounts,9 old fixture containers stopped and old project retained | These fields corroborate the lead's synthetic-runtime boundary; they do not establish production readiness or company-data approval. |

QA used Node `assert/strict` against the two JSON receipts to require PASS, exact counts, the expected provider project and final image, enabled actual-R2 mode, read-only individual mounts, old-container/retention fields and the single loopback publication. Receipt fields and the current `S04.md`/`PLANS.md` evidence agree. Their newly explicit historical-checkpoint wording correctly preserves the earlier failures and pending states. Security's final47-source/publication/CI reconciliation remains independently owned; its older46-source cutoff is not a substitute for final sign-off.

The final UI report also retains two harness observations: a5s small-file observer expired during real finalization and was replaced with40s, outside the unchanged35s client deadline; a Staff sign-in request timed out at30s, then an unchanged isolated check passed in1.919s and the full unchanged gate passed. No cause is assigned to that sign-in timeout. No application timeout or authorization assertion was relaxed. This replaces the previous section's pending real-UI status; existing69-file unchanged-input proof carries forward the matching backend/provider/database evidence.

Source remains frozen at47 changes with the final app/production manifest above. Exact published commit and independently decoded hosted-CI evidence are the remaining mandatory QA gate. No new product defect or material contradiction is demonstrated by the permitted receipts/current reports. S04 remains VERIFYING, with S05, production and company SOP processing still gated.

## Exact published candidate and hosted CI: final QA acceptance

The final source candidate is `1ef852166cda0e07c231ddd4834cf053442bb1dd`, tree `64a1946be0983098bfc4a6f12b4513a6681fd9cb`, on `codex/s04-private-uploads`. It changes55 files relative to kickoff868dca5:47 source/test/configuration files and8 Markdown reports/guides. QA independently recomputed the47-source path/NUL/lowercase-SHA256/newline manifest as `e8d68296d880a3787ef0aa44becc610f1225a8dd8f59e9f38490a474fbdd317e`, exactly matching security's frozen source checkpoint. Read-only Git inspection used `git diff --name-only`, `git cat-file --batch` and `git rev-parse <candidate>^{tree}`; no index/object/ref or implementation mutation was made.

### Exact source/artifact newline distinction

The first raw-byte comparison of all92 receipt inputs to the published Git blobs failed only for `tsconfig.json`. The saved local image input is703 bytes, SHA-256 `04569496623a9a2ccc85ee42ba924fae0d59ac7fd7ab65457571b68b9aac44ae`, ending in CRLF; the committed blob is702 bytes, SHA-256 `3a2d2d9e970868c7140a8c038745ff991a59d2103b272c45cb2cda1650ea39d6`, ending in LF. All other bytes match after CRLF→LF normalization, and parsed JSON is identical. The other91 build inputs match their committed blobs byte-for-byte. The worktree was clean at this comparison; the file is unchanged by this sprint and is outside the47 changed-source manifest. QA did not rewrite either representation.

The canonical committed92-input aggregate is therefore `c12c35050e0ace4e9e3c52aa1ba86c1b5dc3ac017f8a1c40c383e9e811b2855d`; its70-production-input aggregate is `c24cef94d6d9a1ffc61f25ceaed500fd1c11c10db44e6a12a4e4275438439ae1`. These differ from the local receipt aggregates solely because they hash the committed final LF. This is a documented byte-level provenance difference without a compiler-option/content change. The hosted build and runtime checks below executed the exact committed blob, so no semantic source mismatch or untested implementation delta is inferred.

### Independently fetched primary GitHub evidence

QA fetched the run metadata, job/step metadata and decoded complete job log through the GitHub tools:

```text
github_fetch: https://api.github.com/repos/AuserZ/ai-sop-assistant/actions/runs/45018939728
github_fetch_workflow_run_jobs: repo_full_name=AuserZ/ai-sop-assistant, run_id=45018939728
github_fetch_workflow_job_logs: repo_full_name=AuserZ/ai-sop-assistant, job_id=137197322521
```

[Hosted run45018939728](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45018939728), attempt1, completed successfully. Metadata binds `head_sha` and the commit tree to the exact identities above; the decoded checkout log independently prints the full same commit SHA. The run started11:46:17Z and was last updated11:57:12Z on22 November2026 (18:46:17–18:57:12 Asia/Jakarta). The sole required `foundation` job, ID137197322521, and all19 job-step entries are completed/success, including setup, checkout/setup-node post-actions and Complete job. There is no skipped/canceled/failing mandatory step. The fetched decoded log contains332,582 characters and4,304 lines; QA inspected the command/result sections and complete native/browser/recovery/redirect/cleanup output rather than relying only on the green run badge.

| Exact hosted command / required step | Observed result |
| --- | --- |
| Pinned checkout/setup-node; `npm ci` | PASS; exact checkout SHA, Node24 setup and successful clean install. Dependency warnings below remain visible. |
| `npm run check:prd` | PASS; both protected originals explicitly unchanged. |
| `npm run lint`; `npm run typecheck` | PASS; ESLint with zero warnings; Next route type generation and TypeScript no-emit complete. |
| `npm test` | PASS40/40 in9 files,2.72s, including2 document-client deadline cases; no skipped test is reported. |
| `node --test infra/n8n/local-secrets.test.mjs` | PASS1/1; fail/canceled/skipped/todo all0. |
| `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` | PASS7/7; fail/canceled/skipped/todo all0. |
| `npm run build` | PASS optimized Next.js compilation, TypeScript and7/7 static pages; document init/status/process routes included. |
| Compose config and app/migrate/verify-db/storage-fixture builds | PASS in the smoke/database step; no masked shell failure. |
| `SOP_STORAGE_FIXTURE_VERIFY=1 SOP_STORAGE_FIXTURE_IMAGE=ai-sop-assistant-storage-fixture node infra/storage-fixture/verify-native.mjs` | PASS actual native PUT/HEAD/GET200 and exact bytes; Authorization-signed SDK.send PUT/GET200/replay412; unsigned known object400; conditional race200/412;9 cryptographic denials,5 gateway denials,0 diagnostic/log credential markers. Isolated network:none/read-only/nonroot container removed;0 persistent volumes created. This is synthetic native compatibility, not actual R2 proof. |
| PostgreSQL startup and `docker compose run --rm --no-deps migrate` | PASS; migrations applied successfully. The dependent migrator later exits successfully. The earlier local repeated-migration/four-ledger-row proof remains separate; this CI log is not claimed to print a fresh ledger count. |
| `docker compose --profile verify run --rm --no-deps verify-db` | PASS48/48 in4 files,4.82s:18 document,12 job,15 auth and3 foundation. Includes exact storage-signal29s/30s assertions in the frozen test source, persisted rejection/no-acceptance and actual PostgreSQL authorization/locking checks. |
| Proxy/storage-fixture startup, live/ready `curl --fail` and conversion-profile command | PASS; proxy and fixture healthy, both HTTP smoke commands succeed, LibreOffice7.4.7.2 version probe completes. This is tooling smoke, not S05 extraction/OCR proof. |
| Injected synthetic browser seed; `npm run test:browser` | PASS15/15 in48.7s:5 document journeys,6 auth journeys and4 workflow journeys. Exact20MB upload/sealing, narrow DOCX, cookie/RBAC, validation/retry, validation-failure stream, slow reader and reconnect/ownership cases pass. Delivery is injected; no email provider is called. |
| `node scripts/verify-workflow-runtime.mjs` | PASS all6 actual cases below; post-check fixture force-recreate returns healthy. |
| `node infra/n8n/verify-redirects.mjs` | PASS actual native POST301/307; each source hit once per mode, default destinations2, no-follow destinations0, forwarded canary0 in both. This remains separate from Queue Mode proof. |
| Always-run `docker compose --profile verify --profile conversion down --volumes --remove-orphans` | PASS; decoded output removes all9 service containers, the3 edge/database/workflow networks and the disposable PostgreSQL volume. Both post-actions and final job completion succeed. Only this disposable hosted environment is removed; the local provider objects/reservations/project remain retained. |

| Hosted recovery check | Result | Measured duration |
| --- | --- | --- |
| Queued work/worker pause | PASS |11.518s |
| In-flight worker loss/fencing | PASS |34.046s |
| Redis interruption/durable work | PASS |72.276s |
| App restart/reconnect cursor | PASS |21.106s |
| Account deactivation/open-stream closure | PASS |5.253s |
| Actual60s proxy timeout/reconnect | PASS |71.389s |

The hosted Redis record requires at least12,000ms interruption after an active attempt, main and worker restart counts0→1 with both healthy, and `queueProcessesManuallyStarted=false`. Its200,000ms collector remains explicitly180,000ms bounded retry horizon+20,000ms delivery allowance. The default100,000ms collector and all production retry/token/SSE bounds retain their previously inspected values and assertions. The actual60s paused-worker interval is visible in the decoded proxy-timeout case. Passing these synthetic probes does not prove an actual SOP answer or real LLM judge.

The final hosted count-only snapshot at11:56:02.428Z contains13 JWT-bearing execution payload rows and54 JWT occurrences across statuses,0 orphan rows/private-key markers,0 JWT occurrences in2 queue hashes and0 available Docker/native-event log credential markers. Its earlier paused snapshot explicitly defers the paused worker's native log. This is a separate disposable-runtime observation from the earlier local19-row/84-occurrence snapshot. Neither snapshot establishes zero persistence or a guaranteed pruning deadline; the hosted volume is then removed by the recorded cleanup.

`npm ci` retains4 moderate dependency advisories, deprecation warnings and esbuild install-script approval notices; the successful workflow is not a claim of a clean dependency audit. The previously documented S14/pre-V01 remediation gate remains. No automated dependency repair, assertion relaxation or history rewrite was performed during QA. Local original100s failures/136.092s completion, initial fixture/browser failures,20MB deadline failures and transient harness/timing failures remain recorded above.

### QA verdict

Independent QA PASS for S04 D2/D1-upload-status/ADR03 candidate `1ef852166cda0e07c231ddd4834cf053442bb1dd`. The exact hosted candidate now passes every required CI job/step and measured runtime regression; the scoped source/fix reviews, actual R2 browser/original/private controls, final lead UI gate and source/artifact correspondence are reconciled with their limits. No mandatory S04 QA check remains NOT RUN at this handoff, and no demonstrated unresolved implementation defect is identified in this bounded review. This supersedes the earlier pending exact-CI/QA statuses without erasing failed evidence.

The lead may record S04 VERIFIED after reviewing the independent security handoff. This verdict does not itself authorize S05 work, production deployment, company SOP processing, provider policy decisions, P1/P2 or V01/V02 acceptance; predecessor sequencing and the existing authorizations still govern those actions. Only this report was edited by QA; implementation, assertions, Git index and runtime/provider resources were left unchanged.
