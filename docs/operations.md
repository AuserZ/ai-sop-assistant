# Operations and Hardening Runbook

Authority: [Technical PRD](../AI%20SOP%20Assistant%20%E2%80%94%20Technical%20Product%20Req.md) sections 12–14 and 16 (`ADR 13`, `ADR 15`). This runbook documents implemented Sprint S14 operational controls, verification tooling, fault-to-recovery procedures, and open policy/assumption gates. It does not invent company retention/MFA policies or claim regulatory/CPOB compliance certification.

## 1. Runtime Isolation & Container Hardening

- **Immutable image digests:** `Dockerfile` pins both `dependencies` and `runtime` stages to an immutable `node:24-bookworm-slim@sha256:...` digest, runs as non-root `USER node`, disables Next.js telemetry (`NEXT_TELEMETRY_DISABLED=1`), and copies `pdf.worker.min.mjs` into `./public/pdf.worker.min.mjs`.
- **Private single-VPS topology (`docker-compose.yml`):**
  - Internal-only Docker networks (`internal: true`): `database`, `workflow`, `ocr`, `conversion`.
  - Only `proxy` publishes a host port, bound to loopback (`127.0.0.1:3000:8080`). PostgreSQL, Redis, n8n main/worker, PaddleOCR, and LibreOffice conversion services publish no host ports.
  - `app`, `proxy`, `redis`, `n8n-main`, `n8n-worker`, `paddleocr`, and `convert-worker` run with `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and explicit `mem_limit`, `cpus`, and `pids_limit` envelopes.
  - Bounded container log rotation (`x-bounded-logging`: `json-file`, `max-size: 10m`, `max-file: 3`) applies to `postgres`, `app`, `proxy`, `redis`, `n8n-main`, and `n8n-worker`.
  - `paddleocr` and `convert-worker` strictly keep `logging: driver: none` so untrusted OCR/DOCX text is never persisted into Docker logs.
- **Reverse proxy hardening (`infra/proxy/nginx.conf`):**
  - Disables Nginx version disclosure (`server_tokens off;`).
  - Blocks external access to internal callback routes (`location /api/internal/ { return 404; }`).
  - Enforces `client_max_body_size 16k;`, `proxy_buffering off;`, `proxy_cache off;`, `proxy_read_timeout 35s;`, `send_timeout 15s;`, `proxy_ignore_client_abort off;`, and canonical `Host` forwarding.
  - Emits canonical defense-in-depth headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`) while deduplicating upstream copies with `proxy_hide_header`.

## 2. Structured Logging & Health Endpoints

- **Structured Pino logs:** Application server logs use redacted structured JSON carrying request, job, and trace correlation IDs plus stage timings, token/usage counts, OCR page counts, and error codes. Raw SOP passages, full prompts, cookies, JWTs, API keys, and presigned URLs are strictly redacted and never logged.
- **Health endpoints:**
  - `GET /api/health/live` — unauthenticated process liveness check (`{ status: "ok" }`, `Cache-Control: no-store`).
  - `GET /api/health/ready` — unauthenticated PostgreSQL + `pgvector` readiness check (`200 { status: "ready" }` or `503 { status: "unavailable" }`).
  - `GET /api/health/ops` — **Admin-only** operational telemetry endpoint reporting database connectivity, workflow job/queue status, provider health indicators, and process memory metrics without exposing SOP text or secrets.

## 3. Operator Scripts & CI Security Gates

### Hardening audit (`scripts/verify-hardening.mjs`)

Validates `Dockerfile` digest pinning and non-root runtime, `docker-compose.yml` internal networks, loopback-only port publication, n8n execution pruning/no-save flags, OCR/conversion `driver: none`, bounded logging, resource limits, `infra/proxy/nginx.conf` security directives, and `n8n/*.json` workflow safety settings. Exits non-zero on any violation.

```bash
node scripts/verify-hardening.mjs
```

### Artifact & bundle leak scan (`scripts/security-scan-artifacts.mjs`)

Scans `.next/static` (when built), `n8n/*.json`, `docs/verification/*.md`, and `src/**` for PEM private keys, `sk-proj-` / `sk-live-` / `re_` / `AKIA` keys, presigned `X-Amz-Signature=` query strings, hardcoded PostgreSQL URL credentials, and raw synthetic SOP benchmark passages. Findings report file, rule ID, and line number only — matched values are never echoed.

```bash
node scripts/security-scan-artifacts.mjs
```

### Operator health monitor (`scripts/ops-monitor.mjs`)

Queries `/api/health/live`, `/api/health/ready`, optional Admin `/api/health/ops` (via `SOP_OPS_COOKIE` environment variable; never printed), and local host disk/memory usage (`fs.statfsSync`, `process.memoryUsage()`). Outputs strictly redacted JSON with status `ok` (exit `0`), `degraded` (exit `2`), or `critical` (exit `1`).

```bash
# Local host disk/memory check only
node scripts/ops-monitor.mjs --local-only

# Against loopback stack with custom thresholds
node scripts/ops-monitor.mjs \
  --base-url=http://127.0.0.1:3000 \
  --disk-free-min=15 \
  --heap-ratio-max=0.85 \
  --failed-jobs-max=5
```

### Bounded-concurrency load benchmark (`scripts/load-benchmark.mjs`)

Measures throughput, error rate, RSS delta, and latency percentiles (`p50`/`p95`/`p99`) under bounded concurrency. Defaults to offline `--mode=synthetic`; supports `--mode=http --base-url=http://127.0.0.1:3000 --path=/api/health/live` for local or authorized staging probes.

