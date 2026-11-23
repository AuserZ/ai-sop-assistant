# S07 independent QA report (Pass 1 — pre-push review)

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S07 — Searchable SOP library and authorized original access (`D1`, `D5`, `U4`; Phase 1) |
| Candidate / branch | Working tree on `codex/s07-library-access` (base S06 closure `c70d50c379aac476a1ab0a3acf9ed8aca53fc83e`) |
| Owners / verifiers | Implementer: `fullstack`; Security: [S07-security.md](S07-security.md); QA: [S07-qa.md](S07-qa.md) |
| Versions / environment | Windows PowerShell, Node `>=24`, `npm.cmd`, `ingestionPipelineVersion = document-ingestion-v1`, `sourceLinkTtlSeconds = 60` |
| Date / overall result | 23 November 2026 — **PASS (Pass 1 pre-push local review)**; hosted CI (`verify-db`, Playwright `test:browser`) pending push / Pass 2 closure |

## Implemented changes (concise)

- **Contracts & token signing (`src/server/documents/contracts.ts`, `src/server/db/schema.ts`):** Added `escapeIlikePattern`, keyset cursor encode/decode (`(createdAt, id)` microsecond UTC fidelity), `listDocumentsQueryInput`, `documentSourceQueryInput` (`disposition`, `page`, `section`), `documentSourceContentQueryInput`, HKDF-SHA256 key derivation (`ai-sop-assistant:document-source-link:v1`), and 60s HMAC-SHA256 session/document/hash-bound source tokens (`signDocumentSourceToken`, `verifyDocumentSourceToken`) plus RFC 5987 sanitized `formatContentDisposition`.
- **Service & HTTP routes (`src/server/documents/{service,http}.ts`, `src/app/api/documents/{route.ts,[id]/source/route.ts,[id]/source/content/route.ts}`):** Implemented `listDocuments` (Staff SQL `WHERE status = 'ACTIVE'` with `diagnostics: null`; Admin all lifecycle states with job/page/chunk/issue/preview diagnostics), `authorizeDocumentSource` (live account/session + status recheck, sanitized `document.source_authorized` audit event), and `readDocumentSourceContent` (constant-time HMAC verification, `410 SOURCE_LINK_EXPIRED`, `403 SOURCE_LINK_INVALID`/`FORBIDDEN`, live account/status/`sha256` recheck, 30s bounded storage read, and `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`).
- **UI & API docs (`src/components/documents/{library-panel.tsx,upload-panel.tsx,client.ts}`, `src/app/documents/page.tsx`, `docs/api-contracts.md`):** Added `LibraryPanel` under `List Document SOP` with title search, Clear/Refresh, keyset pagination, Admin diagnostics + `Review and verify <title>` action links, Staff `ACTIVE`-only view, `{ page, section }` URL context display, inline Open / attachment Download via signed links, `320px` stacked table reflow, and documented the 60s residual bearer/access window.
- **Automated tests (`tests/unit/library.test.ts`, `tests/integration/library.test.ts`, `tests/e2e/library.spec.ts`):** Added 7 unit tests, 3 PostgreSQL integration tests, and 1 end-to-end Playwright journey.

## S07 acceptance criteria mapping (`PLANS.md`)

| S07 acceptance item | Code & test mapping | Pass 1 QA verdict |
| --- | --- | --- |
| 1. Search/table metadata and original access work for Admin/Staff according to role and current account state (`D1`, `D5`, `U4`) | `src/server/documents/service.ts:358-704`, `src/server/documents/http.ts:58-126`, `src/components/documents/library-panel.tsx:61-462`; `tests/unit/library.test.ts:24-125`, `tests/integration/library.test.ts:315-524`, `tests/e2e/library.spec.ts:60-184` | **PASS (local static/unit; DB/E2E ready for CI)** — Staff SQL strictly filters `status = 'ACTIVE'` with `diagnostics: null`; Admin sees all 6 lifecycle states with diagnostics; original PDF and DOCX bytes match exact `sha256` (DOCX returns original `.docx`, not derivative preview PDF). |
| 2. Guessed IDs, non-ACTIVE sources, unauthorized previews, expired links and deactivated sessions fail safely (`D1`, `D5`, `U4`) | `src/server/documents/contracts.ts:309-360`, `src/server/documents/service.ts:546-704`, `src/server/documents/http.ts:72-126`; `tests/unit/library.test.ts:127-238`, `tests/integration/library.test.ts:526-852`, `tests/e2e/library.spec.ts:185-190` | **PASS (local static/unit; DB/E2E ready for CI)** — Guessed UUIDs and Staff non-ACTIVE IDs both return `404 NOT_FOUND` (zero existence oracle); Staff `/preview` on ACTIVE doc returns `403 FORBIDDEN`; expired tokens return `410 SOURCE_LINK_EXPIRED`; tampered/wrong-doc tokens return `403 SOURCE_LINK_INVALID`; cross-user token replay returns `403 FORBIDDEN`; deactivated users/expired sessions return `401 UNAUTHENTICATED`. |
| 3. Signed link issuance rechecks source status; test/document the residual bearer-access window until link expiry (`D5`, `U4`) | `src/server/documents/service.ts:560-676`, `docs/api-contracts.md:16-17,28-33`; `tests/integration/library.test.ts:654-756` | **PASS (local static/unit; DB ready for CI)** — Both `/source` issuance and `/source/content` delivery re-verify live user/session (`FOR SHARE`) and live `sop_documents` status/`sha256`; post-issuance transition to `REJECTED`, Admin-to-Staff demotion, or account deactivation revokes access immediately before bytes stream. Residual 60s window and in-flight stream boundary documented in `docs/api-contracts.md`. |
| 4. Browser tests cover search, open/download, keyboard operation and usable narrow-screen behavior; no fourth menu is added (`D1`, `D5`, `U4`) | `src/components/documents/{library-panel.tsx,upload-panel.tsx}`, `tests/e2e/library.spec.ts:60-204` | **PASS (code/selector audit; E2E ready for CI)** — Covers Admin search/diagnostics/review link, Staff keyboard search (`focus` outline check, `keyboard.type`, `Enter`), inline Open + attachment Download with SHA-256 & header checks, `320px` zero horizontal overflow, `>= 44px` (`min-h-11`) buttons, `<= 3` links (3-menu cap preserved), and zero selector regressions against `documents.spec.ts` / `verification.spec.ts`. |

