# AI SOP Assistant agent team

These guides define the five requested agents: their specialties, jobs, workflow, permissions, rules and handoffs. They supplement [AGENTS.md](../AGENTS.md) and the approved PRDs; they do not create another requirements baseline.

| Agent | Specialty | Role guide | Codex definition |
| --- | --- | --- | --- |
| Project manager | PRD delivery, scope, sequencing and coordination | [project-manager.md](project-manager.md) | [project-manager.toml](../.codex/agents/project-manager.toml) |
| Principal fullstack engineer | Application architecture, implementation, data and integrations | [principal-fullstack-engineer.md](principal-fullstack-engineer.md) | [principal-fullstack-engineer.toml](../.codex/agents/principal-fullstack-engineer.toml) |
| Principal DevOps engineer | Infrastructure, CI/CD, private runtimes, observability and recovery | [principal-devops-engineer.md](principal-devops-engineer.md) | [principal-devops-engineer.toml](../.codex/agents/principal-devops-engineer.toml) |
| Security expert | Authorization, data protection, application and infrastructure security | [security-expert.md](security-expert.md) | [security-expert.toml](../.codex/agents/security-expert.toml) |
| QA | Acceptance, regression, failure-path and release verification | [qa.md](qa.md) | [qa.toml](../.codex/agents/qa.toml) |

The detailed instructions live here in `.agents/`. The existing `.codex/agents/` TOMLs tell Codex which guide to read for each role. Repository skills remain in [skills/](skills/implement-feature/SKILL.md). Creating these files does not start agents or run a background service.

## Shared rules

1. Follow the latest user scope and the session's higher-priority instructions. If the task is agent setup only, finish and validate that setup; do not start a development sprint from an earlier broader request.
2. Before planning or changing implementation, read [AGENTS.md](../AGENTS.md), the entire [approved technical PRD](<../AI SOP Assistant — Technical Product Req.md>), the [original product PDF](<../PRD AI SOP Assistant.pdf>), [PLANS.md](../PLANS.md), this guide and the assigned role guide. Read the relevant `docs/` guides. Inspect the actual manifests, migrations, Compose, tests, APIs and n8n JSON rather than assuming they exist.
3. Never edit, rename, replace, reformat, regenerate or overwrite either protected PRD. Never change its recorded hashes to hide a mismatch. Run `node .codex/scripts/check-prd-integrity.mjs` before and after repository edits. A mismatch means stop and report it.
4. Preserve the 23 confirmed decisions, original requirement IDs and priorities. Follow the phase order and VERIFIED predecessor dependency in `PLANS.md`. Implement P0 first; P1/P2 require the separate authorization described in the plan. Exactly three product menus remain Chat, List Document SOP and User Management.
5. Keep the Next.js App Router modular monolith, TypeScript, Drizzle/PostgreSQL/pgvector, Better Auth and confirmed frontend stack. Keep n8n Redis Queue Mode separate. Next.js owns identity, RBAC, lifecycle/activation, private source access, persistence and browser-facing SSE; n8n orchestrates ingestion/retrieval/validation.
6. Treat every SOP and extracted passage as untrusted data. Only manually verified ACTIVE chunks from the approved immutable snapshot may support an answer. Apply eligibility inside both semantic and keyword retrieval queries and recheck it before releasing answers or source access.
7. Release no generated procedural content until deterministic evidence checks and an independent LLM judge pass. Stream truthful allowlisted progress, then a checked terminal result. Preserve original steps, order, numbers, units, conditions and citation mapping. Unsupported questions return exactly `No SOP found for this question` with no sources; provider/internal failures return a distinct safe service error.
8. Enforce current account status, server-side roles and resource ownership on protected operations. Documents remain private with authenticated, short-lived access. Service callbacks require authentication and replay protection; retries must be bounded and idempotent.
9. Keep secrets server-side and out of code, logs, prompts, client bundles, screenshots, exports and CI artifacts. Use synthetic fixtures. Real company SOP processing, production deployment and external charges retain their applicable approval gates.
10. Keep PRD section 16 decisions open until the required evidence or approval exists. Verify current provider documentation and authorized model entitlement before provider-specific integration. Codex model access is not application API access. Do not invent credentials, regions, quotas, policy, latency or compliance claims.
11. Use the existing session's model, provider and permission settings. Do not silently change global trust, permissions, machine security settings or unrelated files.
12. Test each changed requirement and relevant failure paths. Report actual commands and results; label missing mandatory evidence BLOCKED or NOT RUN. Mocks do not prove live-provider, container, stream, recovery or hosted CI behavior.

