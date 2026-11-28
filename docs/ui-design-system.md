# UI Design System — Option 1: Clinical Precision (Anti-Slop Edition)

Status: Approved UI direction (Design 1 selected + `anti-slop-design` skill applied on 23 November 2026)
Skill baseline: [`.agents/skills/anti-slop-design/SKILL.md`](../.agents/skills/anti-slop-design/SKILL.md)
Applies to: Phase 3 UI implementation (`S11` Chat, `S12` User Management, `S13` Responsive Three-Menu Experience) and visual alignment of existing Phase 1 screens (`documents`, `verify`, `sign-in`, `accept-invitation`).
Subordinate to: [AI SOP Assistant — Technical Product Req.md](<../AI SOP Assistant — Technical Product Req.md>) (ADR 20, Section 11, Requirement IDs C1–C5, D1–D5, U1–U4). This guide does not amend the approved PRD.

## 1. Visual DNA & 5-Token Foundation

Light-first, high-clarity enterprise precision built on Tailwind CSS + `shadcn/ui`, engineered to pass the `anti-slop-design` 7-Axis Quality Gate.

```css
:root {
  /* 5 Foundation Tokens */
  --bg-canvas: #f8fafc;
  --bg-surface: #ffffff;
  --bg-surface-subtle: #f1f5f9;
  --border-subtle: #e2e8f0;
  --border-hover: #cbd5e1;

  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #64748b;

  --accent-primary: #1d4ed8;       /* Cobalt — >= 6.7:1 contrast with white */
  --accent-primary-hover: #1e40af;
  --accent-foreground: #ffffff;
  --accent-soft: #eff6ff;
  --accent-border: #bfdbfe;

  /* Nested Geometry: R_inner = max(0, R_outer - padding) */
  --radius-sm: 6px;   /* Controls inside 12px/16px-padded cards */
  --radius-md: 8px;   /* Primary inputs, nav links, citation chips */
  --radius-lg: 12px;  /* Top-level cards, tables, modals */

  /* Motion (Emil Kowalski Matrix) */
  --ease-out-snappy: cubic-bezier(0.23, 1, 0.32, 1);
  --duration-instant: 0ms;    /* 100+/day actions: nav switch, row select */
  --duration-control: 140ms;  /* Buttons, inputs, hover borders */
  --duration-drawer: 200ms;   /* Citation drawer, modals */
}
```

### Semantic Status Tokens (Text + Color Always Paired — Never Color-Only Dots)

| Lifecycle / Account State | Background | Text | Border |
| --- | --- | --- | --- |
| `ACTIVE` / `Active` | `#ECFDF5` | `#065F46` | `#A7F3D0` |
| `PENDING_VERIFICATION` / `Invited` | `#FFFBEB` | `#92400E` | `#FDE68A` |
| `PROCESSING` / `UPLOADED` | `#EFF6FF` | `#1E40AF` | `#BFDBFE` |
| `FAILED` / `REJECTED` / `DELETED` / `Inactive` | `#FEF2F2` | `#991B1B` | `#FECACA` |

## 2. Typography & Spatial Geometry

- **Maximum 2 Font Families:**
  - *UI & Headings:* `Inter` (fallback system sans). Tight heading tracking (`-0.02em`), relaxed body leading (`1.6`).
  - *Codes, Limits, Dates & Telemetry:* `JetBrains Mono` (fallback system mono) with `font-variant-numeric: tabular-nums` enforced on every SOP code, page number, numeric limit, timestamp, and duration.
- **Sentence Case Everywhere:** Never use tracked-out uppercase eyebrows (`OVERVIEW`, `ANALYTICS`) or all-caps table headers. Use crisp sentence case (`Title`, `Type`, `Uploaded by`, `Uploaded`, `Status`, `Actions`).
- **Reading Width:** Cap chat answer paragraphs and prose explanations at `65ch`–`72ch` (`max-w-[68ch]`).
- **Strict 4px / 8pt Grid:** Card padding minimum `16px` (`p-4`), section gutters `24px` (`gap-6`), control padding `8px 12px` or `8px 16px`.
- **Optical Icon Alignment:** Unified `1.5px`-stroke Lucide vector SVGs (`16px` for `14px` text, `gap-2`). Zero raw emojis anywhere in the UI.

## 3. Core UX Axioms & Anti-Slop Prohibitions

- **1-to-3 Rule:** Every screen header or card has **1 unmistakable primary action** and **at most 3 secondary controls**.
- **Single Source of Truth:** Exactly one brand mark, one page-level search/filter bar per view, and zero fabricated vanity KPI cards.
- **Cognitive De-Clutter:** Strip redundant helper sentences beneath self-explanatory buttons, remove decorative status dots without text labels, and avoid wrapping single inputs or single lines in ghost bordered cards.
- **8-State Interactive Primitives:** Every interactive button/control supports:
  1. Default
  2. Hover (`140ms cubic-bezier(0.23, 1, 0.32, 1)`, never `ease-in`)
  3. Focus-Visible (`2px solid #1d4ed8`, `outline-offset: 2px`; never `outline: none` without replacement)
  4. Active / Press (`transform: scale(0.97)` at `60ms ease-out`)
  5. Disabled (`opacity: 0.5`, `cursor: not-allowed`)
  6. Loading (accessible spinner + `aria-busy="true"` + truthful status label)
  7. Error (clear inline message with recovery action, `role="alert"`)
  8. Success (explicit confirmed state with accessible status announcement, `aria-live="polite"`)
