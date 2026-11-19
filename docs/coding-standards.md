# Coding standards

The project uses npm scripts for lint, type checking, tests and builds. See the testing guide for commands and the standards below for new application code. [Technical PRD, sections 0, 3, 8–12](<../AI SOP Assistant — Technical Product Req.md>) · [Testing](testing.md)

## Code and contracts

Use TypeScript and Next.js App Router in one modular monolith. Separate auth/users, documents, ingestion, verification, chat, and evaluation/audit domain responsibilities inside the application. Keep provider credentials, storage signing, database access, and n8n authentication in server-only code. Browser code must not import server secrets or privileged adapters.

Validate external inputs with Zod at browser API, callback, provider-output, and workflow boundaries. Parse model results as untrusted data. Keep transport DTOs distinct from persisted domain state. Illustrative endpoints and types in the PRD remain proposed until implementation, tests, and review establish a versioned contract.

Enforce identity, current active-account status, role, and ownership in handlers and data-access paths. Use shared authorization/state-transition code where it prevents divergent behavior; hiding controls cannot enforce access. Return safe stable service errors and restricted Admin diagnostics; do not forward raw provider exceptions.

Drizzle owns application migrations. Use transactions for activation, deletion eligibility, and durable message/job state where required. Use uniqueness and stable idempotency keys to survive duplicate requests/callbacks. Do not mutate applied migrations casually or rewrite ACTIVE originals in place. See [database](database.md).

## Naming and comments

Use the `caveman` skill for concise chat communication during coding. Keep technical facts, commands, errors and verification results complete. Code, identifiers and persisted documentation must remain clear and readable.

Use `antislop-code` with the antislop core when writing or reviewing comments. Prefer self-explanatory code over explanatory narration:

- Name variables, functions and types for their domain purpose. Use names such as `invitationExpiresAt`, `isAccountActive` and `verifiedSourceChunks` instead of vague names that need explanatory comments.
- Give meaningful limits, durations and quantities names that show their purpose and units, such as `sourceLinkLifetimeSeconds`.
- Keep control flow straightforward. Within authorized implementation work, improve a vague name or simplify a confusing expression before adding a comment that explains what it does.
- Keep comments sparse and short. Explain non-obvious intent, constraints, security invariants, concurrency, protocol requirements, edge cases or workarounds. Preserve substantive API contracts, licensing and legal notices.
- Avoid decorative separators, line-by-line or numbered workflow narration, signature echoes, empty labels, obvious restatements and vague TODOs. A TODO must identify a specific actionable task.
- Comment-only cleanup must change comments only. Identifier renames, imports, formatting and executable behavior remain outside that cleanup; handle necessary code changes within their authorized implementation/refactor scope and verification.

Reviewers check whether each comment adds information the code does not already show. Do not enforce a comment quota or add comments merely to make code look documented.

## Evidence and delivery

SOP bytes and extracted text are data, never instructions. Preserve step order, headings, numbers, units, table meanings, section/page provenance, and chunk identity. Do not paraphrase evidence during extraction or reranking. Treat history as rewrite context rather than evidence.

The browser SSE path emits structured allowlisted progress, then a validated final answer, exact fallback, or safe error. Do not pass through raw n8n/provider messages, tokens, draft paragraphs, or internal diagnostics. Use sanitized Markdown rendering for the approved final response. Preserve `No SOP found for this question` exactly when evidence is insufficient.

## Frontend scope

Use the confirmed Tailwind/shadcn, TanStack Table, React Hook Form/Zod, Lucide, and PDF.js stack. Exactly three menus: Chat, List Document SOP, User Management. Responsive desktop/mobile layouts, accessible labels, keyboard focus, and honest loading/error/empty states are part of the product. Verification belongs within document management; past-chat reopening, feedback, and replacement remain P1.

## Changes and checks

Inspect existing code before choosing paths, package versions, or commands. Keep requirement IDs and priorities visible in change notes/tests. Add meaningful tests for changed requirements using synthetic fixtures and the [testing matrix](testing.md). Do not add unrelated features, speculative abstractions, empty working-looking controls, or fake success metrics.

Use structured redacted logs with request/job/trace IDs and stage timings. Never log passages, full prompts, tokens, signed links, credentials, or sensitive raw provider errors.

Never edit either original PRD. Check `node .codex/scripts/check-prd-integrity.mjs` before and after changes. Report affected files, behavior, actual checks/results, unresolved risks, and next phase; update implementation guides and the plan rather than the approved specification.
