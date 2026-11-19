# S02 independent QA

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint | S02 invitation-only authentication and authorization |
| Requirements | U2/U4; U3 current-access enforcement; ADR 06/07 |
| Dependency | S01 recorded VERIFIED; later user-management screens remain S12 |
| Implementers | Principal fullstack engineer, principal DevOps engineer, project-manager lead |
| Independent verifier | QA agent `/root/s02_qa` |
| Source | Uncommitted working copy on `codex/s02-authentication`, based on `b16e2a6ffaf39cd58a14392bc56d760925b906a6` |
| Review date | 19 November 2026; source inventory captured at 14:04:11 UTC |
| Environment | Windows PowerShell; local Node/npm; synthetic fixtures only |
| First runtime candidate supplied by lead | App image `sha256:c8565e8cf30a624e6de5ab0b8ea1ce25ad1f4d628b32c40cb0b64489d2950648`; QA-01 failed |
| Fixed runtime candidate supplied by lead | App image `sha256:91dc4b50558388079db46b1e1e788c97a8d340587e3554aecf70a4751ffc2114`; independent HTTP rerun on 19 November 2026 at approximately 14:13 UTC |
| Scope result | PASS for assigned static/unit review and limited HTTP rerun; QA-01 fixed and independently rechecked |
| Sprint acceptance | BLOCKED: live sender-domain/delivery evidence unavailable; hosted CI remains pending |

This report records QA's own commands separately from lead/engineer results. It does not close the sprint or authorize S03, production provisioning, deployment or provider calls.

QA read `AGENTS.md`, shared/QA role guides, the complete protected technical PRD, all four original product-PDF pages, `PLANS.md`, testing guidance and the verification template. Repository inspection found actual package scripts, Drizzle migrations, Compose services, auth APIs and tests; n8n workflow execution remains later scope.

The first reviewed inventory contained 36 authentication-related source/test/configuration files. Its SHA-256 aggregate was `191b5fed512461522223dbdf4c612db72cadd5cf3911d094994c123561600a2a`, calculated as SHA-256 of JSON-encoded, path-sorted `{path,sha256}` entries using raw file bytes. It included the package files, Compose/CI/Playwright configuration, migration 0001, auth/API/UI/email/database modules, synthetic Admin script and authentication fixtures/tests. It excludes local credentials and generated outputs. UI/browser fixes were coordinated during review; that earlier aggregate is a historical review snapshot, not a final product candidate.

Backend references inspected during the first pass, before the request-authority fix. Files changed by that fix need their newer candidate identity; this table preserves the initial evidence:

| File | SHA-256 |
| --- | --- |
| `src/server/auth/invitations.ts` | `83016ca6149316877ada5cff6c040ad2e5b55fd1bd4dc22b81a056811f6a85e4` |
| `src/server/auth/accounts.ts` | `adfdcf9af78fa095f21c20b9665cafcbf73437b2c94ee9742615eedf80567055` |
| `src/server/auth/handler.ts` | `07eec2d79fd779b5d1fd7eb2c45c6547941f1fac66c7d324328d1aa2f1189599` |
| `drizzle/0001_authentication.sql` | `551ad6a9eede8626108d9fefbc7fd7cfebae2c922daee3047f17eba6a0b44c05` |
| `tests/integration/auth.test.ts` | `fc04b192fa10145399a970ae85e241dc853cf75c5b3ea999a1910b563008f904` |
| `tests/unit/auth.test.ts` | `e5617b2251a867241df9bc4f1ebc0d7cb05e07bf6ccd5c988bfdcb7c747c2f6e` |
| `tests/unit/auth-email.test.ts` | `9b33af16fcdc17a8d424a031bfb802d954b07df78f97686eb8510f6664648b7c` |

Post-fix source references recorded alongside the passing HTTP rerun:

