# Deployment and recovery guide

Local Compose contains Next.js, PostgreSQL/pgvector, migrations, private n8n Queue Mode/Redis, an unbuffered loopback proxy and isolated LibreOffice tooling. Production deployment and backups belong to later sprints; implementation status is recorded in [PLANS.md](../PLANS.md). [Technical PRD, sections 3, 12–16](<../AI SOP Assistant — Technical Product Req.md>)

## Source repository

The user selected [AuserZ/ai-sop-assistant](https://github.com/AuserZ/ai-sop-assistant) on 19 November 2026. Its default branch is `master`; preserve the existing history and Apache license. Initial source was published on `codex/s01-foundation`, retaining the protected PRDs byte-for-byte and excluding local credentials, dependencies and build outputs through `.gitignore`.

The existing `.github/workflows/ci.yml` runs project checks on pushes/pull requests. Record the exact commit and hosted run result in the S01 report before closing that sprint. Connecting or publishing source does not authorize production deployment or resolve PRD provider/policy gates.

Native Git publication now works after the user completed Git Credential Manager browser sign-in. Branch `codex/s01-foundation` tracks its matching origin branch, and hosted foundation run `44485878184` passed for candidate `59fa63f7df02489a6730b02f6cbbb2383c255503`. The connector's earlier HTTP 403 is historical and was not resolved or retested; publication used native Git. No master merge, image-registry publication or production deployment occurred.

## Local runtime

Use Docker Compose with a Linux container engine. Generate credentials for the disposable local databases and start the app.

```powershell
npm run dev:secrets
docker compose --profile verify build app migrate verify-db
docker compose up --wait postgres
docker compose run --rm --no-deps migrate
docker compose --profile verify run --rm --no-deps verify-db
docker compose up --wait --wait-timeout 180 proxy
Invoke-RestMethod http://127.0.0.1:3000/api/health/ready
docker compose --profile conversion run --rm --build convert
```

Open `http://127.0.0.1:3000`. Readiness returns HTTP503 when PostgreSQL or pgvector is unavailable. Run database tests before the app dispatcher starts. Starting `proxy` also starts its healthy app/n8n/Redis dependencies and native credential/workflow initialization. Conversion checks LibreOffice in its isolated helper.

Use `docker compose down` to stop local services and retain the database volume. Keep the generated credentials in `.local-secrets/` for that volume. On Unix, keep the directory mode at `0700`. On Windows, restrict its host ACL to your account and the Docker engine as appropriate. Compose mounts individual files into authorized Linux containers, where the service users must be able to read them. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)

Only the proxy binds a host port, `127.0.0.1:3000`; app, n8n, Redis and PostgreSQL stay internal. The proxy preserves the canonical public Host, disables SSE buffering and blocks internal job routes. Conversion runs without networking or secrets. [Compose configuration](../docker-compose.yml) · [Workflow trust boundary](workflow-jobs.md)

S02 adds `auth-secret` to `dev:secrets`; rerunning preserves all existing credential files. Compose mounts it only into app and auth verification containers, with `AUTH_BASE_URL=http://127.0.0.1:3000`. Production requires an approved HTTPS origin, a TLS proxy preserving the canonical public `Host`, and protected auth/provider secrets. Auth does not trust forwarded headers or infer its public origin from Next.js's internal bind URL. Resend sender/key remain absent from default Compose; an ignored local overlay mounts the privately configured key into app only. One authorized live invitation/acceptance/sign-in passed for S02; see [authentication](authentication.md). Build stages need neither auth nor email credentials.

For a disposable browser run, after migrations/database tests and proxy startup, mount only the ignored child fixture directory:

```powershell
New-Item -ItemType Directory -Force .local-secrets/browser-fixtures | Out-Null
docker compose --profile verify run --rm --no-deps -e SOP_SYNTHETIC_AUTH=1 -e BROWSER_FIXTURE_DIRECTORY=/browser-fixtures -v "${PWD}/.local-secrets/browser-fixtures:/browser-fixtures" verify-db node --import tsx tests/e2e/seed.ts
npx playwright install chromium
npm run test:browser
```

Use the same `-p` project name as the running test app when isolating Compose projects. The fixture injects email delivery and writes only synthetic credentials/tokens into the ignored file; it proves no live delivery. Do not copy this file into artifacts, source or a production environment. Stop services with `down` after checks; retain volumes unless a separate disposable CI job explicitly owns their deletion.

