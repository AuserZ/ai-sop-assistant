# S02 independent security review

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Date | 19 November 2026; focused unit rerun started at 21:02 local time |
| Requirements | U2/U4; U3 access enforcement; ADR 06/07; technical PRD sections 0, 4 and 12–14 |
| Authorized scope | Invitation-only identity, current-account authorization, safe invitation delivery and associated synthetic checks |
| Reviewer | Independent security specialist; implementation owned by fullstack/lead, runtime checks owned by DevOps/QA |
| Branch and initial review base | Review began on the `codex/s02-authentication` working copy based on `b16e2a6ffaf39cd58a14392bc56d760925b906a6`; later hosted candidate is recorded below |
| Reviewed source identifier | SHA-256 `0093760413dc1c1a8675ba7802d3ee52256e763137e3f99e9a891740ddd0db4d`, covering the 39 files listed below, including final CI configuration |
| Result | F1 resolved against the reviewed source and rebuilt app: independent unit and actual HTTP checks PASS; lead reports six browser checks and hosted CI PASS. R1 remains an open moderate dependency risk. Live-provider evidence remains blocked. No unauthorized-access bypass has been demonstrated. |

This review does not close S02, accept a production risk, or authorize deployment, provider use or real SOP processing. The lead and QA own sprint acceptance. The protected technical PRD and original product PDF were read in full during this review assignment and remain unchanged.

## Reviewed controls

| Boundary / requirement | Evidence inspected | Assessment and limits |
| --- | --- | --- |
| Invitation-only registration, U2/U4 | `src/server/auth/authentication.ts:25`, `:28`; `handler.ts:15`; `validation.ts:5` | Public signup is disabled in Better Auth and excluded by an exact method/path allowlist. Role/active fields are server-owned; strict input schemas reject additional fields. Reset, social, linking and profile-update endpoints are not exposed. |
| Invitation acceptance, U2 | `src/server/auth/invitations.ts:66`; `src/server/db/schema.ts:60` | A random token is stored as a digest, bound to normalized email and the invited role. Delivery, expiry, revocation and consumption are checked before hashing and again under the invitation lock. User, credential, conditional consumption and audit writes share one transaction. Existing-account conflicts do not overwrite credentials or access state. |
| Issuer and delivery races, U2 | `invitations.ts:31`, `:45`; `authorization.ts:50`; `src/server/email/invitation.ts:17` | Current Admin/session state is locked before creation and rechecked after the send. Failure leaves the invitation ineligible and returns a safe error. Resend has an idempotency key and a ten-second abort signal. Mocked delivery is not evidence of inbox receipt. |
| Current role/account/session, U3/U4 | `authorization.ts:20`; `authentication.ts:32`; `accounts.ts:17`; `drizzle/0001_authentication.sql:84` | Guards reload current active state, role and unexpired session from PostgreSQL. Cookie caching is disabled. Access updates and session revocation are transactional; database triggers serialize session insertion against access changes. Owner checks reject other owners even for Admin. |
| CSRF, request bounds and errors, U4 | `http.ts:5`, `:7`, `:18`, `:49`; `handler.ts:23`; `errors.ts:7` | Mutations require exact canonical Origin, actual canonical Host and JSON. Streamed bodies are capped at 4096 bytes. Forwarded headers do not define the trusted origin or limiter identity. Responses use safe DTOs, preserve Set-Cookie headers and omit bearer credentials and stale body headers. The internal request-URL origin check was corrected after F1. |
| Shared limits, U2/U4 | `rate-limit.ts:28`; `handler.ts:39`; `invitations.ts:28`, `:72` | PostgreSQL upserts perform atomic counter updates; identities use HMAC keys. Global limits precede expensive authentication work. Expired-counter cleanup is bounded. The global limits can deny service to other users during abuse; tuning belongs to measured operational hardening. |
| Token-bearing UI and test artifacts, U2 | `src/components/auth/forms.tsx:70`; `src/emails/invitation.tsx:19`; `playwright.config.ts:9`; `tests/e2e/auth.spec.ts:38` | Invitation bearer data travels in a URL fragment, is removed from browser history after capture, and is submitted in the JSON body. Browser assets are local. Test traces, screenshots and videos are disabled; fixture/results paths are ignored. Browser execution results are owned by QA/lead, not claimed independently here. |
| Synthetic bootstrap, U4 | `scripts/seed-synthetic-admin.ts:9`; `tests/e2e/seed.ts:13` | Explicit nonproduction loopback configuration is required; there is no public bootstrap endpoint. Fixtures use synthetic `.invalid` identities. This is not a production Admin provisioning mechanism. |
| Hosted browser configuration, ADR 14 | `.github/workflows/ci.yml:41`; `playwright.config.ts:9` | CI installs Chromium, seeds only synthetic accounts/invitations using injected delivery, mounts the ignored fixture directory with the runner's UID/GID and runs the browser checks. Repository permission remains read-only, checkout credentials are not persisted, and there is no artifact upload or production deployment. This is static configuration review, not hosted-run evidence. |

