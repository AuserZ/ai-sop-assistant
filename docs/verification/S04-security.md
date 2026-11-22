# S04 security review in progress

| Field | Recorded value |
| --- | --- |
| Scope | D2 private uploads, D1 upload status, ADR03; existing Admin/session and private job boundaries |
| Candidate | Uncommitted `codex/s04-private-uploads`, base `93a71e8b93392c7740fd5b097548b28e1747b1d3` |
| Date | Initial review21 November2026; resumed focused review22 November2026, Asia/Jakarta |
| Initial inspected snapshot | 21 files below; SHA-256 `6bd03b337f73017ad3e6ee6850b134429e8c6478ad0c72543e01c5881771e513` |
| Ownership | Security inspects implementation and owns only this report; engineers/lead own fixes and runtime/provider operations |
| Result | IN PROGRESS: exact published candidate and hosted CI remain pending. R-S04-1, R-S04-2 and V-S04-1 passed their focused independent source/fix rechecks. Final47-source publication/staged equality checks pass; only cursor CSS changed from the46-source build/provider checkpoint, with all69 other production inputs unchanged. Saved real-R2 app/original receipts passed consistency and synthetic-fixture checks; final UI/runtime receipts record PASS on the rebuilt app. Production build,48/48 database cases, local browser15/15, six recovery cases and native POST controls retain their attributed results below. The disabled public development URL could not be observed over HTTP because its certificate expired. No additional demonstrated security blocker was found; this report does not close S04. |

The protected PRDs, shared/security role guides, current S04 plan and [upload contract](../private-uploads.md) govern this review. Neither protected source nor its baseline was changed. No real key file, private provider settings or real SOP was read by this reviewer. No real-provider call, implementation edit, Docker lifecycle action, migration, build or deployment was performed.

## Findings

### R-S04-1 — MODERATE: regex metadata checks accept malformed and macro-spoofed OOXML

- **Location / candidate:** `src/server/documents/format.ts:23` and `:68`; SHA-256 `7a598989dab1de43d58cef970563a46d950bafed07814b0d6520ac006861287d`.
- **Requirement:** D2 actual-format validation and the S04 contract's rejection of malformed/encrypted/macro archives.
- **Demonstration:** an independent in-memory Node/tsx harness constructed stored ZIP entries with correct CRC/size/directory records, then invoked the actual `validateDocumentObject` with matching MIME, byte count and SHA-256. Valid minimal DOCX metadata was accepted. Both invalid controls below were also accepted.
  - `[Content_Types].xml` contained `junk`, a matching `Override` text fragment and more `junk`; `_rels/.rels` contained only `junk /officeDocument Target="word/document.xml"`. Neither metadata file was XML.
  - A well-formed content-types file put the allowed DOCX `Override` inside an XML comment, while its actual main part used `application/vnd.ms-word.document.macro&#69;nabled.main+xml`. An innocuously named `word/payload.bin` had type `application/vnd.ms-office.vba&#80;roject`, with its relationship in `word/_rels/document.xml.rels`. The payload was only a non-executable synthetic marker.
- **Cause:** raw string/regex checks do not distinguish comments from elements, validate XML structure, decode numeric character references or bind the required attributes to the same actual part/relationship.
- **Impact:** unsupported or macro-declaring containers can cross the accepted-upload format boundary. This did not demonstrate macro execution, content extraction, ACTIVE eligibility or a provider/storage compromise.
- **Fix / owner:** the lead replaced string/regex metadata checks with pinned `saxes` 6.0.0 parsing of the already byte-bounded metadata. The code checks actual namespace/root/child elements and decoded corresponding attributes, rejects DOCTYPE/parser errors/unexpected text and decoded macro/ActiveX declarations, and preserves entry/byte/inflation limits. No network/entity loader is introduced.
- **Independent verification:** reran the original in-memory actual-validator harness. Valid minimum: ACCEPTED; malformed XML: REJECTED `UPLOAD_INVALID_FORMAT`; original comment/numeric-entity macro trap: REJECTED `UPLOAD_INVALID_FORMAT`. Corrected `format.ts` SHA-256 `4e4d97d0f7c486107d820abaeda97524a600266a6559dacc2f6fbc4cb12a1112`. Status: FIX VERIFIED IN SOURCE AND ORIGINAL REPRODUCTIONS.
- **Remaining limit:** this is accepted-format validation, not a malware or extraction-safety certification. The repository's archived status alone is not a demonstrated defect in this bounded use; no additional material parser defect was demonstrated in this focused pass. Broader required upload/resource/runtime checks remain separate.

### R-S04-2 — LOW functional: initiation retry returns a stale row after acquiring the current lock

- **Location / candidate:** `src/server/documents/service.ts:51`; SHA-256 `3519d1ad3b49edaa9f4c012d8c90a35ab486b40053a06ad67be4985f50709473`.
- **Requirement:** D1 truthful status and D2 idempotent upload initiation/finalization.
- **Trigger:** the existing-intent branch first reads `existing` without locking, then obtains fresh `owned.intent` through `ownedIntent(... FOR UPDATE)`. It nevertheless returns and serializes `existing`.
- **Demonstration:** an independent actual-function harness supplied a mocked transaction read sequence in which the first row was `AWAITING_UPLOAD` and the locked row was `ACCEPTED`. `initializeDocumentUpload` returned `AWAITING_UPLOAD` and invoked `authorizeUpload`. This is a controlled source-function proof, not a real PostgreSQL contention test. Concurrent finalization between those two reads is the corresponding runtime scenario.
- **Impact:** a retry can present stale status and issue staging authorization after acceptance. No original overwrite, cross-owner access or final-byte integrity bypass was demonstrated; final storage is separate and retained quota covers staging.
- **Fix / owner:** the lead now uses `owned.intent` for the returned intent and `documentDto` after obtaining the lock.
- **Independent verification:** reran the original actual-service/mocked-read-sequence harness: fresh locked `ACCEPTED` now returns `ACCEPTED`, `upload=null`, and does not call `authorizeUpload`. Corrected `service.ts` SHA-256 `577c34b3680e9b15a6049e8ba5754e2cf29cb87ca1de901fd4e93764ead395d5`. Status: FIX VERIFIED IN SOURCE AND ORIGINAL REPRODUCTION; real database contention proof remains part of acceptance.

### F-S04-3 — MODERATE functional fixture failure: signed SDK headers were dropped

