# Disaster Recovery and Encrypted Backup Runbook

Authority: [Technical PRD](../AI%20SOP%20Assistant%20%E2%80%94%20Technical%20Product%20Req.md) sections 13 and 16 (`ADR 16`). This runbook documents Sprint S15 encrypted logical backups, `N8N_ENCRYPTION_KEY` offsite escrow, isolated restore procedures, monthly restore drills, and explicit provisional policy caveats.

## 1. Provisional Policy & Open Gate Caveats (PRD Sections 13 & 16)

The following baseline values are **provisional planning / policy assumptions** and are **not guaranteed SLAs or approved company policy** until formally reviewed, approved, and validated in live drills:

- **Retention (30 days):** Proposed policy only; requires Security/Product approval alongside chat/audit deletion rules.
- **Recovery point (up to 6 hours potential database loss):** Assumes scheduled 6-hour logical dumps succeed without outage; not guaranteed.
- **Recovery time (4–8 hours):** Provisional estimate; must be measured and recorded during real isolated restore drills.
- **Offsite provider & key custody:** Cloudflare R2 was selected as object storage, while final backup bucket jurisdiction, retention/immutability rules, R2 object versioning/deletion protection, and protected offsite key custody remain open Section 16 gates.

## 2. Backup Architecture & 6-Hour Encrypted Cadence

