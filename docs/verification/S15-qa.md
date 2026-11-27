# S15 QA verification report — encrypted backups and verified disaster recovery

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S15 — Encrypted backups and verified disaster recovery (`ADR 16`, PRD section 13, Phase 4) |
| Candidate / branch | `83a8cdf17af247140502747e4598ddbafd3f748f` (tree `1b10465ccf6a8e2bd96a29d31498faf53b83b360`) on `codex/s15-backups-recovery` (base `de2b8c1fa9353d1e660b8d801accd816a7185dcf`) |
| Owners / verifiers | Implementer: `principal-devops-engineer`; QA Pass 1: `qa` |
| Versions / environment | Windows 11 host, Node 24, pinned `infra/backup/Dockerfile` (`node:24-bookworm-slim` + `pgvector:0.8.3-pg18-trixie`); hosted CI, live Docker build/drill, real PG `test:db`, Playwright `test:browser`, live R2, and `security-expert` deferred until pre-V01 closure |
| Date / overall result | 27 November 2026 — **Pass 1 PASS** (all 8 findings `Q-S15-1`..`Q-S15-8` verified closed; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until live isolated Docker/R2 drill, hosted CI, and `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **Backup crypto, escrow & private offsite storage (`infra/backup/{crypto,storage,escrow-keys}.mjs`):** Pure `node:crypto` AES-256-GCM authenticated encryption (12B random IV, 16B tag, AAD `{ database, backupId, plaintextSha256 }`), `scryptSync` (power-of-2 & `maxmem`-checked) key escrow with clean-host `--verify` and `0o600` `--recover`, private S3/R2 client enforcing HTTPS default + `HeadObject` byte verification + zero public ACLs.
- **6-hour backup scheduler, isolated restore & drill (`infra/backup/{run-backup,schedule,run-restore,drill}.mjs`, `infra/backup/{Dockerfile,compose.backup.yml}`, `scripts/{local-secrets,verify-hardening}.mjs`, `.github/workflows/ci.yml`, `docs/{disaster-recovery,deployment}.md`, `tests/unit/backup-recovery.test.ts`):** Logical `pg_dump` / `pg_restore` preserving role ownership and least-privilege `GRANT`/`REVOKE` boundaries, redacted critical failure alerting with SSRF-guarded webhook, `backup-scheduler` mounting non-secret `n8n-encryption-key-fingerprint` only (no raw `n8n-encryption-key`), real `app.workflow_jobs`/`chat_turn_artifacts` reconciliation SQL, fail-closed `drill.mjs` smoke checks & `teardownSucceeded` check, and `scripts/verify-hardening.mjs` auditing `infra/backup/Dockerfile` + `compose.backup.yml`.

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| Syntax, Compose & hardening | `node --check infra/backup/*.mjs`, `docker compose -f docker-compose.yml -f infra/backup/compose.backup.yml --profile backup config --quiet`, `node scripts/verify-hardening.mjs`, `node scripts/security-scan-artifacts.mjs` | **PASS** | Exit `0`; `0` hardening violations (8 files incl. backup Dockerfile/Compose); `0` artifact leak findings (`243` files) | Static manifest/bundle checks |
| Local secrets & static/unit suites | `node --test infra/n8n/local-secrets.test.mjs`, `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test` | **PASS** | `1/1` secrets test, `0` lint warnings, `0` TS errors, `29/29` files / `177/177` unit tests (`backup-recovery.test.ts` `19/19`, Tier A `50/50`) | Unit/mocked S3 & `pg_dump`/`pg_restore` layer only |
| Live Docker PG 18 drill, live R2, `test:db`, `test:browser`, hosted CI & `security-expert` | Live isolated restore drill, GitHub Actions, deferred Security review | **NOT RUN (deferred / open gate)** | Deferred per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S15-1` | **Blocker** / Reconciliation SQL (`run-restore.mjs`) | Replaced 4 fictional column names with real `app.workflow_jobs` columns (`state`, `attempt_number`, `attempt_id`, `dispatch_nonce`, `attempt_deadline`, etc.) + `app.chat_turn_artifacts` pruning + schema-alignment unit test. | **CLOSED** |
| `Q-S15-2` | **Blocker** / Backup image & secrets (`infra/backup/{Dockerfile,compose.backup.yml}`, `local-secrets.mjs`, `run-backup.mjs`) | Added pinned PG 18 + Node 24 `infra/backup/Dockerfile`, wired S3 credential secrets, and replaced raw `n8n-encryption-key` mount with non-secret `n8n-encryption-key-fingerprint`. | **CLOSED** |
| `Q-S15-3` | **Blocker** / Ownership & grants (`run-backup.mjs`, `run-restore.mjs`) | Removed `--no-owner --no-privileges` so `sop_migrator`/`sop_runtime`/`sop_n8n` ownership and least-privilege `GRANT`/`REVOKE`s survive restore. | **CLOSED** |
| `Q-S15-4` | **Blocker** / Drill smoke honesty (`drill.mjs`) | Replaced fabricated `/api/health/ready` passes with real fail-closed `401` checks and `{ ok: false, executed: false }` unless a real synthetic functional runner is supplied. | **CLOSED** |
| `Q-S15-5`..`Q-S15-8` | **3 Major, 1 Minor** (`escrow-keys.mjs`, `run-restore.mjs`, `drill.mjs`, `crypto.mjs`, `storage.mjs`, `run-backup.mjs`, `verify-hardening.mjs`) | Clean-host `--verify` & `0o600` `--recover`; 64 KiB stdout/stderr draining, `backupId`/`objectKey` prefix binding & sanitized CLI stderr; in-network restore & `teardownSucceeded`; `scryptSync` power-of-2/`maxmem`, storage HTTPS re-check, webhook private-IP SSRF guard, and backup hardening audit. | **CLOSED** |

## Residual limits & pre-V01 follow-ups

- Pre-V01 live Docker drill follow-ups (Minor): verify `node --version && pg_dump --version` ABI in `infra/backup/Dockerfile` during live Docker build; pass recovered `n8n-encryption-key` bind mount and `DRILL_PROXY_PORT` override when running a live isolated drill against `docker-compose.yml`.
- Live offsite R2 backup bucket/credentials, retention/immutability policy (30-day retention is proposed, not approved), R2 object recovery policy, live drill timings (provisional 6h RPO / 4–8h RTO), hosted CI, and deferred `security-expert` review remain open in [PLANS.md](../../PLANS.md).