| File | SHA-256 |
| --- | --- |
| `src/server/auth/http.ts` | `49f9e10254d4e1f98e2b1486795a707ee68088fa5ececb4575f10f031183e966` |
| `tests/unit/auth.test.ts` | `8b330775518d0e7a65b4205c2a8f5b90a5d7ae8f2d6dd05090fc247bef7f1dd3` |
| `tests/integration/auth.test.ts` | `bb8a3581e0393caa7f0641ad8e8d60069b341c92de91f19483b4eb6ad48e7aa0` |
| `src/components/auth/session-status.tsx` | `35422f00101778676ec6c107f2acd40be9ab6ab5540d0dceb10838c1aa59f774` |
| `tests/e2e/auth.spec.ts` | `f5cfdd02752ce56b0876db9be54f9c5e7b6b4fa10f4222a3b4a41544225ee986` |

## Executed independent checks

| Check | Exact command or scenario | Result | Evidence and limit |
| --- | --- | --- | --- |
| Original PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` before inspection and before report creation | PASS | Both protected originals match the baseline |
| Unit regressions | `npm.cmd test` | PASS | 3 files, 12/12 tests; Vitest duration 10.77 seconds. Includes real email rendering with mocked Resend, safe abort failure, origin/body bounds, ownership, cookie-header sanitization and refused synthetic bootstrap modes |
| Focused audit | `npm audit --omit=dev --json` | FAIL | Exit 1; 4 moderate findings, 0 high/critical; Drizzle/esbuild optional tooling chain |
| Optional-peer comparison | `npm audit --omit=dev --omit=optional --json` | PASS | Exit 0; 0 findings. Does not establish what the final runtime image includes |
| Whitespace | `git -c core.autocrlf=false diff --check` | PASS | No whitespace error at the inspected revision |
| Disabled tests | `rg -n '\b(it|test|describe)\.(skip|todo|only)|\b(xit|xtest|xdescribe)\(' tests` | PASS | No matching skipped, focused or placeholder test declaration |
| Source/test review | Read auth services, routes, schema/migration, Compose/CI, fixtures, email and UI/browser tests | PASS within static scope | Assertions exercise observable outcomes; no demonstrated unresolved backend defect found by this pass. Static inspection does not prove PostgreSQL or HTTP behavior |
| App readiness probe | Local `fetch` of `http://127.0.0.1:3000/api/health/ready`, 3-second timeout | PASS after startup | Initially unavailable during build; later HTTP 200 |
| Initial actual HTTP trust boundary | Node `fetch` scenarios listed below against loopback port 3000 | FAIL, historical | 9/12 assertions pass; 3 fail because configured-origin mutations return `INVALID_ORIGIN`. No valid login, fixture changes or provider calls |
| Fixed actual HTTP trust boundary | Rerun the same 12 Node `fetch` scenarios against image `91dc4b50558388079db46b1e1e788c97a8d340587e3554aecf70a4751ffc2114` | PASS | 12/12 assertions pass, including all three prior failures. Error DTO/cache/cookie checks also pass; no valid login, fixture changes or provider calls |
| Final PostgreSQL run | Lead/DevOps owns the isolated Compose project | NOT RUN by QA | Lead reported initial-image 18/18 PASS; final-image rerun remains separately owned evidence |
| Browser journeys | Lead owns Playwright and fixture consumption | NOT RUN by QA | Lead reported first browser run 6/6 failed at the origin boundary; after the fix, 6/6 PASS in 13.6 seconds on image `91dc4b5…`. These are attributed results, not QA-executed browser evidence |
| Post-fix unit/database/build checks | Lead/engineer execution | NOT RUN by QA | Lead reported units 14/14 PASS in 7.34 seconds, lint/type PASS and PostgreSQL 18/18 PASS in 7.51 seconds after the fix. Preserve their exact artifact evidence in the sprint report |
| Final lint/type/build and hosted CI | Lead/DevOps owns generated files/builds/publication | NOT RUN by QA | No build/typegen or Docker mutation was run concurrently by QA |
| Live Resend sender/delivery | No authorized sender, recipient or live configuration supplied | BLOCKED | Injected senders and SDK mocks cannot establish live email delivery |

The four audit findings are `drizzle-kit`, `@esbuild-kit/esm-loader`, `@esbuild-kit/core-utils` and nested `esbuild`. The underlying advisory concerns esbuild's development-server behavior: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Better Auth's optional peers affect npm's dependency classification. QA reproduced the audit outputs but did not certify exclusion from the standalone image or approve a dependency exception; the security review and actual image evidence must state those limits.

