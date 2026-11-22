# S04 private uploads

Implementation contract for D2, D1 upload status and ADR03, subordinate to the protected PRDs. S03 is VERIFIED for source0396cf6 and hosted run44852222243; closure93a71e8 is the S04 base. The user's continuation and Cloudflare R2 selection carry development into this sprint. Timebox is unset.

Status on22 November2026: implementation and local unit/database/browser/recovery checks pass, including live synthetic R2 acceptance and exact original bytes. Final UI gate passes. Exact hosted CI and independent final closure remain required. [Recorded evidence](verification/S04.md)

## Bounded outcome

An active Admin can submit one synthetic PDF/DOCX through short-lived backend-issued direct upload authorization. Backend finalization verifies the actual object, seals immutable accepted bytes and commits one durable ingestion intent. The original stays private and UPLOADED; its job explicitly waits for the processor implemented in S05. This sprint performs no extraction, OCR, embedding, verification, activation, retrieval or chat work.

Cloudflare R2 is selected. Bucket, endpoint and credential files are supplied privately. The user confirmed Public Development URL disabled and Custom Domains empty. Live synthetic browser uploads, private original-byte reads, tampering, conditional races/replay, expiry and CORS checks pass. The optional disabled public-domain HTTP probe was unobserved because TLS reported an expired certificate; TLS was not bypassed. Jurisdiction/location, company privacy approval and object recovery policy remain open. Local fixture evidence remains distinct from live-provider evidence.

## Ownership

| Owner | Files / responsibility |
| --- | --- |
| Fullstack | `src/server/documents/**`, document API routes, schema/new0003 migration and metadata, narrow probe-kind guards in jobs, document/job unit and DB tests, root package/lockfiles |
| DevOps | `infra/storage-fixture/**` including isolated package/lockfile, verification Compose overlay, fixture secret generation and CI/runtime integration; provider secrets/config mounts after interface agreement |
| Lead | This contract, plan/team guides, document upload UI, browser tests and integration/closure |
| Security / QA | Independent design/source/evidence review; only assigned report files may be edited |

Workers share the workspace and preserve concurrent edits. Fullstack owns root package files; DevOps keeps fixture dependencies isolated and coordinates any base Compose/env changes. Do not run database fixtures while the dispatcher app can reconcile their jobs.

## UI direction before generation

Use the user's existing styling choice: ENERGY1 / RHYTHM1 / MOTION1, matching S02. Keep the white/system-font interface, left-aligned labels, black primary upload action and underlined secondary links. A single form and its actual status are the screen's content; no cards, invented statistics, assets or extra product navigation. Use compact phone spacing, wrapping filenames, visible focus and at least44px controls. Record the lead's item-by-item antislop delivery gate only after real browser verification.

## Browser/backend contract

| Operation | Behavior |
| --- | --- |
| `POST /api/documents/upload-init` | Fresh active Admin/session, canonical Origin/Host and bounded strict JSON; durable limits. Input `{requestKey,title,fileName,mimeType,sizeBytes,sha256}`. Atomically reserve quota and allocate immutable owner/input/object identities. Duplicate matching request returns the same document; conflicting input fails409. Return a120s presigned PUT for only the staging key, with exact signed type/length/create-only headers. |
| `POST /api/documents/{id}/process` | Owner-bound current Admin/session. Fenced finalization lease, two concurrent finalizers per process, bounded storage timeout/read size. Read staging bytes, check actual format/MIME, exact size and server SHA256. Seal those exact validated bytes under the server-only final key using conditional create. Recheck current authorization before committing one document, one ingestion intent and audit event. |
| `GET /api/documents/{id}` | Owner-bound current Admin/session; safe upload/status DTO. No signed download link, file bytes, arbitrary worker strings or other uploader's metadata. |

Upload states distinguish awaiting upload, finalizing, safe failure and accepted UPLOADED. The product describes accepted work as queued for processing; it must not claim extraction or activation. Existing styling and accessible pending/error/retry states apply during development. No extra product menu or Staff library is added.

The presigner must explicitly force Content-Type, Content-Length and If-None-Match into its actual SignedHeaders; the SDK's default excludes Content-Type. The browser receives only the settable type/create-only headers and sends a File body, which supplies network Content-Length automatically. One overall abort/read/storage deadline must fit inside the fenced lease. Final commit requires the current unexpired fence and fresh Admin/session locks; stale finalizers cannot clear replacement leases. ZIP selected-metadata streams have actual inflated-byte caps and no entity/network resolution.

Current bounded verification settings: overall storage deadline30s, fenced lease45s, browser metadata request35s and proxy read35s. Direct PUT remains120s and upload acceptance intent600s. An actual20MB read took11.220s and a separate write10.699s, exceeding the previous15s combined budget; the updated real-provider20MB acceptance passed. These measurements do not establish a production latency guarantee or approved file policy.