## Executed checks

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | PASS | Both protected PRDs unchanged (`exit 0`) on base `c70d50c379aac476a1ab0a3acf9ed8aca53fc83e` | — |
| Static & unit | `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test` | PASS | `eslint . --max-warnings 0` (`exit 0`); `next typegen && tsc --noEmit` (`exit 0`); Vitest `16/16` files, `68/68` unit tests passed (`tests/unit/library.test.ts` `7/7` in `117ms`, 0 flakes) | — |
| DB & E2E CI-readiness audit | Static audit of `tests/integration/library.test.ts` & `tests/e2e/library.spec.ts` | PASS | Prefix-scoped queries (`S07-*`), explicit `1_000_000_000` quota override, no collision with `documents.test.ts` dynamic `before = await quota()` or `workflow_jobs` dispatchers; Playwright `test.setTimeout(210_000)` and distinct `aria-label="Review and verify ${item.title}"` preserve `documents.spec.ts` & `verification.spec.ts` | Local Docker pipe unavailable; live DB/Playwright runs in hosted CI |
| Hosted CI | Run `<pending>` (`foundation` / `paddleocr`) | NOT RUN | Pre-push Pass 1 checkpoint | Awaits push & Pass 2 closure verification |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & fix commit | Rerun verdict |
| --- | --- | --- | --- |
| — | None in Pass 1 pre-push QA review (`0` functional, test-isolation, or selector defects found) | — | Ready for push and hosted CI |

## Residual limits & closure

- Local Docker Desktop daemon is not used during Pass 1; disposable PostgreSQL integration (`npm run test:db`), Next.js standalone build (`npm run build`), and Playwright browser verification (`npm run test:browser`) are gated on hosted CI in Pass 2.
- Unchanged PRD section 16 external gates remain tracked in [PLANS.md](../../PLANS.md).
- **Pass 1 QA status:** `PASS (ready for push & hosted CI)` | **Final S07 status:** Pending Pass 2 post-CI closure.

---

# S07 independent QA report (Pass 2 — single post-CI closure pass)

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S07 — Searchable SOP library and authorized original access (`D1`, `D5`, `U4`; Phase 1) |
| Candidate / branch | `ae644f95ef1a155e047f0baabcd4af52f169e31d` (tree `264eff0116d6db120fadcb13173eea3b02a82615`) on `codex/s07-library-access` |
| Delta from `6a44efc` | 1 file (`tests/integration/library.test.ts`, `+26 / -1`) |
| Hosted CI evidence | Run [45149286306](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45149286306) on `ae644f95ef1a155e047f0baabcd4af52f169e31d` (`conclusion = success`: `foundation` `137606269872` **20/20** `success`, `changes` `137606270295` **5/5** `success`, `paddleocr` `137606327839` `skipped` after passing **9/9** on `6a44efc` run [45146557698](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45146557698) job `137597213921`) |
| Date / overall result | 23 November 2026 — **VERIFIED / PASS** (hosted CI run `45149286306`) |

## S07 acceptance criteria closure (`PLANS.md`)

