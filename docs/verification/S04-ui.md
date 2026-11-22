# S04 UI delivery gate

Executed by the project-manager lead, not delegated. Final real-R2 click-through receipt:2026-11-22T11:39:48.617Z (18:39 Jakarta). User chose antislop during development with existing styling. Direction was declared before generation in [the upload contract](../private-uploads.md): ENERGY1 / RHYTHM1 / MOTION1, white/system typography, black primary action, underlined secondary links and one upload task.

Evidence: final production Docker app OCI index `sha256:c9c9b062f540ae4a9402e0e6a934479192cc6ed3eb659af3754e95a6cff65f61`, amd64 manifest `ab33a09bee732c8daf60b31f3bf711cd90f02be02072c1df984a585dbac23e91`. The app-only build exited0 in49.263s. Only label cursor CSS changed among the92 build inputs; all69 other production inputs match the verified30s-budget build. The lead's final real-R2 click-through exercised native file selection through its label, title-label focus/pointer, disabled-label not-allowed cursor, account loading/error Retry, pending/disabled upload actions, failed-transfer Retry upload, reload/Check upload, Choose another file, Back to account, anonymous Sign in and Staff denial. No uncaught page errors occurred. Controlled response delays/failures establish UI states, not a real provider outage. Earlier fixture browser regression passed15/15 in1.0min, including exact20MB and all10 auth/workflow journeys; final hosted regressions remain separate.

The lead inspected all five final screenshots: form at320/768/1280px, transfer error and saved320px state. Final checks covered keyboard focus, no horizontal overflow,200% text and a320×300 viewport; earlier browser cases also cover long filenames, Enter and44px buttons. Private synthetic fixtures, screenshots, scripts and receipt remain ignored; no real SOP, secret or signed URL is included. These checks establish measured Chromium behavior, not universal accessibility or physical-device coverage. Separate live R2 acceptance and original-byte proof passed in [S04 evidence](S04.md).

During this final pass, a five-second private observer expired while real finalization was still checking bytes. Its small-file acceptance observer was set to40s, outside the unchanged35s client bound. A subsequent Staff sign-in request timed out at30s; an unchanged isolated Staff check passed in1.919s and the complete unchanged gate then passed. The timeout's cause is unproven. The original cursor check found `default` on labels; source CSS now supplies pointer and disabled not-allowed states, both observed in the final pass. No application timeout or authorization assertion was relaxed for these UI checks.

Source SHA256 at this gate:

| File | SHA256 |
| --- | --- |
| `src/app/documents/page.tsx` | `f431f27e6dbfc2e6f32c76674e665f182248ec313599c4375cf73d4b4d37272a` |
| `src/components/documents/client.ts` | `42fb6992480f5eef9caa03c2d74b8c44482aeb92ff5aa590133aa6fbbcf60baf` |
| `src/components/documents/upload-panel.tsx` | `0978c0679e478bc748cab94e1a9b72961562b392942ebd309831bda89d93d503` |
| `src/components/auth/session-status.tsx` | `5c3dac52994c07229a78acf1682d0887b5b7eb1495b2da041871844bcd089231` |
| `src/app/globals.css` | `33299e7f63cae3a1dcffa49830f6725feccae4bc10b145ccfbae1ca243a072e6` |

Actual browser computed colors match the shared palette. WCAG sRGB calculations: black/white21.00:1; muted `#4b5563`/white7.56:1; input border `#6b7280`/white4.83:1; error `#991b1b`/white8.31:1; white/hover `#333333`12.63:1; white/active `#111111`18.88:1; white/disabled `#4b5563`7.56:1.

## Hard gate

