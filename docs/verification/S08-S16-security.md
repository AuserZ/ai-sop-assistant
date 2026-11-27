# S08–S16 independent security audit report

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Scope | Deferred independent security review across `S08`–`S16` (`D4`, `C1`–`C5`, `U1`–`U4`, `ADR 08/09/10/12/13/14/15/16/18/19/20/23`, PRD §§3–14 & 16) |
| Initial audit / branch | `679c28cd2a74efe6fa60d3711d449a0db28a0676` on `codex/s16-deploy-rollback` (**FAIL** — `3 Medium`, `4 Low`) |
| Closure re-review / branch | `codex/pre-v01-security-ci-closure` (re-review of remediation diff vs `c3754c7aa001d0062d797fa7e47c7f9c8eae3277`) |
| Verifier | Independent `security-expert` subagent (read-only audit & re-review; zero files edited) |
| Date / overall verdict | 27 November 2026 — **PASS (code/static/unit; 7/7 findings CLOSED, 0 new findings)** — runtime CI (`test:db`, `test:browser`, live DR drill) & PRD §16 external gates remain required before V01 |

## Executed read-only checks (re-review)

| Check | Result | Notes |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Protected PRDs unchanged |
| `node scripts/verify-hardening.mjs` | **PASS** | `10` manifests checked, `0` violations (now enforces `migrate` hardening & bans `postgres-admin`/`sop_bootstrap` in `compose.backup.yml`) |
| `node scripts/security-scan-artifacts.mjs` | **PASS** | `249` files scanned incl. `.next/static`, `0` findings |
| `npm.cmd audit --omit=dev --audit-level=high` | **PASS (exit 0)** | `0` high/critical prod vulns; 4 moderate dev-chain `esbuild` (`GHSA-67mh-4wv8-2f99`) via `drizzle-kit` remain open |
| DOM sink scan (`dangerouslySetInnerHTML`/`innerHTML`/`eval(`) | **PASS** | `0` hits in `src/` |
| Adversarial `SEC-S16-01` Node script (`6` traversal/allowlist vectors) | **PASS (`6/6` blocked)** | Rejected `configDigests["../../outside.conf"]`, extra keys, extra/mutated `workflows`, Windows/UNC/drive/NUL paths, and snapshot/restore traversal |
| `npm.cmd test` | **PASS (`30/30` files, `199/199` tests)** | Includes new `SEC-S16-01`, `SEC-S15-01`, `SEC-S14-01`, `SEC-S14-02`, `SEC-S09-01`, and `50/50` Tier A synthetic benchmark tests |

## Findings closure status (`7/7 CLOSED`)