| S07 acceptance item | Pass 2 closure status | Verified evidence at `ae644f95ef1a155e047f0baabcd4af52f169e31d` |
| --- | --- | --- |
| 1. Search/table metadata and original access work for Admin/Staff according to role and current account state (`D1`, `D5`, `U4`) | **PASS** | `tests/unit/library.test.ts` (`7/7` unit), `tests/integration/library.test.ts` (Staff `ACTIVE`-only SQL filter + `diagnostics: null`, Admin 6-state diagnostics, keyset pagination, `ILIKE` wildcard escaping, exact PDF/DOCX byte & `sha256` match), and `tests/e2e/library.spec.ts` passed in hosted CI run `45149286306` (`foundation` Steps 6, 13, 14 `success`). |
| 2. Guessed IDs, non-ACTIVE sources, unauthorized previews, expired links and deactivated sessions fail safely (`D1`, `D5`, `U4`) | **PASS** | Verified in unit, PostgreSQL integration (Step 13 `verify-db` `success`), and Playwright E2E (Step 14 `test:browser` `success`): guessed UUIDs & Staff non-ACTIVE IDs return identical `404 NOT_FOUND`; Staff `/preview` returns `403 FORBIDDEN`; expired tokens return `410 SOURCE_LINK_EXPIRED`; tampered/wrong-doc tokens return `403 SOURCE_LINK_INVALID`; cross-user token replay returns `403 FORBIDDEN`; deactivated accounts/revoked sessions return `401 UNAUTHENTICATED`. |
| 3. Signed link issuance rechecks source status; test/document the residual bearer-access window until link expiry (`D5`, `U4`) | **PASS** | `authorizeDocumentSource` and `readDocumentSourceContent` both re-verify live user/session (`FOR SHARE`) and live `sop_documents` status + `sha256`. Post-issuance transition to `REJECTED` (`404`), Admin-to-Staff demotion (`401` on trigger-revoked session + `404` on fresh `STAFF` session with pre-issued token), and deactivation (`401`) passed in Step 13 `verify-db`. Residual 60s TTL and in-flight stream boundary documented in `docs/api-contracts.md:28-33`. |
| 4. Browser tests cover search, open/download, keyboard operation and usable narrow-screen behavior; no fourth menu is added (`D1`, `D5`, `U4`) | **PASS** | Playwright `tests/e2e/library.spec.ts` + regression specs (`documents.spec.ts`, `verification.spec.ts`, `auth.spec.ts`, `jobs.spec.ts`) passed in hosted CI Step 14 (`137606269872`): keyboard search (`focus` outline, `Enter`), inline Open + attachment Download with SHA-256 & security header assertions, `320px` zero horizontal overflow, `>= 44px` (`min-h-11`) buttons, and `<= 3` links (3-menu cap preserved). |

## Executed checks (Pass 2)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | PASS | Both protected PRDs unchanged (`exit 0`) at `ae644f95ef1a155e047f0baabcd4af52f169e31d` | — |
| Fix diff inspection | `git diff 6a44efca7cf3e293b40238f1c6d8f279a11e430e..ae644f95ef1a155e047f0baabcd4af52f169e31d` | PASS | Strictly `tests/integration/library.test.ts` (`+26/-1`); 0 weakened assertions | — |
| Hosted CI (`foundation` + `changes`) | GitHub REST API `GET .../actions/runs/45149286306` & `/jobs` | PASS | `head_sha = ae644f95ef1a155e047f0baabcd4af52f169e31d`, `conclusion = success`: `foundation` `137606269872` (`20/20` steps `success`), `changes` `137606270295` (`5/5` steps `success`) | Unauthenticated `/logs` returned HTTP `403` |
| Hosted CI (`paddleocr`) | GitHub REST API `GET .../actions/runs/45146557698/jobs` | PASS | Job `137597213921` on `6a44efca7cf3e293b40238f1c6d8f279a11e430e` passed `9/9` steps (`skipped` on `45149286306` because no OCR/infra files changed in `6a44efc..ae644f9`) | Unauthenticated `/logs` returned HTTP `403` |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & fix commit | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S07-CI-1` | Test-expectation alignment (`tests/integration/library.test.ts`) | On `6a44efc` (run `45146557698`, `foundation` Step 13), `UPDATE app.auth_users SET role = 'STAFF'` fired `0001_authentication.sql` trigger `auth_users_revoke_sessions`, revoking `adminAccount`'s session (`401 UNAUTHENTICATED`) before reaching the `404 NOT_FOUND` status check. Fixed in `ae644f95ef1a155e047f0baabcd4af52f169e31d` (`+26/-1`) by asserting `401 UNAUTHENTICATED` on the revoked session, re-seeding a fresh `STAFF` session for the same `accountId` to assert `404 NOT_FOUND` on the `REJECTED` document, and deferring seeded `workflow_jobs.dispatchNextAt` by +60s. | **PASS** — Run `45149286306` `foundation` `20/20` steps `success` |

## Residual limits & closure

- Unauthenticated GitHub REST API log download (`GET /repos/AuserZ/ai-sop-assistant/actions/jobs/137606269872/logs`) returned HTTP `403`; run/job/step API metadata, exact `head_sha`, timestamps, and step conclusions were independently verified.
- Local Docker Desktop daemon was not used locally; full disposable PostgreSQL migrations/integration (`verify-db`), Next.js standalone build, n8n workflow runtime, and Playwright E2E checks passed in hosted CI run `45149286306`.
- Unchanged PRD section 16 open gates remain tracked in [PLANS.md](../../PLANS.md).
- **Final QA status:** `VERIFIED / PASS` at `ae644f95ef1a155e047f0baabcd4af52f169e31d` | **Next proposed sprint:** `S08` (SOP deletion and reliable unindexing; no production/real-SOP authorization).
