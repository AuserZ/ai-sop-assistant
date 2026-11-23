# Sprint preflight checklist (implementer)

Read this before coding any sprint increment to eliminate avoidable Security/QA rework and blind CI failures. Derived from verified S01–S06 findings.

## 1. Database & lifecycle invariants
- Enforce critical state transitions, immutability, and snapshot bindings in PostgreSQL `CHECK` constraints and triggers — never rely on service-layer checks alone.
- Bind mutable retries/reprocesses to a rotating attempt or revision ID (`attempt_id`), never solely to a reused job ID.
- Preserve least-privilege runtime grants (column-level `UPDATE` on immutable columns; `REVOKE UPDATE, DELETE` on append-only audit tables; zero n8n/worker write privileges on authoritative activation/auth tables).
- Keep all `sop_documents` retrieval eligibility strictly `ACTIVE`-only in both SQL branches where retrieval applies.

## 2. Authorization, input & private-resource boundaries
- Enforce server-side current-account status, RBAC role, and resource ownership on every API route and server action — hidden UI controls are never authorization.
- Add explicit negative tests for anonymous, Staff/wrong-role, deactivated-account, cross-user, and forged/worker-JWT callers.
- Cap request body sizes (e.g., 16 KB for JSON mutations), enforce bounded timeouts on storage/upstream fetches, and set `Cache-Control: private, no-store`, `X-Frame-Options: DENY`, and `Cross-Origin-Resource-Policy: same-origin` on private document/preview endpoints.
- Keep secrets, passages, prompts, and signed URLs out of logs, client bundles, exports, and CI output.

## 3. Next.js standalone, UI & accessibility
- Copy any browser worker or static package asset (e.g., `pdf.worker.min.mjs`) into `./public/` in `Dockerfile` (`--chown=node:node`) and load it from the same origin — do not rely on `new URL(..., import.meta.url)` in Next.js standalone builds.
- Keep exactly three top-level menus (`Chat`, `List Document SOP`, `User Management`).
- Expose deterministic DOM state attributes (`data-rendered-*`, `aria-selected`, etc.) for async canvas/stream updates so Playwright never races renders.
- Verify keyboard navigation, ARIA tab/dialog bindings, `min-h-11` interactive targets, and zero horizontal page overflow at `320px`.

## 4. Test isolation & pre-review gates
- Ensure PostgreSQL integration tests clean up or scope shared global rows (`document_upload_intents`, `workflow_jobs`) and remain deterministic under `npm run test:db` (`--no-file-parallelism`).
- Run `npm.cmd run check:prd`, `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd test` cleanly before requesting Pass 1 Security + QA review.
- Never alter `AI SOP Assistant — Technical Product Req.md` or `PRD AI SOP Assistant.pdf`.
