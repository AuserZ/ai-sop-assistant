# S14 QA verification report — operational monitoring and security hardening

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S14 — Operational monitoring and security hardening (`ADR 13`, `ADR 15`, PRD sections 12–14, Phase 4) |
| Candidate / branch | `867b61885097cc203647200eb44f2c2af21cde35` (tree `fc9602ab5a85c06828b7d2206bb0eb4d0fcd9f76`) on `codex/s14-monitoring-hardening` (base `b521f0304884b3d2add39a6d3fb828142a7dd86c`) |
| Owners / verifiers | Implementers: `principal-devops-engineer` (`Dockerfile`, `docker-compose.yml`, `infra/proxy/nginx.conf`, `.github/workflows/ci.yml`, `scripts/*`, `ops-hardening.test.ts`, `docs/operations.md`) + `principal-fullstack-engineer` (`pino@10.4.0`, `next.config.ts`, `src/server/observability/*`, `/api/health/{live,ready,ops}`, rate limits, service telemetry, adversarial & hardening tests, `docs/{security,api-contracts}.md`); QA Pass 1: `qa` |
| Versions / environment | Windows 11 host, Node v24+, Next.js `16.4.6` (`webpack`), `pino@10.4.0` (`0` new advisories); `test:db`, `test:browser`, hosted CI, and `security-expert` deferred per 23 Nov 2026 instruction |
| Date / overall result | 27 November 2026 — **Pass 1 PASS** (all 3 findings `Q-S14-1`..`Q-S14-3` verified closed; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, `test:browser`, hosted CI, and `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **Infrastructure hardening, CI scans & operator scripts (`Dockerfile`, `docker-compose.yml`, `infra/proxy/nginx.conf`, `.github/workflows/ci.yml`, `scripts/{verify-hardening,security-scan-artifacts,ops-monitor,load-benchmark}.mjs`, `docs/operations.md`, `tests/unit/ops-hardening.test.ts`):** Digest-pinned `node:24-bookworm-slim` in `Dockerfile`; Nginx `server_tokens off`, security headers + `proxy_hide_header` dedup; Compose `x-bounded-logging` (`json-file` 10m×3), `driver: none` preserved on `paddleocr`/`convert-worker`, resource limits on `postgres`/`app`, `read_only: true` + `/tmp` tmpfs + `cap_drop: [ALL]` on `app`; CI hardening, `npm audit --omit=dev --audit-level=high`, and post-build artifact/secret/passage leak scans; operator monitor aligned to `/api/health/ops` and bounded-concurrency benchmark script.
- **Redacted Pino telemetry, Admin ops health, rate limits & adversarial suites (`package.json`, `next.config.ts`, `src/server/observability/*`, `src/app/api/health/{live,ready,ops}/route.ts`, `src/server/auth/rate-limit.ts`, `src/server/{documents,verification}/http.ts`, `src/server/{ingestion,retrieval,answers,chat}/service.ts`, `tests/unit/{observability,security-adversarial}.test.ts`, `tests/integration/hardening.test.ts`, `docs/{security,api-contracts}.md`):** `pino@10.4.0` recursive key/value redaction + CRLF/PEM/secret scrubbing, `X-Request-Id` trace correlation across `/api/health/{live,ready,ops}`, bounded stage/OCR/provider ring-buffer metrics, Admin-only `GET /api/health/ops` (zero SOP text/PII/secrets; surfaces open PRD §16 policy gates), durable `60/60s` rate limits on document source/content/preview & ops health, defense-in-depth `next.config.ts` CSP/security headers, and adversarial + PG hardening suites.

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| Script syntax & repo hardening audit | `node --check scripts/*.mjs` + `node scripts/verify-hardening.mjs` + `docker compose -f docker-compose.yml -f infra/storage-fixture/compose.yml config --quiet` | **PASS** | Exit `0`, `violationCount: 0` across 6 manifests | Static manifest validation |
| ESLint & Typecheck | `npm.cmd run lint`, `npm.cmd run typecheck` | **PASS** | `eslint . --max-warnings 0` & `tsc --noEmit` exit `0` | Static only |
| Unit & adversarial suite | `npm.cmd test` | **PASS** | `28/28` files, `158/158` tests (`ops-hardening.test.ts` `15/15`, `observability.test.ts` `5/5`, `security-adversarial.test.ts` `8/8`, Tier A `50/50`) | Unit/synthetic layer only |
| Production build & post-build leak scan | `node ./node_modules/next/dist/bin/next build --webpack` + `node scripts/security-scan-artifacts.mjs` | **PASS** | All `/api/health/{live,ready,ops}` dynamic `ƒ`; `241` files scanned incl. `.next/static`, `findingCount: 0` | No live container boot |
| Operator & synthetic load CLIs | `node scripts/ops-monitor.mjs --local-only`, `node scripts/load-benchmark.mjs --mode=synthetic --concurrency=8 --requests=40` | **PASS** | `status: "ok"`, `alerts: []`; `40/40` succeeded, `errorRate: 0` | Synthetic local only; real VPS load open |
| Dependency audit | `npm.cmd audit --omit=dev --audit-level=high` | **PASS (0 high/crit)** | `0` new advisories from `pino@10.4.0`; 4 pre-existing moderate `drizzle-kit`→`esbuild` (`GHSA-67mh-4wv8-2f99`) dev-chain advisories transparently tracked | Full audit cleanup tracked for pre-V01 |
| PG `test:db`, Playwright `test:browser`, hosted CI & `security-expert` | `npm run test:db` (`hardening.test.ts`), `npm run test:browser`, GitHub Actions, deferred Security review | **NOT RUN (deferred)** | Deferred per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S14-1` | **Blocker** / Contract mismatch (`scripts/ops-monitor.mjs` ↔ `src/server/observability/{metrics,ops}.ts`) | `ops-monitor.mjs` read fictional keys (`queue.failedJobs`, `providers[k].ok`, `memory.heapRatio`) instead of `/api/health/ops`'s `OperationalHealthSnapshot`. Added `process.heapTotalBytes` in `metrics.ts`/`ops.ts`, aligned `ops-monitor.mjs` to `database.{ok,pgvectorOk}`, `queues.{workflowJobs.FAILED,staleLeases,deletionCleanupFailed}`, `metrics.providers[name]` fault counters, `heapUsedBytes/heapTotalBytes`, and `status === "degraded"`, and updated `ops-hardening.test.ts`. | **CLOSED** |
| `Q-S14-2` | **Blocker** / DB teardown (`tests/integration/hardening.test.ts:302-359`) | `afterAll` ran revoked `sop_runtime` `DELETE`/`UPDATE` on append-only/protected tables (`42501`/`23514`/`23503`) and wrong sign-in rate-limit key. Switched to `deleteDocument(adminAccount, ...)` + artifact/rate-limit cleanup (`sign-in-global`, `sign-in-email`). | **CLOSED** |
| `Q-S14-3` | **Minor** / Preview rate limit & `/api/health/live` header (`src/server/verification/http.ts`, `src/app/api/health/live/route.ts`) | Wired `authLimits.documentPreview` (`60/60s`) into `verification-preview`, emitted `X-Request-Id` on `/api/health/live`, and switched `health/*` route imports to relative paths for Vitest compatibility. | **CLOSED** |

## Residual limits & open gates

- Runtime Docker boot of `app` with `read_only: true`, live PostgreSQL `test:db` (also note `tests/integration/users.test.ts` `afterAll` for pre-V01 closure), Playwright `test:browser` under new CSP/headers, live n8n execution-storage pruning, and deferred `security-expert` review remain mandatory before marking S14 `VERIFIED` and entering V01.
- Unchanged PRD Section 16 open gates (retention, backup expiry, Admin MFA, 20 MB / 4 vCPU / 8 GB VPS assumptions, real-data approval) remain open in [PLANS.md](../../PLANS.md).