- **Location / initial candidate:** `infra/storage-fixture/gateway.mjs:4` allowed-header filter. This was reported by DevOps during integrated browser verification, not a demonstrated production R2 authorization vulnerability.
- **Requirement:** D2 actual upload/sealing and truthful local fixture/browser evidence.
- **Observed failure:** the first integrated browser run had 11 PASS / 4 FAIL. Native backend `SDK.send` PUT/GET returned 403 `SignatureDoesNotMatch`: the signer included `amz-sdk-invocation-id` and `amz-sdk-request`, but the gateway removed those headers before native HMAC verification. Earlier presigned-request controls did not exercise this Authorization-header SDK path.
- **Fix / owner:** DevOps added exactly those two header names to the allowlist. It did not permit cookies, Bearer credentials, arbitrary unrelated headers, new routes or redirects. Existing body/error limits and diagnostic sanitization remain.
- **Independent recheck:** actual gateway source and changed native regression were inspected. `node --test infra/storage-fixture/gateway.test.mjs` passed 6/6 in 734 ms, including preservation of both SDK headers and continued removal of `X-Unrelated`; `node --check infra/storage-fixture/verify-native.mjs` passed. No Docker/provider/key operation was performed by this reviewer.
- **Attributed native proof:** DevOps reports actual SDK-signed PUT/GET 200, exact-byte match and replay 412, while retaining nine native crypto denials, conditional races, five gateway denials and zero log markers. Fixture OCI index `sha256:c9540b6f3ea8dae005c7a239d124165bd8f0c7593e81478bb554ad707af7ca0c` identifies this checkpoint. The native bridge asserts signed header names and transports synthetic requests via stdin; it does not print credentials or signed URLs.
- **Status / limits:** FIX VERIFIED IN SOURCE, ISOLATED GATEWAY TESTS AND ATTRIBUTED NATIVE SDK REGRESSION. The full 15-case browser rerun was pending at that cutoff; the lead subsequently reported all 15 PASS in 1.0 minute, including the exact 20 MB upload/seal in 6.9 seconds. No new demonstrated security blocker was found in this narrow change; it does not establish real R2 behavior.

| Corrected fixture file | SHA-256 |
| --- | --- |
| `infra/storage-fixture/gateway.mjs` | `27611a4e0aeab1895ae9f1b06f7ad427fa13a8418298a62aa5d5b72ca1d180ba` |
| `infra/storage-fixture/gateway.test.mjs` | `3ce670b25f8d9d7ff3ae9e862975ed4466b1fc438f1da040d831cf44f93c2684` |
| `infra/storage-fixture/verify-native.mjs` | `a4e6c0f58a425b466abf5292dcfd66ad8da695bdc87847483cd2a2e7031bdd97` |

## Checks actually executed

| Check | Result / provenance | Limits |
| --- | --- | --- |
| Required guides, actual routes/domain code, migration/schema, probe guards, upload UI and fixture gateway inspection | Inspected independently | Source was still changing; this is not a final source freeze or runtime acceptance |
| In-memory `node --import tsx --input-type=module` format harness | FAIL: one valid control and both invalid controls were accepted | No files, providers, database or executable macro were used; R-S04-1 above |
| In-memory Node/tsx initiation harness invoking actual service with a mocked transaction | FAIL: fresh locked `ACCEPTED` row produced stale `AWAITING_UPLOAD` response | Does not replace a real database race test; R-S04-2 above |
| Original format harness repeated after fix | PASS: valid minimum accepted; both original traps rejected with `UPLOAD_INVALID_FORMAT` | Actual validator, same synthetic stored-ZIP controls; no provider/database or executable macro |
| Original initiation harness repeated after fix | PASS: locked accepted row returned accepted status, null upload and no authorization call | Actual service with mocked transaction read sequence; real PostgreSQL race remains separate |
| Actual pinned S3 presigner using explicit synthetic configuration | PASS: `X-Amz-SignedHeaders` exactly `content-length;content-type;host;if-none-match`, expiration 120 seconds | No network request or signed URL was printed; real R2 denial/expiry behavior remains separate |
| Actual R2 adapter/pinned SDK against an ephemeral synthetic loopback HTTP server that sent headers then stalled | PASS: abort rejected the GET and closed the response transport | This proves the local SDK cancellation path, not a live R2 timeout |
| Generic `readBoundedObject` with an idle `PassThrough` | Remained pending and undestroyed after abort until harness cleanup | The actual SDK transport control above did cancel correctly. No production resource leak was demonstrated; the helper currently relies on transport cancellation while no chunk arrives |
| PRD integrity | PASS before report creation | Repeat after report changes; never rewrite either original or its baseline |
| Format/full unit regressions | PASS, attributed to lead | Expanded format controls initially 7/9 with two failures, then 9/9 after fix; full unit suite 37/37 in 14.1 seconds. This reviewer repeated the original reproductions rather than another broad suite |
| Native fixture HTTP | PASS, attributed to DevOps | Synthetic-only CA-corrected image `4cbff164…`: signature/path/type/length/If-None-Match/Host/wrong-secret denials, expiry denial, unknown identity denial; PUT/HEAD/GET/hash success; unsigned GET denied; replay 412 and concurrent create-only 200/412. Cookie/Bearer/foreign-Origin and public/explorer denial also observed; sanitized log counts zero. No real R2 compatibility claim |
| Corrected gateway tests and native-verifier syntax | PASS, independent | Gateway 6/6, 734 ms; native helper syntax passed. Exact two-header change, sanitization and authority boundary were inspected; F-S04-3 records the separate attributed native SDK proof |
| Initial integrated browser run / corrected rerun | Initial 11 PASS / 4 FAIL; corrected full 15/15 PASS, attributed to lead | Signed SDK-header stripping caused the fixture failure. Later actual rerun passed in 1.0 minute; exact 20 MB case 6.9 seconds. The failed run remains part of the history |
| Manual UI receipt | PASS, attributed to lead | Receipt 16:57:01Z; five screenshots inspected and computed contrast verified by the lead, with a private gate file. This reviewer did not inspect those screenshots or read that private file |
| Candidate production build and real database checks | PASS, attributed to DevOps through lead | Saved candidate build and 48/48 database cases passed. Root added the locked-accepted-row unit regression and strengthened database contention/barrier/expiry/rate cases; this reviewer inspected those deltas rather than rerunning Docker/database work |
| Hosted CI and live R2 object upload/seal/privacy | No provider/CI execution by this reviewer; later saved app/original and final UI/runtime receipts checked below | Actual provider operations belong to the lead. Exact published candidate/hosted CI remain pending; standalone public-domain HTTP privacy observation remains unavailable |