On Linux, add `--user "$(id -u):$(id -g)"` to fixture preparation so the container writes as the owner of the private bind-mounted directory. The CI browser step uses this setting; do not make the directory world-writable to bypass a UID mismatch.

For recovery checks, use a fresh fixture seed and the same owned project name. The script deactivates only its synthetic revocation account and restores touched services; it does not reset that account afterward. Enable the bounded synthetic callback delay before starting the test app:

```powershell
$env:WORKFLOW_PROBE_CALLBACK_DELAY_MS = "2000"
docker compose up -d --no-deps app
$env:SOP_WORKFLOW_TEST_PROJECT = "ai-sop-assistant"
node scripts/verify-workflow-runtime.mjs
node infra/n8n/verify-redirects.mjs
```

Use `-p NAME` consistently, and set `SOP_WORKFLOW_TEST_PROJECT` to that exact name for an isolated S03 project. Runtime controls reject mismatched project/workspace labels. The redirect helper uses an inactive synthetic workflow and a temporary private fixture; it proves native POST301/307 behavior, not Queue Mode by itself. Count-only execution/queue/log snapshots expose no payloads. Local queue recovery runs every minute; completed/error saving is disabled and pruning is configured, but a pending or crashed execution may retain a short-lived JWT until native recovery/pruning. These are initial local operational settings, not approved company retention policy. [S03 evidence and limits](verification/S03.md)

## Planned environment

One VPS runs the TLS reverse proxy, Next.js application, PostgreSQL/pgvector, n8n main/workers, Redis and an isolated LibreOffice conversion helper. Managed private S3-compatible storage, OpenAI, Google Document AI, Resend and encrypted offsite backups are external. Protect internal ports/networks and limit worker/conversion CPU, RAM, time and outbound access.

The initial 4-vCPU/8-GB VPS estimate, file/page caps, and worker/OCR concurrency are assumptions requiring load tests. The user selected Cloudflare R2 on 21 November 2026; its bucket/account endpoint, jurisdiction/location, scoped credentials and object recovery policy remain open. Exact models and OCR project limits also remain open. Local synthetic scaffolding must not silently set production policy or submit company documents externally.

Local Compose provisions separate n8n persistence and main/worker Queue Mode with authenticated Redis. Keep secret values out of Git, restrict host access and preserve `N8N_ENCRYPTION_KEY` consistently across workers and recovery. Production restart, backup and deployment policies are verified in Phase4.

## Release path (Sprint S16 — approval-gated deployment & rollback)

Authority: [Technical PRD](../AI%20SOP%20Assistant%20%E2%80%94%20Technical%20Product%20Req.md) sections 14 and 16 (`ADR 09`, `ADR 14`).

### 1. Immutable release artifacts (`infra/deploy/release-manifest.mjs`, `infra/deploy/compose.release.yml`)

Every deployable candidate is bound to an immutable `release-manifest.json` (`schemaVersion: 1`) generated by `infra/deploy/release-manifest.mjs`:

- **Git identity:** exact 40-hex `gitSha`, `gitRef`, and ISO-8601 `builtAt`.
- **Digest-pinned container images:** `app`, `migrate`, `paddleocr`, `convertWorker`, and `backupScheduler` must all match `^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$`. Mutable tags and `:latest` references are rejected.
- **Schema & workflow provenance:** records `drizzle/meta/_journal.json` `headTag`, `count`, and per-file SQL SHA-256 digests; records SHA-256 digests and verified IDs for `n8n/s03-probe.v1.json`, `n8n/s05-ingestion.v1.json`, and `n8n/s11-chat.v1.json`.
- **Configuration provenance:** SHA-256 digests of `docker-compose.yml`, `infra/deploy/compose.release.yml`, `infra/proxy/nginx.conf`, and `infra/backup/compose.backup.yml`.
- **Schema compatibility declaration:** `schemaChangeType` must be `none`, `additive_backward_compatible`, or `breaking_requires_restore`.

