# Database guide

S01 adds the application database, separate n8n database and the first Drizzle migration for `app.audit_events`. The other entities below describe planned capabilities. [Technical PRD, sections 3–9](<../AI SOP Assistant — Technical Product Req.md>)

## Ownership and entities

PostgreSQL/pgvector stores app data and search indexes; Drizzle owns application migrations. n8n operational persistence uses a separate database/schema with distinct credentials. Redis is transient orchestration infrastructure.

The local PostgreSQL bootstrap installs pgvector and assigns three identities. `sop_migrator` manages schema and the migration ledger inside `sop_app`. `sop_runtime` has application data privileges and can insert and read audit events. `sop_n8n` owns its separate operational database and is denied connections to `sop_app`. The bootstrap runs when initializing a fresh volume. Start with a prepared database before running `npm run db:migrate`, and use the migrator credential only for that command. [Bootstrap SQL](../infra/postgres/bootstrap.sql) · [First migration](../drizzle/0000_foundation.sql)

| Proposed entity | Intent / integrity requirements |
| --- | --- |
| Better Auth tables (`auth_*` illustrative) | Identity, credentials, sessions, verification, role mapping, active state; reconcile actual names with the supported Better Auth adapter |
| `sop_documents` | Title, type, original/preview object keys, immutable hash, uploader, lifecycle, current approved snapshot and reviewer/time |
| `sop_processing_jobs` | Document, pipeline version, stable identity, stage/state, attempts, safe error codes, timestamps |
| `sop_extraction_pages` | Original/normalized text, meaningful page/section/layout mapping, confidence when available |
| `sop_chunks` | Document/snapshot, section/page/order, original text, content type/hash, full-text data, embedding and model/version |
| `sop_verification_issues` | Page/region, severity, reason, resolution and reviewer; preserve the verification audit required by section 5 |
| `chat_conversations` | Owner and conversation metadata |
| `chat_messages` | Conversation, role/content, request identity, validation outcome and timestamps |
| `chat_message_sources` | Message/document/chunk references and section/page snapshots, with current availability resolved separately |
| `audit_events` | Actor/action/target/time/outcome and sanitized metadata |
| `evaluation_runs` | Dataset/configuration/model/workflow versions, results and timings |

Final types, foreign keys, indexes, constraints, and naming require implementation review. Do not treat this guide as a migration. Embedding dimensions must follow the actually configured, verified model; do not assume a dimension from a candidate name.

## Lifecycle and transactions

Lifecycle: `UPLOADED → PROCESSING → PENDING_VERIFICATION → ACTIVE`; processing failure yields `FAILED`; Admin rejection yields `REJECTED`; Admin deletion yields a `DELETED` tombstone followed by cleanup. Only ACTIVE is searchable. Reprocessing must renew verification and must not mutate an ACTIVE original in place; replacement is D6/P1.

Activation is a backend-owned transaction binding original SHA-256, successful job/pipeline snapshot, nonempty chunks, and explicit Admin verification. Reject stale approvals and mismatched snapshots. n8n's scoped role may work on extraction/chunk/job data but cannot alter authoritative approval/activation state.

Deletion commits loss of retrieval eligibility first, then schedules physical chunk/vector/object/preview cleanup. Keep a tombstone until reconciliation confirms cleanup. A late worker callback must not reactivate or repopulate a deleted document's eligible evidence.

Use a unique stable job key equivalent to `(document_id, sha256, pipeline_version)` and idempotent writes. Define retry/replay handling for final chat persistence so one request cannot create duplicate messages or sources. Establish precise implemented keys and transaction isolation through tests.

## Search and access

Both pgvector and PostgreSQL full-text branches join/enforce the same verified ACTIVE snapshot constraints inside their queries. A post-retrieval status filter is insufficient. Index document/state/verification fields and conversation ownership; add full-text indexes and vector indexing appropriate to measured scale. Provision extensions/search configuration through reviewed migrations/infrastructure.

Scope every user-owned conversation read/write to the authenticated owner. Staff document access is ACTIVE-only; Admin can inspect processing/rejected/failure states. Current account status and source eligibility must be checked outside historical snapshots too. A historical source reference does not grant current download access.

Tests must use disposable PostgreSQL with pgvector for migrations, query filtering, constraints, rollback/transaction behavior, source revocation, and duplicate/racing jobs. Mocks alone do not establish database correctness. See [testing](testing.md) and [deployment](deployment.md) for migration and recovery gates.