| ID | Severity | Status | Location & verified remediation |
| --- | --- | --- | --- |
| `SEC-S16-01` | **Medium** | **CLOSED** | `infra/deploy/release-manifest.mjs:56-99,241-325,571-668`: Enforced exact allowlist equality (`MANAGED_WORKFLOW_SPECS`, `TRACKED_CONFIG_FILES`) and strict `resolveConfinedRepoPath` confinement across validation, collection, verification, snapshot, and restore + negative unit tests (`tests/unit/deploy-rollback.test.ts:134-206`). |
| `SEC-S15-01` | **Medium** | **CLOSED** | `infra/postgres/bootstrap.sql`, `infra/postgres/init-databases.sh`, `scripts/local-secrets.mjs`, `docker-compose.yml`, `infra/backup/{compose.backup.yml,run-backup.mjs,drill.mjs}`, `scripts/verify-hardening.mjs`: Added least-privilege read-only `sop_backup` role (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`, `CONNECT` on `sop_app`/`sop_n8n`, `pg_read_all_data`); switched `backup-scheduler` to `backup-db` secret (banning `postgres-admin`/`sop_bootstrap` in `verify-hardening.mjs`), keeping `postgres-admin` for isolated restore only + DB/unit privilege tests (`tests/integration/database.test.ts:135-185`, `tests/unit/backup-recovery.test.ts`, `tests/unit/ops-hardening.test.ts`). |
| `SEC-S12-01` | **Medium** | **CLOSED** | `src/server/auth/invitations.ts:31-51`: Acquired `SELECT pg_advisory_xact_lock(hashtextextended(${parsed.data.email}, 7480201))` inside `issueInvitation` transaction before querying `auth_users`/`auth_invitations` + mixed-case parallel DB concurrency test (`tests/integration/users.test.ts:313-361`). |
| `SEC-S14-01` | **Low** | **CLOSED** | `next.config.ts:3-64`, `Dockerfile:9-10`, `infra/storage-fixture/compose.yml:3-5`: Scoped production `connect-src` to `'self'` + validated storage origin (narrow default `'self' https://*.r2.cloudflarestorage.com`, zero wildcard `https:`, zero prod loopback); optional `ARG R2_ENDPOINT=""` in `Dockerfile` (loopback fixture arg strictly in `infra/storage-fixture/compose.yml`) + unit tests (`tests/unit/security-adversarial.test.ts:665-732`). |
| `SEC-S16-02` | **Low** | **CLOSED** | `.github/workflows/deploy.yml:214-274,330-380`: Quoted remote SSH args with `printf '%q'`, replaced SCP with single-SSH base64-over-stdin into `umask 077` `mktemp` file, and added `EXIT` trap revoking smoke session via `POST /api/auth/sign-out` + deleting temp cookie/bundle. |
| `SEC-S14-02` | **Low** | **CLOSED** | `docker-compose.yml:88-111`, `scripts/verify-hardening.mjs:14,18,28,247-255`: Hardened `migrate` (`read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` tmpfs, bounded logging, resource caps) + hardening audit tests (`tests/unit/ops-hardening.test.ts:78-103`). |
| `SEC-S09-01` | **Low** | **CLOSED** | `src/server/ai/bounded-response.ts`, `src/server/retrieval/{rerank,rewrite}.ts`, `src/server/answers/{generator,judge}.ts`: Enforced `256 KiB` `Content-Length` + streaming `getReader()` byte cap with immediate cancellation before UTF-8 decode/`JSON.parse`, failing closed as safe `502`/`service_error` (never `No SOP found`) + unit tests (`tests/unit/{retrieval,answers}.test.ts`). |

- **Informational (non-blocking):** `src/server/ingestion/embeddings.ts:107` (S05 ingestion batch embeddings) still uses `response.json()`; optional post-P0 hardening can wrap it with a batch-appropriate bounded reader.

## Verified security invariants & residual limits

- **0 Critical / 0 High findings across S08–S16:** Core invariants verified in code — irreversible PG `DELETED` tombstone & SigV4-only `DELETE` (S08), dual-branch SQL `ACTIVE`-only retrieval & no `"GPT-6 Luna"` / loopback SSRF / XML `\u003c` fencing / deterministic + independent judge fail-closed / backend-built citation links (S09–S10), DB `CHECK`/trigger enforcement & byte-level allowlisted SSE with live source/user recheck & pure-React `SafeMarkdown` (S11), Admin RBAC + self/last-Admin concurrency + instant session/SSE/60s-source revocation (S12–S13), recursive Pino scrubbing & Admin-only zero-leak `/api/health/ops` (S14), AES-256-GCM + AAD + bounded-KDF key escrow & isolated restore guards (S15), and SHA-pinned approval-gated `environment: production` workflow (S16).
- **Residual limits & PRD §16 open gates:** Live Docker/PG `test:db`, Playwright `test:browser`, n8n runtime redirect/recovery tests, live isolated DR drill, live non-prod VPS deploy/rollback rehearsal, Tier B live-model 50-question benchmark, and all PRD §16 external/policy gates in [PLANS.md](../../PLANS.md) remain required before **V01**.