`infra/deploy/compose.release.yml` overlays `docker-compose.yml` (and `infra/backup/compose.backup.yml` when `--profile backup` is active) for non-production staging and approved production hosts:
- Pins `app`, `migrate`, `paddleocr`, `convert-worker`, and `backup-scheduler` (`profiles: [backup]`) strictly to required `${*_IMAGE_DIGEST:?...}` environment variables with `build: !reset null` and `pull_policy: always` (zero `:latest` or local build fallback).
- Forces all synthetic/local fixture flags OFF: `SOP_WORKFLOW_PROBE_ENABLED="0"`, `SOP_LOCAL_STORAGE_FIXTURE_ENABLED="0"`, `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED="0"`, `SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED="0"`, and `SOP_LOCAL_ANSWER_FIXTURE_ENABLED="0"`.
- Sets `restart: unless-stopped` on `app`, `proxy`, `postgres`, and `redis`, preserving private internal networks (`database`, `workflow`, `ocr`, `conversion`) with zero new published host ports.

### 2. Approval-gated GitHub Actions workflow (`.github/workflows/deploy.yml`)

Deployment is triggered **exclusively** via manual `workflow_dispatch` (never `push` or `pull_request`), with top-level `permissions: {}`, per-job least-privilege permissions, all GitHub Actions pinned to exact 40-hex commit SHAs, zero inline `${{ inputs.* }}` interpolation in shell `run:` scripts, `printf '%q'`-quoted remote SSH positional arguments, single-SSH `umask 077` `mktemp` transfer of the smoke session cookie with an `EXIT` trap that revokes the smoke session via `POST /api/auth/sign-out` and deletes temporary files:

1. **`verify-candidate`**: runs `check:prd`, `verify-hardening`, per-file `node --check` on `infra/deploy/*.mjs`, `lint`, `typecheck`, `npm test`, `npm audit --omit=dev --audit-level=high`, `npm run build`, and `security-scan-artifacts`. Any failure blocks image builds and promotion.
2. **`build-immutable-artifacts`** (`needs: verify-candidate`): builds and pushes commit-scoped GHCR images (`app`, `migrate`, `paddleocr`, `convert-worker`, `backup-scheduler`), generates and validates `release-manifest.json` with immutable `@sha256` digests, validates both `docker compose -f docker-compose.yml -f infra/deploy/compose.release.yml config --quiet` and `docker compose -f docker-compose.yml -f infra/backup/compose.backup.yml -f infra/deploy/compose.release.yml --profile backup config --quiet`, packages `release-bundle.tar.gz` (manifest, `n8n/`, `infra/deploy/`, `infra/proxy/nginx.conf`, `infra/n8n/bootstrap.mjs`, Compose files), and uploads the artifact.
3. **`deploy-nonprod`** (`needs: [verify-candidate, build-immutable-artifacts]`, `environment: staging`): enforces required secrets including `STAGING_SYNTHETIC_SESSION_COOKIE`, unpacks `release-bundle.tar.gz` on the staging VPS, runs `deploy.mjs --environment staging` (verifying on-disk workflow/config SHA-256 digests and snapshotting `.deploy-state/releases/<gitSha>/`), runs health + checked-answer SSE smoke checks, and rehearses rollback when a previous known-good manifest exists.
4. **`deploy-production`** (`needs: [verify-candidate, build-immutable-artifacts, deploy-nonprod]`, `if: inputs.target_environment == 'production'`, `environment: production`): requires GitHub Environment manual reviewer approval AND an exact `V01_CANDIDATE_SHA == TARGET_SHA` match (via env) plus `PROD_SYNTHETIC_SESSION_COOKIE` before unpacking `release-bundle.tar.gz` and running `deploy.mjs --environment production` with reviewed migrations and smoke verification.

No commands here authorize production deployment or waive open PRD Section 16 gates. Production release remains gated on V01 PASS and explicit human approval.

### 3. Controlled deploy, smoke checks, and rollback commands

