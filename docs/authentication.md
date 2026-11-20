# S02 authentication

Implementation guide for U2/U4, U3 access enforcement and ADR 06/07. The approved PRD remains the requirements authority. User directory and account-management screens belong to S12; password reset and SSO remain deferred.

## Runtime contract

Better Auth uses the Drizzle PostgreSQL adapter. The Next.js catchall delegates only the allowlisted methods and paths below. Better Auth public signup is also disabled. Unknown, encoded signup and other unexposed library endpoints return 404.

| Endpoint | Input / access | Success response |
| --- | --- | --- |
| `POST /api/auth/sign-in/email` | `{email,password,rememberMe?}` | `{user:{id,name,email,role}}` and session cookies |
| `POST /api/auth/sign-out` | `{}`; current active session | `{success:true}` and cleared cookies |
| `GET /api/auth/get-session` | Current active session | `{user,session:{id,expiresAt}}` |
| `GET /api/account` | Current active session | `{user}` |
| `POST /api/auth/invitations/accept` | `{token,email,name,password}` | `{accepted:true}`; sign in afterward |
| `POST /api/users/invite` | `{email,role}`; current active Admin | Invitation ID, intended email/role and expiry; no token |

All responses use `Cache-Control: no-store`. Public account data excludes credential hashes, session bearer tokens and library internals. Errors are `{error:{code}}`; unexpected failures return safe 503 responses. Protected unauthenticated operations return 401, denied Admin actions return 403, and ownership failures return 404.

Mutations require JSON, an exact canonical `Origin`, an actual `Host` matching the configured public host and no cross-site fetch marker. The internal Next.js request URL is not a public-origin authority: standalone uses its bind hostname, and a TLS proxy can use internal HTTP. The approved proxy must preserve the public `Host`; forwarded host/protocol/IP headers never supply a fallback. Bodies are capped at 4096 bytes, including streamed bodies without a size header. Passwords require 12 to 128 characters for account creation. The app does not expose a public bootstrap account route.

## Invitations and current access

Invitations have a random 32-byte token; the database stores only its SHA-256 digest. Intended email and role are fixed by an Admin. The 24-hour invitation must be unconsumed, unrevoked, unexpired and marked delivered. Delivery marking means the configured provider accepted the request; it does not establish inbox receipt. Sender failure leaves the invitation ineligible. Admin/session validity is locked and rechecked before issuance and delivery marking.

Acceptance checks eligibility before expensive hashing, then locks and rechecks the invitation. Credential/account creation, conditional consumption and audit insertion share one transaction. The final consumption checks expiry again after lock waits; a failure rolls back the account and credentials. Existing accounts cannot be replaced through acceptance. Concurrent consumers produce one account.

Email links use `/accept-invitation#TOKEN`. The browser captures and removes the fragment immediately, holds it only in component memory and posts it in the acceptance body. It does not put the token in a query string, DOM label, persistent storage, source URL or referrer. Reloading the cleared URL requires reopening the email link.

Protected operations reload account role/active status and session expiry from PostgreSQL. Better Auth cookie caching is disabled. Database triggers serialize session creation against role/status changes and revoke all sessions on an access change. A later reactivation does not revive an old cookie. `requireOwner` never grants an Admin implicit ownership of another user's resources. These guards support later features; chat/document endpoints do not exist yet.

Shared limits use atomic PostgreSQL counters keyed by HMAC, independent of process memory and spoofable forwarding headers. Defaults: 10 sign-ins per email/minute, 10 acceptances per token and email/minute, 20 invites per Admin/hour, 120 session operations per account/minute, and 120 requests per operation/minute globally where applied. Each counter operation prunes at most 50 expired rows. Global limits bound abuse but can temporarily deny service to other users; tune from measured load in operational hardening.

## Configuration and external gate

`AUTH_BASE_URL` must be a canonical HTTPS origin, with loopback HTTP allowed for local development. Configure exactly one of `AUTH_SECRET` and `AUTH_SECRET_FILE`, at least 32 characters. Auth initializes lazily; builds need no credentials. Production cookies are Secure, HttpOnly and SameSite=Lax; local HTTP omits Secure.

Resend uses `RESEND_FROM` plus exactly one of `RESEND_API_KEY` and `RESEND_API_KEY_FILE`. The React Email renderer produces HTML/plain text from `src/emails/invitation.tsx`. Sends have a 10-second abort signal and an invitation-specific idempotency key. Provider errors stay server-side and revoke eligibility.

Local Compose mounts the auth secret only into app and auth verification services. No Resend credentials or sender are configured by this repository. A verified sender domain, authorized synthetic recipient and observed live delivery remain required external evidence. Injected delivery tests cannot close this gate. Production initial-Admin provisioning and operational recovery remain proposals requiring review; the local fixture is not a production provisioning mechanism.

That S02 live evidence was completed on 20 November 2026: the user confirmed sender/domain configuration and inbox receipt, accepted one authorized invitation and signed in; the lead confirmed the consumed invitation, active STAFF account and active post-acceptance session. Private sender/recipient/key/receipt configuration stays ignored, with the key mounted read-only into the local app only. Default Compose and CI still use no live sender/key. [S02 evidence](verification/S02.md). Production provisioning, recovery and deployment approval remain separate.

Proposed initial-Admin procedure, pending Product/Security/operations review: an authorized operator runs a separately reviewed one-off task on the private production host, outside HTTP routes and app startup. Confirm the intended person's identity/email and approved Admin role through the agreed company process. Require no existing active Admin; create the initial credential with the supported Better Auth password hash and user/account transaction, taking a database lock so two operators cannot bootstrap concurrently. Supply a strong temporary password through a protected operator secret file and deliver it through the separately approved company credential channel, never logs or chat. Record operator, approved identity, time and outcome without the password; remove the one-off task and temporary material afterward. Verify sign-in, active Admin guards and normal invitation delivery before handoff. This is a review proposal, not an implemented command; temporary-credential change/recovery and MFA policy must be resolved before production provisioning is approved.

## Synthetic verification

`auth:seed:synthetic` requires `SOP_SYNTHETIC_AUTH=1`, nonproduction execution, loopback HTTP auth configuration and `SYNTHETIC_ADMIN_PASSWORD` or its file source. It inserts only `synthetic-admin@example.invalid`, preserving an existing account. Never enable it on a deployed service.

`tests/e2e/seed.ts` creates isolated `.invalid` accounts and two delivered invitations using an injected sender. It writes bearer data only to a mode-0600 fixture in an explicitly supplied directory. Playwright reads the ignored local fixture; traces, screenshots and videos are disabled. Failure context stays in the ignored private output directory and must not be exported. CI runs the fixture as the host runner's UID/GID so it can write inside the private mode-0700 bind-mounted directory without broadening permissions. Run only against the disposable local Compose database. See [testing](testing.md) and the candidate-specific sprint report for executed evidence.

## Interface direction

The user selected existing styling with antislop applied during development. ENERGY 1 / RHYTHM 1 / MOTION 1. System typography and a single monochrome submit action extend the existing page; spacing separates invitation context, fields and outcome. Repeated invited-email wording and Staff/Admin labels identify the access model. Red denotes a written error only. No imagery, invented navigation, animation or third-party browser assets are needed for these tasks.