The initial test limit is20,000,000 bytes (20MB), preserving its status as a tested assumption rather than approved production policy. Quota is explicit configuration, with atomic reservations of twice declared size for staging plus original. No production company quota is invented. Staging/reservations remain accounted for until a reviewed cleanup policy exists: expiry or one negative HEAD cannot prove an earlier in-flight PUT will never commit. No automatic retention or recovery policy is introduced.

## Immutable accepted bytes

Presigned URLs remain reusable until expiry. A staging key must never be the accepted original. A bounded staging GET followed by actual-size/SHA256/type validation and conditional PUT of those same bytes avoids an ETag-as-SHA assumption and source-copy race. The browser never receives write authorization for the final key. A staging replay cannot alter the accepted original.

After an ambiguous final write/DB failure, retry the same identity. Reread and verify an existing final object before accepting it; never blindly overwrite it, duplicate jobs or delete a potentially accepted original. PDF signature and bounded OOXML ZIP/container checks establish accepted upload format, not safe content or successful extraction. Reject unsafe/encrypted/macro archives without unbounded decompression.

## Reuse of durable jobs

Extend `workflow_jobs` with immutable `document_ingestion` document/hash/pipeline identity and a unique `(document_id,sha256,pipeline_version)`. Use explicit `WAITING_FOR_PIPELINE` with no active deadline, deliveries or running lease. No attempt has executed. S05 must explicitly start the implemented pipeline.

Both probe dispatch and reconciliation filter supported probe kind. Probe callbacks and probe SSE reject ingestion IDs. The current signed probe graph is not an ingestion processor; this sprint creates no ingestion workflow or synthetic processing success for documents. Preserve every S03 regression and authorization boundary.

## Storage configuration and fixture limits

Use lazy server-only `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID_FILE`, `R2_SECRET_ACCESS_KEY_FILE` and required `DOCUMENT_UPLOAD_QUOTA_BYTES`. Builds need no keys. Real endpoints require the correct HTTPS R2 account/jurisdiction host; region `auto` is signing configuration, not a residency approval. `SOP_LOCAL_STORAGE_FIXTURE_ENABLED=1` permits only the controlled loopback fixture endpoint, with synthetic credential files. Actual supplied bucket/endpoint are in ignored local configuration; the100,000,000-byte reservation quota is an explicit synthetic trial value. [R2 setup](r2-setup.md)

The proposed verification-only Wrangler sidecar uses the official local SigV4 S3 endpoint, path-style addressing and the app's network namespace so app and browser share the same loopback URL. Default Compose retains the sole proxy3000 binding; the test overlay alone exposes loopback8787. A narrow forwarder excludes unsigned public/explorer routes, suppresses signed queries/Authorization logs and uses bounded private tmpfs. Root real secrets/Resend files are never mounted into it.

Pinned local Miniflare implements configured-key SigV4 HMAC verification, signed-header binding and expiry, so actual local rejection tests establish only those measured fixture behaviors. Its region/skew/repeated-header behavior differs, destination CopyObject conditions and flexible SHA checksums are unsupported, and CORS is permissive within loopback. Conditional PutObject is the common primitive. Separate actual R2 signature/header/expiry, conditional-write and configured browser CORS evidence is recorded in the sprint report. Every CI Compose call inherits the same overlay; DB tests still precede dispatcher startup. Recheck fixture namespace readiness after an app recreation.

## Required verification

- Admin success and Staff/anonymous/demoted/revoked/foreign-owner denial; origin/body/rate bounds.
- Concurrent matching/conflicting initiation, finalization and quota reservations; no duplicate accepted document/job.
- Requested/actual type, signature/container, size/hash and quota failures; missing/incomplete/wrong object; bounded reads, timeout and archive limits.
- Presigned key/header/expiry tampering; replay cannot alter final bytes; conditional writes/races and ambiguous prior write/DB failure recover safely.
- Parked ingestion jobs remain untouched by active probe dispatch/reconciliation/callback/SSE.
- Actual browser direct PUT/finalization and accessible UI states with S02/S03 regression checks; fixture limits recorded honestly.
- Live private R2 synthetic upload/check/conditional/CORS evidence after configuration, protected secrets/logs, full lint/types/build/unit/DB/browser/CI and independent scoped security/QA.

Only after these mandatory checks pass may S04 become VERIFIED. S05 and production/company-data processing remain gated.

## Primary provider references

- [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/) and [authentication](https://developers.cloudflare.com/r2/api/tokens/): bucket-scoped object credentials and jurisdiction-correct endpoint.
- [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/) and [consistency](https://developers.cloudflare.com/r2/reference/consistency/): bearer authorization, atomic creation and in-flight request limits.
- [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [local development](https://developers.cloudflare.com/r2/local-development/) and [CORS](https://developers.cloudflare.com/r2/buckets/cors/): supported behavior and separate real-provider evidence.
