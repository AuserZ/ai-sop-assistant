# S04 infrastructure evidence

This is the DevOps handoff for D2, D1 upload status and ADR03. It supplements the lead's S04 report and [upload contract](../private-uploads.md); it does not close S04 or authorize deployment, real SOP processing or S05.

## Candidate and scope

| Field | Value |
| --- | --- |
| Branch / predecessor | `codex/s04-private-uploads`; S03 closure `93a71e8b93392c7740fd5b097548b28e1747b1d3` |
| Working-copy basis at local verification start | HEAD `868dca58d785540000bf3c1b81f70a1f4c91f20a` plus uncommitted S04 changes; artifact hashes below identify the checked source; final publication identity belongs to the lead |
| Owner | Principal DevOps engineer, under the project-manager lead |
| Environment | Windows host, Docker desktop-linux, disposable project `ai-sop-s04-verify-20261121` |
| Scope | Fixture/Compose/CI, secret-free images, fresh PostgreSQL migration and DB checks, private local runtime |
| Date | 21 and22 November2026 Jakarta; evidence timestamps are UTC; initial DB suite started21Nov16:33:15Z |
| Result | Historical local migration/DB/native fixture, final six recovery cases and native POST controls PASS. After the lead's 30s storage deadline correction, rebuilt app/tooling CLI exit 0 and 48/48 database regressions PASS; see the correction section below. Lead-reported prior browser 15/15 and private manual UI PASS. Hosted CI and updated real R2 evidence belong to the lead's separate gates. |

No actual R2 or Resend key was read or mounted by this work. The selected overlay uses only synthetic files in `.local-secrets/storage-fixtures`; browser seeding mounts only `.local-secrets/browser-fixtures`.

## Historical application artifacts

These artifacts precede the 30s storage deadline correction. The app and verification images are retained under the aliases below; their `latest` tags now identify the rebuilt images recorded later. The migration image is unchanged.

`docker image inspect TAG` returns the OCI index digest in this engine. `docker image inspect --platform linux/amd64 TAG` returns the platform manifest. These are different digest kinds, not conflicting builds.

| Service / tag suffix | OCI index | Linux/amd64 manifest |
| --- | --- | --- |
| `ai-sop-s04-verify-20261121-app:before-budget-20261122` | `sha256:98b98b329a6719e7e3b4a3eea8df7f26f2e505fdede5e538c68f68a7fd77db23` | `sha256:de32a1455b0c248ccb42257f476bd17395fe0acabcc9e9961bab4232a38e7d09` |
| `ai-sop-s04-verify-20261121-migrate` | `sha256:1120323f3df964a9db53e94d8ede78e095ad52e4f774f821d758cfbc144adf65` | `sha256:0fb4597df3619835bc784f35932bacd7aefba6558774f92db0275baf4863a109` |
| `ai-sop-s04-verify-20261121-verify-db:before-budget-20261122` | `sha256:83db78b5f4fc2915ee7389853f1ca2673ebe9694b2edd09507d307786911e3f3` | `sha256:7e2fd9b59eca3feb846980cb350bff8a28d72ea7abc01cbc0f784c6465a83ba5` |

The recorded Docker Next build completed compilation77s, TypeScript63s and static-page generation, with the build stage completing166.1s. No real auth/email/storage keys were supplied to the build. The context was556.09kB and excluded private credential paths. All three images use `node` and contain no credential environment variables.

The original build client handle41085 expired during a user pause, so its final CLI exit code is unavailable. Do not invent exit0. Exported artifacts were subsequently inspected and executed successfully; the saved app reached healthy HTTP200 and the saved tooling ran migrations/48 DB checks. Hosted CI must independently record the final candidate's full build result.

### Source identity

Hashes are SHA256 over file bytes. Aggregate hashes use sorted relative-path/individual-SHA256 pairs serialized as JSON.