- R-02 PASS: new page, component and client copy contains no em dash.
- R-03 PASS:320px long-filename/error/saved states have no horizontal overflow; tablet/desktop screenshots reflow correctly.
- R-17 PASS: no unsupported usage, customer, uptime or performance statistics appear.
- R-18 PASS: no testimonials, avatars or invented people appear.
- R-23 PASS: text-only existing product identity and the authorized document menu use no new visual assets or navigation structure.
- R-24 PASS: List Document SOP, Back to account and Sign in lead to existing pages and were exercised.
- R-25 PASS: measured text contrast exceeds4.5:1; input boundaries exceed3:1.
- R-26 PASS: fields, upload, retry, resume and navigation perform their actual handlers; no placeholder controls exist.
- R-27 PASS: anonymous/Staff/empty form, account/upload pending, validation/service errors and accepted states were exercised.
- R-28 PASS: no FAQ exists; none is needed for this task.
- R-32 PASS: Tab and Enter reach/activate native controls with visible focus; no custom modal, Escape action or focus trap exists.
- R-33 PASS: interface behavior/styles live in repository TSX/TypeScript, without external source/CSS patch scripts.
- R-34 PASS: existing light styling has no theme toggle or alternate theme requiring validation.
- R-35 PASS: production app built and ran; browser tests and the lead's recorded click-through exercised every new field/link/button.
- R-36 PASS: no security/compliance certification or invented performance/customer claim is displayed.
- R-37 PASS: existing styling, Design Read and dials were recorded before generation.
- R-38 PASS: copy describes the implemented upload/status behavior; screenshots use explicitly synthetic test content.
- R-39 PASS: native controls have visible labels, accessible names, focus and pointer/hover/active/disabled states. Language, title and main landmark exist; no motion or zoom restriction exists.
- R-40 PASS: no media, remote font or external browser script is introduced. Account loading/status reserve space; no downstream content is displaced. No unmeasured performance number is displayed.

## Purpose gate

- R-01 PASS: no gradient or glow appears.
- R-04 PASS: no decorative or generic icon appears.
- R-06 PASS: native system typography preserves the existing task interface without font downloads or ornamental labels.
- R-07 PASS: no decorative background pattern appears.
- R-08 PASS: no decorative arrow appears.
- R-09 PASS: no capsule badge or duplicated headline label appears.
- R-10 PASS: no glass effect appears.
- R-12 PASS: no shadow/elevation effect appears.
- R-13 PASS: no glow appears on any element.
- R-14 PASS: no feature cards or forced grid appears.
- R-19 PASS: static feedback matches MOTION1; no animation exists.
- R-22 PASS: no generic illustration appears.

## Liveliness

- Dials PASS: ENERGY1 / RHYTHM1 / MOTION1 were explicit before generation.
- Consistency PASS: calm monochrome, one form column and immediate state feedback match the dials.
- Focal point PASS: each state has one task heading and primary upload/retry/next-file action.
- Whitespace PASS: spacing separates title, file, guidance and outcome; screenshots verify narrow and wide structure.
- Accent PASS: solid black marks the primary action; dark red accompanies written errors only.
- Motif PASS: SOP title, exact filename and explicit acceptance/queue wording repeat the document lifecycle context.
- Design Read PASS: the pre-generation direction and user preference are recorded in the upload contract.

## Craftsmanship

- C-1 PASS: typography, monochrome action and one-column spacing preserve the user's existing styling and serve upload tasks.
- C-2 PASS: every new interactive control has exercised selection, submit, retry, resume or navigation behavior.
- C-3 PASS: only task context, fields, status and recovery actions appear; no filler section exists.
- C-4 PASS: loading/error/saved states, narrow/short viewport, long names and keyboard interaction remain usable in tested Chromium.
- C-5 PASS: no testimonial, statistic or claim is fabricated.
- R-05 PASS: the layout follows the upload task and its actual outcomes, without a marketing template.
- R-11 PASS: modest input/button corners and unboxed links avoid pill repetition.
- R-15 PASS: actions say Upload SOP, Retry upload, Check upload, Choose another file, Retry, Sign in and Back to account.
- R-16 PASS: no marketing buzzword appears.
- R-20 PASS: Admin-only SOP guidance, exact filenames and honest queued status identify this app's document workflow.
- R-21 PASS: existing light styling is preserved; no required theme control was deferred.
- R-29 PASS: black/white and neutral grays form the base; dark red carries written errors.
- R-30 PASS: no external product assets, brand or composition were copied.
- R-31 PASS: every major visual choice has a written purpose in the upload contract and this report.

Code-comment supplement: PASS. New UI uses domain names and native elements without decorative, narrated-step or placeholder comments. This was authorized implementation work, not a comment-only cleanup.