- **Reduced Motion:** Honor `@media (prefers-reduced-motion: reduce)` by disabling transitions and press scaling.
- **High-Frequency Zero-Latency Rule:** Sidebar navigation switches, table row clicks, and citation tab switches run at `0ms` (instant).

## 4. Navigation Shell (Strictly 3 Menus)

Never add a 4th top-level menu (no dashboards, analytics, settings hub, or P1 past-chat reopen sidebar).

- **Desktop (`>= lg`):** Fixed `240px` left sidebar (`bg-white border-r border-slate-200`) containing:
  1. Single brand mark (`AI SOP Assistant` with geometric SVG emblem).
  2. Exactly 3 navigation items (`1.5px` Lucide icons, subtle `1px` hairline active state):
     - **Chat** (Admin & Staff)
     - **List Document SOP** (Admin & Staff)
     - **User Management** (Admin only; hidden for Staff, enforced server-side)
  3. Bottom account block with geometric monogram identicon, user name, explicit role text (`Admin` or `Staff`), and sign-out action.
- **Mobile (`< lg`):** Compact top header + bottom tab bar strictly matching permitted menus. All mobile touch targets are at least `44x44px`.

## 5. Screen Blueprints

### Chat (`S11`, `C1`–`C5`)
- **Single Page-Level Header:** `Current session` + indexed ACTIVE count + single `New session` secondary button.
- **Centered Reading Lane (`max-w-[68ch]`):** Current-session messages only.
- **Slide-Over Citation Inspector (`w-80` right pane on desktop, stacked sheet on mobile):** Triggered on citation click; displays verified SOP code, title, section, page, literal excerpt, active verification metadata, and single primary button (`Open original PDF` via short-lived authorized signed URL).
- **Truthful SSE Progress Panel:** Allowlisted pipeline stages (`Retrieving` → `Reranking` → `Generating` → `Validating`) with `aria-live="polite"`. Never streams unvalidated answer tokens.
- **Three Distinct Terminal Outcomes:**
  1. *Supported Answer:* Numbered steps with tabular numeric limits preserved verbatim + clickable verified source chips.
  2. *No Evidence (`C4`):* Exact literal string `No SOP found for this question` with zero citations.
  3. *Service Error:* Safe, non-leaking error banner (`role="alert"`) with explicit retry control, visually distinct from `No SOP found`.

### List Document SOP & Assisted Verification (`D1`–`D5`, `ADR 17`)
- **Unified Page Control Bar:** Single search input (`Search by SOP title or code`), optional single status filter (Admin only), and 1 primary Admin CTA (`Upload SOP`).
- **TanStack Table (Desktop) / Linear Cards (Mobile):** Sentence-case headers (`Title`, `Type`, `Uploaded by`, `Uploaded`, `Status`, `Actions`). Staff sees `ACTIVE` rows only. Actions obey the 1-to-3 rule (`Review & verify` primary for `PENDING_VERIFICATION`, `Open`, `Delete`).
- **Assisted Verification (nested under Documents):**
  - 50/50 split pane on desktop, clean vertical stack on mobile.
  - Left: PDF.js original/derivative preview with page controls.
  - Right: Extracted chunks with highlighted numeric/unit/table flags and explicit `Approve & activate` (primary) vs `Reject` (destructive secondary) controls. No auto-approval; OCR confidence is never presented as proof of accuracy.

### User Management (`S12`, `U1`–`U4`, Admin-only)
- Unified header with single primary CTA (`Invite user`) opening a clean inline/modal React Hook Form + Zod panel sending a single-use expiring Resend invitation (never displaying or emailing passwords).
- Directory table with sentence-case columns (`User`, `Role`, `Status`, `Last activity`, `Actions`) and explicit role-change / deactivate / reactivate controls.

## 6. Mandatory 7-Axis Pre-Emit Quality Gate (`S11`–`S13`)

Every Phase 3 UI PR must score `>= 4/5` on all 7 axes from `.agents/skills/anti-slop-design/SKILL.md`:
1. **Anti-Slop Purity:** Zero purple/indigo blobs, zero emojis as icons, zero vanity stats, zero single-word italic accents.
2. **UX Speed & 1-to-3 Rule:** 1 primary CTA per viewport section, max 3 secondary controls, unified page-level filter bar, zero duplicated metrics.
3. **Typographic Discipline:** Max 2 font families, `tabular-nums` on all numbers/dates/codes, body `<= 75ch`, sentence-case labels.
4. **Spacing & Geometric Math:** 4px/8pt grid, `R_inner = max(0, R_outer - padding)`, minimum `16px` card padding, optical icon-text centering.
5. **Micro-Interactions & Motion:** Standard transitions `< 200ms` `ease-out` (never `ease-in`), `0ms` for 100+/day actions, `:active` `scale(0.97)`, `prefers-reduced-motion` honored.
6. **Accessibility & Keyboard Flow:** Visible `:focus-visible` rings, semantic landmarks (`<nav>`, `<main>`, `<header>`), `<label>` on every input, `aria-label` on icon-only buttons, live-region announcements for SSE/errors.
7. **Mobile & Responsive Linearity:** Clean vertical stacking, zero accidental horizontal overflow (accessible scroll containers or card views for tables), minimum `44x44px` touch targets.

*Note:* Passing this heuristic gate complements — and never replaces — real contrast verification, keyboard/screen-reader testing, and Playwright E2E checks in `S11`–`S13`.
