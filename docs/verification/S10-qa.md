# S10 QA verification report — evidence-validated procedural answers and citations

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S10 — Evidence-validated procedural answers and citations (`C2`, `C3`, `C4`, `C5`, `ADR 12`, Phase 2) |
| Candidate / branch | `026e9f3562c9805638f003f4c6c2036e3192f5fb` (tree `b1c156ed2f2dfeab4ca348810a813d67d054f26c`) on `codex/s10-answer-validation` (base `8c0846459deb498b19b229fb735b406164120d19`) |
| Owners / verifiers | Implementer: `principal-fullstack-engineer`; QA Pass 1 (`validate-rag` + deferred security preflight/negative-boundary checks per 23 Nov 2026 instruction): `qa` |
| Versions / environment | Windows 11 host, Node >=24, Next.js 16.4.6 (`webpack`), Vitest 5.1.1; local Docker/PostgreSQL unavailable (`test:db`, hosted CI, `security-expert`, and Tier B live benchmark deferred/open) |
| Date / overall result | 23 November 2026 — **Pass 1 PASS** (after closing `Q-S10-1`..`Q-S10-5`; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, hosted CI, `security-expert`, and Tier B live-model gates pass before V01) |

## Implemented changes reviewed (concise)

- **Answer generation, validation & citation module:** `src/server/answers/{contracts,config,generator,deterministic,judge,citations,service,index}.ts` — private structured procedural candidate generator (passages-only input), deterministic schema/citation/URL/order/quantity/unit/comparator/sign/condition/table validator, separate independent claim-level LLM judge (`OPENAI_JUDGE_MODEL`), live DB `SnapshotIdentity` citation resolver via S09's `loadOriginalActivePassagesByIds`, exact `No SOP found for this question` fallback vs safe `ChatServiceFailure`, fail-closed model/SSRF config, and pre-/post-validation `lockCurrentUser`.
- **Benchmark & tests:** `docs/benchmarks/rag-benchmark-rubric.md` (Section 6 Tier A synthetic baseline), `tests/unit/answers.test.ts` (14 tests), `tests/unit/answer-benchmark.test.ts` (50-case Tier A synthetic benchmark), `tests/integration/answers.test.ts` (real PG + pgvector suite).

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| ESLint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` (exit `0`) | Static only |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` (exit `0`) | Static only |
| Unit & Tier A benchmark | `npm.cmd test` | **PASS** | `21/21` files, `108/108` tests (`answers.test.ts` `14/14`; `answer-benchmark.test.ts` `50/50` Tier A synthetic cases, `34/34` `100%` valid citations, `0` invented steps, `16/16` exact fallback) | Synthetic fixtures / mocked HTTP; no live PG or live OpenAI |
| Production build | `node ./node_modules/next/dist/bin/next build --webpack` | **PASS** | Compiled + TS + 7/7 static pages (exit `0`) | No runtime smoke |
| `ADR 12` / `C4` privacy & error separation | `service.ts`, `judge.ts`, `generator.ts`, `contracts.ts` | **PASS** | Candidate stays private until deterministic + judge + live citation + account checks pass; judge `FAIL`/`UNCERTAIN`/disagreement & provider outages return `service_error` (never `No SOP found` or draft text) | Live provider runtime deferred to Tier B / V01 |
| `C2` / `C5` deterministic & judge checks | `deterministic.ts`, `judge.ts`, `tests/unit/answers.test.ts` | **PASS** | All 5 Pass 1 findings (`Q-S10-1`..`Q-S10-5`) verified closed with negative unit tests | Non-blocking fail-closed note on prose-only quantities inside `mixed` chunks |
| `C3` / `D4` / `D5` citations & PG audit | `citations.ts`, static audit of `tests/integration/answers.test.ts` | **PASS (static)** / **NOT RUN (live PG)** | Full `SnapshotIdentity` recheck, partial revocation fails closed, PDF pages vs DOCX `null` omitted, clean PG `0000`–`0006` triggers/grants/isolation | Real PG `test:db` deferred until pre-V01 CI |
| PG `test:db`, hosted CI, `security-expert`, Tier B live benchmark | `npm run test:db`, GitHub Actions, deferred Security review, live OpenAI benchmark | **NOT RUN (deferred / open gate)** | Deferred per 23 Nov 2026 instruction; Tier B live model IDs/entitlements remain PRD Section 16 open gate | Mandatory before `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S10-1` | **Major** / Comparators & bounds (`deterministic.ts`) | Strict `<`/`>` flips (`< 80.0 °C` -> `> 80.0 °C`) and post-numeric `minimum`/`maximum` (`121.0 °C minimum` -> `maximum`) bypassed checks. Enforced strict comparators in `containsExactQuantityInText`/`extractBounds` + post-quantity min/max patterns + negative tests. | **VERIFIED FIXED** |
| `Q-S10-2` | **Major** / Table row binding (`deterministic.ts`) | Single-number named row mismatch (`Endotoxin limit is <= 1.3 uS/cm.`), `mixed`-chunk prose caption sweep, and multi-chunk prose+table false-positive risk. Enforced named row keys for `>= 1` number, capped `caption` to immediate title line, and passed `nonTableCorpus` + negative/positive tests. | **VERIFIED FIXED** |
| `Q-S10-3` | **Major** / Sign & compound conditions (`deterministic.ts`, `judge.ts`) | Dropped unary `-` (`-20.0 °C` -> `20.0 °C`, `SOP-101` -> `101`), dropped second `until` threshold, and dropped non-numeric `unless` clause bypassed checks. Captured unary `-` boundaries, required `.every(...)` on conditional thresholds, and required preserved conditional cues + negative tests. | **VERIFIED FIXED** |
| `Q-S10-4` | **Minor** / Lab units & judge unit boundary (`deterministic.ts`, `judge.ts`) | Added `µL`/`uL`/`µg`/`ug`/`ng`/`rpm`/`mm`/`cm`/`mbar`/`mmHg`/`sec`/`hrs`/`weeks`/`months`/`years`; replaced `cell.includes` `"g"`-in-`"mg"` with token-bounded `quantitySupportedInTable` + negative tests. | **VERIFIED FIXED** |
| `Q-S10-5` | **Minor** / Interleaved order & partial-revocation test (`deterministic.ts`, `answers.test.ts`) | Tracked `lastAnchorByDocument` (`Map`) for interleaved cross-document order inversions and added explicit 2-chunk partial-revocation unit test. | **VERIFIED FIXED** |

## Residual limits & open gates

- Real PostgreSQL + pgvector execution (`npm run test:db`), hosted CI, Pass 2 QA closure, and deferred `security-expert` review remain mandatory before marking S10 `VERIFIED` and entering V01.
- Tier B live-model evaluation and unchanged PRD Section 16 open gates (verified live OpenAI reranker/rewrite/answer/judge model IDs & balance, Product/QA scoring rubric & p50/p95 sign-off, company data privacy/residency approval) remain open in [PLANS.md](../../PLANS.md).
