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

## Release path

1. Identify the immutable candidate code/image, reviewed Drizzle migrations, n8n JSON/pipeline versions, configuration and environment.
2. Pass implemented lint/type/unit/integration/Playwright/workflow-contract checks plus relevant security/dependency/image checks. Use synthetic fixtures.
3. Pass the versioned 50-question benchmark for the candidate: ≥43 correct, 100% valid supporting citations, and 0 invented steps. Record latency and rubric evidence.
4. Verify private networking/storage, current provider entitlement, no-training/privacy/data-processing approval, retention/recovery policies, pilot owners and remaining section 16 gates.
5. Build immutable images in GitHub Actions and retain the previous known version. Production deployment requires the manual approval gate and reviewed migration/rollback plan.
6. Deploy pinned images/workflows and reviewed migrations through the approved process; run health and functional smoke checks, including authenticated access, ACTIVE filtering and checked-answer-only SSE.

No commands here authorize deployment. The release skill assesses evidence; it does not publish, run production migrations, or skip required approval. Define exact executable deploy/rollback commands after the infrastructure exists and has been reviewed.

Rollback must distinguish image rollback from schema/data recovery. Do not assume restoring an old image reverses a migration. Preserve candidate/configuration identifiers and define stop/rollback triggers and responsible owners before launch.

## Backups and restore

Confirmed baseline: encrypted PostgreSQL logical dumps every six hours for app and n8n persistence, copied to private offsite S3/R2 with restricted credentials. Securely escrow the original n8n encryption key and required configuration separately. Validate dump success, encryption, upload and alerting; a scheduled task alone is insufficient.

Thirty-day retention is proposed policy, not approved. Up to six hours potential database loss assumes successful backups; recovery in four to eight hours is provisional. Active originals must remain available, with provider-specific version/deletion protection still to be selected. Live deletions may survive in retained backups according to the final documented policy.

Perform monthly restore tests into an isolated environment: restore app+n8n databases and pgvector, restore the correct encryption key/secret bindings, verify object access, reconcile durable jobs after transient Redis loss, and run synthetic auth/ingestion/retrieval/SSE smoke checks. Never restore over production as a readiness test. Record timing, artifact identities, integrity and recovery gaps. See the Sprint S15 [disaster recovery runbook](disaster-recovery.md) for backup encryption, key escrow, isolated restore commands, and monthly drill evidence recording.

## Monitoring and incident behavior

Correlate request/job/trace IDs across browser/Next.js/n8n. Record safe stage timings, queue depth, resource/disk/DB health, provider errors, job retries and activation/security events. Redact passages, prompts, signed URLs and credentials. Minimize/prune n8n execution data.

OpenAI outage yields safe service error; OCR outage yields bounded retries then FAILED; worker loss requires retry/reconciliation; DB outage denies protected operations; VPS loss requires rebuilding versioned services, restoring secrets/data, validating private object access and smoke testing. Do not release an unvalidated answer to hide an outage.

Complete [verify-release](../.agents/skills/verify-release/SKILL.md), [testing](testing.md), and [security](security.md) evidence before launch. Record support, launch/rollback and feedback owners plus pilot adoption observations in [PLANS.md](../PLANS.md).
