# S09 QA verification report — verified ACTIVE hybrid retrieval and reranking

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S09 — Verified ACTIVE hybrid retrieval and reranking (`C2`, `ADR 10`, `ADR 23`, Phase 2) |
| Candidate / branch | `996d653dfc0384349eb4bb9c2bed1ae2cb33fa47` (tree `63c13dbee321a9c561f15c904dfbeb5677d8d0b3`) on `codex/s09-hybrid-retrieval` (base `526b9ae51f613450a29744379d39f9ec27e8d54a`) |
| Owners / verifiers | Implementer: `principal-fullstack-engineer`; QA Pass 1 (`validate-rag` + deferred security preflight/negative-boundary checks per 23 Nov 2026 instruction): `qa` |
| Versions / environment | Windows 11 host, Node >=24, Next.js 16.4.6 (`webpack`), Vitest 5.1.1, Drizzle 0.45.4, postgres-js 4.1.1; local Docker/PostgreSQL unavailable (`test:db` & hosted CI deferred per 23 Nov 2026 instruction) |
| Date / overall result | 23 November 2026 — **Pass 1 PASS** (after closing `Q-S09-1`..`Q-S09-5`; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, hosted CI, and deferred `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **Retrieval module:** `src/server/retrieval/{config,contracts,rewrite,search,rrf,rerank,service,index}.ts` — `ACTIVE`-only semantic (`OPERATOR(public.<=>)`) and keyword (`search_vector` `'simple'`) SQL queries sharing `activeChunkEligibilityPredicate()`, RRF deduplication with conflict fail-closed, strict ID-only reranker with post-rerank DB original-passage reload, bounded follow-up query rewriter, fail-closed model/SSRF config, and account-verified entry point.
- **Benchmark & tests:** `tests/fixtures/benchmark-50.json` (`v1.0.0`, 50 synthetic cases across 11 PRD Section 14 categories), `docs/benchmarks/rag-benchmark-rubric.md`, `tests/unit/retrieval.test.ts` (17 tests), `tests/unit/benchmark-dataset.test.ts` (2 tests), `tests/integration/retrieval.test.ts` (real PG/pgvector suite).

## Executed checks (Pass 1 — pre-push & post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (`EXIT_PRD=0`) | Local working copy |
| ESLint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` (`EXIT_LINT=0`) | Static only |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` (`EXIT_TYPECHECK=0`) | Static only |
| Unit tests | `npm.cmd test` | **PASS** | `19/19` files, `93/93` tests (`retrieval.test.ts` `17/17`, `benchmark-dataset.test.ts` `2/2`) | Mocked/synthetic providers; no live PG |
| Production build | `node ./node_modules/next/dist/bin/next build --webpack` | **PASS** | Compiled + TS + 7/7 static pages (`EXIT_BUILD=0`) | No runtime smoke |
| Benchmark fixture integrity | Read-only check verifying all `mustPreserveTokens` verbatim in `expectedChunkIds` | **PASS** | `0` missing tokens across all 50 synthetic cases | Synthetic fixture only |
| `C2`/`ADR 10`: Both SQL branches enforce `ACTIVE` snapshot constraints before `LIMIT` | Static SQL/trigger/grant audit of `search.ts` & `tests/integration/retrieval.test.ts` | **PASS (static)** / **NOT RUN (live PG)** | Shared `activeChunkEligibilityPredicate()` in both branches; `Q-S09-1` & `Q-S09-2` fixed in DB suite | Real PG `test:db` deferred until pre-V01 CI |
| `ADR 23`: Strict ID-only reranker, RRF identity, bounded follow-up rewrite, race & outage safety | `rrf.ts`, `rerank.ts`, `rewrite.ts`, `config.ts`, `service.ts`, `tests/unit/retrieval.test.ts` | **PASS** | Strict Zod + ID/dup check + post-rerank DB reload + `Q-S09-3`..`Q-S09-5` closed; no silent `"GPT-6 Luna"` substitute | Live OpenAI model entitlement remains open |
| PostgreSQL `test:db` / hosted CI / `security-expert` | `npm run test:db` (`tests/integration/retrieval.test.ts`), GitHub Actions, deferred Security review | **NOT RUN (deferred per user instruction)** | Deferred for intermediate sprints (`S08`–`S16`) per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S09-1` | **Blocker** / DB test (`tests/integration/retrieval.test.ts:204-214`) | `seedIndexedDocument` skipped `embedIngestionStage` when deterministic vector was passed, leaving `workflow_jobs.step = 3` and triggering `409 INVALID_WORKFLOW_ORDER` in `completeIngestionStage`. Fixed to always run `embedIngestionStage` first before overwriting `embedding` while `PROCESSING`. | **CLOSED** |
| `Q-S09-2` | **Major** / DB test isolation (`tests/integration/retrieval.test.ts:419,500`) | Shared OR tokens (`procedure`, `line`, `SOP`) could match leftover `ACTIVE` rows from earlier integration files under `--no-file-parallelism`. Scoped Test 1 keyword `LIMIT 1` and Test 3 delete-race (`finalTopK: 1`) queries to unique per-test `tag`. | **CLOSED** |
| `Q-S09-3` | **Minor** / Prompt fence (`rerank.ts`, `rewrite.ts`) | `JSON.stringify(...)` inside `<untrusted_*>` XML fences did not escape `<`. Added `escapeJsonForXmlFence` (`<` -> `\u003c`) + unit assertions. | **CLOSED** |
| `Q-S09-4` | **Minor** / Error classification (`rerank.ts`, `rewrite.ts`) | `response.json().catch(() => null)` misclassified body-read timeouts/aborts as `502` invalid output instead of retryable `503`. Separated `response.text()` (`503 RETRIEVAL_PROVIDER_TRANSIENT`) from `JSON.parse()` (`502 RETRIEVAL_*_INVALID_OUTPUT`) + unit tests. | **CLOSED** |
| `Q-S09-5` | **Minor** / Config validation (`config.ts`) | Merged `env` and caller `overrides` reported bad server env vars as `400` instead of `503`, and placeholder regex missed suffixed forms (`gpt-6-luna-preview`). Validated server env separately (`503 RETRIEVAL_CONFIG_MISSING`) and broadened regex to `/gpt[-_.\s]?6[-_.\s]?luna/i` + unit tests. | **CLOSED** |

## Residual limits & open gates

- Real PostgreSQL + pgvector execution (`npm run test:db`), hosted CI, Pass 2 QA closure, and deferred `security-expert` review remain mandatory before marking S09 `VERIFIED` and entering V01.
- Unchanged PRD Section 16 open gates (live OpenAI reranker/rewrite/answer/judge model IDs & balance, Product/QA scoring rubric & p50/p95 sign-off, company data privacy/residency approval) remain open in [PLANS.md](../../PLANS.md).