The presigner deliberately forces the three application headers. This matters because the upstream S3 presigner otherwise marks Content-Type unsignable by default. [Primary SDK source](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/src/presigner.ts#L75). Browser code relies on the File/Blob's automatically emitted Content-Length rather than setting that forbidden header manually.

## Reviewed controls and remaining evidence

The inspected lifecycle reuses `lockCurrentAdmin` before claiming a finalizer and after storage I/O. It reserves twice the declared size under a shared PostgreSQL advisory lock, retains reservations, writes only the validated bytes to a server-only key using `If-None-Match: *`, and verifies an existing final object before ambiguous-write recovery. The one 15-second storage budget is separate from the 30-second fenced lease. Database acceptance, one document/job and audit creation are transactional. Actual race, revocation, timeout, inflated-size and ambiguous-write tests remain required.

The migration binds originals and ingestion identity to owner/hash, prevents upload-identity/reservation mutation and deletion, and parks ingestion with no active deadline or dispatch/run lease. Both probe dispatch/reconciliation queries filter kind; probe callbacks/SSE reject ingestion identities. The upload UI uses `credentials: "omit"` and `redirect: "error"` for the presigned PUT and maps provider failures to safe messages. These are source observations pending actual database/browser proof.

The verification overlay and gateway use synthetic-only credential mounts, a narrow bucket/object surface, local ports and bounded request/error handling. Cookies, non-S3 Authorization and foreign origins are rejected; upstream redirects and diagnostic XML are not exposed. DevOps subsequently supplied native fixture HTTP proof separate from the gateway's isolated tests. The native runtime initially lacked a CA bundle; its fixture Dockerfile was corrected before successful checks. DevOps identified real configured-key HMAC/expiry verification in pinned local Wrangler, with future-date skew, repeated-header, region, checksum and CORS limitations. Native preflight returned wildcard allowed origin, so it is not real R2 CORS evidence. This reviewer did not independently operate the native fixture.

The exact-byte conditional-PUT design matches documented R2 atomic create behavior. Negative HEAD results do not settle an earlier in-flight write, so preserving reservations and avoiding speculative cleanup are material controls. [R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

The lead separately reports real R2 HeadBucket and CORS setup/preflight checks, with no object written at that checkpoint. These are attributed partial configuration results, not this reviewer's provider verification. Actual live synthetic PUT/read/hash/create-only/header-tampering/expiry/browser-CORS proof and private/public-access confirmation remain open. The ignored private test quota is not an approved production company quota or retention/recovery policy. No S05 processing, extraction, verification, activation or real SOP use is established here.

## Remaining production-source pass

No additional demonstrated blocker was found in the actual config, routes, storage boundary and upload UI. The production endpoint is restricted to HTTPS R2 account/jurisdiction hosts, provider credentials are server-only/lazy, browser mutations reuse canonical Origin/Host plus strict bounded JSON, and status/finalization enforce current Admin/session and uploader ownership. Safe DTOs omit storage keys and signed download links; UI provider failures are mapped to fixed messages and direct PUT omits cookies and rejects redirects. The original format/service fix hashes remain unchanged.

| Inspected checkpoint | SHA-256 |
| --- | --- |
| `src/server/documents/config.ts` | `5f8c5141b94bf46223bbaa84a4925f1c12716ab1481136c296efb78d96b55e2a` |
| `src/server/documents/storage.ts` | `595a7148cfef939b3161ecf35dfc48481203d335cb96f8fa07c0f4b691d17c08` |
| `src/server/documents/http.ts` | `79cc515a86d314016bfdc89f0fa9b22af0d17e2f9d8e1124b0d44fb0e238665e` |
| `src/components/documents/client.ts` | `782b9373e7479b97e9bc8144cb364ea5c34a5b9d18c0fd192aa710b50d9d2c11` |
| `src/components/documents/upload-panel.tsx` | `0978c0679e478bc748cab94e1a9b72961562b392942ebd309831bda89d93d503` |
| Locked-row regression `tests/unit/document-service.test.ts` | `efeca9ec71ca6523010a710361a8ecb61fc3cd312c4da4790eb2d40cbbf4735a` |

This is an inspected-source checkpoint, not a final whole-candidate freeze, image correspondence claim or additional independent suite run.

## Bounded live R2 proof proposed to the lead

Use existing bucket-scoped object credentials and only newly allocated, recorded synthetic canary keys or app fixture identities. No bucket listing/deletion, real SOPs, raw signed URLs/credential logs or broad administrator token is needed.

1. Record dashboard confirmation that public `r2.dev` access is disabled and custom domains are absent/disabled. They are independent access methods; a denied unsigned S3 GET alone cannot establish both settings. [Cloudflare public-bucket controls](https://developers.cloudflare.com/r2/buckets/public-buckets/).
2. Before a valid write to an absent canary key, verify changed signature/method/path, missing or changed Content-Type/If-None-Match and a complete request whose actual body/Content-Length differs from its signed length are denied. Avoid malformed HTTP framing; record safe status/code/counts only.
3. Race two correct conditional PUTs to one fresh key: one success and one 412; replay must fail and an authenticated read/hash must remain unchanged. Complete the normal Admin app path with tiny synthetic PDF/DOCX bytes, matching sealed SHA and one parked job on retry. A separate same-size wrong-byte intent must fail backend SHA validation without an accepted document/job.
4. Use a genuinely short-lived signed URL to a never-written key, wait beyond its expiry without modifying the signed timestamp, and verify denial. Perform an actual browser PUT from the allowed exact origin/headers without cookies; a foreign-origin preflight must grant no permission. An expired R2 response can omit CORS, so a generic safe browser error is appropriate. [Cloudflare CORS behavior](https://developers.cloudflare.com/r2/buckets/cors/).
5. Verify unsigned GET of the known synthetic object is denied. Retain accepted app originals/staging/reservations under the current contract. Remove only standalone test canaries if cleanup is authorized and all their writes have definitively completed; a negative HEAD or URL expiry must not trigger speculative cleanup.

These are proposed provider checks, not results or privacy/production approval. Native fixture proof remains distinct from them.

## Initial source snapshot

Hash exact file bytes with SHA-256; sort these paths by ordinal values; concatenate `path + NUL + lowercase_file_hash + LF` as UTF-8 and hash that manifest. The result is `6bd03b337f73017ad3e6ee6850b134429e8c6478ad0c72543e01c5881771e513`. This includes only the initial inspected implementation/fixture paths, not the report, future tests, dependency files, images or an unrecorded later candidate.

```text
drizzle/0003_private_uploads.sql
infra/storage-fixture/Dockerfile
infra/storage-fixture/compose.yml
infra/storage-fixture/gateway.mjs
infra/storage-fixture/server.mjs
infra/storage-fixture/worker.mjs
src/app/api/documents/[id]/process/route.ts
src/app/api/documents/[id]/route.ts
src/app/api/documents/upload-init/route.ts
src/app/documents/page.tsx
src/components/documents/client.ts
src/components/documents/upload-panel.tsx
src/server/db/schema.ts
src/server/documents/config.ts
src/server/documents/contracts.ts
src/server/documents/format.ts
src/server/documents/http.ts
src/server/documents/service.ts
src/server/documents/storage.ts
src/server/jobs/dispatch.ts
src/server/jobs/service.ts
```

## Frozen implementation publication checkpoint

On 22 November, this reviewer independently inspected the frozen 43 staged implementation/test/configuration paths below. All staged blobs exactly matched their working files. The full index contained 181 paths, with no private fixture/secret-directory, environment-file, installed dependency/build output, browser-output, image, key-file or log artifacts. Root `.gitignore`, root default-deny Docker context and the separate default-deny fixture context exclude private/runtime material; package manifests and locks remain intentional source.

| Identifier | Value |
| --- | --- |
| Branch / HEAD | `codex/s04-private-uploads` / `868dca58d785540000bf3c1b81f70a1f4c91f20a` |
| Frozen implementation paths | 43; byte equality PASS |
| Staged-source SHA-256 manifest | `9d45116e3924b1c215bdcc02c44535bb37d0018506314203988edf53a9251da8` |
| Full index tree SHA-1 | `b57d186224b8ad8b93a3e063fdf600b367c3ebd6` |
| Scoped publication result | PASS; no publication blocker found in these staged implementation paths |

The source manifest uses the same exact-byte/path-NUL/hash-LF method as the earlier snapshot. The tree was calculated from stage-0 index modes/blob IDs/paths without writing Git objects or changing the index; the calculation was validated against the existing HEAD tree. Docs were still unstaged and may change the eventual commit tree. This checkpoint does not claim a future final commit/tree or publication of unreviewed later docs.

Both protected staged originals match their recorded SHA-256 baselines: technical PRD `d91d6eacc6e390b6f5bf4bb3018d801b2f39b4ae9f4d64f6b1097d0b7a4a2dc1`; PDF `a84d9cb74ae572a6b9e2943137277adc732567169f5d5110de29734af0c6ea5e`. LICENSE is byte-identical to original commit `da80bde363f773e565d1c1dde9b78b400ad56054`. That commit, verified S03 source `0396cf606b8e34a805a038b273a103687a691ce1` and S03 closure `93a71e8b93392c7740fd5b097548b28e1747b1d3` remain ancestors of HEAD.

A bounded staged-text scan found zero high-confidence private-key PEM, provider-token/JWT literals, actual presigned-signature query values or provider credential literals. No actual secret file was read. The lead's separate comparison against known private credential values is not represented as a check executed by this reviewer; pattern scanning is not an exhaustive secret-detection guarantee. PRD integrity passed before/after report edits. No Git index/ref edits, network writes or Docker/provider actions were performed.

```text
.github/workflows/ci.yml
drizzle/0003_private_uploads.sql
drizzle/meta/0003_snapshot.json
drizzle/meta/_journal.json
infra/n8n/inspect-execution-storage.mjs
infra/n8n/verify-redirects.mjs
infra/storage-fixture/.dockerignore
infra/storage-fixture/Dockerfile
infra/storage-fixture/compose.yml
infra/storage-fixture/create-secrets.mjs
infra/storage-fixture/gateway.mjs
infra/storage-fixture/gateway.test.mjs
infra/storage-fixture/package-lock.json
infra/storage-fixture/package.json
infra/storage-fixture/provider.compose.example.yml
infra/storage-fixture/secrets.test.mjs
infra/storage-fixture/server.mjs
infra/storage-fixture/verify-native.mjs
infra/storage-fixture/worker.mjs
package-lock.json
package.json
scripts/verify-workflow-runtime.mjs
src/app/api/documents/[id]/process/route.ts
src/app/api/documents/[id]/route.ts
src/app/api/documents/upload-init/route.ts
src/app/documents/page.tsx
src/components/auth/session-status.tsx
src/components/documents/client.ts
src/components/documents/upload-panel.tsx
src/server/db/schema.ts
src/server/documents/config.ts
src/server/documents/contracts.ts
src/server/documents/format.ts
src/server/documents/http.ts
src/server/documents/service.ts
src/server/documents/storage.ts
src/server/jobs/dispatch.ts
src/server/jobs/service.ts
tests/e2e/documents.spec.ts
tests/fixtures/document-files.ts
tests/integration/documents.test.ts
tests/unit/document-service.test.ts
tests/unit/documents.test.ts
```

## Resumed focused review: live synthetic helper and Redis recovery

On22 November, this reviewer resumed the two assigned source checks after the user confirmed the bucket's public development URL disabled and custom domains empty. The reviewer read only `.local-secrets/s04-r2-live-check.mjs` among ignored private files. No credential, provider configuration or receipt file was read, and no provider request was made. The confirmation is attributed to the user/lead; it is not an independent dashboard inspection or company-data policy approval.

| Reviewed working file | SHA-256 |
| --- | --- |
| Ignored standalone live-R2 helper | `2b5a9e0f5daa75436b4506a6f403d00e08d68fe21a8617c321dee88e870dd24c` |
| `docker-compose.yml` | `3c760ac94d927cef0c063383aeebe07e460a2bd98c8e32e13c8ed8649a01ddad` |
| `scripts/verify-workflow-runtime.mjs` | `118f2fad83d674c9ff2cea8452fff74dccbc55a4c17032552c7e41b53247989c` |

The original corrected application hashes remain `format.ts` `4e4d97d0f7c486107d820abaeda97524a600266a6559dacc2f6fbc4cb12a1112` and `service.ts` `577c34b3680e9b15a6049e8ba5754e2cf29cb87ca1de901fd4e93764ead395d5`. This is a working-source checkpoint, not a new frozen whole-index manifest. The earlier43-file publication checkpoint remains historical; the newer Compose/verifier changes need inclusion in the eventual candidate.

### Standalone live-R2 helper

No demonstrated execution blocker was found in the inspected helper. The source:

- Requires explicit disabled-public-URL, absent/denied-domain and user-confirmation fields before creating a client or signing requests. It restricts the configured target to the intended bucket name and an HTTPS R2 account host.
- Allocates a fresh cryptographically random synthetic prefix and uses only the repository-generated PDF bytes. It lists no bucket contents and accesses no existing app document.
- Keeps keys and signed URLs in process memory. The private receipt contains its owned prefix, safe check labels/statuses and synthetic SHA; console output omits the prefix and raw provider exceptions. No credential or signed URL is printed.
- Tests signature/path/method/type/create-only-header changes before a valid canary write. Its changed-size request sends a complete body whose actual Content-Length differs from the signed length; it does not deliberately send malformed HTTP framing.
- Tests an atomic create-only race, replay denial, authenticated exact-byte/hash read and denied unsigned S3/development-URL reads of the known synthetic key. The expiry case signs a genuinely two-second URL for an unused key, waits four seconds and sends the unchanged URL.
- Refuses fetch redirects, bounds those requests with10-second abort signals and uses one SDK attempt. Only its one newly allocated standalone key is deleted, after successful definitive operations. Failure records the owned prefix and leaves objects for reviewed recovery; it does not speculatively delete in-flight or app-owned objects/reservations.

Evidence limits: this source review and Node helper do not prove actual browser PUT/cookie/CORS behavior, backend sealing, accepted originals or one parked job; those remain separate required live app checks. A method response405 establishes method rejection, not by itself cryptographic method binding. A denied S3 request alone cannot establish custom-domain privacy. No live result is claimed here.

### Queue-process restart correction

No additional demonstrated security blocker was found in the narrow Compose diff. `restart: unless-stopped` is added only to `n8n-main` and `n8n-worker`; bootstrap and the shared anchor retain their previous behavior. Existing private networks, secret mounts, nonroot/readonly execution, capabilities, resource limits and host-port boundaries are unchanged. Container restart behavior does not enlarge the application's bounded workflow attempts or authorize document activation.

The Redis regression records initially healthy queue containers and their configured policy, keeps Redis unavailable for at least12 seconds after a confirmed attempted dispatch, then starts only Redis. Before completion, it requires both queue services healthy with increased restart counters and different start times. The case contains no manual start of either queue process; its automatic-recovery log appears only after those assertions. Existing100-second stream collection, strict terminal/frame assertions and cleanup remain. Runtime success must still be established by the DevOps execution; source policy/syntax is not recovery proof.

Checks actually executed in this resumed pass:

- `node --check .local-secrets/s04-r2-live-check.mjs`: PASS.
- `node --check scripts/verify-workflow-runtime.mjs`: PASS.
- Scoped `git diff --check -- docker-compose.yml scripts/verify-workflow-runtime.mjs`: PASS.
- Original technical PRD and4-page original product PDF consulted; original hashes matched before report edits. A local PDF read helper first hit a cleanup-method error after extracting all4 pages; its corrected in-memory read then exited0, with4 pages/4152 text characters. Neither original was modified.

No implementation, index/ref, Docker lifecycle, provider or actual-secret action was performed. Post-fix six-case recovery/native redirect evidence, live synthetic provider/app proof and exact hosted CI remain required before the lead closes S04. Residency/recovery/company-data approval gates remain separate.

### Live denial compatibility and browser-helper follow-up

The lead's first real-provider helper run reached the unsigned S3 read before stopping on an assertion: the provider returned400 `InvalidArgument`, with XML Message exactly `Authorization`, while the helper allowed only401/403/404. The lead's same-owned-canary diagnostic distinguished this authorization-field rejection from public access. Earlier changed signature/path/method/type/create-only-header/actual-size requests all returned403; conditional race200/412, replay412 and signed exact637-byte/hash read passed. These are attributed lead results, not provider requests executed by this reviewer.

The lead narrowly changed the denial assertion and added a same-canary resume path. Reviewed helper SHA-256 `301ec02da8f9183d5d60ff7de55b4c1b02f9bce2d6271c12aac199d7899e9621`; syntax PASS. The only newly allowed400 denial is the unsigned S3 read, and it additionally requires a bounded4096-character diagnostic matching Code `InvalidArgument` and Message exactly `Authorization`. The diagnostic is not printed or retained. Other exact tamper/status assertions remain unchanged.

For the recorded prior FAIL object, resume requires the unsigned-read failure phase, `cleaned=false`, a v4-UUID prefix in the standalone synthetic namespace and prior race200/412. It reuses that prefix, skips completed writes/tampering, rereads and validates the same canary bytes, then continues the public-development denial, true expiry and single-key cleanup. No demonstrated security blocker was found. A small robustness limit was reported to the lead: this version validates under `if(previous)`, so a flag-enabled falsey JSON receipt could fall back to a new prefix; an explicit non-null-object assertion would make the resume guard fail closed for that invalid local artifact. The actual recorded receipt was not read by this reviewer.

The separately authorized `.local-secrets/s04-r2-browser-check.mjs` also passed source and `node --check` review at SHA-256 `b37061bea09d6abddb59b3d7b960d3f3c64d8b44f25b7258d2084b8a58196ee4`. It guards loopback/example.invalid fixtures and the public-access confirmation; exercises actual PDF/DOCX browser transfers; awaits exactly2 actual `allHeaders()` observations with HTTPS/configured-host/no-cookie assertions; checks accepted size/hash/UPLOADED/parked-job status and unchanged job IDs on repeated finalization; rejects a wrong SHA without accepted document/job; and checks Staff403. It deletes no app object/reservation and suppresses raw exceptions/links/credentials in output. Runtime/provider-overlay handoff and the actual browser result remain required. Only these two exact helper source files were read among private paths; no configuration, credential or receipt contents were inspected.

### Disabled public-route TLS limit and strict resume recheck

The lead's subsequent same-canary run verified unsigned S3 denial400 with the exact authorization-field diagnostic. The disabled public development hostname then failed certificate validation with `CERT_HAS_EXPIRED` before an HTTP response. This is a transport limitation, not a successful HTTP authorization-denial test. The lead explicitly retained TLS verification and did not count this as public HTTP PASS.

Updated live helper SHA-256 `a4115b3f598b1ad4e7e8f00b1f5176cf87d74fc83b4981ef872c25e1a0147248`; `node --check` PASS. The lead added an explicit resume-enabled/non-null-object assertion before the earlier validation, fixing the falsey-receipt robustness note. A valid recorded failure at either the unsigned-S3 or public-development check reuses the same UUID-owned canary and preserves the completed write/race results. It rereads the bytes, continues remaining tests and deletes only that standalone key after definitive success; no fresh canary is allocated in valid resume mode.

The exception handler is scoped only to the disabled public-route probe. It accepts only a `TypeError` whose cause code is exactly `CERT_HAS_EXPIRED`; the receipt records `HTTP_NOT_OBSERVED`, that reason, the attributed user-disabled configuration and an explicit limit. The overall receipt becomes `PASS_WITH_LIMIT`. HTTP2xx, unexpected HTTP statuses, redirects, DNS failures and other TLS failures still throw. Private S3, actual app traffic, expiry and cleanup are outside this exception and must still pass normally.

The reviewer independently evaluated the actual helper's `status`/`denied`/public-probe branch in memory with stubbed fetch responses, without executing imports or reading private inputs. All7 cases passed: public200, unexpected500,301, `ENOTFOUND` and another TLS error throw;403 records a denial; only the known expired-certificate failure records the explicit unobserved-HTTP limit. No network, provider, credential, configuration or receipt access occurred in this check.

No demonstrated security blocker was found in this distinction. ADR03 and the security requirements require private storage; they do not require use of a disabled public hostname or bypassing certificate validation to test it. The user's explicit disabled-public-URL/empty-custom-domain confirmation is configuration evidence, while the known existing object's denied unsigned S3 read is separate access evidence. The public-route HTTP result remains unavailable and must stay visible. This is not proof that every possible public access route was independently tested, nor company-data/privacy/residency approval. Actual app private-S3 TLS/browser/sealed-original evidence and final recovery/CI checks remain required.

## Final44-source publication and provider-app helper checkpoint

On22 November, the reviewer read the complete protected technical PRD, original4-page product PDF, shared/security guides, plan, security guide and current S04 contract/reports. The PDF was read using the already installed PDF.js module, with evaluation disabled; its loading task was destroyed normally. Neither original nor its hash baseline was changed.

The frozen implementation now includes `docker-compose.yml` plus the prior43 paths; the workflow verifier also contains its later Redis-specific horizon correction. All44 staged blobs matched the corresponding working-file bytes. All181 stage-0 indexed paths were inspected for publication boundaries. There were no unresolved stages, forbidden private/environment/build/dependency/browser-output/key/log paths, or high-confidence private-PEM/provider/JWT/signed-query literal matches in the scoped scans.

| Snapshot identifier | Value |
| --- | --- |
| Branch / HEAD before publication | `codex/s04-private-uploads` / `868dca58d785540000bf3c1b81f70a1f4c91f20a` |
| Changed implementation paths / indexed paths |44 /181 |
| Final staged44-source SHA-256 manifest | `659f619d6d91695d4444b6cc857fe98567efb08332ebb1886dbba9be466e3302` |
| Full index tree at this checkpoint | `649a229089843276a2dda7e78237f5640a168e6e` |
| `docker-compose.yml` | `3c760ac94d927cef0c063383aeebe07e460a2bd98c8e32e13c8ed8649a01ddad` |
| `scripts/verify-workflow-runtime.mjs` | `5f088a15386a1f8d81f4f7466c7309070a40999229db9f0d0614c236baf84bf2` |
| Ignored original-object verification helper | `0242e14441aa58c060cf38c2bd33b035ec541e95ab22ba29a37bf17e901884d5` |
| Ignored browser-provider helper | `92e74f0875394e706e27ba2b76f1bc7cf6227a851f62568b1326b87cfaacd62c` |

The44-source manifest uses the report's path-NUL/file-SHA256-LF method. The full index tree was computed without writing objects or changing the index; that computation was checked against the existing HEAD tree. HEAD and index entries remained unchanged throughout the audit. Docs were still unstaged, so this tree is a checkpoint, not a claim about the eventual commit after reports are added.

Both protected indexed originals match the previously recorded SHA-256 values and their working copies. LICENSE remains byte-identical to original commit `da80bde363f773e565d1c1dde9b78b400ad56054`; that commit, S03 source0396cf6 and closure93a71e8 remain ancestors of HEAD. The first inline audit helper could not locate its literal technical-PRD map key; the corrected helper derived the canonical filename from the index and passed without changing any file. No actual credential file was read. The lead's separate seven-known-value comparison remains attributed to the lead; scoped pattern scanning is not an exhaustive secret-detection guarantee.

### Corrected recovery source and attributed results

The only Compose additions remain `restart: unless-stopped` on main/worker. The corrected collector defaults to100,000ms. Exactly the extended Redis case supplies its calculated200,000ms budget: three configured60,000ms attempts plus20,000ms transport/reconciliation allowance. The three-attempt/60s values match the current application contract. Other call sites keep the default; the100s queue-health wait, production retries/leases/token/SSE limits and strict failed-frame/one-terminal/event/byte/cursor checks remain intact.

The earlier100s failures and actual136.092s attempt3 completion remain evidence; a test budget is not a new product recovery SLA. Source assertions still require at least12s outage after attempted dispatch and automatic restart-counter/start-time/healthy changes, without manually starting queue processes in that case. No new demonstrated security blocker was found in this correction.

The final [DevOps report](S04-infra.md) records full six-case exit0 with durations29.573s,57.852s,90.704s,26.403s,8.449s and75.530s. Native POST301/307 controls also exited0, with destination2 under default following,0 under explicit no-follow and0 forwarded canaries. These executions are attributed to DevOps, not rerun by this reviewer. The report's final native snapshot retained19 JWT-bearing payload rows/84 occurrences with zero observed log markers; do not describe n8n as zero-persistence or infer a fixed pruning deadline.

### Provider-app browser helper

The browser helper now exercises three independently generated synthetic files: small PDF, DOCX and exact20,000,000-byte PDF. Its actual `allHeaders()` observation count must equal `files.length`; every observed PUT must use HTTPS on the configured storage host and omit cookies. The large-file test waits180s to cover the existing120s direct-transfer and metadata budgets; this changes no application/server15s finalization limit. Accepted size/SHA/state, repeat-finalization job identity, ingestion-SSE rejection, wrong-SHA/no-accepted-state and Staff403 assertions remain. No app object or reservation is deleted, and raw exceptions/links/credentials are suppressed.

`node --check` passed for this exact helper. This is source/syntax evidence, not an executed real-browser/provider result. It still needs the lead's fresh provider runtime and synthetic fixture handoff.

### Independent sealed-original helper

No demonstrated execution blocker was found in the new helper. It requires a successful app receipt containing three bounded-size/hash/ID records, identifies exactly the named provider app by project/workspace labels and checks actual-provider mode/configuration correspondence. It then runs static, parameter-bound SELECT statements for those exact IDs in the fresh test database. The existing application runtime credential is mounted alone; it is not a newly read-only database role. Read-only claims here describe the SELECT-only operation and container filesystem, not a change to that role's privileges.

The one-off query container has an unpredictable ownership label/name, no Docker log driver, nonroot identity, read-only root, dropped capabilities/no-new-privileges and explicit memory/CPU/process limits. No R2 key is mounted into it. Its private metadata output is captured in host memory; the helper checks automatic container removal before proceeding. Error cleanup verifies the ownership label before any force removal and uses no volume-removal option. No application object/reservation is deleted or bucket contents listed.

For each expected original, the source checks the synthetic owner, immutable key prefix/ID, filename/MIME/size/hash, UPLOADED status and exactly one matching parked ingestion job with zero dispatches. A separate authenticated real-R2 GET must match actual Content-Length/Content-Type, bounded streamed bytes and SHA256. Unsigned access to that same known original must fail;400 requires a4096-character-bounded exact `InvalidArgument`/`Authorization` diagnostic, while unexpected success/statuses fail. The negative checksum intent must have no document or job and remain FAILED. The final receipt omits original keys, provider secrets and signed URLs and binds itself to the app receipt's SHA256.

`node --check` passed. An independent in-memory harness extracted only the actual unsigned-denial branch, without executing module imports or reading private inputs. All10 synthetic controls passed: exact400 and401/403/404 denial accepted; wrong400 code/message, authorization text beyond4096 characters,200,301 and500 rejected. These tests made no Docker, provider, credential, configuration or receipt access. They verify assertion fidelity, not stored-object availability or actual private-provider behavior.

At this historical helper-review checkpoint, only the two exact helper source files were read under `.local-secrets`. The reviewer performed no real-key/configuration/receipt read, provider request, Docker lifecycle action, build, migration, implementation/index/ref edit or deployment. The original format/service fix hashes remained unchanged. Actual provider-app TLS/browser/original-byte results, the final published candidate and exact hosted CI were then outstanding. The later five-receipt review below records the provider evidence without changing residency/recovery/company-data approval gates.

## Measured20MB provider deadline correction

The lead subsequently demonstrated a D2 availability failure on real R2: small PDF637 bytes and DOCX1134 bytes were accepted, while the valid20,000,000-byte PDF failed twice near the15s finalization deadline without an accepted original/job. Its staged size and actual SHA matched. Separate authorized measurements observed a full read in11.220s and writes in10.699s or9.789s; the ordinary Expect100 path was acknowledged in133ms. These measurements are attributed to the lead. This reviewer made no provider call or private receipt/key/configuration read. Both standalone write-diagnostic canaries were reported deleted with204; the failed app intent/objects/reservation were retained under the existing contract.

The measured availability failure is not a demonstrated file-integrity or authorization bypass. The candidate failed safely, but its earlier15s combined read/validation/seal window did not accommodate the tested supported-size file on that network. The lead's narrow correction changes only storage30s, finalize lease45s and client metadata35s; no HTTP-header workaround, provider retry increase, quota release or app-object deletion was introduced.

| Working file at this review | SHA-256 |
| --- | --- |
| `src/server/documents/contracts.ts` | `86ed3af17cad9aa1a015ea89b4f6f15911fad7b0d3d4b7bd3c1ba854056f1d21` |
| `src/components/documents/client.ts` | `42fb6992480f5eef9caa03c2d74b8c44482aeb92ff5aa590133aa6fbbcf60baf` |
| Deadline DB test before the signal-observation follow-up | `d27e45635f5cf855550883268312765628d283c886ce6120229fa0d1d01ec131` |
| New `tests/unit/document-client.test.ts` | `7a36a8face29e219c950b15b39347db84a8904d87a99750f3bdde6910ea55d0e` |
| Unchanged `src/server/documents/service.ts` | `577c34b3680e9b15a6049e8ba5754e2cf29cb87ca1de901fd4e93764ead395d5` |
| Unchanged `src/server/documents/storage.ts` | `595a7148cfef939b3161ecf35dfc48481203d335cb96f8fa07c0f4b691d17c08` |
| Unchanged proxy configuration | `6e4d20131eb1c6a7646cd7c5877e8d92c21fb9ef8eea2d9ed6f2a9a00496fc2f` |

Independent read-only source checks confirmed30,000ms storage <35,000ms client metadata <=35,000ms proxy read, and30,000ms storage <45,000ms lease. The storage/lease margin remains15s; client/proxy allow5s beyond storage work. These are configured relationships, not a guaranteed total request SLA: authentication, rate-limit and database overhead can still result in a safe caller/proxy timeout and require idempotent status/retry. The existing fixed-key conditional writes, hash/MIME/size checks, two-finalizer limit,20MB file cap,120s upload bearer,600s acceptance intent, archive bounds and fresh account/fence/expiry commit checks are unchanged. The adapter still uses one SDK attempt and abortable bounded reads/writes.

No additional demonstrated production security blocker was found in the timing correction. A stale finalizer still cannot accept a document after a replacement fence, role/session revocation or intent/lease expiry. A late physical write does not authorize a document/job, overwrite an accepted original or release reserved storage. The local fixture gateway retains its separate15s per-request transport timeout; mocked late-response/deadline controls must not be represented as live fixture or provider latency measurements.

### V-S04-1 — LOW verification: outer settlement does not independently observe storage abort time

- **Location:** `tests/integration/documents.test.ts:227` deadline case and `src/server/documents/service.ts:154` failure cleanup.
- **Mapping:** D2 bounded finalization and the changed deadline regression.
- **Observation:** the new DB case advances fake time to29s and checks only the finalization promise's `settled` flag. The actual service catches a storage deadline rejection and awaits a real PostgreSQL FAILED-state update before that outer promise rejects. Slow cleanup can therefore leave the outer promise pending after an earlier storage abort. This is a source-level verification gap, not a demonstrated production timeout bypass or a claim that the observed DB run falsely passed.
- **Minimal fix:** capture the AbortSignal passed to the deliberately uncooperative storage read; require it un-aborted at29s and aborted at30s independently of database cleanup. Preserve the final `UPLOAD_STORAGE_UNAVAILABLE` and no-document/no-job assertions.
- **Fix independently inspected:** `SyntheticStorage.read` now passes its actual `AbortSignal` to `beforeRead`. The deadline case captures that signal, requires `aborted=false` at29s and `aborted=true` at30s independently of outer promise settlement/database cleanup, then preserves `UPLOAD_STORAGE_UNAVAILABLE`, no accepted document/job and FAILED status. Corrected `tests/integration/documents.test.ts` SHA-256 `cadd9e97b627eb222ea10e4360c4a4ca615c4c2b7a602a974ea8936374c51250`.
- **Verification / status:** FIX VERIFIED IN SOURCE. The lead/DevOps reports the strengthened case in the48/48 real-PostgreSQL PASS in16.83s; the subsequently permitted saved DB receipt independently records command exit0 and the corresponding verification image. This reviewer did not rerun the database suite. The exact signal assertions close the reported observation gap; actual suite count/runtime provenance remains attributed.

The new client tests were inspected: one accepts a valid29s response; the other requires an unavailable request remain pending at30s and fail by36s. Their2/2 RED at the old25s client bound and2/2 GREEN after35s are attributed to the lead, not rerun here. This pass performed only source/diff inspection, exact hashes, static timing/limit assertions and protected-PRD integrity checks. It performed no DB/build/provider/runtime/index action.

The earlier44-source manifest is historical. The corrected deadline test, new client unit file and private-diagnostic lint exclusion are included in the46-source checkpoint below, which has rebuilt-image and actual20MB real-R2/original-byte evidence. The subsequent47-source CSS candidate and final UI/runtime correspondence are recorded after that historical checkpoint. Published SHA and exact hosted CI remain required. No production/company-data, residency/recovery or file-limit policy approval is implied by this bounded synthetic correction.

## Historical46-source evidence checkpoint

The independent read-only publication audit observed46 staged source/test/config paths and182 indexed paths on `codex/s04-private-uploads`, HEAD `868dca58d785540000bf3c1b81f70a1f4c91f20a`. All46 staged blobs matched their working files, with no unmerged entries. The sorted path/NUL/lowercase-SHA256/newline source manifest is `bd3214fe6e37259bdcedaec9e246a0653dd17d876568d6cec8d4f28cc42e746c`; the full index tree checkpoint is `397750ec725572324786af60b331245eff60258d`. The tree was reconstructed and checked against Git's HEAD-tree calculation without index/object/ref writes. Documentation remained unstaged, so this is a source checkpoint rather than the eventual commit tree.

No private/environment/build/dependency/browser-output/log/key artifact was indexed, and the high-confidence private-key/provider-key/JWT/presigned-query pattern scan found zero matches. These pattern checks do not prove absence of every possible secret. The lead separately reports zero literal matches when comparing all182 indexed paths with seven known credential files; this reviewer did not read those files. Both protected originals matched their expected working/index hashes, LICENSE matched the original commit, and the original-license/S03-source/S03-closure commits remained ancestors. No history/license/protected-source change was made by this reviewer.

The only ESLint change adds `.local-secrets/**` to `globalIgnores`, SHA-256 `86eea8fb9263826aea7e60658ebe7f496112db70d8a5cd45ff4bb6169967b84d`. An independent ESLint `isPathIgnored` metadata check passed6/6: a synthetic private diagnostic path was ignored; the document contract, client, integration test, client unit test and ESLint configuration were not. No lint rule or public source/test directory was disabled. Full lint/TypeScript and40 units in7.23s are attributed PASS to the lead. One existing100ms VM-bound unit failed during concurrent CPU-heavy checks before the standalone40-unit rerun passed with its cap unchanged; that history is retained without assigning an unproved root cause.

### Five permitted sanitized receipts

The reviewer read exactly the five specifically authorized saved receipts: `s04-r2-app-receipt.json`, `s04-r2-original-receipt.json`, `s04-r2-live-receipt.json`, `s04-budget-build-receipt.json` and `s04-budget-db-receipt.json` under ignored `.local-secrets`. No other private configuration, credential, fixture, log or receipt was read in this closure pass. Checks below concern receipt fidelity and source correspondence; provider/runtime executions are the lead's operations.

| Saved evidence | Independently checked result | Provenance / limit |
| --- | --- | --- |
| Actual R2 app browser,22 November2026 `11:11:23.673Z` | PASS; three distinct document/job IDs; PDF637 bytes, DOCX1134 bytes and exact20,000,000-byte PDF; three observed browser PUTs, no cookies, retained app objects/reservations | All three MIME/size/SHA values matched the repository's public synthetic fixture generators independently in memory. The lead's run also records repeat-finalization job identity, wrong-SHA422 and Staff403; no provider call was repeated here |
| Retained originals, `11:12:30.409Z` | PASS; receipt SHA binds the exact app receipt; three original-byte/hash/MIME checks, one parked job each, negative no document/job, removed query container, retained app objects; unsigned statuses400/400/400 | The reviewed helper requires the exact bounded Authorization diagnostic for400. This verifies consistency of the saved proof and assertions; actual signed/unsigned R2 requests and SELECT-only query execution belong to the lead |
| Standalone R2 | PASS_WITH_LIMIT; expiry403, cleanup204 and cleaned=true | The public development URL returned no HTTP result because `CERT_HAS_EXPIRED`; TLS verification stayed enabled. User/lead dashboard confirmation of disabled public URL and no custom domains remains separate attestation. Known-original unsigned S3 denial does not establish a public-domain HTTP response |
| Controlled build, `05:43:12.153Z`–`05:44:04.072Z` | PASS/exit0/sourceUnchanged; zero build secrets/arguments; all92 admitted source hashes independently match current public files | Recomputed92-input manifest `9ea99296aedba6d51e38763e5c66f94242c3816ed755b18942c7bb47547c650d` and70-production-input manifest `6ea5253735eeb6459e20ea3b843a134b185cb3391597d8aab663ad19cf2811b8` match the receipt; all five recorded public configuration hashes also match. Recorded tooling-source exclusion checks passed; this reviewer did not build or inspect Docker runtime |
| Database rerun, `05:44:18.323Z`–`05:44:50.513Z` | PASS; PostgreSQL start, DB command and stop all exit0; dispatcherStarted=false, providerCalls=false, migrationsRun=false; all nine services stopped and volume retained | Uses the same recorded verification image as the build. The48-case/16.83s suite metrics are attributed to DevOps; the receipt records the overall DB command in21.841s. Existing migrated state was reused, so this is not a fresh-migration claim |

The saved build identifies app OCI index `sha256:96a51f9116fa7059b83edad3dd7b239489430e3b723b55ef5009b4f3d1a0d958`, amd64 `sha256:85d44da51292b1ddf4f09aa260ea8964f67081c28ecabdd44ad56cbef04adfd6`, and verify-db index `sha256:484b3d2e7401bfed6aba9b00caed9fcfd4366b67ab40012d7e0d0651e35e1b4f`, amd64 `sha256:6af03429eb346b1f2be34d128b100318fba289ddfcb098254ebdbf05b1bdf4fb`. Both recorded image users are `node`, with no sensitive environment names. The lead separately verified that the provider-app execution used this actual app container/image; this reviewer did not inspect runtime metadata. These46-source image identities become historical when the CSS-only app rebuild is recorded.

### Subsequent CSS affordance fix

The lead's actual UI gate found default cursors on clickable native labels. The diff in `src/app/globals.css` adds only base `label[for] { cursor: pointer; }` and `label[for]:has(+ :disabled) { cursor: not-allowed; }`. No backend/client/upload logic changes appear in that diff. No security defect was demonstrated by this presentation-only correction. At this intermediate cutoff the final47-source/artifact/UI checks were pending; the following section records their completed bounded review. Existing real-R2 and database proofs remain bound to the46-source checkpoint and are carried forward through explicit unchanged-input evidence.

## Final47-source publication and UI/runtime evidence

The independent read-only recheck observed47 staged source/test/config files and182 indexed paths at the same HEAD `868dca58d785540000bf3c1b81f70a1f4c91f20a`. All47 staged blobs equal their working files; there are no unmerged entries or indexed private/generated artifacts. Source manifest: `e8d68296d880a3787ef0aa44becc610f1225a8dd8f59e9f38490a474fbdd317e`. Source-only full-index checkpoint: `b722821b0067fbd27a270f8d0deb588cacabda53`. This is the pre-documentation index, not the eventual published commit tree; the lead owns final documentation staging, commit and CI identity. Removing only `src/app/globals.css` reproduces the prior46-source manifest exactly.

The audit again checked both protected originals against expected working/index hashes, LICENSE against its original commit and original-license/S03 ancestry. All passed. High-confidence credential/private-key/JWT/presigned-query patterns found zero matches. A broader query-value pattern matched the unchanged synthetic transport-test constant in `infra/storage-fixture/gateway.test.mjs:50`; inspection classified it as a local test scope, not a credential. No matched credential value or private data was printed. Final whole-index known-secret-literal comparison remains the lead's operation after documentation staging.

Independently recomputing all92 public build-input hashes against the permitted earlier build receipt found exactly one changed input: `src/app/globals.css`, SHA-256 `33299e7f63cae3a1dcffa49830f6725feccae4bc10b145ccfbae1ca243a072e6`. All69 other production files, all tests and the five recorded build/Compose/migration configurations are unchanged. Recomputed92-input manifest `ec2b463128ef9ae5830781a440f44474bafb8dbc818b4d870a958a707c2a327a` and70-production-input manifest `23a5e08fb27318a939a3831d2b8a6a1095082b86fdc4ba6a233600d01f5afa5f` agree with the public DevOps report. Its app-only build records exit0 in49.263s, nonroot/no-sensitive-environment/excluded-private-path checks and compiled cursor rules; these runtime/build operations were not repeated by this reviewer.

Final app OCI index is `sha256:c9c9b062f540ae4a9402e0e6a934479192cc6ed3eb659af3754e95a6cff65f61`; amd64 manifest `sha256:ab33a09bee732c8daf60b31f3bf711cd90f02be02072c1df984a585dbac23e91`. The verification image remains the previously recorded `484b3d2e…` index. No repeated provider upload or database execution is claimed for the CSS delta; relevant production/backend/test inputs match the preceding actual-provider/database proofs.

Two additional specifically permitted sanitized receipts were read, without any other private-input access:

| Receipt / time,22 November2026 UTC | Independently inspected record | Limits |
| --- | --- | --- |
| `.local-secrets/s04-ui/receipt.json`, `11:39:48.617Z` | PASS;13 checks, five screenshots; label pointer/focus and disabled not-allowed cursor, account loading/error recovery, pending duplicate prevention, injected transfer-failure retry, reload/resume, narrow/200%-text states, navigation, anonymous/Staff boundaries and no uncaught page errors | The lead executed this nondelegatable gate and inspected all five screenshots. This reviewer checked the receipt and refreshed public UI report, not screenshots or browser/runtime behavior |
| `.local-secrets/s04-r2-current-runtime-receipt.json`, `11:40:33.093Z` | PASS; exact `c9c9b062…` app index; eight owned containers, six healthy services/two successful one-shots; only published binding `127.0.0.1:3000`; actual-R2 flag and individual read-only credential mounts; old nine containers stopped/project retained | Saved sanitized runtime correspondence supplied by the lead, not an independent Docker inspection; no mount contents, configuration or credentials were read |

The refreshed [lead UI report](S04-ui.md) records the initial five-second observer expiry, its40s observation window outside the unchanged35s client bound, one30s Staff sign-in request timeout, an unchanged isolated Staff PASS in1.919s and the subsequent unchanged full-gate PASS. The timeout cause remains unproven. The prior default-cursor finding and its actual enabled/disabled observations are retained. Observer changes do not change application timeout or authorization assertions.

No new demonstrated security/publication defect was found in this final CSS/evidence delta. Exact published SHA/whole-index checks and hosted CI remain required before sprint closure. The expired-certificate public-domain HTTP limit, dashboard attestation, transient n8n execution-payload persistence and provider/file-limit/residency/recovery/company-data policy gates retain their stated scope; neither this review nor synthetic acceptance grants a production approval.

## Handoff

The two initial findings and the deadline-observation gap passed focused independent fix checks; the fixture-header failure retains its corrected native/browser evidence. Saved actual-provider/original receipts, final47-source publication checks, unchanged-input correspondence and final UI/runtime records pass the bounded checks above. Preserve failed-run history and historical identities, then bind final whole-index checks and exact hosted CI to the published revision before acceptance. Public-domain HTTP observation and provider/file-limit/residency/recovery/company-data policy limits remain explicit. This report does not close S04 or authorize production/real-data processing. Only this report was created and updated by the security reviewer.