## Demonstrated runtime finding

**F1 — HIGH functional acceptance failure: legitimate canonical-origin mutations were rejected by the standalone server. RESOLVED for the reviewed source and rebuilt image below.**

- **Failing candidate / location:** app image `sha256:c8565e8cf30a624e6de5ab0b8ea1ce25ad1f4d628b32c40cb0b64489d2950648`, prior 38-file source identifier `a27b72317223ce363cce73a34684115c2dd3ab5b377af1b12053f0854f16d30e`; `src/server/auth/http.ts:8` compared the framework request URL origin with the configured public origin.
- **Requirement:** U2/U4, S02 actual login/invitation acceptance and CSRF verification; ADR 01/06/07.
- **Trigger / independent evidence:** synthetic HTTP POSTs to local `/api/auth/sign-in/email` and `/api/users/invite`, with exact `Origin: http://127.0.0.1:3000` and JSON content, both returned HTTP 403 `INVALID_ORIGIN`. The sign-in used a nonexistent synthetic account; the invitation request had no cookie, so neither could send provider mail. An origin-valid wrong-password sign-in should reach authentication and return 401; the anonymous invitation should reach the identity guard and return 401.
- **Impact:** legitimate mutations cannot reach authentication in the actual app. This blocks S02 functional acceptance. It is not evidence of an unauthorized-access exploit.
- **Cause evidence:** both the engineer and this reviewer inspected installed Next.js 16.4.6 server/adapter source. `request.url` uses the server bind hostname (`0.0.0.0`) while the real public Host header is retained. Direct handler tests constructed public-origin URLs and did not exercise this framework boundary.
- **Minimal fix / owner:** fullstack replaced only the internal request-URL origin comparison with an exact actual Host check against the canonical configured host, retaining exact configured Origin, JSON and Sec-Fetch checks. Forwarded host/protocol headers do not select or expand trust. This reviewer inspected `http.ts` SHA-256 `49f9e10254d4e1f98e2b1486795a707ee68088fa5ececb4575f10f031183e966`. A future reverse proxy must preserve the canonical public Host.
- **Fix checks:** the engineer reported that the new bind-address regression failed against the old code, then passed after the correction. This reviewer independently ran the focused auth/email unit suite after the fix: eleven of eleven passed in 7.69 seconds. The new cases include internal-bind request URLs with canonical HTTP/HTTPS public Origin/Host and missing, foreign or malformed Host despite forged forwarding.
- **Rebuilt-runtime verification:** the lead identified healthy app image `sha256:91dc4b50558388079db46b1e1e788c97a8d340587e3554aecf70a4751ffc2114`. Against that app, this reviewer independently executed eight synthetic HTTP probes. Canonical wrong-password sign-in and anonymous invitation returned 401; foreign Origin and actual Host remained 403 despite forged canonical forwarding; correct Origin/Host with hostile forwarding reached 401; absent/null Origin returned 403; simple content type returned 415. Every response was no-store. No provider was called and no bearer was printed.
- **Browser verification:** the lead reported all six actual browser checks passing in 13.6 seconds against the rebuilt image. Coverage includes canonical Staff/Admin login, Staff denial at the Admin API, cookies/DTOs, initial fragment navigation, wrong-email/reuse checks at both viewports, keyboard/error/pending states and the sign-out focus-refresh regression. This is attributed evidence; the security reviewer did not independently run Playwright.