| Checked input | SHA256 |
| --- | --- |
| Original93-file build-input inventory | `0970fb12d61b07bfa7964b633ba7d0537a4bb868f9940a209fcf2fd9d5ad6391` |
| Production70-file manifest: `src`, `drizzle`, `n8n`, package/lock and build configuration | `ea128cf2a9b99920136eaf43f7d4bcbe0b495802bb021d817cf8737a1881b5a1` |
| Original6-file integration/fixture aggregate, matched inside tooling before later test-helper changes | `933602775087b93d00f8faad15a7882bb9dcec1d32f560575e42edc95e8695a2` |
| Current unchanged DB subset: four integration files plus `tests/fixtures/auth.ts` | `fcd67fcff275352b5875131a1c1e3bcb35bca17a89afbff52bdd0e67caa2874d` |
| `drizzle/0003_private_uploads.sql` | `e4f5791e68c0f3813c16f360f155b7bd1aee5223efdb3735f300695b99e0299d` |
| Root package lock | `633fe76abc03ddac795aac08ad1f1f8dc64537f3487176d1a7b1154da06bd83f` |

An actual temporary tooling container compared production and DB-test source against the host successfully. Later changes added one host unit case and the exact20,000,000-byte browser fixture/case. The document-file helper is not imported by the DB suite. Those test-only changes do not alter the checked production/migration/18-document DB sources, but the old six-file aggregate must not be described as today's entire test tree. The lead's later full suite is38 units/15 browser cases; those counts are not claimed as executions inside the saved image.

## Migration and database verification

All Compose calls inherited the base and synthetic overlay. Equivalent PowerShell commands are shown below; execution used child-process environment variables with these exact values and arguments, without changing global machine configuration.

```powershell
$docker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
$env:COMPOSE_FILE = "docker-compose.yml;infra/storage-fixture/compose.yml"
$env:WORKFLOW_PROBE_CALLBACK_DELAY_MS = "2000"
& $docker compose -p ai-sop-s04-verify-20261121 --profile verify build app migrate verify-db
& $docker compose -p ai-sop-s04-verify-20261121 up --wait --wait-timeout 180 postgres
& $docker compose -p ai-sop-s04-verify-20261121 run --rm --no-deps migrate
& $docker compose -p ai-sop-s04-verify-20261121 run --rm --no-deps migrate
& $docker compose -p ai-sop-s04-verify-20261121 --profile verify run --rm --no-deps verify-db
```

| Check | Result / evidence |
| --- | --- |
| New project before startup | Zero existing containers; PostgreSQL volume absent |
| Fresh PostgreSQL | Healthy; database network internal; no host ports |
| Migrations0000–0003 | PASS, CLI exit0 |
| Idempotent migration repeat | PASS, CLI exit0; exactly4 ledger rows, latest migration timestamp `1795254925557` |
| Full PostgreSQL suite, before dispatcher startup | PASS48/48 across4 files:18 documents,12 jobs,15 auth,3 foundation;39.26s; session69988 exit0 |
| Provider access from DB tooling | No R2 provider overlay or credentials; document storage injected by DB tests |

No schema was repaired through manual table writes. No test reservation was released to obtain a pass. All volumes remain retained.

## Runtime startup and boundaries

Before stopping old S03 services, every old container's project/workspace labels were checked. Only the six long-running services in `ai-sop-s03-verify-20261120` were stopped. Its PostgreSQL volume and all three networks remain. Original S02 account/volume/Resend configuration was untouched.

New startup used:

```powershell
& $docker compose -p ai-sop-s04-verify-20261121 up --no-build --wait --wait-timeout 300 proxy
& $docker compose -p ai-sop-s04-verify-20261121 up --no-deps --no-build --wait --wait-timeout 120 storage-fixture
```

The first core startup passed with migrator/bootstrap exit0 and all six core services healthy. The first sidecar startup omitted `--no-deps`; Compose restarted the completed bootstrap and timed out waiting for it. Bootstrap itself subsequently exited0 with all native import/publish commands passing. Starting only the sidecar with `--no-deps` passed; CI now uses that flag, including recreation after app restart.

Actual inspection confirmed:

