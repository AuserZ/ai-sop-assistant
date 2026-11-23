# Development team

The user requested this five-role team on 19 November 2026, adding the principal DevOps engineer after the initial four roles and explicitly authorizing project-manager orchestration. S01–S07 are VERIFIED; next permitted sprint is S08 (not started yet). Predecessor checks, external decisions and deployment approval remain required. This is an execution agreement subordinate to the [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), [original product PDF](<../PRD AI SOP Assistant.pdf>) and [sprint plan](../PLANS.md).

| Role | Responsibility | Detailed role guide | Codex definition |
| --- | --- | --- | --- |
| Project manager | Own scope, sprint order, assignments, blockers and evidence | [project-manager.md](../.agents/project-manager.md) | [project-manager.toml](../.codex/agents/project-manager.toml) |
| Principal fullstack engineer | Implement assigned application/schema/business workflow changes, meaningful tests and defect fixes | [principal-fullstack-engineer.md](../.agents/principal-fullstack-engineer.md) | [principal-fullstack-engineer.toml](../.codex/agents/principal-fullstack-engineer.toml) |
| Principal DevOps engineer | Implement assigned infrastructure, CI/CD, private runtimes, monitoring, backup/recovery and operational runbooks | [principal-devops-engineer.md](../.agents/principal-devops-engineer.md) | [principal-devops-engineer.toml](../.codex/agents/principal-devops-engineer.toml) |
| Security expert | Independently review access, private data, untrusted files, service boundaries and release controls | [security-expert.md](../.agents/security-expert.md) | [security-expert.toml](../.codex/agents/security-expert.toml) |
| QA | Independently execute applicable acceptance/regression checks and report candidate-specific evidence | [qa.md](../.agents/qa.md) | [qa.toml](../.codex/agents/qa.toml) |

Read the [shared agent rules](../.agents/README.md) together with the assigned role guide. Each guide defines the specialty, job/ownership, step-by-step workflow, do/don't rules, required handoff and completion standard. The TOMLs are concise Codex entry points that instruct the agent to load these guides.

The project manager is explicitly authorized to act as development orchestrator and invoke all four specialist roles for their jobs within the current scope. It assigns bounded ownership and acceptance checks, monitors running tasks, coordinates dependencies, reviews results and routes fixes to the responsible engineer. Routine delegation requires no additional permission request. Security/QA independence, thread limits, PRD phase order and external approval gates remain in force; app runtime orchestration remains n8n.

The main agent acts as project manager and schedules the four specialist roles in waves of up to three specialist threads, matching the existing session capacity. Fullstack owns assigned application/schema/business workflow work; DevOps owns assigned infrastructure/CI/runtime/recovery work. Agree shared migration, workflow and configuration interfaces before editing. A delegated project-manager lead must coordinate capacity with the root. Existing explorer, architect and reviewer roles remain available. All roles inherit the session's model and permissions.

## Working loop

1. Read the complete protected PRDs, compact [PLANS.md](../PLANS.md) and actual implementation. Run `node .codex/scripts/check-prd-integrity.mjs` before edits. Select the earliest sprint whose prerequisites allow work.
2. Spawn **fresh specialist subagents per sprint** (skip DevOps when Docker/Compose/CI/runtime files are untouched). Assign bounded file ownership, requirement IDs and [sprint preflight checklist](sprint-preflight-checklist.md) upfront. Tell workers they share the workspace and must preserve other edits.
3. Implement the smallest coherent increment with real success/failure automated tests; run `check:prd`, `lint`, `typecheck` and `npm test` cleanly before review.
4. **2-pass review & CI cadence:**
   - **Pass 1 (Pre-push):** Independent Security and QA review the local implementation once.
   - **Fix → Push → CI:** Implementer fixes findings, commits/pushes, and the lead waits once (~12 min for full CI unless local Docker or authenticated read-only `gh` CLI is available) rather than polling repeatedly. `.github/workflows/ci.yml` path-filters standalone `paddleocr` fail-safely when OCR/CI/PRD files did not change.
   - **Pass 2 (Single closure pass):** Independent Security and QA verify the fix diff and green CI run together in one wakeup using compact table receipts ([verification template](sprint-verification-template.md)).
5. Save compact evidence in `docs/verification/Sxx.md`, update compact `PLANS.md` (archiving narrative history in [verification history](verification/history.md)) and `AGENTS.md`, rerun PRD integrity, push closure, and recommend `/compact` or a fresh chat before starting the next sprint.

S01–S07 are VERIFIED against their recorded evidence (archived in [verification history](verification/history.md)). Next permitted sprint is S08; later sprints require predecessor verification. Provider configuration and policy decisions remain gated, with synthetic fixtures where the plan permits. P1/P2, production release and real company-data processing retain their approval gates. V01 technical acceptance, production approval and V02 pilot acceptance remain separate outcomes.