## Requirement coverage review

Coverage below means the named assertions were inspected. The original 12-test unit run and the limited HTTP runs above were executed by QA. Post-fix unit/database/browser results are attributed to the lead/engineer; their final evidence belongs in the sprint report.

| Requirement/control | Meaningful assertions present | Remaining verification |
| --- | --- | --- |
| U2 intended email/role | Normalized intended email, invitation-bound Admin/Staff role, role-injection denial, credential login after acceptance | Final PostgreSQL and browser results |
| U2 single use/expiry | Forged, wrong-email, expired, reused, undelivered and revoked tokens; two racing consumers yield one account/credential | Final PostgreSQL result |
| U2 transactional integrity | Existing-account conflict preserves prior credentials/role/status and leaves invite unconsumed; expiry after a lock wait rolls back creation | Final PostgreSQL result |
| U2 delivery | Real React Email HTML/plain text; link includes role/expiry without password; missing configuration, provider error and abort failure stay safe; failed/demoted issuer leaves invite ineligible | Unit PASS; real delivery BLOCKED |
| U4 invitation-only login | Better Auth `disableSignUp`; allowlisted handler rejects signup/encoded/trailing/unsupported routes and methods; no uninvited account created | Final PostgreSQL plus actual HTTP boundary |
| U4 RBAC/ownership | Staff cannot issue invites or change access; anonymous current-account check fails; Admin and Staff cannot claim another owner; extra access-update fields are rejected | Unit ownership PASS; final PostgreSQL/API result |
| U3 current access | Role/status changes revoke stale cookies; inactive login fails; reactivation does not revive old sessions; both session-insert/deactivation orders asserted | Final PostgreSQL result |
| U4 cookies/data | Actual library HTTPS handler checks Secure/HttpOnly/SameSite; safe DTOs exclude password/token/credential keys; logout invalidates old cookie | Unit header sanitization PASS; final PostgreSQL/browser result |
| U4 CSRF/body bounds | Exact/missing/null/hostile origins; cross-site marker; JSON content type; oversized streamed body without trusted length; forged forwarding ignored | Unit PASS; final HTTP boundary result |
| U4 durable limits | Concurrent clients produce exactly 5 allowed/15 rejected for a five-attempt limit; bounded expired pruning preserves active counter; forwarded-IP changes do not reset login limits | Final PostgreSQL result |
| Interface | Staff/Admin login/logout, email-link acceptance at desktop/320px, reused/wrong-email invite, missing link, keyboard focus, 200% text, pending/error/retry states | Lead's final browser run and nondelegable antislop gate |
| Fixture safety | Unit child processes refuse production, missing flag and nonloopback origin; scripts use `.invalid` accounts and no public route | Negative guard unit PASS; positive/idempotent fixture execution belongs to runtime evidence |

Document retrieval, RAG, OCR, citations and SSE content-release invariants are not changed by S02. Their feature and benchmark gates remain in their planned sprints; this report claims no coverage or completion for them.

## Review observations and follow-up

### QA-01: configured-origin requests rejected by the real Next.js boundary, fixed

Initial severity: high functional blocker for U2/U4. Location: `src/server/auth/http.ts`, `requireMutationOrigin`; the original guard compared both the `Origin` header and `new URL(request.url).origin` against the configured public origin. The failing runtime used `AUTH_BASE_URL=http://127.0.0.1:3000`. The internal Next.js request origin was a suspected cause; QA did not instrument application code to establish its exact value.

Reproduction executed with Node `fetch`: POST `http://127.0.0.1:3000/api/users/invite`, headers `Origin: http://127.0.0.1:3000` and `Content-Type: application/json`, body `{email:"qa-boundary@example.invalid",role:"ADMIN"}`, no cookie. Expected 401 `UNAUTHENTICATED` after the legitimate origin passes. Actual 403 `{error:{code:"INVALID_ORIGIN"}}`, `Cache-Control: no-store`. This was reproduced twice before the complete boundary run.

