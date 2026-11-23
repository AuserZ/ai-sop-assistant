# Sprint verification report template

Use this compact table-driven format for `docs/verification/Sxx.md`, `Sxx-qa.md`, and `Sxx-security.md` (adjust relative links from `docs/verification/`). Prefer terse factual tables and bullet receipts over long prose; never duplicate unchanged PRD boilerplate across all three reports. Never edit either protected PRD.

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | Sxx — `<feature>` (`<IDs/ADRs>`) |
| Candidate / branch | `<commit SHA>` (tree `<tree SHA>`) on `<branch>` |
| Owners / verifiers | Implementer: `<role>`; Security: `Sxx-security.md`; QA: `Sxx-qa.md` |
| Versions / environment | `<schema/image/workflow/model/CI env>` |
| Date / overall result | `<date>` — **VERIFIED / FAIL / BLOCKED** (CI run `<id>`) |

## Implemented changes (concise)

- Bullet list of schema/backend/UI/workflow/test changes and affected file groups (no narrative essays).

## Executed checks

Use `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`.

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | NOT RUN | — | — |
| Static & unit | `lint`, `typecheck`, `npm test` | NOT RUN | — | — |
| Hosted CI | Run `<id>` (`foundation` / `paddleocr`) | NOT RUN | — | — |
| Independent Security & QA | Pass 1 + Pass 2 closure receipts | NOT RUN | — | — |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & fix commit | Rerun verdict |
| --- | --- | --- | --- |
| — | None / list defects fixed in sprint | — | — |

## Residual limits & closure

- Explicit limits (e.g. unauthenticated CI `/logs` 403, local Docker unavailable, single-page fixtures).
- Reference `PLANS.md` for unchanged PRD section 16 open gates instead of repeating full tables.
- **Final status:** `VERIFIED` / `BLOCKED` | **Next proposed sprint:** `Sxx` (no production/real-SOP authorization).