## Continuity

The earlier persistent goal was cleared; development continued through S03 acceptance on21 November for0396cf6/hosted44852222243, with closure93a71e8. The user's latest continuation and R2 choice carry S04 forward. The lead coordinates fullstack backend/schema/test ownership, DevOps fixture/config/CI ownership, independent security/QA and root UI/integration/contracts/docs. No new background goal is implied. Native Git and hosted CI remain available; S05 waits for S04 acceptance, and unresolved provider decisions remain open.

External blockers must name the missing evidence and next action. Request repository/environment names or URLs without credentials; do not invent a remote, change global permissions or claim that absent hosted tests passed. This team agreement does not replace the PRD, grant deployment approval or resolve its open decisions.

## Setup checks, 19 November 2026

The lead parsed all ten standalone agent TOMLs with the existing temporary `@iarna/toml` tool. Every definition has a unique name and the required name/description/instructions fields; the four new definitions contain no model, provider, permission or sandbox overrides. The existing three-child configuration is unchanged. `codex --strict-config app-server --print-startup-config` passed on CLI 0.167.0, and the protected PRD integrity check passed before and after edits. These are configuration checks, separate from product acceptance.

Independent QA also parsed all ten definitions, checked the four-role responsibilities/capacity and preserved PRD gates, and resolved all 26 relative links in the four setup/team guides. The lead separately checked 31 links including the amended S01 report. Fresh-client discovery of the new role names was not exercised; the current session used the available worker/reviewer types with these explicit responsibilities.

The engineering, security and QA specialists completed current S01 reviews. QA reran lint, three unit tests, type checking, build and standalone health smoke checks successfully. Required container and hosted CI evidence is still missing; see the dated recheck in [S01 verification](verification/S01.md). No product defect was demonstrated or patched, and no later sprint was started.

## Role-guide setup checks, 19 November 2026

For the user's follow-up request, created `.agents/README.md` and the four role guides, made the four Codex definitions load those guides, and updated `AGENTS.md`, `.codex/README.md`, this guide and `PLANS.md`. No application implementation changed.

- PASS: inline Node validation using the existing temporary `@iarna/toml` parsed all ten agent definitions and checked the four shared/role references, unique role identities and absence of override fields.
- PASS: all four role guides contain specialty, job/ownership, workflow, do/don't rules, required handoff and completion criteria, with no unfinished placeholders.
- PASS: all 71 relative links across the finished nine setup/team Markdown files resolve; the existing three-child capacity is preserved.
- PASS: `codex --strict-config app-server --print-startup-config` and PRD integrity checks before/after edits.

These checks validate instruction/configuration structure and references. Fresh-session agent execution and product tests were not rerun for this documentation-only task; the earlier S01 evidence and blockers are unchanged.

## Principal DevOps engineer addition, 19 November 2026

Added `.agents/principal-devops-engineer.md` and its `.codex/agents/` entry point with specialty, operational ownership, workflow, do/don't rules, handoff and completion criteria. Updated team indexes, manager coordination and fullstack/QA ownership wording. The five-role team schedules its four specialists within the unchanged three-child capacity.

Executed inline Node/TOML validation: PASS for all 11 definitions, all five guide references/identifiers and seven required sections, no override fields/placeholders, manager coordination and 84 relative links across ten Markdown files. Strict Codex startup configuration and protected PRD integrity checks passed. No infrastructure was provisioned or deployed, application code changed or product test rerun; fresh-session execution of the new role was not exercised.

## Project-manager orchestration authority, 19 November 2026

Made explicit that the project manager may invoke and follow up with fullstack, DevOps, security and QA agents for their jobs within the current authorized scope. Assignments include objective, requirement mapping, ownership, acceptance checks and handoff; the lead monitors tasks, coordinates dependencies, reviews results and routes fixes. Independent review, three-child capacity and PRD/approval gates remain intact. Runtime orchestration remains n8n.

Independent QA reviewed the finished authority instructions and fixed-scope wording: PASS for delegation/role routing, ownership/review boundaries, capacity, phase/approval preservation, all 11 agent TOMLs and project configuration, five guide routes, 63 relative references across six reviewed Markdown files, strict startup and PRD integrity. Core candidate SHA-256: `.agents/project-manager.md` = `780d512b08b358abba53ec5b40b77c41b3b74c0bc2a0a0a19766ad3c4bda9c94`; `.codex/agents/project-manager.toml` = `543a9569cf5b2510eaaccfd263a867bece96276b6ee7f375e47e934201a8a9a7`.

The lead exercised this authority by assigning the configuration review to QA and the bounded S01 build diagnosis/retry to DevOps. These are real delegated tasks within the current session, separate from the app's release acceptance. Docker/S01 runtime outcomes belong in the sprint report; this configuration pass does not close S01.