The defect prevented legitimate mutations from reaching authentication or input checks. The engineer changed the guard to require the exact configured `Origin` and canonical incoming `Host`, continuing to reject cross-site markers and ignoring forged forwarding headers. QA inspected the change and independently reran the actual HTTP scenarios on the rebuilt image. No implementation was changed by QA.

| Actual HTTP scenario | Expected | Observed | Result |
| --- | --- | --- | --- |
| Readiness | 200 | 200 | PASS |
| Anonymous `/api/account` | 401 `UNAUTHENTICATED` | Same | PASS |
| Anonymous `/api/auth/get-session` | 401 `UNAUTHENTICATED` | Same | PASS |
| Anonymous invite with configured origin | 401 `UNAUTHENTICATED` | 403 `INVALID_ORIGIN` | FAIL |
| Public signup | 404 `NOT_FOUND` | Same | PASS |
| Encoded signup path | 404 `NOT_FOUND` | Same | PASS |
| Trailing signup path | Final 404 `NOT_FOUND` | Same, after framework redirect | PASS |
| PUT sign-in | 404 `NOT_FOUND` | Same | PASS |
| Hostile origin with forged forwarding headers | 403 `INVALID_ORIGIN` | Same | PASS |
| Missing origin | 403 `INVALID_ORIGIN` | Same | PASS |
| Configured origin, non-JSON content type | 415 `INVALID_CONTENT_TYPE` | 403 `INVALID_ORIGIN` | FAIL |
| Configured origin, 5000-byte body | 413 `INVALID_BODY` | 403 `INVALID_ORIGIN` | FAIL |

The table preserves the initial failing run. On fixed image `91dc4b50558388079db46b1e1e788c97a8d340587e3554aecf70a4751ffc2114`, all 12 scenarios returned their expected status/code: legitimate anonymous invite 401, non-JSON mutation 415 and oversized body 413; hostile/missing origins remained 403 and signup variants remained 404. All checked error responses contained only `{error:{code}}`, were `no-store` and set no cookies. Neither QA run performed a successful account mutation, login or email call. QA-01 is CLOSED for this fixed candidate and scoped reproduction; production proxy/TLS behavior remains later environment evidence.

### Other observations

1. Initial browser tests loaded an empty invitation page and injected the fragment after mount. QA identified that this missed the email-link entry path. The lead changed the helper to navigate from another page with the full invitation URL; the URL is passed in browser evaluation rather than echoed in an assertion. The lead subsequently reported the strengthened browser suite PASS on the fixed image.
2. QA identified a possible UI race where a focus refresh started during sign-out could restore stale signed-in presentation. This was a static hypothesis, not a demonstrated authorization bypass. The lead added an abort of the latest account request after successful sign-out and a held-response regression scenario. The backend continues to recheck current access; the lead subsequently reported this browser regression PASS on the fixed image.
3. The initial guide described production Admin provisioning as open without a concrete proposal. The lead added a private, operator-only, reviewed one-off procedure, explicitly unimplemented and pending security/operations approval. The development fixture remains forbidden in production.
4. The CI file inspected during this pass had unit/build/Compose/database checks but no browser step. The lead/DevOps must add and execute the actual S02 browser suite before claiming hosted coverage.

No implementation or test assertion was changed by QA. Only this assigned evidence file is QA-owned. Review findings are not permission to waive sender-domain, recovery/MFA or production approval decisions.

## Closure

| Item | Result |
| --- | --- |
| Scoped independent unit/static and limited HTTP checks | PASS with the stated limits; QA-01 fixed and rechecked |
| Assigned QA task | Complete; only this evidence file was edited |
| All S02 acceptance items independently executed | NOT RUN |
| Final-image and hosted evidence reviewed | NOT RUN |
| Live sender delivery | BLOCKED |
| Original PRDs unchanged | PASS before and after report creation |
| Sprint closure | BLOCKED for live sender delivery; hosted CI pending. Project-manager lead retains closure responsibility |
| Next action | Review/publish the final CI evidence and resolve live sender evidence without starting S03 |