`infra/backup/compose.backup.yml` builds from `infra/backup/Dockerfile` (immutable `@sha256`-pinned PostgreSQL 18 `pgvector` client tools + pinned Node 24 binary, zero `apt-get`, non-root `USER 1000:1000`) and runs the hardened `backup-scheduler` service (`profiles: [backup]`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` tmpfs, bounded `json-file` logs, explicit memory/CPU/PID limits, zero published host ports) on a default **6-hour (`21600` seconds)** cadence (`infra/backup/schedule.mjs`).

Each backup cycle (`infra/backup/run-backup.mjs`) executes:

1. **Logical PostgreSQL dumps** (`pg_dump --format=custom --lock-wait-timeout=30000`) for both:
   - `sop_app` (application tables, Drizzle metadata, `pgvector` extension/embeddings, role ownership, and all S01–S08 least-privilege `GRANT`/`REVOKE` permissions — intentionally preserving owners and privileges without `--no-owner`/`--no-privileges`)
   - `sop_n8n` (n8n workflows, encrypted credential records, and `sop_n8n` ownership)
2. **Authenticated encryption (`infra/backup/crypto.mjs`):**
   - Pure `node:crypto` AES-256-GCM with a random 12-byte IV, 16-byte authentication tag, binary format version `1` (`SOPB`), and AAD binding `{ database, backupId, plaintextSha256 }`.
   - Any tampered ciphertext, swapped database artifact, truncated file, or wrong key fails closed before `pg_restore`.
3. **Redacted manifest (`manifest.json`):**
   - Records `backupId`, `createdAt`, `migrationHead`, SHA-256 `workflowVersions`, `n8nKeyFingerprint` (SHA-256 only — never raw keys), `backupKeyFingerprint`, storage bucket/prefix/region, and artifact plaintext/ciphertext SHA-256 digests and byte sizes.
   - `backup-scheduler` mounts only the non-secret `n8n-encryption-key-fingerprint` file, never the raw `n8n-encryption-key` or `backup-escrow-passphrase`.
4. **Private offsite S3/R2 upload & verification (`infra/backup/storage.mjs`):**
   - Uploads `sop_app.dump.enc`, `sop_n8n.dump.enc`, and `manifest.json` using `@aws-sdk/client-s3` with `forcePathStyle: true`, HTTPS-only endpoints by default (loopback HTTP allowed only when `SOP_LOCAL_STORAGE_FIXTURE_ENABLED=1`), and zero public ACLs.
   - Verifies every uploaded object via post-upload `HeadObject` byte-length check (`BACKUP_VERIFY_FAILED` on mismatch).
5. **Actionable safe failure alerting:**
   - Any failure in `config`, `dump`, `encrypt`, `upload`, or `verify` emits a redacted structured JSON alert (`severity: "critical"`, `code: BACKUP_CONFIG_INVALID | BACKUP_DUMP_FAILED | BACKUP_ENCRYPTION_FAILED | BACKUP_UPLOAD_FAILED | BACKUP_VERIFY_FAILED`) to stderr and posts it to `BACKUP_ALERT_WEBHOOK_URL` (HTTPS-only, private/loopback IP literals blocked outside fixture mode, `redirect: "error"`, 10s timeout) with all credentials, SQL, and raw keys scrubbed.

### Generating local backup secret files

```bash
node scripts/local-secrets.mjs --with-backup
docker compose -f docker-compose.yml -f infra/backup/compose.backup.yml --profile backup config --quiet
```

`backup-scheduler` mounts only `backup-encryption-key`, `postgres-admin`, `n8n-encryption-key-fingerprint`, `backup-s3-access-key-id`, and `backup-s3-secret-access-key`. Raw `n8n-encryption-key` and `backup-escrow-passphrase` remain unmounted from the scheduled backup container.

## 3. `N8N_ENCRYPTION_KEY` Escrow, Verification & Recovery

Restoring `sop_n8n` without the exact original `N8N_ENCRYPTION_KEY` renders stored n8n credentials unusable. Use `infra/backup/escrow-keys.mjs` to create, verify, and recover an encrypted escrow bundle using `scrypt` (`N=32768, r=8, p=1`, random 16-byte salt) + AES-256-GCM with AAD-bound non-secret metadata (`migrationHead`, `workflowVersions`, bucket/prefix, `backupKeyFingerprint`, and logical secret names):

```bash
# 1. Create encrypted escrow bundle (outputs fingerprints only; never raw keys)
node infra/backup/escrow-keys.mjs --create \
  --n8n-key-file .local-secrets/n8n-encryption-key \
  --passphrase-file .local-secrets/backup-escrow-passphrase \
  --backup-key-file .local-secrets/backup-encryption-key \
  --bucket "$BACKUP_S3_BUCKET" \
  --prefix "backups/postgres" \
  --output /secure-offsite-staging/n8n-key-escrow.json

# 2. Verify escrow bundle on a clean host (no local key file required)
node infra/backup/escrow-keys.mjs --verify \
  --input /secure-offsite-staging/n8n-key-escrow.json \
  --passphrase-file /secure-custody/backup-escrow-passphrase

# 3. Recover N8N_ENCRYPTION_KEY on a clean recovery host (writes 0600 file; never prints raw key)
node infra/backup/escrow-keys.mjs --recover \
  --input /secure-offsite-staging/n8n-key-escrow.json \
  --passphrase-file /secure-custody/backup-escrow-passphrase \
  --output-key-file .local-secrets/n8n-encryption-key
```

Store the encrypted escrow bundle separately from the primary VPS and separately from the escrow passphrase (e.g., separate offline secret manager / hardware-backed custody approved by Security).

## 4. Original & Preview Object Recovery Policy

- Original SOP PDFs/DOCX files and generated PDF previews reside in the private Cloudflare R2 bucket (zero public access, short-lived server-issued signed URLs only).
- Active SOP originals must remain available while documents are `ACTIVE`.
- **Live deletion vs. retained backups:** Live Admin deletion (`D4`, Sprint S08) commits an immediate `DELETED` tombstone and queues physical R2 cleanup. Historical database backups taken prior to deletion may still reference deleted metadata until those backups expire under the approved retention policy. Restoring an older backup therefore requires reconciling against any post-backup deletion audit trail before serving users.
- **Open gate:** R2 object versioning, soft-delete/retention lock, and cross-region replication policy remain open PRD Section 16 decisions and must be finalized before production launch.

## 5. Step-by-Step Isolated Restore Procedure

**Non-negotiable safety rule:** Never overwrite production to test recovery. `infra/backup/run-restore.mjs` refuses to run unless `--isolated-target` is explicitly set and blocks `NODE_ENV=production` or production project/host targets with `RESTORE_PRODUCTION_GUARD_BLOCKED`.

1. **Provision isolated host or disposable Compose project** using pinned images and the same `migrationHead` / `n8n/*.json` workflow versions recorded in `manifest.json`.
2. **Recover `N8N_ENCRYPTION_KEY` from encrypted escrow** (`escrow-keys.mjs --recover`) and place all required secret bindings in the isolated `.local-secrets/` directory (host permissions `0700`, files `0444`).
3. **Start isolated PostgreSQL & Redis** in a dedicated non-production project (`-p ai-sop-dr-drill-<date>`). PostgreSQL stays private on the internal `database` network (never published to host ports).
4. **Run isolated restore inside the disposable project's internal `database` network** using the `backup-scheduler` image (`pg_restore` + `psql` 18 + Node 24) targeting `postgres:5432`:

```bash
docker compose -p ai-sop-dr-drill-20261127 \
  -f docker-compose.yml -f infra/backup/compose.backup.yml \
  --profile backup run --rm --no-deps -T \
  -e RESTORE_TARGET_PROJECT=ai-sop-dr-drill-20261127 \
  -e N8N_ENCRYPTION_KEY_FILE=/run/secrets/n8n-encryption-key-restore \
  -v "$PWD/.local-secrets/n8n-encryption-key:/run/secrets/n8n-encryption-key-restore:ro" \
  backup-scheduler \
  node infra/backup/run-restore.mjs \
  --isolated-target \
  --target-project ai-sop-dr-drill-20261127 \
  --target-host postgres \
  --backup-id backup-20261127T000000Z-a1b2c3d4
```

What `run-restore.mjs` verifies automatically:
- Downloads `manifest.json`, `sop_app.dump.enc`, and `sop_n8n.dump.enc` (or reads `--local-dir` for offline checks), verifying `manifest.backupId` matches `--backup-id` and all artifact object keys stay inside the requested backup prefix.
- Verifies restored `N8N_ENCRYPTION_KEY` matches `manifest.n8nKeyFingerprint` (fails closed with `RESTORE_N8N_KEY_MISMATCH`).
- Verifies ciphertext SHA-256 digests, decrypts both archives with AES-256-GCM + AAD, and verifies plaintext SHA-256 digests.
- Ensures `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;` in `sop_app`.
- Restores `sop_app` and `sop_n8n` via `pg_restore --clean --if-exists --exit-on-error` (preserving `sop_migrator`/`sop_runtime`/`sop_n8n` role ownership and least-privilege `GRANT`/`REVOKE` rules).
- Verifies `pgvector` operator execution (`<->`), required `app.*` tables, and `sop_n8n` credential/workflow tables.
- Reconciles transient Redis queue loss against the real `app.workflow_jobs` schema: marks `state = 'RUNNING' AND attempt_number >= 3` as `FAILED` (`RESTORE_ATTEMPTS_EXHAUSTED`), resets `state = 'RUNNING' AND attempt_number < 3` back to `QUEUED` with a rotated `attempt_id`, incremented `attempt_number`, fresh `dispatch_nonce`, cleared lease columns (`dispatch_lease_token`, `dispatch_lease_until`, `run_lease_until`), and fresh `attempt_deadline`, and prunes orphaned `app.chat_turn_artifacts` rows.
- Reports exact stage timings (`downloadMs`, `decryptMs`, `restoreAppMs`, `restoreN8nMs`, `verifyMs`, `totalMs`) and explicit `recoveryGaps`.

5. **Start isolated `n8n-main`, `n8n-worker`, `app`, and `proxy`** (using a dedicated non-colliding `DRILL_PROXY_PORT`, default `3099`, never `3000`), verify `/api/health/ready`, confirm unauthenticated protected routes return `401`, confirm private object storage access, and run synthetic functional smoke checks (auth, upload, verification, ACTIVE-only retrieval, and chat SSE stream safety).

## 6. Monthly Restore Drill Cadence & Evidence Recording

Run a monthly isolated restore drill using `infra/backup/drill.mjs` with a disposable `ai-sop-dr-drill-*` Compose project name and non-colliding `DRILL_PROXY_PORT`:

```bash
DRILL_PROXY_PORT=3099 node infra/backup/drill.mjs \
  --project ai-sop-dr-drill-20261127 \
  --backup-id backup-20261127T000000Z-a1b2c3d4 \
  --sample-object-key synthetic/probe.pdf \
  --base-url http://127.0.0.1:3099
```

`drill.mjs` provisions the isolated stack, runs in-network `run-restore.mjs --isolated-target` against `postgres:5432`, reconciles transient Redis/durable jobs, checks private object access, runs unauthenticated fail-closed probes plus the supplied synthetic functional smoke suite (`auth`, `upload`, `verification`, `activeOnlyRetrieval`, `chatSseStreamSafety` — failing closed if any suite is not executed), tears down the disposable `ai-sop-dr-drill-*` project (failing `ok: false` if teardown fails), and emits a redacted JSON receipt.

### Monthly Drill Evidence Table

Record every executed drill below (or in `docs/verification/`), without copying any credentials, signed URLs, or SOP text:

| Drill date (UTC) | Drill ID & project | Backup ID & manifest timestamp | Migration head | Stage timings (`download`/`decrypt`/`restoreApp`/`restoreN8n`/`verify`/`total` ms) | `pgvector` & `N8N_ENCRYPTION_KEY` verified | Private object access & synthetic smoke checks | Teardown succeeded | Observed data-loss / recovery gaps | Operator |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _Pending live offsite R2 & drill schedule_ | — | — | — | — | — | — | — | Provisional targets unmeasured until live isolated drill runs | — |