- Seven running services healthy, with migrator/bootstrap exited0.
- Only `127.0.0.1:3000` through proxy and verification-only `127.0.0.1:8787` through the app namespace are published. App3000, PostgreSQL, Redis, n8n and Wrangler18787 have no host bindings.
- Fixture network mode references the current app container. It has only two readonly synthetic credential binds, readonly root, nonroot1000:1000, dropped capabilities/no-new-privileges,512MiB/1CPU/128pids and256MiB private tmpfs.
- App configuration selects only the synthetic bucket/local endpoint; callback delay is2000ms. No actual provider secret mount is present.
- App live/ready200; public internal-job route404; fixture health200, public/explorer404 and unsigned S3 object access denied400.

## Native fixture failures and fixes

The fixture remains an experimental local Cloudflare simulation, not a replacement for real R2 checks. See [local R2](https://developers.cloudflare.com/r2/local-development/), [pinned authentication](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.166.0/packages/miniflare/src/workers/r2/s3/auth.worker.ts) and [pinned operations](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.166.0/packages/miniflare/src/workers/r2/s3/operations.worker.ts).

1. Initial fixture build failed `EACCES` creating `/fixture/node_modules`. The Dockerfile now owns the workdir before nonroot dependency installation.
2. First isolated startup failed because the slim image contained no system CA certificates. Added Debian `ca-certificates` without disabling TLS or weakening network/sandbox restrictions. The executed build installed `ca-certificates20250419~deb12u2` and OpenSSL/libssl3 `3.0.22-1~deb12u2`.
3. Initial presigned native proof passed, but the first integrated browser run had11 passes/4 failures. Browser PUTs actually returned200; server SDK GET/PUT returned403 `SignatureDoesNotMatch`. The SDK signs `amz-sdk-invocation-id` and `amz-sdk-request`; the narrow forwarder had dropped both. Only those two headers were added. No backend deadline, authorization or cryptographic check was relaxed. A separate browser locator ambiguity was corrected by the lead.

The corrected verifier now uses real SDK serialization/signing for Authorization-signed PUT/GET/conditional replay as well as presigned requests. Its transport passes signed requests through stdin into a single labelled network:none container; it implements no SigV4 verifier itself.

The lead's corrected full browser run passed15/15 in1.0min, including direct PDF/DOCX upload, sealed originals, retry and cookie omission plus the ten existing auth/workflow journeys. The exact20,000,000-byte case passed in6.9s. Private UI click-through passed at16:57:01Z with five inspected screenshots. This is attributed lead evidence, not a browser run executed by DevOps. It tests the stated local size assumption, not general capacity or real R2 latency.

| Native/gateway check | Actual result |
| --- | --- |
| Presigned PUT/HEAD/GET |200/200/200;50-byte content hash matched |
| Authorization-signed SDK.send | PUT200/GET200, exact bytes, replay412; signed SDK header names retained |
| Unsigned existing object |400 denial |
| Create-only replay / concurrent race |412; race exactly one200 and one412 |
| Signature/path/type/length/create-only-header/Host/wrong-secret tamper |403 `SignatureDoesNotMatch` |
| Expiry / unknown credential identity |403 `ExpiredRequest` /401 `Unauthorized` |
| Cookie/Bearer/foreign Origin |403 gateway denial |
| Unsigned public/explorer routes |404 gateway denial |
| Docker/native log inspection | Zero credential/signature markers; no regular native log files; one `/dev/null` debug sink |
| Cleanup | Owned isolated/diagnostic containers removed; zero persistent volumes created |

Corrected fixture image:

- OCI index `sha256:c9540b6f3ea8dae005c7a239d124165bd8f0c7593e81478bb554ad707af7ca0c`.
- Linux/amd64 manifest `sha256:68fa7019e9a3f10236ed9d9e08a84307b701afd606cd754898b76c9d8a9e6e86`.
- Supersedes CA-fixed index `4cbff164…`, which had only presigned coverage before the SDK transport defect was found.

Only the fixture was rebuilt/recreated for the header correction. App index98b98b32…, PostgreSQL, reservations and the15s backend deadline remained unchanged. The sidecar's storage is synthetic tmpfs: recreation discards fixture objects and does not prove external object durability or approve a cleanup/recovery policy.

## Redis recovery defect and correction

The first integrated recovery run, session61018, exited1. Worker pause passed18.933s and in-flight worker loss passed52.752s. The Redis case exceeded the existing100s collector budget; later cases did not run. Read-only diagnostics found the pinned n8n main and worker both exited1 after their10s Redis reconnect threshold. Neither was OOM-killed. Redis had returned, but both queue containers had Docker restart policy `no` and restartCount0. The app remained healthy, preserved its durable probe, exhausted its bounded attempts and failed safely without a completion marker.

The lead authorized `restart: unless-stopped` on **n8n-main and n8n-worker only**, keeping bootstrap and all other services unchanged. This follows the PRD's restart/reconciliation requirement; it does not increase application retries or approve a production recovery policy. [n8n Redis threshold](https://docs.n8n.io/hosting/configuration/environment-variables/queue-mode/) · [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)

The Redis regression now waits at least12s after an interrupted dispatch attempt before restoring Redis, then requires both queue processes to restart automatically with increased restart counts, different start times and healthy status. It does not manually start either queue process. The existing100s stream collector,60s application attempt, all job/SSE assertions and scoped cleanup remain unchanged.

After the long user pause, inspection on22 November Jakarta time confirmed both policies applied, both queue processes healthy and restartCount0, with17:10:26Z start times. There was no saved completed post-fix run. The synthetic Admin fixture's one-hour session had expired at17:54:16Z; the lead explicitly authorized refreshing it through the existing seed helper. Seeding mounted only the browser-fixtures child, used injected email and preserved all existing accounts, database rows and reservations.

Preflight Compose validation, verifier syntax and scoped ESLint passed. A count-only native snapshot at2026-11-21T23:49:29.359Z found1 old crashed execution/data row with1 JWT occurrence, age24601s; no orphan payload or Redis payload hashes. Available Docker/native logs contained zero JWT/Bearer/private-key markers. This observation does not establish a fixed native-pruning deadline or zero payload retention. No payload content was read and pruning was not changed.

Post-fix six-case run33156 exited1: worker pause passed38.129s; worker loss passed66.943s; Redis recovery exceeded the unchanged100s collector. The automatic restart assertions passed: both main and worker increased restart counts from0 to1 and were healthy without manual starts. Later cases did not run in this full-suite attempt.

Read-only inspection proves genuine delayed completion rather than only collector event-loop starvation. The Redis probe was created at23:52:28.766Z, retried after60.918s and121.001s, accepted on attempt3 at23:54:33.900Z and completed with one validated synthetic terminal event after136.092s. Redis returned at23:52:46.939Z; worker/main automatically started at23:52:48.087Z/23:52:49.212Z. Vendor logs showed Redis loss around23:52:29Z and reconnect exhaustion/exit around23:52:39Z. Readiness timestamps and individual dispatch HTTP failure classes were not retained; they are not inferred from the current healthy state. No application retry scheduling, verification bound or source was changed after this failure.

The lead authorized a clearly labelled private subset of the unchanged final3 checks, copied from verifier SHA `118f2fad83d674c9ff2cea8452fff74dccbc55a4c17032552c7e41b53247989c`. It skipped the already observed first3 cases, retained their recorded failure and changed no repository source/index. The subset exited0: app restart passed27.439s, account deactivation10.965s and the real proxy timeout/reconnect75.276s. This subset does not turn the preceding full-suite failure into a pass.

Independent QA assessed the Redis-specific horizon against the existing three60s application attempts. The lead approved an optional collector budget: the default remains100,000ms; only the explicit extended Redis case uses200,000ms, calculated as180,000ms bounded retry horizon plus20,000ms transport/reconciliation allowance. The100s queue-health wait and all production attempt/retry/SSE limits, terminal checks, event/byte bounds and cursor checks remain unchanged. Sanitized automatic-recovery evidence prints the formula's values. Both original100s failures remain recorded above.

After refreshing the consumed synthetic revocation fixture with injected delivery, final full six-case run78225 exited0 against the final verifier SHA below. Sanitized stdout is saved privately in ignored `.local-secrets/s04-final-recovery-output.log`; no credential or signed URL is included.

| Final recovery case | Result | Measured duration |
| --- | --- | --- |
| Queued work survives worker pause | PASS |29.573s |
| In-flight worker loss fences abandoned attempt | PASS |57.852s |
| Redis outage beyond vendor reconnect threshold | PASS |90.704s |
| App restart preserves job and reconnect cursor | PASS |26.403s |
| Account deactivation closes stream | PASS |8.449s |
| Actual60s proxy timeout and reconnect | PASS |75.530s |

The final Redis evidence records200,000ms collector budget =180,000ms retry horizon +20,000ms allowance. Main restart count increased1→2 and worker0→1, both healthy, with `queueProcessesManuallyStarted: false`. Passing this synthetic progress proof does not establish an LLM judge, grounded SOP answer, universal recovery time or production capacity.

Final count-only execution snapshot at2026-11-22T00:07:32.368Z:19 payload rows contain84 JWT occurrences;0 orphan payload rows or private-key markers. One Redis queue hash has0 JWT occurrences. All four Docker/native log checks have0 JWT/Bearer/private-key markers. These are retained synthetic execution payloads, including older crashed rows; do not describe the runtime as zero-persistence or claim a fixed pruning deadline. No payload contents were read and pruning policy was not changed.

Native POST control session41900 then exited0. Default behavior reached the destination twice, with one301 and one307 source request; explicit no-follow reached it0 times. Both modes had0 forwarded synthetic canaries. The inactive synthetic control workflow remains in the operational database; its temporary container and private input file were removed. Sanitized stdout is ignored in `.local-secrets/s04-final-redirect-output.log`.

After app restart, only the storage fixture was recreated using `--no-deps --no-build --force-recreate --wait --wait-timeout 120`; this exited0. Final inspection at2026-11-22T00:11:52.489Z passed: seven services healthy/unpaused, two successful completed one-shots, exactly nine owned containers and no redirect fixture. The sidecar shares the current app namespace and uses only synthetic storage mounts. Only loopback3000 and verification-only8787 are published; callback delay remains2000ms. App live/ready returned200, the public internal callback path404, fixture health200 and public/explorer routes404. Database volumes, existing accounts, reservations and secrets were retained. Runtime was handed back frozen for the lead's provider phase; no further service mutations belong to this DevOps handoff.

Executed from the repository root with the owned project and overlay:

```powershell
$env:COMPOSE_FILE = 'docker-compose.yml;infra/storage-fixture/compose.yml'
$env:SOP_WORKFLOW_TEST_PROJECT = 'ai-sop-s04-verify-20261121'
$env:WORKFLOW_PROBE_CALLBACK_DELAY_MS = '2000'
node scripts/verify-workflow-runtime.mjs
node infra/n8n/verify-redirects.mjs
& 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' compose -p ai-sop-s04-verify-20261121 up --no-deps --no-build --force-recreate --wait --wait-timeout 120 storage-fixture
```

The actual Node runs additionally piped sanitized stdout through `Tee-Object` to the ignored paths above and propagated the native exit code. Final receipt is ignored in `.local-secrets/s04-final-runtime-receipt.json`. No `down --volumes`, database/quota reset, provider-key access or production operation occurred.

| Corrected input | SHA256 |
| --- | --- |
| `docker-compose.yml` | `3c760ac94d927cef0c063383aeebe07e460a2bd98c8e32e13c8ed8649a01ddad` |
| `scripts/verify-workflow-runtime.mjs` | `5f088a15386a1f8d81f4f7466c7309070a40999229db9f0d0614c236baf84bf2` |

## 22 November deadline correction rebuild

Mapping remains D2, D1 upload status and ADR03. The lead reported that actual R2 small PDF/DOCX acceptance passed, but a 20,000,000-byte finalization failed twice at the former 15s overall storage deadline. Separate actual SDK measurements were 11.220s for staging read and 10.699s for the final PUT; these are attributed lead evidence, not provider calls executed by DevOps. The lead changed the overall storage deadline from 15 to 30s, fenced lease from 30 to 45s and browser metadata deadline from 25 to 35s. The 35s proxy limit, file/hash/format/create-only/auth checks and two-finalizer concurrency remain unchanged. The exact large-file provider rerun remains a separate lead-owned check.

The lead froze source before this rebuild after 40 standalone unit tests, lint, TypeScript no-emit, whitespace and PRD integrity passed. One unit test had failed during concurrent host unit/lint/type verification, then passed standalone with its existing 100ms VM cap unchanged; do not describe that earlier attempt as passing. DevOps ran no host Next build/typegen or duplicate recovery suite.

At 05:40:17Z, all nine retained `ai-sop-s04-verify-20261121` containers were exited and their project/workspace labels matched this repository. Before retagging, both historical app/tooling images were preserved with `:before-budget-20261122` aliases. The running real R2 project was not inspected, recreated, stopped or changed by this work.

The following commands used explicit base and synthetic-fixture Compose files, with no provider overlay, build arguments or build secrets:

```powershell
$docker = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
& $docker compose --progress plain -p ai-sop-s04-verify-20261121 -f docker-compose.yml -f infra/storage-fixture/compose.yml --profile verify build app verify-db
& $docker compose -p ai-sop-s04-verify-20261121 -f docker-compose.yml -f infra/storage-fixture/compose.yml up --no-deps --no-build --wait --wait-timeout 180 postgres
& $docker compose -p ai-sop-s04-verify-20261121 -f docker-compose.yml -f infra/storage-fixture/compose.yml --profile verify run --rm --no-deps -T verify-db
& $docker compose -p ai-sop-s04-verify-20261121 -f docker-compose.yml -f infra/storage-fixture/compose.yml stop postgres
```

| Check | Actual result |
| --- | --- |
| Explicit Compose configuration validation | PASS, CLI exit 0 |
| App/tooling build, 05:43:12.153–05:44:04.072Z | PASS, CLI exit 0, 51.919s; session 24063; production build stage 42.1s |
| Build context | 78.35kB incremental transfer; unchanged allowlist excludes local secrets/configuration, Git, docs and protected PRDs |
| Tooling source comparison | PASS: all 92 admitted COPY-input paths/hashes match the frozen host; source unchanged throughout build |
| Isolated tooling container, network:none and no mounts | PASS: `.local-secrets`, `.env`, `.git`, docs, AGENTS and both protected PRDs absent |
| Built image identities | Both nonroot `node`; zero sensitive credential environment names |
| Existing Postgres only, no dependencies | PASS, CLI exit 0, 4.274s; same retained container ID `a212d28334d5db19b9ceabbac767b7346c7d248e4a03aad4a68ce96b9b211a75` |
| Full database suite against new tooling | PASS 48/48 across 4 files: 18 documents, 12 jobs, 15 auth, 3 foundation; Vitest 16.83s, command 21.841s, CLI exit 0; session 82134 |
| Changed overall deadline regression | PASS: actual injected storage AbortSignal is false at 29s and true at 30s; pending at 29s, safe failure, no accepted document/job and FAILED upload state |
| Scoped shutdown | PASS, CLI exit 0; at 05:44:50.513Z all 9 old containers exited; retained `ai-sop-s04-verify-20261121_postgres-data` volume confirmed |

No migration rerun was needed: migration 0003 remains byte-identical to the twice-tested earlier version. All app/queue/fixture services stayed stopped; the dispatcher never ran during DB tests. Tests injected storage and email. No actual provider credential value, parent secret-directory mount, quota release, database reset, volume deletion or production operation was used.

### Rebuilt artifact identities

| Service / tag | OCI index | Linux/amd64 manifest |
| --- | --- | --- |
| `ai-sop-s04-verify-20261121-app:latest` | `sha256:96a51f9116fa7059b83edad3dd7b239489430e3b723b55ef5009b4f3d1a0d958` | `sha256:85d44da51292b1ddf4f09aa260ea8964f67081c28ecabdd44ad56cbef04adfd6` |
| `ai-sop-s04-verify-20261121-verify-db:latest` | `sha256:484b3d2e7401bfed6aba9b00caed9fcfd4366b67ab40012d7e0d0651e35e1b4f` | `sha256:6af03429eb346b1f2be34d128b100318fba289ddfcb098254ebdbf05b1bdf4fb` |

Aggregate hashes below use SHA256 of UTF-8 JSON containing sorted `[relativePath, fileSha256]` pairs. The 92 COPY-input manifest includes the eight admitted root/seed/workflow files and recursive `src`, `drizzle` and `tests` files. The 70-file production subset excludes `tests`. Dockerfile and `.dockerignore` are separate build-definition inputs. Full pair inventories and actual CLI exits are saved privately in ignored `.local-secrets/s04-budget-build-receipt.json` and `s04-budget-db-receipt.json`; sanitized stdout is in the matching `s04-budget-*-output.log` files. No receipt is a source artifact or provider approval.

| Frozen input | SHA256 |
| --- | --- |
| 92 admitted COPY inputs | `9ea99296aedba6d51e38763e5c66f94242c3816ed755b18942c7bb47547c650d` |
| 70 production inputs | `6ea5253735eeb6459e20ea3b843a134b185cb3391597d8aab663ad19cf2811b8` |
| `src/server/documents/contracts.ts` | `86ed3af17cad9aa1a015ea89b4f6f15911fad7b0d3d4b7bd3c1ba854056f1d21` |
| `src/components/documents/client.ts` | `42fb6992480f5eef9caa03c2d74b8c44482aeb92ff5aa590133aa6fbbcf60baf` |
| `tests/integration/documents.test.ts` | `cadd9e97b627eb222ea10e4360c4a4ca615c4c2b7a602a974ea8936374c51250` |
| `tests/unit/document-client.test.ts` | `7a36a8face29e219c950b15b39347db84a8904d87a99750f3bdde6910ea55d0e` |
| Dockerfile | `2cc6beda3a113035e640ed073bde7385040e98bb4df5bbf956c13e284623893d` |
| `.dockerignore` | `845eb92c2c80b4b9bfdfa0c3eb6836bdda6f2f3f368273f9bf773a12df2da5f6` |
| Unchanged migration 0003 | `e4f5791e68c0f3813c16f360f155b7bd1aee5223efdb3735f300695b99e0299d` |

This bounded artifact/DB handoff is PASS. The lead owns copying the rebuilt image to the separate R2 project, its controlled app recreation, real large-file browser/provider rerun, final hosted CI and independent QA/security review. The earlier six recovery/native POST checks remain historical evidence; they were not repeated locally after this narrowly scoped timeout change. S04 closure and all provider-policy, recovery, production and S05 gates remain separate.

## Source and check handoff

| Owned input | SHA256 |
| --- | --- |
| Gateway | `27611a4e0aeab1895ae9f1b06f7ad427fa13a8418298a62aa5d5b72ca1d180ba` |
| Native verifier | `a4e6c0f58a425b466abf5292dcfd66ad8da695bdc87847483cd2a2e7031bdd97` |
| Fixture Dockerfile | `543b0b53c75b0213e1810681b03810258d35999dcb853c9626b4953b8baa29d3` |
| Synthetic Compose overlay | `f36fd1303881152149eebe0e14e189d8dabe47edd1ce449c401b45fd82e288a9` |
| CI at this handoff | `2d61625ff25fc051d10768a36c2c2564e268e1ebe50deae4f9d9815db891941f` |

`node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` PASS7/7. Scoped ESLint with zero warnings PASS. Corrected isolated native verifier session89906 exited0. Compose/CI ordering checks and protected-PRD integrity passed. Hosted CI for S04 is not yet recorded here.

Remaining limits: local CORS is permissive internally (`*`) while the forwarder admits the canonical local origin; this does not prove real bucket CORS. Flexible checksum headers and destination CopyObject conditions are not faithfully implemented locally. Actual bytes/SHA256 validation and conditional PutObject are the shared contract. Real R2 compatibility, public-access settings, jurisdiction/privacy and recovery policy remain separate lead-owned gates. No model/OCR, extraction, real SOP or production operation occurred.

## Final label cursor artifact — 22 November

The lead's final UI check found that associated form labels still used the default cursor. The lead added only base CSS in `src/app/globals.css`: `label[for]` uses `pointer`, and `label[for]:has(+ :disabled)` uses `not-allowed`. This addresses the existing R39 UI gate without changing document/backend/client/test/migration/CI behavior. DevOps changed no application source or index.

The lead reports that the preceding 30/45/35-second candidate passed all three real R2 app files, including the 20,000,000-byte file, plus retained-original verification. That remains attributed lead evidence. Before this final build, all 69 production inputs other than `globals.css` matched the previous 70-file production manifest `6ea5253735eeb6459e20ea3b843a134b185cb3391597d8aab663ad19cf2811b8`. Dockerfile, context allowlist, both Compose files and migration 0003 were unchanged. The preceding database, recovery and provider byte/security evidence therefore retains the same relevant source inputs; those suites were not rerun locally for CSS.

At 11:24:18.833Z, all nine old synthetic containers remained exited with matching project/workspace labels. App index `96a51f9116fa7059b83edad3dd7b239489430e3b723b55ef5009b4f3d1a0d958` was preserved as `ai-sop-s04-verify-20261121-app:before-cursor-20261122`. The preceding deadline section's app `latest` tag described its earlier handoff; the new `latest` identity is below. The verification image remains index `484b3d2e7401bfed6aba9b00caed9fcfd4366b67ab40012d7e0d0651e35e1b4f`.

Only app was built, through the old synthetic project and explicit fixture configuration:

```powershell
& 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' compose --progress plain -p ai-sop-s04-verify-20261121 -f docker-compose.yml -f infra/storage-fixture/compose.yml --profile verify build app
```

| Check | Actual result |
| --- | --- |
| App build, 11:25:11.703–11:26:00.966Z | PASS, actual CLI exit 0, 49.263s; session 35332; production build stage 41.1s |
| Build inputs | 6.50kB incremental context; no build arguments, secrets or actual provider configuration; all 92 source hashes unchanged throughout build |
| Other production files | PASS: 69/69 match the preceding manifest exactly; only `src/app/globals.css` changed |
| Built runtime CSS | PASS in an ephemeral network:none container with no mounts: enabled associated labels have `pointer`; disabled associated labels have `not-allowed` |
| Image boundary | Nonroot `node`; zero sensitive credential environment names; `.local-secrets`, `.env`, `.git` and docs absent |
| Retained environment | PASS: all nine old containers still exited and the old PostgreSQL volume retained; no service startup or provider project operation |

| Final artifact / input | Identity |
| --- | --- |
| `ai-sop-s04-verify-20261121-app:latest`, OCI index | `sha256:c9c9b062f540ae4a9402e0e6a934479192cc6ed3eb659af3754e95a6cff65f61` |
| Linux/amd64 manifest | `sha256:ab33a09bee732c8daf60b31f3bf711cd90f02be02072c1df984a585dbac23e91` |
| 92 admitted COPY inputs, same aggregate method as above | `ec2b463128ef9ae5830781a440f44474bafb8dbc818b4d870a958a707c2a327a` |
| 70 production inputs | `23a5e08fb27318a939a3831d2b8a6a1095082b86fdc4ba6a233600d01f5afa5f` |
| `src/app/globals.css` | `33299e7f63cae3a1dcffa49830f6725feccae4bc10b145ccfbae1ca243a072e6` |
| Built `.next/static/chunks/0ih1tpw50_waq.css` | `1134f84d9cf52d6f51ba2e488b248d05e34d6c1afe0b2f9696d6f99130a6573d` |

Sanitized actual stdout and exit/source/image receipts are saved privately in ignored `.local-secrets/s04-cursor-build-output.log`, `s04-cursor-build-receipt.json` and `s04-cursor-preflight-receipt.json`. No actual credential value was read, no provider call was made, and no container in the real R2 project was inspected or modified. The lead owns its app image update, final UI gate, hosted CI, independent reviews and sprint closure. Production, company-data processing and S05 remain separately gated.