```bash
# Validate candidate release manifest and Compose release overlays
node infra/deploy/release-manifest.mjs --validate release-manifest.json
docker compose -f docker-compose.yml -f infra/deploy/compose.release.yml config --quiet
docker compose -f docker-compose.yml -f infra/backup/compose.backup.yml -f infra/deploy/compose.release.yml --profile backup config --quiet

# Staging deploy (retains prior .deploy-state/current-release.json as previous-known-good.json)
node infra/deploy/deploy.mjs \
  --environment staging \
  --manifest release-manifest.json \
  --base-url https://staging.example.invalid \
  --session-cookie-file .deploy-state/smoke-session.cookie

# Production deploy (fails closed with DEPLOY_APPROVAL_REQUIRED without production gate + matching V01 SHA)
GITHUB_ENVIRONMENT=production node infra/deploy/deploy.mjs \
  --environment production \
  --v01-candidate-sha "<40-hex-v01-verified-sha>" \
  --manifest release-manifest.json \
  --base-url https://sop.example.invalid \
  --session-cookie-file .deploy-state/smoke-session.cookie

# Post-deploy health, boundary, header, and checked-answer SSE smoke check
node infra/deploy/smoke-check.mjs \
  --base-url https://staging.example.invalid \
  --session-cookie-file .deploy-state/smoke-session.cookie

# Read-only health/boundary probe (explicitly marks checkedAnswerSse unexecuted; never fabricates a pass)
node infra/deploy/smoke-check.mjs --base-url http://127.0.0.1:3000 --health-only

# Controlled rollback to .deploy-state/previous-known-good.json
node infra/deploy/rollback.mjs \
  --base-url https://staging.example.invalid \
  --session-cookie-file .deploy-state/smoke-session.cookie
```

`smoke-check.mjs` uses `redirect: "error"` with end-to-end request and SSE stream timeouts, verifying `GET /api/health/live` (`200`, `status: "ok"`, `X-Request-Id`, `Cache-Control: no-store`), `GET /api/health/ready` (`200`, `status: "ready"`), unauthenticated `401` across `/api/documents`, `/api/users`, `/api/chat/conversations`, and `/api/health/ops`, external `404` on `/api/internal/chat/.../claim`, canonical proxy security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), and checked-answer SSE safety (allowlisted progress stages only, zero leaked draft/procedural fields in progress frames, terminal `completed` with valid citations or exact `No SOP found for this question` fallback, and separate `firstProgressMs`/`firstAnswerMs`/`completedMs` timings).

`deploy.mjs` verifies on-disk workflow/config SHA-256 digests (`ARTIFACT_DIGEST_MISMATCH` on drift), snapshots each release under `.deploy-state/releases/<gitSha>/`, starts `postgres` before `migrate` and `redis`/`n8n-main` before `n8n-bootstrap`, and records `.deploy-state/in-progress-release.json` immediately before running migrations (cleared only after `recordCurrentRelease` or a verified rollback). If `deploy.mjs` fails after migrations or service start, it exits non-zero, preserves `.deploy-state/previous-known-good.json`, leaves `in-progress-release.json` so `rollback.mjs` never misses post-migration schema drift, and reports whether image rollback is safe or S15 data recovery is required. During compatible rollback, `rollback.mjs` restores and verifies the target release's snapshotted workflow/config bundle before re-running `n8n-bootstrap`, and restarts `paddleocr`/`convert-worker`/`n8n-worker`/`app`/`proxy` with `--no-deps` so `migrate` is never re-executed.

### 4. Image rollback vs. schema/data recovery matrix

Container image rollback **never** reverses applied PostgreSQL Drizzle migrations. Use `checkRollbackCompatibility` (`infra/deploy/release-manifest.mjs --check-rollback`) and follow this matrix:

| Current vs. target migrations | `schemaChangeType` | Compatibility result | Allowed action |
| --- | --- | --- | --- |
| Identical `headTag` and SQL SHA-256 digests | `none` | `image_rollback_safe` (`requiresDataRecovery: false`) | Run `infra/deploy/rollback.mjs` to restore pinned known-good images and n8n workflows, then verify smoke checks. |
| New forward migrations added (zero modified/removed SQL) | `additive_backward_compatible` | `schema_recovery_required` (`requiresDataRecovery: true`) | Blind rollback refused (`ROLLBACK_REQUIRES_DATA_RECOVERY`). Either execute S15 encrypted backup restore ([disaster-recovery.md](disaster-recovery.md)) OR, only after DBA/engineering verifies the target image tolerates the new additive columns/tables, pass `--allow-additive-schema-rollback`. |
| Breaking DDL (dropped/renamed columns, altered constraints, or modified/removed migration SQL) | `breaking_requires_restore` (or mismatched SQL hash) | `schema_recovery_required` (`requiresDataRecovery: true`) | Blind image rollback is **unconditionally blocked** even with `--allow-additive-schema-rollback`. Follow the S15 [disaster recovery runbook](disaster-recovery.md) to restore both `sop_app` and `sop_n8n` dumps + escrowed `N8N_ENCRYPTION_KEY`, reconcile jobs, and re-run smoke checks. |

