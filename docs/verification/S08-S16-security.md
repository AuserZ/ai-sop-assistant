# S08–S16 independent security audit report

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Scope | Deferred independent security review across `S08`–`S16` (`D4`, `C1`–`C5`, `U1`–`U4`, `ADR 08/09/10/12/13/14/15/16/18/19/20/23`, PRD §§3–14 & 16) |
| Candidate / branch | `679c28cd2a74efe6fa60d3711d449a0db28a0676` on `codex/s16-deploy-rollback` |
| Verifier | Independent `security-expert` subagent (read-only audit; zero files edited) |
| Date / overall verdict | 27 November 2026 — **FAIL — fixes required before V01** (`0 Critical`, `0 High`, `3 Medium`, `4 Low`, `3 Informational`) |

## Executed read-only checks

| Check | Result | Notes |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Protected PRDs unchanged |
| `node scripts/verify-hardening.mjs` | **PASS** | `10` manifests checked, `0` violations |
| `node scripts/security-scan-artifacts.mjs` | **PASS** | `247` files scanned incl. `.next/static`, `0` findings |
| `npm.cmd audit --omit=dev --audit-level=high` | **PASS (exit 0)** | `0` high/critical prod vulns; 4 moderate dev-chain `esbuild` (`GHSA-67mh-4wv8-2f99`) via `drizzle-kit` remain open |
| DOM sink scan (`dangerouslySetInnerHTML`/`innerHTML`/`eval(`) | **PASS** | `0` hits in `src/` |
| Adversarial `validateReleaseManifest` check | **REPRODUCED `SEC-S16-01`** | Accepted injected `configDigests["../../outside.conf"]` and extra `workflows` path `"../../evil.json"` |

## Findings to close before V01

| ID | Severity | Location | Finding & minimal remediation |
| --- | --- | --- | --- |
| `SEC-S16-01` | **Medium** | `infra/deploy/release-manifest.mjs:195-233,533-575` | `validateReleaseManifest` checks required entries but allows extra `workflows`/`configDigests` keys including `..` path traversal, which `snapshotReleaseArtifacts`/`restoreReleaseArtifacts` copy. Enforce exact allowlist equality (`MANAGED_WORKFLOW_SPECS`, `TRACKED_CONFIG_FILES`) and strict `resolve(baseDir, relPath)` prefix confinement + negative unit tests. |
| `SEC-S15-01` | **Medium** | `infra/backup/compose.backup.yml:17-18,29-35`, `infra/backup/run-backup.mjs:416`, `infra/postgres/bootstrap.sql` | `backup-scheduler` runs on `database` + `edge` using superuser `sop_bootstrap` (`/run/secrets/postgres-admin`). Add read-only `sop_backup` role (`CONNECT` + `pg_read_all_data`, no write/DDL/superuser), mount `backup-db` secret in `compose.backup.yml`, keep `postgres-admin` for isolated restore only, and audit in `verify-hardening.mjs`. |
| `SEC-S12-01` | **Medium** | `src/server/auth/invitations.ts:35-53` | `SELECT ... FOR UPDATE` acquires no lock when 0 rows exist, allowing concurrent `POST /api/users/invite` calls for the same email to insert two live 24h invitation tokens. Acquire `pg_advisory_xact_lock(hashtextextended(email, 7480201))` before checking `auth_users`/`auth_invitations` + add concurrency DB test. |
| `SEC-S14-01` | **Low** | `next.config.ts:3-15` | Scope `connect-src` to `'self'` + configured storage origin (loopback only when `NODE_ENV !== "production"`) and evaluate nonce CSP for `script-src`. |
| `SEC-S16-02` | **Low** | `.github/workflows/deploy.yml:220-237,317-335` | Quote SSH remote positional args with `printf '%q'`, transfer `smoke-session.cookie` inside a single SSH session with `umask 077` + `EXIT` trap, and rotate/sign-out smoke session post-deploy. |
| `SEC-S14-02` | **Low** | `docker-compose.yml:88-100` | Add `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` tmpfs, bounded logging, and resource limits to `migrate` + audit in `verify-hardening.mjs`. |
| `SEC-S09-01` | **Low** | `src/server/retrieval/{rerank,rewrite}.ts`, `src/server/answers/{generator,judge}.ts` | Cap outbound AI provider `response.text()` reads (e.g., 256 KiB) before `JSON.parse`. |

## Verified security invariants & residual limits

- **0 Critical / 0 High findings across S08–S16:** Core invariants verified in code — irreversible PG `DELETED` tombstone & SigV4-only `DELETE` (S08), dual-branch SQL `ACTIVE`-only retrieval & no `"GPT-6 Luna"` / loopback SSRF / XML `\u003c` fencing / deterministic + independent judge fail-closed / backend-built citation links (S09–S10), DB `CHECK`/trigger enforcement & byte-level allowlisted SSE with live source/user recheck & pure-React `SafeMarkdown` (S11), Admin RBAC + self/last-Admin concurrency + instant session/SSE/60s-source revocation (S12–S13), recursive Pino scrubbing & Admin-only zero-leak `/api/health/ops` (S14), AES-256-GCM + AAD + bounded-KDF key escrow & isolated restore guards (S15), and SHA-pinned approval-gated `environment: production` workflow (S16).
- **Residual limits & PRD §16 open gates:** Live Docker/PG `test:db`, Playwright `test:browser`, n8n runtime redirect/recovery tests, live isolated DR drill, live non-prod VPS deploy/rollback rehearsal, Tier B live-model 50-question benchmark, and all PRD §16 external/policy gates in [PLANS.md](../../PLANS.md) remain required before **V01**.
