---
name: verify-release
description: Assess AI SOP Assistant P0 release readiness from actual test, benchmark, security, recovery, and approval evidence. Use for a readiness review or release verification; this skill does not itself authorize deployment.
---

# Verify a release candidate

Read [AGENTS.md](../../../AGENTS.md), the complete [technical PRD](<../../../AI SOP Assistant — Technical Product Req.md>), [PLANS.md](../../../PLANS.md), and the [testing](../../../docs/testing.md), [security](../../../docs/security.md), and [deployment](../../../docs/deployment.md) guides. Keep both original PRDs unchanged. Identify the exact candidate commit/artifacts, n8n workflow versions, schema version, configuration, and environment; report missing identifiers.

## Verify evidence against the candidate

- Map all P0 C1–C5, D1–D5, U1–U4 requirements to passing checks and implemented behavior. Keep C6/C7/D6/U5 and D7/U6 deferred unless requested. A working UI alone does not meet acceptance.
- Check lint/type/unit/disposable-database integration/Playwright/n8n contracts and relevant security scans. Inspect failed/skipped checks, synthetic fixture provenance, RBAC, deactivation, ownership, ACTIVE-only retrieval, idempotency, OCR failure, citations, judge failure, and stream safety.
- Verify a versioned 50-question benchmark for the actual candidate/configuration: at least 43 correct, 100% valid supporting citations, 0 invented steps. Model/retrieval/workflow changes require renewed evidence.
- Separate progress, first meaningful answer, and completion timings. Preserve the under-30-second business goal and 3-second/10-second technical targets; require the agreed rubric and measured p50/p95. Pilot adoption of at least 60% weekly needs observed pilot evidence, not a prelaunch claim.
- Check provider/model entitlement, project configuration, private storage/regions, no-training and privacy controls, real-data company approval, sender-domain/recovery readiness, and unresolved retention/MFA/resource-limit policies. Do not silently approve open gates.
- Verify private infrastructure, scoped secrets, callback replay protection, protected n8n encryption key, redacted logs, immutable images/workflows, migration review, deployment approval, smoke checks, and rollback plan.
- Require an isolated restore drill covering encrypted six-hourly app/n8n backups, pgvector, original n8n encryption key, object access, and a synthetic end-to-end answer. A backup file existing is insufficient recovery evidence.

Run authorized, non-production checks available in the repository. Do not initiate a deployment, production migration, destructive restore, paid provider run, or real-document processing merely because this skill is active. Existing explicit user authorization still applies; request only genuinely missing approval immediately before a dependent action.

## Report

Run `node .codex/scripts/check-prd-integrity.mjs`. Produce a readiness report with the candidate identity, requirement-to-evidence mapping, commands actually run/results, missing or failed gates, risk owners, and next actions. Distinguish prelaunch technical acceptance from pilot metrics that need observation. Do not claim readiness or mark milestones complete while mandatory evidence is absent. Record review evidence in `PLANS.md` or a requested report, never in the original PRDs.
