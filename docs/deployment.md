# Deployment and recovery guide

S01 adds local Compose services for Next.js, PostgreSQL/pgvector and Drizzle migrations, plus an isolated LibreOffice helper. Production deployment and backup jobs belong to later sprints. [Technical PRD, sections 3, 12–16](<../AI SOP Assistant — Technical Product Req.md>)

## Source repository

The user selected [AuserZ/ai-sop-assistant](https://github.com/AuserZ/ai-sop-assistant) on 19 November 2026. Its default branch is `master`; preserve the existing history and Apache license. Prepare the initial source candidate on `codex/s01-foundation`, retaining the protected PRDs byte-for-byte and excluding local credentials, dependencies and build outputs through `.gitignore`.

The existing `.github/workflows/ci.yml` runs project checks on pushes/pull requests. Record the exact commit and hosted run result in the S01 report before closing that sprint. Connecting or publishing source does not authorize production deployment or resolve PRD provider/policy gates.

Current connection check: public reads succeed, but native Git has no cached login and the authenticated connector's blob write returned HTTP 403 `Resource not accessible by integration`. The reviewed source is committed locally; no source was uploaded. Authenticate local Git or grant the GitHub connection appropriate access to this repository before publishing the review branch. ChatGPT plugin approval-mode controls do not grant GitHub-side repository/OAuth permissions.

## Local runtime

Use Docker Compose with a Linux container engine. Generate credentials for the disposable local databases and start the app.

```powershell
npm run dev:secrets
docker compose up --build --wait app
Invoke-RestMethod http://127.0.0.1:3000/api/health/ready
docker compose --profile verify run --rm --build verify-db
docker compose --profile conversion run --rm --build convert
```

Open `http://127.0.0.1:3000`. The readiness endpoint returns HTTP 503 when PostgreSQL or pgvector is unavailable. Compose waits for the Drizzle migration before starting the app. The conversion command checks that LibreOffice starts in the isolated helper.

Use `docker compose down` to stop local services and retain the database volume. Keep the generated credentials in `.local-secrets/` for that volume. On Unix, keep the directory mode at `0700`. On Windows, restrict its host ACL to your account and the Docker engine as appropriate. Compose mounts individual files into authorized Linux containers, where the service users must be able to read them. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)

Only the app binds a host port, on loopback. PostgreSQL stays on the internal network. The conversion helper runs without networking or secrets. S03 will add n8n and Redis services. [Local Compose configuration](../docker-compose.yml)

## Planned environment

One VPS runs the TLS reverse proxy, Next.js application, PostgreSQL/pgvector, n8n main/workers, Redis and an isolated LibreOffice conversion helper. Managed private S3-compatible storage, OpenAI, Google Document AI, Resend and encrypted offsite backups are external. Protect internal ports/networks and limit worker/conversion CPU, RAM, time and outbound access.

The initial 4-vCPU/8-GB VPS estimate, file/page caps, and worker/OCR concurrency are assumptions requiring load tests. S3 versus R2, regions, object recovery, exact models and OCR project limits remain open. Local synthetic scaffolding must not silently set production policy or submit company documents externally.

The local Compose definition starts the application and database and provisions separate n8n persistence. S03 adds n8n main, workers and Redis. Keep secret values out of Git, restrict host access and preserve `N8N_ENCRYPTION_KEY` consistently across workers and recovery. Production restart, backup and deployment policies are verified in Phase 4.

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

Perform monthly restore tests into an isolated environment: restore app+n8n databases and pgvector, restore the correct encryption key/secret bindings, verify object access, reconcile durable jobs after transient Redis loss, and run synthetic auth/ingestion/retrieval/SSE smoke checks. Never restore over production as a readiness test. Record timing, artifact identities, integrity and recovery gaps.

## Monitoring and incident behavior

Correlate request/job/trace IDs across browser/Next.js/n8n. Record safe stage timings, queue depth, resource/disk/DB health, provider errors, job retries and activation/security events. Redact passages, prompts, signed URLs and credentials. Minimize/prune n8n execution data.

OpenAI outage yields safe service error; OCR outage yields bounded retries then FAILED; worker loss requires retry/reconciliation; DB outage denies protected operations; VPS loss requires rebuilding versioned services, restoring secrets/data, validating private object access and smoke testing. Do not release an unvalidated answer to hide an outage.

Complete [verify-release](../.agents/skills/verify-release/SKILL.md), [testing](testing.md), and [security](security.md) evidence before launch. Record support, launch/rollback and feedback owners plus pilot adoption observations in [PLANS.md](../PLANS.md).