## Open dependency finding

**R1 — MODERATE: affected esbuild remains in the installed dependency graph; current S02 serve-mode exposure is not demonstrated.**

- **Location:** `package-lock.json:827` locks `@esbuild-kit/core-utils/node_modules/esbuild@0.18.20`; the chain includes core-utils (`:463`), esm-loader (`:865`) and drizzle-kit (`:4900`). Better Auth 1.7.26 is at `:4320` and declares optional tooling peers.
- **Requirement:** ADR 14, technical PRD sections 12/14, S14 dependency/image hardening and V01 release evidence.
- **Trigger and impact:** an affected esbuild HTTP development server must be running, and a user must visit an attacker-controlled website. Served source can then be read across origins, including when the server uses localhost. Upstream identifies versions at least 0.25.0 as patched. [Primary upstream advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)
- **Evidence:** the lock marks this chain `devOptional`. The lead reported `npm audit --omit=dev` and the full audit both failing with four moderate records after Better Auth optional-peer reclassification. `--omit=dev --omit=optional` reported zero, which is a different dependency set and does not make the production audit pass. Project scripts and reviewed package usage do not start esbuild serve mode; the installed loader utility uses transform APIs. These are four audit records in the same dependency chain, not proof of four exposed S02 attack paths.
- **Runtime evidence:** the lead reported no tooling entries in ten Next.js server trace files. The lead/DevOps reported a network-disabled recursive inventory of 71 package manifests in pre-F1-correction app image `sha256:c8565e8cf30a624e6de5ab0b8ea1ce25ad1f4d628b32c40cb0b64489d2950648`: no drizzle-kit, @esbuild-kit, vitest or esbuild packages, process UID 1000 and no `.local-secrets`/`.env` paths. The correction does not change the recorded package-lock hash, but a separate recursive inventory for rebuilt image `91dc4b...` was not supplied to this reviewer. This is attributed runtime evidence, not an image inspection independently executed by this reviewer. The tooling stage deliberately installs development packages. Do not claim that every produced image is free of the affected package.
- **Minimal fix / owner:** the engineer tracks a compatible tooling-chain update that removes affected esbuild, under S14 before V01. Do not apply npm's proposed major downgrade or a forced override without compatibility verification. Final image evidence may refine exposure; it does not remove the known lockfile finding.
- **Verification:** rerun clean installation, full/production audits, migration idempotency, applicable unit/database/build/CI checks and recursive runtime-image inventory after remediation. Reassess if any command starts esbuild serve mode.

F1 is retained as a resolved defect with its failed and passing evidence. R1 remains open. No unauthorized-access bypass was identified in the inspected S02 boundaries; this report grants no risk waiver or release approval.

## Executed checks and evidence provenance

