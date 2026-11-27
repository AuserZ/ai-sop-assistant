# S16 QA verification report — controlled deployment and rollback

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S16 — Controlled deployment and rollback (`ADR 09`, `ADR 14`, PRD sections 14 & 16, Phase 4 exit) |
| Candidate / branch | `a5009fcb2496624c2d71e9396b04b1aceeef740b` (tree `a94f04506b81a24448c8c66b8ab67f2ba4502c06`) on `codex/s16-deploy-rollback` (base `a85b5937647b44f68632ffee77b894a107b3ac95`) |
| Owners / verifiers | Implementer: `principal-devops-engineer`; QA Pass 1: `qa` (with final `Q-S16-8` fix verified in `a5009fc`) |
| Versions / environment | Windows 11 host, Node 24, Docker Compose CLI, Vitest 5.1.1; live GHCR publish, GitHub `staging`/`production` environment approval & live non-prod VPS rehearsal deferred until authorized staging/CI pre-V01 closure |
| Date / overall result | 27 November 2026 — **Pass 1 PASS** (all 8 findings `Q-S16-1`..`Q-S16-8` closed; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until hosted CI, live non-prod rehearsal, and `security-expert` review pass before V01) |

## Implemented changes reviewed (concise)

- **Immutable release manifest & Compose overlay (`infra/deploy/{release-manifest.mjs,compose.release.yml}`):** `schemaVersion: 1` manifest enforcing 40-hex `gitSha`, strict `@sha256:[a-f0-9]{64}` across all 5 images (`app`, `migrate`, `paddleocr`, `convertWorker`, `backupScheduler`), Drizzle migration/workflow/config SHA-256 verification (`verifyRepoArtifactsMatchManifest`), per-release snapshot/restore (`snapshotReleaseArtifacts`/`restoreReleaseArtifacts`), rollback compatibility matrix (`image_rollback_safe` vs `schema_recovery_required`), and `compose.release.yml` pinning all 5 services (`build: !reset null`, `pull_policy: always`, all 5 `SOP_*` local/probe flags `"0"`).
- **Controlled deploy, rollback, smoke checks & approval-gated workflow (`infra/deploy/{smoke-check,deploy,rollback}.mjs`, `.github/workflows/{deploy,ci}.yml`, `scripts/verify-hardening.mjs`, `docs/deployment.md`, `tests/unit/deploy-rollback.test.ts`):**
  - `smoke-check.mjs`: active `AbortController` timeout across fetch + JSON + SSE stream body reads, `redirect: "error"`, unauthenticated `401` + external `/api/internal/` `404` + security headers + checked-answer SSE progress/draft-leak verifier, fail-closed without session cookie unless explicit `--health-only`.
  - `deploy.mjs` & `rollback.mjs`: production approval guard (`DEPLOY_APPROVAL_REQUIRED`), `.deploy-state/in-progress-release.json` pre-migration tracking so failed breaking/additive deploys block blind rollback (`ROLLBACK_REQUIRES_DATA_RECOVERY`), cold-start dependency ordering (`postgres` -> `migrate`, `redis`+`n8n-main` -> `n8n-bootstrap`), `--no-deps` rollback without re-running `migrate`, and target workflow bundle restore before `n8n-bootstrap`.
  - `.github/workflows/deploy.yml`: `workflow_dispatch`-only, `permissions: {}`, 40-hex pinned actions, `env:`-only input passing (zero inline `${{ inputs.* }}` in `run:`), positional SSH `bash -euo pipefail -s --` args, complete `release-bundle.tar.gz` packaging (incl. Redis & Postgres init scripts) re-extracted before post-rollback re-deploy, `verify-candidate` -> `build-immutable-artifacts` -> `deploy-nonprod` -> `deploy-production` (`environment: production` manual approval gate).

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| Syntax, Compose & hardening | Per-file `node --check infra/deploy/*.mjs`, both `docker compose` release & backup+release `--profile backup config --quiet`, `node scripts/verify-hardening.mjs`, `node scripts/security-scan-artifacts.mjs` | **PASS** | Exit `0`; `10` manifests audited (`0` violations); `245` files scanned (`0` findings); `backup-scheduler` pinned `@sha256` with zero `build:` | Static manifest/bundle checks |
| Lint, Typecheck & Unit suite | `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test` | **PASS** | `0` lint warnings, `0` TS errors, `30/30` files / `192/192` unit tests (`deploy-rollback.test.ts` `15/15`, Tier A `50/50`) | Unit/mocked runner layer only |
| Live GHCR, GitHub `production` gate, live non-prod VPS rehearsal, hosted CI & `security-expert` | Hosted workflow + staging VPS deploy/rollback + deferred Security review | **NOT RUN (deferred / open gate)** | Deferred per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S16-1` | **Blocker** / Post-failed-migration rollback guard (`deploy.mjs`, `rollback.mjs`) | Failed migration-bearing `v2` left no state file so `rollback.mjs` compared `v1` to `v1`. Added `.deploy-state/in-progress-release.json` pre-migration + unit test proving `ROLLBACK_REQUIRES_DATA_RECOVERY`. | **CLOSED** |
| `Q-S16-2` | **Blocker** / GitHub Actions injection & SSH quoting (`.github/workflows/deploy.yml`) | Removed inline `${{ inputs.* }}` from `run:` blocks (passed via `env:`) and switched SSH to positional `bash -euo pipefail -s -- ... <<'REMOTE_EOF'`. | **CLOSED** |
| `Q-S16-3`..`Q-S16-7` | **4 Major, 1 Minor** (`compose.release.yml`, `release-manifest.mjs`, `smoke-check.mjs`, `deploy.mjs`, `rollback.mjs`, `verify-hardening.mjs`) | Pinned `backup-scheduler` in `compose.release.yml`; added workflow/config bundle packaging + digest verification + rollback snapshot restore; kept `AbortController` active across SSE body reads + `redirect: "error"`; fixed cold-start dependency order & `--no-deps` rollback; required `SMOKE_SESSION_COOKIE` preflight + stricter `auditDeployWorkflow` + CLI `try/catch`. | **CLOSED** |
| `Q-S16-8` | **Major** / Post-rollback re-deploy bundle re-extract (`.github/workflows/deploy.yml`) | Kept `release-bundle.tar.gz` until `EXIT` trap, re-extracted before post-rollback re-deploy, and included `infra/n8n/redis-{entrypoint,health}.sh` + `infra/postgres/{init-databases.sh,bootstrap.sql}` in bundle. | **CLOSED** (`a5009fc`) |

## Residual limits & open gates

- Live GHCR image publish, GitHub `staging`/`production` environment reviewer configuration, live non-prod VPS deploy/rollback rehearsal, online resolution of the 5 newly pinned Action SHAs, hosted CI, `test:db`, `test:browser`, live DR drill, `security-expert` review, and PRD §16 owner/policy/provider gates remain open in [PLANS.md](../../PLANS.md).
