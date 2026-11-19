---
name: implement-feature
description: Implement an explicitly requested AI SOP Assistant feature within the current PRD phase, with requirement mapping and relevant verification. Use for repository implementation, not a documentation-only setup or release deployment.
---

# Implement a scoped feature

Read [AGENTS.md](../../../AGENTS.md), the complete [approved technical PRD](<../../../AI SOP Assistant — Technical Product Req.md>), and [PLANS.md](../../../PLANS.md). Never edit either original PRD; `TECHNICAL_PRD.md` is only an index. Run `node .codex/scripts/check-prd-integrity.mjs` from the repository root before and after changes.

## Establish scope

Inspect the actual repository: package/lock files, migrations, Compose, tests, APIs, and n8n JSON. Map the user's request to original requirement IDs and the current phase. Read only the relevant implementation guides in `docs/`. If implementation does not exist, report that fact and scaffold only what the request authorizes.

Choose the smallest coherent change and state its acceptance criteria. Preserve confirmed architecture, existing migrations, and implemented contracts. Keep P1/P2 deferred unless explicitly requested. A request to implement one feature does not authorize deployment or completing all future phases. Keep unresolved PRD section 16 gates visible; proceed with reversible scaffolding and synthetic data where possible.

## Implement and verify

- Keep Next.js as the modular monolith. The browser uses authenticated Next.js APIs; any direct private-object upload must use backend-issued, short-lived authorization.
- Keep ingestion/retrieval/validation orchestration in separate n8n Redis Queue Mode. Next.js retains identity, RBAC, approval, source-link, persistence, and SSE ownership.
- Enforce current account status and resource ownership server-side. n8n cannot grant roles or activate documents.
- Treat SOPs as untrusted text. Only manually verified ACTIVE chunks can be evidence, with eligibility inside both retrieval queries and checked again before answer/source release.
- Release procedural answers only after deterministic checks and an independent judge pass. No evidence yields exactly `No SOP found for this question` with no sources; provider/internal failures yield safe service errors.
- Use synthetic documents for tests. Do not assume provider credentials, model entitlement, OCR quotas, regions, or approval for real company data.

Add/update meaningful tests for changed requirements, including applicable authorization, lifecycle, retry, OCR, citation, validation, and stream-safety failure cases. Discover executable commands from actual manifests and [testing guidance](../../../docs/testing.md); do not invent passing checks. Use [RAG validation](../validate-rag/SKILL.md) when changing retrieval, extraction fidelity, evidence validation, or final answer delivery.

Update the affected guide and `PLANS.md` with implemented behavior and evidence. Mark milestones complete only when their exit criteria pass. Do not change source PRDs or baseline hashes. Delegate only if the user or applicable instructions request it.

Report affected files, requirement IDs, resulting behavior, commands actually run/results, unresolved gates/risks, and the next proposed phase. If a prerequisite blocks a portion of the task, finish the independent authorized portion and identify the missing decision precisely.