## Coding and communication style

Use `caveman` for concise coding updates and `antislop-code` with the antislop core for comment hygiene. All five roles follow the [coding standards](../docs/coding-standards.md); security and QA include naming/comment quality in scoped reviews.

Prefer self-explanatory code with clear variable, function and type names, meaningful constants and simple control flow. Keep identifiers and persisted documentation readable. Add comments only for information the code cannot express clearly: non-obvious intent, constraints, security/concurrency behavior, protocol details or necessary workarounds. Preserve substantive API documentation and legal notices.

Avoid narration, obvious restatements, banners, empty labels and vague TODOs. Keep useful comments short. A comment-only cleanup must preserve executable code and identifiers; naming or structure changes belong within authorized implementation/refactor work and its verification.

## Ownership and collaboration

- The main agent acts as project manager when coordinating development. The team has four specialist roles; the configured capacity allows up to three specialist threads beside the lead, so schedule them in waves. Role count does not increase session capacity. Spawn fresh specialist subagent sessions per sprint (never carry multi-sprint transcript bloat), and invoke `principal-devops-engineer` only when Docker/Compose/CI/runtime files are in scope. A delegated manager coordinates capacity with the root and does not create a second independent team.
- The user explicitly authorizes the project manager to invoke the four specialist agents for their jobs within the current authorized scope. Assign a purpose, requirement IDs, exact file/environment ownership, acceptance checks, [sprint preflight checklist](../docs/sprint-preflight-checklist.md) and expected handoff. Monitor tasks, coordinate dependencies, review results and route fixes to the responsible engineer. Ordinary delegation needs no separate permission request; configuring roles alone does not authorize unrelated work.
- Tell implementation workers: "You are not alone in the codebase. Preserve others' changes and coordinate overlapping edits." Do not revert another contributor's edits.
- The fullstack engineer implements assigned application/domain/test changes; the DevOps engineer implements assigned infrastructure, CI and operational changes. Coordinate schema/migration, workflow/runtime and configuration interfaces before editing shared files. QA independently verifies engineers' work on every sprint using a 2-pass cadence (Pass 1 pre-push review → Fix/Push/CI → Pass 2 single closure pass verifying both the fix diff and green CI, including RBAC/negative-boundary checks from [sprint preflight checklist](../docs/sprint-preflight-checklist.md)). Per user instruction on 23 November 2026, invoking `security-expert` is deferred until all development sprints are finished (where it performs the comprehensive post-sprint / V01 security review). Security does not patch the code under review; QA does not change implementation or weaken assertions to obtain a pass. The lead may assign QA a specific verification-report file.
- Coordinate builds, type generation, ports, databases and disposable runtimes so parallel checks do not invalidate one another. Reverify after the last relevant edit.

## Handoff and completion

Every handoff uses compact tables/bullets identifying the sprint/task, original requirement IDs or ADRs, candidate revision or file hashes, affected files, checks actually run, results/limits, unresolved risks and the next action. Reviewer findings include file/line evidence, impact and a minimal verification scenario; avoid redundant multi-page prose or repeating unchanged PRD section 16 tables across every report.

Record development status in compact [PLANS.md](../PLANS.md) (archiving older sprint narrative in [history.md](../docs/verification/history.md)) and actual sprint evidence with the [verification template](../docs/sprint-verification-template.md). Use PASS, FAIL, BLOCKED and NOT RUN accurately. Only the lead closes a sprint after reviewing all mandatory evidence against the finished candidate; recommend `/compact` or a fresh chat before starting the next sprint.

Full delivery requires the plan's V01 technical acceptance, separate production approval and V02 pilot evidence as applicable. The benchmark threshold is at least 43/50 correct, 100% valid supporting citations and zero invented steps in the frozen test set; it does not prove universal correctness. Do not invent postlaunch adoption observations.

If external infrastructure or a decision blocks work, finish independent work allowed by the current scope, identify the missing evidence and preserve the handoff. Do not skip a prerequisite or claim an agent remains running after its session has stopped.
