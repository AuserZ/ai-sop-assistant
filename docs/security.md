# Security guide

Authority: [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), sections 0, 3–8, 12–16, plus the [original PRD](<../PRD AI SOP Assistant.pdf>) no-model-training requirement. These are implementation/release obligations, not claims of controls already deployed or regulatory certification.

## Identity and authorization

Only invited active users authenticate through Better Auth. Invitations are expiring, single-use, tied to the intended email/role and sent through Resend; do not email passwords. Enforce server-side RBAC and current active-account state for every protected operation. Deactivation must block ongoing access. Conversations/messages belong to their owner; an Admin role does not imply unrestricted access to another user's chats.

Staff may chat and list/open/download verified ACTIVE SOPs. Admin may manage documents, review extraction, and manage users. Only the backend activates snapshots or grants roles. Use secure HTTP-only cookies, HTTPS, appropriate CSRF protections, and rate limits for authentication, invitations, uploads, chat and token generation.

## Trust boundaries

| Boundary | Required control |
| --- | --- |
| Browser→Next.js | Identity/account/role/ownership checks, input validation, safe errors, sanitized final Markdown |
| Next.js↔n8n | Private service exposure, signed authentication, schema validation, request correlation, timestamp/nonce replay protection |
| Internal infrastructure | Non-public PostgreSQL/Redis/n8n editor, isolated Docker networks and scoped service roles |
| Storage | Private managed bucket, scoped credentials, signature/MIME/size/hash checks, authorized short-lived access |
| DOCX conversion | Isolated resource-limited helper with restricted outbound access; no trust in file content |
| External AI/OCR | Recorded company processing approval, region/retention/privacy review, least necessary data, verified model/project access |
| CI/deployment | Protected secrets, scans, reviewed migrations/artifacts, production approval and rollback |

Presigned links are bearer access until they expire. Reauthorize current user and document status before issuing them; use short lifetimes and test revocation/deletion behavior within the documented expiry limits. Historical citations do not bypass source access checks.

## Untrusted SOPs and generated output

Treat original files, metadata, OCR output, and extracted passages as untrusted data. Embedded instructions cannot change system behavior or authorize tools. Test prompt injection, forged citations, wrong chunk/document mapping, OCR numeric traps, unsupported quantities, file-reference SSRF, malformed/oversized files and malicious conversion inputs.

Only matching human-approved ACTIVE snapshots may appear in either query branch. Validate current eligibility again before answer/source release. Deterministic checks and an independent judge must pass before procedural content reaches any browser response/event. Fail closed on uncertainty and provider/validation outages. Exact evidence-absence fallback and service errors remain distinct.

## Secrets, privacy and logging

Keep credentials server-side in restricted configuration and Docker Compose secrets; never place them in code, client bundles, fixture documents, workflow exports, logs or CI artifacts. Compose secret mounts do not encrypt host source files; restrict source permissions, backup access and key handling. Keep the n8n encryption key stable and securely recoverable.

Do not log full prompts, document passages, signed links, tokens or sensitive provider exceptions. Extracted text and embeddings remain potentially confidential. Use correlation IDs and safe stage/error metrics. Minimize and prune n8n execution payload retention.

The original PRD requires uploaded SOPs not be used to train models. Verify applicable provider/project data controls and contractual settings; do not assume subscription level proves them. Development and CI use synthetic documents. Real SOP processing requires company approval and privacy/residency/retention review before any external submission.

## Unresolved policy and evidence

Storage provider/region/recovery, real-data approval, chat/audit deletion, backup expiry, Admin MFA, account recovery and sender-domain readiness remain open gates in [PLANS.md](../PLANS.md). Proposed retention periods are not approved policy. A live deletion may persist in encrypted backups according to the eventual documented policy.

Require focused authorization/adversarial tests and relevant dependency/image scans; release verification must distinguish implemented evidence from planned controls. This project does not claim regulatory compliance or CPOB computerized-system validation. See [testing](testing.md) and [deployment](deployment.md).
