# Development team

The user requested this five-role team on 19 November 2026, adding the principal DevOps engineer after the initial four roles. Current follow-ups cover explicit project-manager orchestration authority and Docker/S01 runtime verification. They do not waive predecessor verification or authorize later sprints or deployment. This is an execution agreement subordinate to the [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), [original product PDF](<../PRD AI SOP Assistant.pdf>) and [sprint plan](../PLANS.md).

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

1. Read the complete protected PRDs, current plan and actual implementation. Run the integrity checker before edits. Select the earliest sprint whose prerequisites allow work.
2. Assign fullstack and DevOps work with bounded file ownership and requirement IDs, coordinating shared interfaces. Tell workers they share the workspace and must preserve other edits. Request scoped security and QA review; coordinate generated files and runtime access within the three-child capacity.
3. Implement the smallest coherent increment, fix demonstrated defects and run feature tests during development. Repeat affected checks after fixes.
4. Run post-development verification against the finished candidate. Save real evidence with the [verification template](sprint-verification-template.md), update [PLANS.md](../PLANS.md) and rerun PRD integrity. Mark VERIFIED only when all mandatory checks pass.
5. Advance in the existing phase/sprint order. Continue authorized P0 development without asking again for each implementation, test or fix. Keep unresolved section 16 decisions and external dependencies visible; finish independent work while requesting missing information.

S01 remains the current sprint until its required container/database and hosted CI evidence exists. An unavailable runtime does not justify silently starting S02. Provider-neutral scaffolding is allowed only where the existing plan permits it. P1/P2 work, production release and real company-data processing retain their explicit approval gates. V01 technical acceptance, production approval and V02 pilot acceptance remain separate outcomes.

## Continuity

The user cleared the earlier persistent development goal, then explicitly requested `continue` after S01 verification/publication. The current authorized task is S02 implementation, tests, fixes and verification. The lead has assigned backend work to the principal fullstack engineer and scoped runtime support to DevOps, with independent security/QA reviews; root owns integration/docs and the pending auth UI/email template. No new background goal or service is implied. Native Git publication and hosted CI remain available; S03 must wait for S02's required acceptance evidence, including applicable external gates.

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
