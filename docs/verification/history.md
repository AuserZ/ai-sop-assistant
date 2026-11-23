# Historical setup & sprint progress log (S01–S06)

Archived from [PLANS.md](../../PLANS.md) on 23 November 2026 to keep `PLANS.md` compact while preserving every historical date, commit SHA, hosted CI run ID, and setup check verbatim. Individual sprint evidence remains in [S01.md](S01.md) through [S06.md](S06.md).

## Setup & planning verification — 18 November 2026

| Check actually performed | Result |
| --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` | PASS: original technical Markdown and product PDF match SHA-256 values captured before setup |
| Integrity checker from nested working directory; missing/altered synthetic sources in an isolated temporary directory | PASS: correct root resolution and nonzero failure for missing/changed sources; original files untouched |
| `codex --strict-config app-server --print-startup-config` | PASS on installed CLI 0.167.0 |
| Project TOML parsed and validated against current official Codex JSON schema | PASS; validation tooling installed only in a temporary directory |
| Six standalone agent TOMLs parsed and required fields checked | PASS; no model/provider/permission override fields |
| Three skill YAML frontmatters, names/descriptions and unfinished-scaffold checks | PASS using a Node equivalent of the bundled skill validator's checks; Python unavailable |
| Optional hooks JSON parsed and empty hook table schema checked | PASS; no lifecycle commands enabled |
| `codex execpolicy check` for `git status --short`, `docker compose down -v`, and `gh workflow run deploy.yml` | PASS: allow, prompt, prompt respectively (evaluated only) |
| Relative links in editable Markdown guides/skills | PASS: 63 links resolve; 14 links across sprint-plan docs; 16 uniquely ordered sprints, 64 checkboxes, 14 P0 IDs mapped |

## Team authorization & coding style — 19 November 2026

- User authorized continued P0 development, requested a five-role team (project manager, principal fullstack engineer, principal DevOps engineer, security expert, QA) within existing three-child capacity, and explicitly authorized project-manager orchestration ([development-team.md](../development-team.md)).
- Initial team/role-guide setup validated all 11 Codex definitions, 5 role-guide structures/references, 84 relative links, strict Codex startup, and PRD integrity.
- Coding style recorded: `caveman` for concise coding communication and `antislop-code` for sparse, useful comments ([coding-standards.md](../coding-standards.md)).

## Verified sprint milestones (S01–S06)

### S01 — Foundation (VERIFIED, 19 November 2026)
- Published source `59fa63f7df02489a6730b02f6cbbb2383c255503`; closure `b16e2a6ffaf39cd58a14392bc56d760925b906a6` on `codex/s01-foundation` (`AuserZ/ai-sop-assistant`, preserving `master` history/license).
- [Hosted run 44485878184](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44485878184): 14/14 steps PASS (3 unit, 3 PostgreSQL/pgvector, cleanup). Initial local esbuild `ETXTBSY` did not recur on retry (root cause unproven). Open S14/pre-V01 risk: 4 moderate dev-only Drizzle/esbuild advisories (`GHSA-67mh-4wv8-2f99`). Report: [S01.md](S01.md).

### S02 — Invitation-only authentication & authorization (VERIFIED, 20 November 2026)
- Branch `codex/s02-authentication`; app source `1ce6fbeaa8da5d4bff1a6baf8b8896efefa04fbb` + browser correction `964687cd111ab60bdb5af20973f9ea6cef075957`; closure `14ab58698f7432a96727bb01442ec71d0fea9ad6`.
- [Hosted run 44548005713](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44548005713) (replacing failed doc-head run `44543410142`): 15/15 steps PASS (14 unit, 18 PostgreSQL, 6 Chromium, cleanup).
- One authorized live Resend invitation returned HTTP 201 (21:54:45 Asia/Jakarta, 19 Nov); user confirmed receipt, acceptance, and sign-in; final DB read (07:54 Asia/Jakarta, 20 Nov) confirmed consumed invite, active STAFF account, and active session. Report: [S02.md](S02.md).

### S03 — Durable private workflow jobs & safe progress proof (VERIFIED, 21 November 2026)
- Branch `codex/s03-workflow-jobs`; published source `0396cf606b8e34a805a038b273a103687a691ce1`; closure `93a71e8b93392c7740fd5b097548b28e1747b1d3`.
- [Hosted run 44852222243](https://github.com/AuserZ/ai-sop-assistant/actions/runs/44852222243) (job `136685999286`): 18/18 steps PASS (28 unit, 30 PostgreSQL, 10 browser, 6 recovery/60s proxy timeout cases, native POST 301/307 controls, cleanup). Native recovery/pruning removed earlier retained JWT payloads; transient buffering retention remains explicit. Phase 0 complete. Report: [S03.md](S03.md).

### S04 — Admin private SOP upload (VERIFIED, 22 November 2026)
- Branch `codex/s04-private-uploads`; published source `1ef852166cda0e07c231ddd4834cf053442bb1dd`; closure `f81a8d3`.
- User selected **Cloudflare R2** (public development URL disabled, Custom Domains empty); standalone tampering/race/replay/hash/CORS/expiry/private-S3 checks and live 20 MB/PDF/DOCX/original-byte checks passed on fresh project `ai-sop-s04-r2-verify-20261122` after increasing coordinated seal timeouts (`30s` storage / `45s` lease / `35s` client/proxy).
- [Hosted run 45018939728](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45018939728) (job `137197322521`): 19/19 steps PASS (40 unit, 48 PostgreSQL, 15 browser, native storage, 6 recovery cases, POST redirects, cleanup). Report: [S04.md](S04.md).

### S05 — SOP extraction, OCR, previews & indexing (VERIFIED, 23 November 2026)
- Branch `codex/s05-document-processing`; historical S05a `4f1bf000b004e8a488a73268aed6635e8cb88423` (hosted `45026670726`, plus standalone live OpenAI `text-embedding-3-small`/1,536 synthetic request: 17 tokens, 1,536 finite values); S05b initial `3e7c626` (failed Step 13 parallel DB test contention on `45101706382`); final implementation `caf0fc7d8e8bb879f1162d1d32c174248022ee31` (tree `ac923727099f080f3923954e573cdcd9f19ca041`); closure `cbabecd50d40a5f45caa2c76bd66f7f42412a579`.
- [Hosted run 45102843612](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45102843612): 29/29 steps PASS (`paddleocr` `137457390869` 9/9 + `foundation` `137457391121` 20/20). Independent Security ([S05-security.md](S05-security.md)) and QA ([S05-qa.md](S05-qa.md)) PASS. Report: [S05.md](S05.md).

### S06 — Assisted verification & atomic activation (VERIFIED, 23 November 2026)
- Branch `codex/s06-assisted-verification`; initial `2da02bbb63b1a5ed157489bbe9bd8d8b21d51969` (passed Steps 1–13, failed Step 14 standalone PDF.js worker URL on `45117819835`); final implementation `14e2d54cade8dfe6b357caa7a1baad6dcafdcf28` (tree `644ee407bcfa699a36892c54d1dff7b7562e0c46`); closure `aa8ccef3a2a7ff6afbb1ea464210919c09b6949e`.
- [Hosted run 45122984069](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45122984069): 29/29 steps PASS (`paddleocr` `137520801499` 9/9 + `foundation` `137520801816` 20/20). Independent Security ([S06-security.md](S06-security.md)) and QA ([S06-qa.md](S06-qa.md)) PASS. Report: [S06.md](S06.md).
