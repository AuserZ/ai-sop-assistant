# S13 QA verification report — responsive three-menu experience

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S13 — Responsive three-menu experience (`C1`/`D1`/`D5`/`U1`/`U4`, `ADR 20`, Phase 3 exit; [ui-design-system.md](../ui-design-system.md)) |
| Candidate / branch | `4b8dd063df27e83358a290012e19a4ead34e8996` (tree `5f9e5f8e4337273cbb3067cb190169ea17e5115b`) on `codex/s13-responsive-shell` (base `27a7a043ee750691196b05183df499c755acc4d0`) |
| Owners / verifiers | Implementer: `principal-fullstack-engineer`; QA Pass 1 (static E2E compatibility, compiled CSS cascade, 7-axis design gate & security preflight): `qa` |
| Versions / environment | Windows 11 host, Node `v26.13.0`, Next.js `16.4.6` (`webpack`), Tailwind CSS `4.3.5`, `lucide-react@1.82.0`, `@tanstack/react-table@9.3.1`; `test:db`, `test:browser`, hosted CI, and `security-expert` deferred per 23 Nov 2026 instruction |
| Date / overall result | 27 November 2026 — **Pass 1 PASS** (all 5 findings `Q-S13-1`..`Q-S13-5` closed; eligible for `IMPLEMENTED`, **NOT** `VERIFIED` until `test:db`, `test:browser`, hosted CI, and `security-expert` pass before V01) |

## Implemented changes reviewed (concise)

- **Design system & primitives:** `package.json`, `package-lock.json` (`lucide-react@1.82.0`, `@tanstack/react-table@9.3.1`, 0 new advisories), `src/app/{layout.tsx,globals.css}`, `src/components/ui/primitives.tsx` (Clinical Precision 5-token palette, offline `"Inter"`/`"JetBrains Mono"` stacks, `.tabular-nums`, 8-state `Button`/`Input`/`Select`/`StatusBadge`/`SurfaceCard`/`BrandMark`, explicit `ButtonSize` without conflicting `px-*`, display-less `textLinkBaseClassName`, `:focus-visible`, `:active scale(0.97)`, `prefers-reduced-motion` incl. `.animate-spin`).
- **Responsive three-menu shell:** `src/components/layout/{navigation.ts,app-shell.tsx}` — fixed `240px` desktop sidebar + mobile compact header & fixed bottom tab bar (`>= 44px` targets), strictly 3 Admin / 2 Staff menus (`Chat`, `List Document SOP`, `User Management`), nested `/documents/[id]/verify` mapped to `"documents"`, zero 4th menu or deferred P1/P2 controls.
- **Refactored Phase 1–3 screens & tests:** `src/app/{page,sign-in/page,accept-invitation/page,documents/page,documents/[id]/verify/page}.tsx`, `src/components/{auth,chat,documents,verification,users}/*` (single-DOM TanStack Table v9 on Documents & Users collapsing into stacked mobile cards without duplicate `data-testid`s, Chat Citation Inspector side pane with dynamic status badge, 50/50 desktop / stacked mobile verification workspace), `tests/unit/shell.test.ts` (`6/6`), `tests/e2e/s13-experience.spec.ts`.

## Executed checks (Pass 1 — post-fix)

| Check / acceptance item | Exact command or scenario | Result | Evidence / SHA / run ID | Explicit limit |
| --- | --- | --- | --- | --- |
| PRD integrity | `node .codex/scripts/check-prd-integrity.mjs` | **PASS** | Both protected PRDs unchanged (exit `0`) | Local working copy |
| ESLint | `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` (exit `0`) | Static only |
| Typecheck | `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` (exit `0`) | Static only |
| Unit & contract suite | `npm.cmd test` | **PASS** | `25/25` files, `130/130` tests (`shell.test.ts` `6/6`, Tier A `50/50`) | Unit layer only |
| Production build & compiled CSS audit | `node ./node_modules/next/dist/bin/next build --webpack` + CSS audit (`6986069c0acea98a.css`) | **PASS** | Clean build, `0` Google Font fetches, `reduced-motion-spin: true`, `0` Tailwind cascade collisions | No live runtime smoke |
| Static XSS, anti-slop & 8-spec E2E compatibility | Scan across `src/` + line-by-line audit of `auth`, `documents`, `library`, `deletion`, `verification`, `workflow`, `chat`, `users`, `s13-experience` specs | **PASS (static)** | `0` `dangerouslySetInnerHTML`/`innerHTML`/`eval`/emojis/`ease-in`/purple blobs; all `Sign out`, `Your account`, `<= 3` links, `data-testid`, `data-rendered-*`, `data-chat-stage` contracts intact | Live browser (`test:browser`) deferred |
| PG `test:db`, Playwright `test:browser`, hosted CI & `security-expert` | `npm run test:db`, `npm run test:browser`, GitHub Actions, deferred Security review | **NOT RUN (deferred)** | Deferred for intermediate sprints (`S08`–`S16`) per 23 Nov 2026 instruction | Mandatory before marking `VERIFIED` / V01 |

## Findings, fixes & reruns

| ID | Severity / area | Trigger & verified fix | Rerun verdict |
| --- | --- | --- | --- |
| `Q-S13-1` | **Blocker** / Tailwind v4 CSS cascade (`primitives.tsx`, `upload-panel.tsx`) | `.inline-flex` emitted after `.hidden` kept `"Back to account"` visible at `320px`, breaking `deletion.spec.ts:173-174` (`<= 3` links). Exported display-less `textLinkBaseClassName` and used `${textLinkBaseClassName} hidden lg:inline-flex` + unit lock in `shell.test.ts`. | **CLOSED** |
| `Q-S13-2` | **Major** / Button padding cascade (`primitives.tsx` + 8 callers) | Hardcoded `px-4` in `buttonBaseClassName` overrode `.px-2`/`.px-2.5`/`.px-3` on compact buttons & `320px` header `"Sign out"`. Added mutually exclusive `ButtonSize` (`default`/`sm`/`compact`/`icon`) + unit lock in `shell.test.ts`. | **CLOSED** |
| `Q-S13-3` | **Major** / E2E hydration race & cleanup (`tests/e2e/s13-experience.spec.ts`) | Asserted hash stripping before React hydration and lacked `finally` Staff reactivation fallback. Awaited `getByLabel("Name")` visibility first and added `finally` API reactivation. | **CLOSED** |
| `Q-S13-4` | **Minor** / Citation Inspector badge & loading state (`chat-workspace.tsx`) | Hardcoded `"ACTIVE"` badge on error and never set `loadingHistory(true)` before `fetchConversationDetail`. Mapped badge from `inspectedCitation.status` (`ready`/`loading`/`error`) and set `setLoadingHistory(true)`. | **CLOSED** |
| `Q-S13-5` | **Minor** / Reduced motion (`src/app/globals.css`) | Added `.animate-spin { animation: none; }` under `@media (prefers-reduced-motion: reduce)`; verified in compiled CSS. | **CLOSED** |

## Residual limits & open gates

- Live Playwright browser execution (`npm run test:browser`, incl. `s13-experience.spec.ts` and all 8 existing specs), real PostgreSQL `test:db`, hosted CI, Pass 2 QA closure, and deferred `security-expert` review remain mandatory before marking S13 `VERIFIED` and entering V01.
- Pre-existing 4 moderate dev-chain `drizzle-kit` -> `esbuild` (`GHSA-67mh-4wv8-2f99`) advisories and unchanged PRD Section 16 open gates remain open in [PLANS.md](../../PLANS.md).
