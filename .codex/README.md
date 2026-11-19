# Project Codex setup

Read [AGENTS.md](../AGENTS.md), the complete [technical PRD](<../AI SOP Assistant — Technical Product Req.md>), and [PLANS.md](../PLANS.md). Never modify the approved PRD Markdown or original product PDF. `TECHNICAL_PRD.md` is a source index.

## Configuration

This setup targets the installed Codex CLI 0.167.0 and the current official configuration format checked on 18 November 2026. It uses standalone custom-agent TOML files with `name`, `description`, and `developer_instructions`. No agent or project file selects an application model, provider, approval policy, or sandbox mode. Those settings stay with the user's session and managed policy.

Project configuration, rules, and custom agents require the project layer to be trusted. Review the files and open a new Codex session from the workspace root; do not have an agent silently change global trust or permission settings. `project_root_markers` includes `AGENTS.md` because this folder does not yet contain Git metadata.

`config.toml` makes up to three child-agent threads available. Availability is not an instruction to delegate: use them when requested by the user or applicable instructions. Standalone agent files inherit the parent's permissions. Their inspect-only instructions are behavioral constraints, not separate read-only sandboxes.

| Role | Use |
| --- | --- |
| `project-manager` | Drive authorized P0 sprints, specialist assignments, verification and blockers |
| `principal-fullstack-engineer` | Implement assigned sprint increments, tests and fixes |
| `principal-devops-engineer` | Implement assigned infrastructure, CI/CD, runtime, monitoring and recovery work |
| `security-expert` | Independently review security controls and remaining evidence |
| `qa` | Independently execute acceptance/regression checks against the finished candidate |
| `explorer` | Map existing code, manifests, migrations, tests, and workflow JSON |
| `architect` | Review ownership, phase scope, contracts, and unresolved decisions |
| `backend-reviewer` | Review auth, transactions, lifecycle, APIs, idempotency, and SSE |
| `rag-reviewer` | Review ACTIVE-only retrieval, evidence fidelity, reranking, validation, and citations |
| `security-reviewer` | Review authorization, secrets, untrusted documents, storage, and internal services |
| `test-reviewer` | Review requirement coverage, failure cases, benchmark, and release evidence |

Example request: “Use explorer to inspect the repository, then ask architect to review the smallest Phase 0 implementation plan. Do not implement yet.” Another: “Review these RAG changes with rag-reviewer and test-reviewer, then summarize findings.” These examples do not preauthorize unrelated implementation or external actions.

The user's 19 November 2026 requests established the five-role development team and explicitly authorize the project manager to invoke the specialists as development orchestrator. Current follow-ups cover that authority and bounded Docker/S01 verification. Read the [shared agent rules and role index](../.agents/README.md) for specialties, responsibilities, workflows, do/don't rules and completion criteria. The five team Codex TOMLs reference those detailed guides. Schedule the four specialists within the existing three-child capacity. [Team ownership and continuity](../docs/development-team.md)

## Repository skills

Skills are discovered under [`.agents/skills`](../.agents/skills/implement-feature/SKILL.md). Use `$implement-feature` for an authorized implementation task, `$validate-rag` to check grounding and stream safety, and `$verify-release` to assess readiness. None authorizes deployment, provider charges, or processing real SOPs by itself.

## Command rules and optional hooks

[rules/default.rules](rules/default.rules) contains narrow examples for inspection and checks, plus review rules for destructive/deployment commands. Rules match command prefixes; they are not path-based write protection, cannot catch every shell wrapper/flag order, and do not authorize a deployment. Session and managed permissions still govern execution. An `allow` rule means permission to execute a matching command, not approval of its content.

[hooks.json](hooks.json) is an empty, valid hook configuration. No lifecycle commands run automatically. This avoids adding an unreviewed dependency or running product tests that do not yet exist. If hooks are added later, review and trust their exact definitions in the supported client and test their behavior before relying on them.

## Integrity and setup verification

Run from the repository root:

```powershell
node .codex/scripts/check-prd-integrity.mjs
codex --strict-config app-server --print-startup-config
codex execpolicy check --pretty --rules .codex/rules/default.rules -- git status --short
codex execpolicy check --pretty --rules .codex/rules/default.rules -- docker compose down -v
```

The integrity checker uses Node built-ins and checks both original files against hashes captured before setup. It detects changes; it does not prevent an editor or shell from writing a file. Do not update the baseline to hide a mismatch. The other checks validate Codex startup configuration and command-rule decisions; they do not prove product correctness. Project trust affects which files Codex loads.

S01 now defines package scripts, infrastructure and initial tests. See [testing](../docs/testing.md) for executable commands and [S01 evidence](../docs/verification/S01.md) for checks performed and remaining runtime/CI gates.

Official references: [configuration](https://learn.chatgpt.com/docs/config-file/config-basic), [custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [command rules](https://learn.chatgpt.com/docs/agent-configuration/rules), [hooks](https://learn.chatgpt.com/docs/hooks), and [skills](https://developers.openai.com/codex/skills).