```bash
node scripts/load-benchmark.mjs --mode=synthetic --concurrency=8 --requests=40
node scripts/load-benchmark.mjs --mode=http --base-url=http://127.0.0.1:3000 --path=/api/health/ready --concurrency=8 --requests=40
```

### n8n execution storage & pruning verification (`infra/n8n/inspect-execution-storage.mjs`)

n8n runs with `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, `EXECUTIONS_DATA_SAVE_ON_ERROR=none`, `EXECUTIONS_DATA_SAVE_ON_PROGRESS=false`, `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false`, `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=1`, and `EXECUTIONS_DATA_PRUNE_MAX_COUNT=100`. Every versioned workflow in `n8n/*.json` repeats `saveDataErrorExecution: "none"` and `saveDataSuccessExecution: "none"`.

Operators verify zero leaked credentials or retained execution payloads against a running synthetic Compose project with count-only inspection:

```bash
SOP_WORKFLOW_TEST_PROJECT=ai-sop-assistant node infra/n8n/inspect-execution-storage.mjs
```

### CI dependency & security gates (`.github/workflows/ci.yml`)

The `foundation` job enforces:
1. Syntax validation (`node --check`) of all infrastructure and operational scripts.
2. `node scripts/verify-hardening.mjs`.
3. `npm audit --omit=dev --audit-level=high` (fails on high/critical production advisories while keeping transparent visibility on the 4 pre-existing moderate `drizzle-kit` → `esbuild` dev-chain advisories tracked in `PLANS.md`).
4. `node scripts/security-scan-artifacts.mjs` immediately after `npm run build` so compiled `.next/static` client bundles are scanned alongside workflow exports and source files.

## 4. Fault-to-Recovery Mapping (PRD Section 13)

| Fault scenario | Expected safe system behavior | Operator detection & recovery action |
| --- | --- | --- |
| **OpenAI outage / rate-limit / timeout** | Chat emits safe service error (`failed` SSE event), never releases unvalidated drafts and never masquerades as `No SOP found for this question`. Ingestion embedding retries within bounds then marks `FAILED`. | Check `/api/health/ops` and `ops-monitor.mjs` `PROVIDER_FAULT` alert; inspect redacted Pino error codes + OpenAI billing/status; retry affected `FAILED` ingestion jobs after provider recovers. |
| **PaddleOCR / LibreOffice conversion failure** | Bounded retries then `FAILED` status with restricted Admin diagnostics; document never becomes `ACTIVE`; `driver: none` prevents raw text leakage. | Check `docker compose ps` health for `paddleocr` / `convert-worker` and `/api/health/ops` failed-job count; restart unhealthy worker container if wedged; inspect synthetic reproduction before retrying. |
| **n8n worker crash or Redis interruption** | `n8n-main` and `n8n-worker` restart automatically (`restart: unless-stopped`); durable PostgreSQL job state fences abandoned attempts and retries within `maxAttempts`. | Check `docker compose ps`, `ops-monitor.mjs`, and `scripts/verify-workflow-runtime.mjs` in non-production drills; confirm Redis healthcheck passes and stuck attempts reconcile cleanly. |
| **PostgreSQL / pgvector outage** | `/api/health/ready` returns `503`; all protected reads, writes, chat, and source resolutions fail closed. | `ops-monitor.mjs` exits `1` (`READINESS_FAILED` / `DATABASE_UNAVAILABLE`); inspect PostgreSQL container health, disk space (`DISK_SPACE_CRITICAL`), and volume integrity; restore from encrypted offsite backup (Sprint S15) if corrupted. |
| **Low disk space or memory pressure** | Container `mem_limit`/`pids_limit` and `x-bounded-logging` prevent unbounded log exhaustion; high pressure degrades readiness/latency. | Act on `DISK_SPACE_LOW` (<15%) / `DISK_SPACE_CRITICAL` (<5%) and `HEAP_USAGE_HIGH` (>=0.85); verify Docker log rotation, prune stale unused images, inspect `n8n` execution table pruning, and resize VPS if sustained. |
| **Full VPS loss** | No partial unverified state exposed; offsite encrypted dumps + escrowed `N8N_ENCRYPTION_KEY` + private R2 originals preserve recovery path. | Provision clean host, deploy pinned version-controlled Compose and immutable images, restore secrets/escrowed `N8N_ENCRYPTION_KEY` and PostgreSQL dumps (Sprint S15), verify R2 access, and run full health + synthetic smoke checks. |

## 5. Open Policy & Assumption Gates (PRD Section 16)

The following items remain **OPEN** and are intentionally not silently decided by S14 tooling:

- **Capacity assumptions:** The 20 MB file upload limit, page limits, 4 vCPU / 8 GB RAM VPS sizing, and worker/OCR concurrency values are planning assumptions only and must be validated with real VPS load benchmarking before launch.
- **Retention & security policies:** Proposed 90-day audit retention, 30-day backup expiry, chat/audit deletion rules, Admin MFA requirement, account recovery flow, and Resend production sender domain require explicit Security/Product approval.
- **Provider & data-processing approvals:** Company approval for confidential SOP processing (privacy, residency, no-model-training controls), OpenAI billing/model catalog entitlements, production OCR provider acceptance, and R2 jurisdiction/object recovery policy remain mandatory pre-launch gates.
- **Known dev-chain advisories:** 4 moderate `drizzle-kit` → `esbuild` (`GHSA-67mh-4wv8-2f99`) dev-dependency advisories remain visible in `npm audit` output; never report full audit as clean until resolved.