### 5. Re-verification triggers (`detectRequiredReverification`)

Compare the previous release manifest against a candidate manifest (`node infra/deploy/release-manifest.mjs --reverify --previous <old> --next <new>`) before promotion:

| Changed artifact area | Required re-verification suites |
| --- | --- |
| Application code / `app` or `migrate` image digest | `lint`, `typecheck`, `unit`, `security-scan-artifacts`, `deploy-smoke-check`, `checked-answer-sse-smoke`, `golden-benchmark-50` |
| Drizzle SQL migrations (`drizzle/**`) | `test:db`, `migration-review`, `rollback-compatibility-check`, `isolated-restore-drill` |
| Managed n8n workflows (`n8n/*.json`) | `verify-hardening`, `workflow-contract`, `workflow-runtime-recovery`, `checked-answer-sse-smoke` (plus `golden-benchmark-50` when `sop-s11-chat-v1` changes) |
| Ingestion workers (`paddleocr`, `convertWorker`) | `paddleocr-verify`, `conversion-verify`, `ingestion-regression` |
| Runtime config (`docker-compose.yml`, `compose.release.yml`, `nginx.conf`) | `verify-hardening`, `compose-config`, `deploy-smoke-check`, `nonprod-rollback-rehearsal` |
| Backup config or `backupScheduler` image | `verify-hardening`, `backup-unit`, `isolated-restore-drill` |

### 6. Release, rollback, support, and pilot ownership (PRD §16)

Named owners must be confirmed and recorded before V01 sign-off and production deployment approval (do not fabricate placeholder names):

| Role | Responsibility | Assigned owner |
| --- | --- | --- |
| **Launch owner** | Authorizes production `workflow_dispatch` promotion after V01 PASS and Section 16 gate sign-off | `TBD — Confirmation Required (PRD §16)` |
| **Rollback owner** | Approves and executes `rollback.mjs` or escalates to S15 `docs/disaster-recovery.md` restore on post-deploy incident | `TBD — Confirmation Required (PRD §16)` |
| **Support owner** | Triages pilot incidents, monitors `/api/health/ops` and `ops-monitor.mjs`, coordinates provider outage communications | `TBD — Confirmation Required (PRD §16)` |
| **Pilot owner** | Confirms pilot roster, launch date, document languages/types, rubric acceptance, and V02 weekly active staff observation | `TBD — Confirmation Required (PRD §16)` |

## Backups and restore

Confirmed baseline: encrypted PostgreSQL logical dumps every six hours for app and n8n persistence, copied to private offsite S3/R2 with restricted credentials. Securely escrow the original n8n encryption key and required configuration separately. Validate dump success, encryption, upload and alerting; a scheduled task alone is insufficient.

Thirty-day retention is proposed policy, not approved. Up to six hours potential database loss assumes successful backups; recovery in four to eight hours is provisional. Active originals must remain available, with provider-specific version/deletion protection still to be selected. Live deletions may survive in retained backups according to the final documented policy.

Perform monthly restore tests into an isolated environment: restore app+n8n databases and pgvector, restore the correct encryption key/secret bindings, verify object access, reconcile durable jobs after transient Redis loss, and run synthetic auth/ingestion/retrieval/SSE smoke checks. Never restore over production as a readiness test. Record timing, artifact identities, integrity and recovery gaps. See the Sprint S15 [disaster recovery runbook](disaster-recovery.md) for backup encryption, key escrow, isolated restore commands, and monthly drill evidence recording.

## Monitoring and incident behavior

Correlate request/job/trace IDs across browser/Next.js/n8n. Record safe stage timings, queue depth, resource/disk/DB health, provider errors, job retries and activation/security events. Redact passages, prompts, signed URLs and credentials. Minimize/prune n8n execution data.

OpenAI outage yields safe service error; OCR outage yields bounded retries then FAILED; worker loss requires retry/reconciliation; DB outage denies protected operations; VPS loss requires rebuilding versioned services, restoring secrets/data, validating private object access and smoke testing. Do not release an unvalidated answer to hide an outage.

Complete [verify-release](../.agents/skills/verify-release/SKILL.md), [testing](testing.md), and [security](security.md) evidence before launch. Record support, launch/rollback and feedback owners plus pilot adoption observations in [PLANS.md](../PLANS.md).
