# S12 QA verification report — Admin user directory and account management

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S12 — Admin user directory and account management (`U1`, `U2`, `U3`, `U4`, `ADR 06/07/20`, Phase 3) |
| Candidate / branch | `ba57672e3f377e4a057cc668db2cd5473a02977d` (tree `ae3286ace2b210878058b0f6246a6831f36fc04a`) on `codex/s12-user-management` (base `cf19b31d74616759d8325f0566af26689b1e47c0`) |
| Owners / verifiers | Implementer: `principal-fullstack-engineer`; QA Pass 1 (including deferred security preflight/negative-boundary checks per 23 Nov 2026 instruction): `qa` |
| Versions / environment | No new DB migration (uses `0001_authentication.sql` `app.auth_users`, `app.auth_invitations`, `app.auth_sessions` & `auth_users_revoke_sessions` trigger); Windows 11 host, Node >=24, Next.js 16.4.6 (`webpack`), Vitest 5.1.1; local Docker/PostgreSQL unavailable (`test:db`, `test:browser`, hosted CI, and `security-expert` deferred) |
| Date / overall result | 24 November 2026 — **Pass 1 PASS** (`0` Blocker, `0` Major, `0` Minor defects; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, `test:browser`, hosted CI, and `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **Admin directory, role/status mutations & invitation safeguards (`src/server/auth/{validation,rate-limit,accounts,invitations}.ts`, `src/app/api/users/route.ts`, `src/app/api/users/[id]/route.ts`):**
  - `GET /api/users`: enforces live active Admin session (`lockCurrentAdmin`), rate limits (`users-global`, `users:list`), duplicate query-param rejection (`400 INVALID_INPUT`), escaped `ILIKE` search (`q`), `role` (`ADMIN`/`STAFF`), `status` (`ACTIVE`/`INACTIVE`), `limit` (`1..100`, default `50`), deterministic ordering (`createdAt DESC, id ASC`), summary counts, and sanitized `pendingInvitations` (excluding `tokenDigest`).
  - `POST /api/users/invite`: locks active pending `auth_invitations` (`FOR UPDATE`) to block duplicate active pending invites (`409 INVITATION_ALREADY_PENDING`) while allowing re-invite after expiry or revocation; writes redacted `audit_events` metadata (`{ role }` only — zero emails, tokens, or passwords).
  - `PATCH /api/users/[id]`: enforces `requireMutationOrigin` (CSRF + `application/json` + 4 KB cap), rate limits (`users-global`, `users:update`), deadlock-free `FOR UPDATE` locking on `[actor.id, targetId]`, self-lockout protection (`409 SELF_ACCESS_CHANGE_DENIED`), last-active-Admin protection (`409 LAST_ADMIN_REQUIRED`), immediate `auth_sessions` deletion + DB trigger revocation, and redacted `account_access_changed` audit metadata.
- **UI, 3-menu navigation, docs & tests (`src/app/users/page.tsx`, `src/components/users/{client.ts,user-management-panel.tsx}`, `src/components/auth/session-status.tsx`, `docs/{api-contracts,authentication}.md`, `tests/{unit,integration,e2e}/users.*`):** Added `/users` Admin User Management UI (`320px` overflow-free, `min-h-11` targets, summary badges, passwordless invite form, pending invitations, search/filter bar with `data-testid="users-count-status"`, role toggle, deactivate/reactivate, disabled self-row actions, and Staff `role="alert"` `"Admin access required."`), added `User Management` (`/users`) as the 3rd primary menu item for `ADMIN` only, and added unit/DB/Playwright suites.

## Executed checks (Pass 1)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| ESLint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` (exit `0`) | Static only |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` (exit `0`) | Static only |
| Unit & contract suite | `npm.cmd test` | **PASS** | `24/24` files, `124/124` tests (`users.test.ts` `5/5`, `auth.test.ts` `8/8`, `answer-benchmark.test.ts` `50/50`) | Mocked/unit layer only |
| Production build | `node ./node_modules/next/dist/bin/next build --webpack` | **PASS** | `/users`, `/api/users`, `/api/users/[id]`, `/api/users/invite` built cleanly (exit `0`) | No runtime smoke |
| Security preflight & DB/E2E audit (`U1`–`U4`) | Static audit of `accounts.ts`, `invitations.ts`, `users.test.ts`, `users.spec.ts`, and S02–S11 regression compatibility | **PASS (static)** | Deadlock-free locking, self/last-Admin guards, immediate session/SSE/60s-source revocation, rolled-back tx isolation for `LAST_ADMIN_REQUIRED`, zero S02–S11 test regressions | Live PG (`test:db`) and Playwright (`test:browser`) deferred |
| PG `test:db`, Playwright `test:browser`, hosted CI & `security-expert` | `npm run test:db`, `npm run test:browser`, GitHub Actions, deferred Security review | **NOT RUN (deferred)** | Deferred for intermediate sprints (`S08`–`S16`) per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

None (`0` Blocker, `0` Major, `0` Minor defects found).

## Residual limits & open gates

- Real PostgreSQL (`npm run test:db`), Playwright browser E2E (`npm run test:browser`), hosted CI, Pass 2 QA closure, and deferred `security-expert` review remain mandatory before marking S12 `VERIFIED` and entering V01.
- Password-reset enhancements (`U5`, P1), SSO (`U6`, P2), production account recovery procedure, and Resend sender-domain operational readiness remain open in [PLANS.md](../../PLANS.md).