| Check | Result | Evidence / limits |
| --- | --- | --- |
| Required guides, full protected PRDs, S02 checklist, API/security/database/authentication guides and actual implementation/test inspection | PASS | Read-only inspection of the paths above, including schema, migration, synthetic fixture, email boundary and browser fragment handling. |
| `node node_modules/vitest/vitest.mjs run tests/unit/auth.test.ts tests/unit/auth-email.test.ts`, initial attempt | FAIL | Eight passed and the synthetic-bootstrap refusal test timed out at its 15,000 ms limit. Its synchronous child-process loop took 155,061 ms; total run 160.51 seconds during concurrent work. No security assertion failure was demonstrated. Cause remains unproven. |
| Same focused command, unchanged test, 21:02 rerun | PASS | Two files, nine tests passed in 12.14 seconds. Covers origin/configuration, streamed body bounds, strict input, ownership, safe responses/cookies, bootstrap refusal and mocked Resend with real React Email rendering. |
| Same focused command after F1 correction, 21:10 rerun | PASS | Two files, eleven tests passed in 7.69 seconds. Includes the new internal-bind/canonical-Host regression and hostile/missing Host cases. |
| Lead's complete unit rerun | PASS, reported | Lead reported 12/12 tests in 5.32 seconds. This is attributed evidence, not a second independent full-suite run. |
| Lead's complete post-F1 unit/lint/type checks | PASS, reported | Lead reported 14/14 unit tests in 7.34 seconds, plus lint and type checks. These were not independently repeated by this reviewer. |
| Initial target-image database/handler suite | PASS, reported | Lead/DevOps reported 18/18 integration checks in 9.69 seconds, including invitation lock/expiry, stale sessions, both insert/deactivation orderings and independent-client limiter races. Security inspected these test cases but did not operate Docker or independently rerun this suite. Final source/image linkage remains the runtime verifier's responsibility. |
| Second target-image database/handler suite before F1 correction | PASS, reported | Lead/DevOps reported 18/18 integration checks in 13.65 seconds. This reviewer did not operate Docker or independently execute the suite. |
| Post-F1 target-image database/handler suite | PASS, reported | Lead reported 18/18 integration checks in 7.51 seconds after the host-check correction. This reviewer did not operate Docker or independently execute the suite. |
| Pre-F1-correction recursive runtime inventory | PASS, reported | App image and 71-manifest inventory recorded in R1; exact rebuilt-image inventory remains a stated limit. |
| First actual browser run | FAIL, reported | Lead reported six of six checks failed. The canonical-origin rejection in F1 is a demonstrated app defect; a separate global Next.js alert/route-announcer selector collision is being corrected in the browser harness. |
| Independent actual HTTP origin checks | FAIL | Inline Node fetch sent canonical-Origin JSON POSTs to `/api/auth/sign-in/email` and `/api/users/invite` on local port 3000. Both returned 403 `INVALID_ORIGIN` with no-store. See F1; no bearer data was printed. |
| Independent post-F1 actual HTTP checks | PASS | Eight limited synthetic probes against rebuilt app `91dc4b...` passed with expected 401/403/415 and no-store. See F1 for the scenarios. |
| Corrected actual browser run | PASS, reported | Lead reported six of six checks passed in 13.6 seconds against rebuilt app `91dc4b...`. All results are attributed, including initial fragment navigation and sign-out focus-refresh regression. |
| Final additional browser assertion | PASS, reported | After the six-case pass, the lead added an account-loading hold assertion to the existing UI-state test and reported that affected test passing independently, one of one in 4.0 seconds. App code was unchanged. The final test file hash is recorded below. |
| Final CI browser-step inspection | PASS, static only | Reviewed the Chromium install, synthetic fixture mount/UID/GID, injected delivery and browser command. No upload step, permission broadening or deployment was added. Subsequent hosted execution is attributed separately below. |
| S02 hosted CI | PASS, reported | Lead identified candidate `1ce6fbeaa8da5d4bff1a6baf8b8896efefa04fbb` and [run 44542205919, job 135623234256](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44542205919/job/135623234256): 15/15 steps successful, including 14 unit, 18 database and six browser checks plus cleanup. This reviewer did not independently inspect the hosted logs; QA is checking that evidence separately. |
| Current production/full dependency audit | FAIL, reported | Four moderate records; see R1. Audit commands were run by the lead, not repeated by this reviewer. |
| Live Resend delivery and sender-domain configuration | BLOCKED | No credentials/sender or authorized live recipient supplied. No provider call was made by this reviewer. |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS before and after report creation | Both protected source files match their original baseline. |

The earlier timeout and F1's failed runtime/browser attempts are preserved rather than rewritten as clean first-run passes. No implementation or test was changed by the security reviewer.

### Hosted result follow-up, 19 November 2026

Recorded at 21:22 WIB after the lead supplied the successful hosted result above. Candidate `1ce6fbeaa8da5d4bff1a6baf8b8896efefa04fbb` is separate from the original working-copy manifest, which remains the identifier for the independent source review. This follow-up adds attributed CI evidence only; findings, the live Resend gate, production-policy decisions and the review's approval limits are unchanged.

### Concurrent UI correction inspected

The lead added a regression for an account refresh started during sign-out. Such a refresh could restore stale signed-in UI after logout; no backend authorization bypass was demonstrated. The lead's correction at `src/components/auth/session-status.tsx:54` aborts the current refresh immediately before setting anonymous state. This reviewer inspected that delta and the new browser test. Browser execution remains attributed to the lead/QA. Concurrent UI/test corrections changed the source identifier during report preparation; the source manifest was recalculated after inspection and extended to include final CI configuration.

## Source identity

For each file below, compute SHA-256 over its exact bytes. Sort paths lexicographically, concatenate `path + NUL + lowercase_file_hash + LF`, encode as UTF-8 and SHA-256 that manifest. The result is `0093760413dc1c1a8675ba7802d3ee52256e763137e3f99e9a891740ddd0db4d`. This report and other documentation are excluded from that implementation identifier.

```text
.dockerignore
.github/workflows/ci.yml
.gitignore
Dockerfile
docker-compose.yml
drizzle/0001_authentication.sql
package-lock.json
package.json
playwright.config.ts
scripts/local-secrets.mjs
scripts/seed-synthetic-admin.ts
src/app/accept-invitation/page.tsx
src/app/api/account/route.ts
src/app/api/auth/[...all]/route.ts
src/app/api/users/invite/route.ts
src/app/page.tsx
src/app/sign-in/page.tsx
src/components/auth/client.ts
src/components/auth/forms.tsx
src/components/auth/session-status.tsx
src/emails/invitation.tsx
src/server/auth/accounts.ts
src/server/auth/authentication.ts
src/server/auth/authorization.ts
src/server/auth/config.ts
src/server/auth/errors.ts
src/server/auth/handler.ts
src/server/auth/http.ts
src/server/auth/invitations.ts
src/server/auth/rate-limit.ts
src/server/auth/validation.ts
src/server/db/schema.ts
src/server/email/invitation.ts
tests/e2e/auth.spec.ts
tests/e2e/seed.ts
tests/fixtures/auth.ts
tests/integration/auth.test.ts
tests/unit/auth-email.test.ts
tests/unit/auth.test.ts
```

Selected file hashes:

| File | SHA-256 |
| --- | --- |
| `package-lock.json` | `f99e990615822fc2848ef1067f7ff9558602adcb93ea6ff7594e5b979d242270` |
| `src/server/auth/invitations.ts` | `83016ca6149316877ada5cff6c040ad2e5b55fd1bd4dc22b81a056811f6a85e4` |
| `src/server/auth/authorization.ts` | `b69671c208835c83f015e12035c2af3e03c82a9ef7aa9879373d5de5a7c41010` |
| `src/server/auth/handler.ts` | `07eec2d79fd779b5d1fd7eb2c45c6547941f1fac66c7d324328d1aa2f1189599` |
| `src/server/auth/http.ts` | `49f9e10254d4e1f98e2b1486795a707ee68088fa5ececb4575f10f031183e966` |
| `drizzle/0001_authentication.sql` | `551ad6a9eede8626108d9fefbc7fd7cfebae2c922daee3047f17eba6a0b44c05` |
| `src/server/email/invitation.ts` | `799cfd5dd401d224b82c9194c0d659199c844c02118972b6e27f4cf60cd29c93` |
| `src/components/auth/session-status.tsx` | `35422f00101778676ec6c107f2acd40be9ab6ab5540d0dceb10838c1aa59f774` |
| `tests/e2e/auth.spec.ts` | `8a8619e5a587d447cd6f1a75172bbe4ac5ad5024ac5de8fec2e1eca73e3cc1a3` |
| `.github/workflows/ci.yml` | `4a1ea3e08ccb44cd2d5a5a59270cea1200913e2437f9ad6476215e111b62fa5c` |

## Remaining evidence and handoff

The lead/QA must link the final runtime, database, browser, hosted CI and image inventory evidence to the finished candidate and repeat affected checks after relevant changes. Live sender delivery remains a separate unresolved external gate. Production provisioning, recovery, Admin MFA and retention decisions remain open. S03, reset/SSO, the S12 directory, real SOP processing, release verification and production deployment are outside this review.

Only this report was created by the reviewer. No implementation, secrets, permissions, Git refs or protected specifications were changed.
