# S05a independent QA

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Requirement / predecessor | D3; ADR04 and the user's22 November2026 temporary local-OCR follow-up; S04 VERIFIED, closuref81a8d3 |
| Authorized increment | Standalone offline CPU PaddleOCR Docker worker, synthetic numeric/unit OCR and bounded failure/sandbox verification |
| Candidate | Published `4f1bf000b004e8a488a73268aed6635e8cb88423`, tree `24cb68484f7474447bc9bb35d283ad2eaa7bf8c7`, on `codex/s05-document-processing`; initial `1eb4adeaf8a5ed5e44e61726fb90a86972f86f14` is historical |
| Local worker image | `sha256:8bfe1e3ce933e57f429c34275252bb418b09123a9de9592dc559755f909852e5` |
| Eight build-input manifest | `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7` |
| Pipeline / models | `local-paddleocr-v1`; `PP-OCRv5_mobile_det` and `en_PP-OCRv5_mobile_rec`; all output remains UNVERIFIED |
| QA ownership / environment | Source/assertions read-only; only this report edited. Host Node read-only consistency checks; no Docker/build/provider/key/private-configuration access or suite execution by QA. |
| Date |22 November2026, Asia/Jakarta |
| Result | Independent QA PASS for the bounded S05a Docker increment at4f1bf00: source/artifact/receipt checks and both exact hosted jobs pass. QA review completed; independent security remains BLOCKED by its actual role usage limit. Full S05 remains IN_PROGRESS. |

The protected technical PRD/PDF, shared/QA guides, current S05 checklist, testing guide and [temporary setup contract](../paddleocr-setup.md) govern this review. The original Google decision remains visible and unchanged in the protected PRDs. QA does not replace the limited DevOps/security roles or infer any approval from their unavailable sessions.

This component does not integrate an HTTP/API service, application schema, document/job lifecycle, n8n orchestration, source activation, chunking or embeddings. Native/scanned/mixed PDF and DOCX processing, faithful tables/sections, preview/source mappings, duplicate-job behavior and complete S05 acceptance are outside the finished increment and remain unverified. No browser/stream test substitutes for those missing pipeline features.

## Independent checks actually performed

QA read the Dockerfile/context allowlist, Compose, engine/CLI, model downloader/manifest, wheel resolver/inputs/lock/source metadata, bounds cases and container verifier. Read-only Node assertions examined only the specifically permitted sanitized receipts and public source files. Protected integrity passed before report edits.

| Check / requirement | Observed result | Evidence and limit |
| --- | --- | --- |
| Build-input correspondence | PASS8/8 actual file hashes and SHA-256 of the ordered JSON inventory reproduce the recorded manifest | Inputs are `.dockerignore`, Dockerfile, requirements.lock, models.json, download_models.py, engine.py, cli.py and verify_cases.py. The separately reviewed verifier/Compose/CI are not image COPY inputs. |
| Wheel lock/source correspondence | PASS71/71 package name/version/hash tuples, unique normalized names; pinned PaddleOCR3.7.0, PaddlePaddle3.3.1, PaddleX3.7.2 and Pillow13.0.0 | All recorded artifact URLs are HTTPS wheel files under files.pythonhosted.org. QA did not resolve or download packages. Lock/source consistency and the lead's hash-checked build are distinct evidence. OS packages resolve at build; no bit-for-bit reproducibility or vulnerability-audit claim follows. |
| Model preparation/source fidelity | PASS source review; two explicit archives total12,943,360 bytes, exact sizes/SHA checked before extraction; six required local files hashed | Archive handling rejects absolute/traversal/backslash paths, wrong roots, nonregular/nested/unexpected/duplicate entries and excessive expansion. These source observations do not constitute adversarial archive execution. Archive hashes were observed by the lead over configured HTTPS downloads, not publisher-signature verification by QA. |
| Meaningful actual OCR assertion | PASS source review and saved receipt | `self_test()` compares the complete ordered recognized text array exactly to four literal lines: `SYNTHETIC SOP TEST`; `Pressure 2.5 bar`; `Wait 10 minutes`; `Temperature 75 C`. No case/spacing/decimal/unit normalization or confidence-based correction can turn another result into success. |
| Result fidelity/bounds | PASS source review and recorded bounds result | Preserves literal text/order, four-point boxes, finite confidence0–1 and model/package/input identity; limits1,024 segments,32,768 UTF-8 bytes per text and1,000,000 JSON bytes. Width/height-bound finite coordinates and total result size are enforced. Empty recognition remains unverified output, not automatic evidence approval. |
| Input safety | PASS inspected implementation and exercised bounds cases | Only bounded single-frame PNG/JPEG data;4,000,000 bytes/12,000,000 pixels. Explicit input paths must be absolute direct children of `/input`; O_NOFOLLOW/O_NONBLOCK plus fstat reject final symlinks/nonregular files without blocking on FIFO input. Actual executed coverage limits are below. |
| Deadline fidelity | PASS source review and saved signal/hard-kill cases | Real SIGALRM interrupts sleeping work in the bounds case; production CLI has75s alarm. GNU timeout entrypoint is80s with5s forced-kill allowance. The hard-kill case scales to1s+1s and uses a real TERM-ignoring20s child, expected exit137; it is not a measurement of an80s production inference. |
| Offline sandbox | PASS inspected verifier and saved per-case attestations | Each actual container must be nonroot10001, network:none, root read-only, unprivileged, all capabilities dropped, no-new-privileges,2GiB/2CPU/128PIDs/128MiB shm/256MiB `/tmp`, no ports and Docker log driver none. Only the two final PNG/JPEG cases may have one dedicated synthetic-input read-only bind; all others forbid non-tmpfs mounts. No application/DB/R2 credential or socket is passed. QA did not inspect a live container. |
| Error/output handling | PASS source review and recorded negatives | CLI emits bounded safe code JSON for known/general failures; inference imports/output are muted. Tests log synthetic counts/hash/model identities instead of procedure text. This is not a universal claim about every fatal OS/library failure. |
| Comment/name hygiene | PASS scoped read-only review | Worker/domain names express the flow; no decorative comments, narrated blocks or vague TODOs were found. No code/comment cleanup was performed. |

The consistency checks used Node `fs.readFileSync`, `crypto.createHash('sha256')` and `assert/strict`; the wheel check parses every checked-in `name==version --hash=sha256:...` line and compares it to `requirements.sources.json`. No Python import, model load, Docker command, provider request or resolver execution was performed by QA. Runtime commands below are attributed to the lead's saved execution.

## Initial actual execution and provenance correction

The initial sanitized receipt at2026-11-22T12:58:41.339Z (19:58:41.339 Asia/Jakarta), raw SHA-256 `88e0255e3d7b731fb455dea33fd57705a6f7f3d724a16169e85a7669dd6d20d5`, records PASS for project `ai-sop-s05-paddleocr-20261122`, historical image `1beb8c94c93276d487624c704cdc3c6f39a71a2e667e1c6ac98ff5517f5e0608`, historical8-file manifest `00917d29de68de57d3e72654532ac4cefb22bede24b29358577bc94c51880610` and five removed containers. Build inventory receipt at12:55:43.473Z has raw SHA-256 `f00dad19f426571459528c1115fc5aca4cb9bf38e1142e4e744a18d6d3b7164e`; QA independently matched both inventory arrays and recomputed their manifest. This inventory does not itself prove build success; actual build exits/image creation are attributed to [the lead's evidence](S05.md).

| Initial actual container case | Recorded result / expected exit | Duration including container operations |
| --- | --- | --- |
| Offline synthetic numeric/unit OCR | PASS,0; exact4 lines/segments, UNVERIFIED |16.268s |
| Input/result/model/deadline bounds | PASS,0;10 named checks |2.025s |
| Empty model cache | Expected safe FAIL/1, OCR_MODELS_UNAVAILABLE |3.031s |
| URL input | Expected safe FAIL/1, OCR_INPUT_PATH |2.932s |
| Uncooperative child/hard kill | Expected137 with no JSON payload |3.928s |

Independent receipt assertions require all five case identities, exits0/0/1/1/137, positive durations, sandbox PASS per case, correct positive hash/packages/models, exact bounds count, negative error codes, image/source identity, cleanup5, network:none,0 secret mounts/ports and `fullIngestionClaimed=false`. The positive PNG hash is `d04ad43ba0b0329882381422e421dd7f97008a73b61f693a47a58fb6a6c8f79c`.

The10 bounds checks actually execute valid PNG decoding, empty/oversized bytes, malformed/PDF input, an expanded12,004,000-pixel PNG, URL/foreign paths, missing and corrupt model data, literal-text/finite-result checks, excessive output and an actual interrupting signal. Confidence NaN/out-of-range and malformed polygon failures are explicit. These checks are more than a PASS count or screenshot; QA inspected the rejecting helper and each operation/assertion.

The lead identified that the first verifier inspected an image tag but also created containers by that mutable tag. It now creates by the already-inspected `imageMetadata.Id` and independently requires each actual `container.Image` to equal it. QA inspected both lines; current verifier SHA-256 is `51c1c2b11d2e8af2f0ecaa820fafa398a321773cdcfa6050dff62d6d33d810f3`. The8 worker build inputs/image are unchanged. The first run remains historical and is not relabeled as execution of the stronger verifier. A fresh five-case run and final published-candidate/CI binding are required for that narrow provenance correction.

## Limits and remaining gates

At the initial checkpoint, the positive recognized fixture was only an English PNG generated inside the self-test. Mounted regular-file/JPEG success and actual symlink/FIFO/directory rejection were coverage gaps, subsequently exercised in the expanded run below. Multiframe rejection, every individual segment/coordinate threshold and adversarial archive extraction remain source-inspected guards without separate execution proof. No Indonesian, multilingual, rotated/scanned/mixed PDF, table, representative-company quality, p95 latency or production-capacity claim follows from the four-line fixture.

At that checkpoint the corrected-verifier runtime/immutable-image receipt, final exact published revision and hosted OCR/foundation jobs remained pending. The following section records the actual expanded local evidence without upgrading its scope to full-S05 acceptance. Security review remains BLOCKED by its actual role usage limit; QA passing its assigned checks cannot replace that review or permit full-S05 VERIFIED status. OpenAI entitlement/dimensions, production OCR/language/table policy, company-data approval, source/job mappings and the remaining pipeline gates stay open. No S04 object/job/configuration/volume reset, real SOP processing, deployment or model/permission change was performed by QA.

## Expanded real file-input verification

The lead rebuilt the worker test layer and reran the completed verifier. QA read only the newly permitted sanitized `s05-ocr-input-receipt.json` and `s05-ocr-input-build-receipt.json`, plus the changed public source. The build receipt records actual build CLI exit0 and image `sha256:8bfe1e3ce933e57f429c34275252bb418b09123a9de9592dc559755f909852e5`. The run receipt at2026-11-22T13:12:45.804Z (20:12:45.804 Asia/Jakarta) binds that same image, source inventory and verifier SHA-256 `2003b2ebadc6c3ae3143112363fc734b62b19768b19d140d1c679efef35d3ea0`.

| Expanded evidence identity | SHA-256 |
| --- | --- |
| Actual run receipt | `d3754dae7a3155301ff6d999ce946884e25e978b2d34488496ee9c7086090ec6` |
| Build receipt | `e242e43e81b5587c48221672ec47af579f28ba8b06e72144c535564bbca60a39` |
| Eight actual build inputs, ordered JSON inventory | `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7` |

QA independently required build exit0, exact matching image IDs, equal8-file inventories and manifest, current source hashes and verifier hash, all case identities/expected exits, positive recorded durations, sandbox PASS for each, cleanup8, network:none, zero secret mounts/ports and no ingestion claim. The recorded build-log SHA is a saved reference; the private raw build log was not read.

| Actual expanded case | Result / expected exit | Measured duration including container operations |
| --- | --- | --- |
| Self-test | PASS/0, exact4 lines |17.028s |
| Synthetic fixture export | PASS/0,2 files |2.670s |
| Actual `--input /input/page.png` | PASS/0, exact4 lines/SHA/UNVERIFIED |9.160s |
| Actual `--input /input/page.jpg` | PASS/0, exact4 lines/SHA/UNVERIFIED |9.321s |
| Bounds including real symlink/FIFO/directory | PASS/0,11 checks |2.067s |
| Missing models | Expected safe FAIL/1 |2.256s |
| URL input | Expected safe FAIL/1 |3.412s |
| TERM-ignoring child | Expected forced exit137 |4.137s |

The fixture-export case generates only the same synthetic image as PNG/JPEG inside the pinned container. Its base64 data is consumed to create two specifically named files in a fresh temporary directory; the saved fixture-export payload contains only result/count. Source inspection confirms only the two real-input cases receive that directory as one read-only `/input` bind, with actual destination/type/read-only/source-basename checks. Other cases require zero non-tmpfs mounts. The bounds case creates actual Linux symlink, FIFO and directory entries on isolated `/input` tmpfs and requires each to fail with OCR_INPUT_PATH; FIFO is opened nonblocking before the regular-file check.

For both real-input results, QA independently checked literal texts, order0–3,1100×420 dimensions, UNVERIFIED, pipeline version, finite confidence0–1 and finite four-point boxes inside the image. The verifier compares each result's SHA to the actual exported bytes it writes. Recorded PNG SHA is `d04ad43ba0b0329882381422e421dd7f97008a73b61f693a47a58fb6a6c8f79c`; JPEG SHA is `18f8385fbafd7c3dd5670a6dc08baccc5f0ff6cf11bf534729fbe6278ac00d79`. There is no automatic text correction or activation.

The receipt records all8 owned containers removed. Host-file cleanup is a separate finally block that removes only the two known files and then their validated fresh temporary directory; it performs no recursive deletion. The lead reports process exit0 after that cleanup. The JSON PASS line is emitted before this final host cleanup, so the receipt alone is not an independent host-cleanup proof; exact successful hosted process completion remains the final corroboration. No private input directory, credentials, live provider runtime or Docker resource was accessed by QA.

Source/assertion and expanded local receipt/artifact consistency PASS. The initial five-case results, old image/manifest and earlier immutable-image correction remain historical evidence. Exact final published candidate and hosted OCR/foundation job verification are still pending. Independent security review remains separately BLOCKED; full S05 remains IN_PROGRESS.

## Exact published-source and copied-runtime binding

QA independently fetched GitHub metadata for run45026670726 and confirmed `head_sha=4f1bf000b004e8a488a73268aed6635e8cb88423`, commit tree `24cb68484f7474447bc9bb35d283ad2eaa7bf8c7`, attempt1, still in progress at this checkpoint. Read-only Git `cat-file --batch` checks bind all8 committed image-input blobs exactly to the expanded receipt's source hashes/manifest and bind the committed verifier exactly to `2003b2eb…`. The worktree was clean before this report update. No old candidate/run result is substituted for the final candidate.

The newly permitted sanitized `.local-secrets/s05-ocr-runtime-files.json`, raw SHA-256 `6bda2e54484646bba54805c7e96c9bfb4852126fb9baacdb244462feafb28732`, contains the six copied runtime source hashes from the lead's actual read-only image inspection. QA matched all6 to the exact committed blobs: requirements.lock, models.json, download_models.py, engine.py, cli.py and verify_cases.py. The map itself contains hashes rather than an embedded image ID; its image-inspection provenance is attributed to the lead, alongside the expanded run/build receipts that name the actual image. QA performed no Docker inspection. An initial strict JSON parse failed on this receipt's UTF-8 BOM; a BOM-aware decode then passed all6 unchanged hash assertions. This was a QA reader correction, not a product failure or relaxed source comparison.

Run45025398293 for initial1eb4ade was reported successful by the lead; immutable-ID-only run45025907843 was still running at the handoff. Both are historical and neither supplies final expanded-candidate acceptance. QA will inspect completed final OCR/foundation job metadata and decoded logs after the lead's completion signal. Security's separate actual usage block remains unchanged.

## Exact completed hosted OCR job

After the lead's completion signal for the OCR job, QA independently called `github_fetch_workflow_run_jobs` for `AuserZ/ai-sop-assistant`, run45026670726, and `github_fetch_workflow_job_logs` for job137221097795. The decoded OCR log contains81,060 characters/770 lines and prints the exact4f1bf000b004e8a488a73268aed6635e8cb88423 checkout. The `paddleocr` job and all9 step entries completed successfully, including build, verification, post-actions and Complete job. Foundation job137221097593 was still in browser journeys at this fetch; no final overall-run/foundation PASS is claimed here.

The actual hosted commands are:

```text
node .codex/scripts/check-prd-integrity.mjs
docker compose -f infra/paddleocr/compose.yml --progress plain build paddleocr
node infra/paddleocr/verify.mjs
```

Both protected originals pass. The build installs71 pinned hash-checked wheels, reports no broken requirements, prepares2 pinned models/6 files, and exports OCI index `sha256:d08be2d5e36e84b275cef9e5f173168dfc81e4a39040e6727aa0661bce042ad9` (platform manifest `sha256:b8f0a00c4296ddae4a116c60fe2f954c4a88fefdfafda51eec57638c7a88333a`). The verifier's actual image ID equals that exported index exactly. Its full8-file source inventory/manifest equals the final committed/local inventory `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7`. The hosted and local image IDs remain distinct builds; no bit-for-bit reproducibility claim is made. The pip root-user warning concerns the build stage; actual inference containers still require UID10001.

| Exact hosted OCR case | Result / exit | Duration including container operations |
| --- | --- | --- |
| Synthetic OCR | PASS/0, exact4 lines |10.434s |
| Fixture export | PASS/0,2 synthetic files |0.296s |
| Actual PNG input | PASS/0, exact4 literal lines/order/hash/UNVERIFIED |2.847s |
| Actual JPEG input | PASS/0, exact4 literal lines/order/hash/UNVERIFIED |2.894s |
| Bounds | PASS/0,11 checks including actual symlink/FIFO/directory |0.376s |
| Missing models | Expected safe FAIL/1, OCR_MODELS_UNAVAILABLE |0.277s |
| URL input | Expected safe FAIL/1, OCR_INPUT_PATH |0.271s |
| TERM-ignoring child | Expected137 |2.188s |

QA parsed the actual final JSON record and independently required exact manifest, build/run image equality, all case exits, sandbox PASS,8 removed containers, network:none,0 secret mounts/ports and no full-ingestion claim. Both PNG/JPEG outputs retain the expected input hashes and4 literal lines,1100×420 dimensions, UNVERIFIED, order0–3, finite confidence0–1 and finite four-point boxes within the image. No unhandled GitHub error marker occurs in the fetched log. Successful verification-step and job completion corroborate process exit0 after the final host-temp cleanup, resolving the earlier receipt-only cleanup limit. This does not prove production accuracy, recovery, real SOP processing or full ingestion.

## Separately approved embedding prerequisite

The lead relayed the user's explicit approval of `text-embedding-3-small` at1,536 dimensions. This is a later follow-up to the initial pending model/dimension checkpoint, not an inferred entitlement or an edit to either original PRD. QA read only the additionally permitted sanitized catalog and embedding receipts; no key/configuration, raw vector or provider request was accessed by QA.

| Saved prerequisite evidence | Observed fields / limit |
| --- | --- |
| Catalog receipt13:13:57.070Z; SHA-256 `51c704902a381d8d6f81071928566a6378589ff4af431b738e4d09e587f86da0` | GET /v1/models200,99 entries, small/large embedding candidates,0 inference calls, no SOP content. Catalog visibility alone did not establish inference/billing. |
| Synthetic embedding receipt13:21:04.556Z; SHA-256 `ca8206bcaedafe290871177ed458cd7cc29ff1a1f80714a1263a2018680216e3` | POST /v1/embeddings200 for approved small model, requested1,536 dimensions and recorded1,536 finite values;1 synthetic call,17 prompt/total tokens,2.772s; no SOP content. Input hash `39a78974a5e8a716688789f8f5f277988d698e5444540d178422f442de9ae033`; raw values were not provided to or recomputed by QA. |

The latter receipt reports PASS and a finite-vector norm near1; these actual-vector checks belong to the lead. Both saved records explicitly decline a balance claim, and the embedding receipt sets `fullIngestionVerified=false`. The specific synthetic endpoint access/model/dimension prerequisite now has saved runtime evidence; vector storage/schema compatibility, real pipeline indexing, quality/limits and company authorization remain open. No repeated embedding call was made for QA.

Final foundation-job/overall-run completion and independent security review remain the outstanding acceptance gates at this cutoff. The completed OCR job is source-bound evidence for the bounded Docker component; it does not mark full S05 VERIFIED.

## Completed exact foundation regression and final QA verdict

After the lead's final completion signal, QA independently refetched run45026670726 and its jobs, then fetched decoded foundation job137221097593 logs. [The exact hosted run](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45026670726), attempt1, is completed/success for `4f1bf000b004e8a488a73268aed6635e8cb88423`, tree `24cb68484f7474447bc9bb35d283ad2eaa7bf8c7`. Run start/update times are13:17:13–13:28:04Z on22 November2026 (20:17:13–20:28:04 Asia/Jakarta). Both required jobs pass: OCR9 step entries and foundation19 entries, all28 completed/success, including cleanup/post-actions/Complete job. No skipped, canceled or failing mandatory step is substituted with an earlier run result.

The foundation decoded log contains309,215 characters/3,894 lines and independently prints the same exact checkout. QA inspected its command/result sections, native storage controls,15 browser-case outputs, six fault records, automatic-restart conditions, POST controls, count-only snapshots and final cleanup; parsed-record assertions separately required the actual counts/outcomes. Primary GitHub calls used `github_fetch` for the run URL, `github_fetch_workflow_run_jobs` with run45026670726 and `github_fetch_workflow_job_logs` with foundation job137221097593.

| Exact hosted command / regression | Independently observed result |
| --- | --- |
| Pinned checkout/setup-node; `npm ci` | PASS exact final checkout and install;4 moderate dependency advisories remain reported, not a clean audit. |
| `npm run check:prd`; `npm run lint`; `npm run typecheck`; `npm run build` | PASS both originals, zero-warning ESLint, generated route types/TypeScript and optimized build. |
| `npm test` | PASS40/40 in9 files,3.38s. |
| `node --test infra/n8n/local-secrets.test.mjs` | PASS1/1, fail/skipped0. |
| `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` | PASS7/7, fail/skipped0. |
| Compose config/builds, PostgreSQL migration and `docker compose --profile verify run --rm --no-deps verify-db` | PASS migration application and48/48 DB cases across4 files,5.42s:18 documents,12 jobs,15 auth,3 foundation. No new ledger-count or full-S05-schema claim is inferred. |
| Native fixture verifier | PASS actual signed PUT/HEAD/GET200 with matching bytes, actual Authorization-signed SDK PUT/GET200/replay412, race200/412,9 cryptographic denials and5 gateway denials. Unsigned known object400, malformed signature/expiry/identity controls and cookie/Bearer/foreign-origin/public/explorer denials are visible. Credential/diagnostic markers0. Owned isolated container removed,0 persistent volumes created. This is fixture compatibility, not another live R2 call. |
| Proxy/fixture health, live/ready curl smoke and conversion profile | PASS in the completed smoke/database step; LibreOffice7.4.7.2 probe. Tool availability does not prove implemented S05 extraction/conversion. |
| Synthetic seed; `npm run test:browser` | PASS15/15 in50.2s:5 document,6 auth and4 workflow cases, including exact20MB, narrow layout, RBAC, safe retry, bounded/failed/slow-reader/reconnect streams. Email delivery is injected. |
| `node scripts/verify-workflow-runtime.mjs` | PASS all6 actual cases below; force-recreated fixture returns healthy. |
| `node infra/n8n/verify-redirects.mjs` | PASS each301/307 source once per mode; default destination2, no-follow destination0, forwarded canary0 in both. Actual native HTTP control remains separate from Queue Mode proof. |
| Always-run `docker compose --profile verify --profile conversion down --volumes --remove-orphans` | PASS; actual log removes all9 service containers,3 edge/database/workflow networks and disposable PostgreSQL volume; post-actions and Complete job also pass. This cleanup concerns the disposable hosted project, not the retained local R2/application state. |

| Actual hosted recovery case | Result | Duration |
| --- | --- | --- |
| Queued worker pause | PASS |11.361s |
| In-flight worker loss/fencing | PASS |34.896s |
| Redis interruption/durable work | PASS |72.507s |
| App restart/reconnect cursor | PASS |20.571s |
| Account deactivation/open stream | PASS |5.399s |
| Real60s proxy timeout/reconnect | PASS |71.773s |

The Redis record explicitly requires12,000ms minimum interruption after an active attempt, main/worker restart counts0→1 with both healthy and no manual queue-process start. It retains200,000ms=180,000ms bounded retry horizon+20,000ms allowance; other collector/production limits are unchanged. These existing synthetic probes use a judge stub/completion marker, not real SOP answers or actual LLM-judge validation.

At13:26:52.054Z, the final count-only execution snapshot contains13 JWT-bearing payload rows/54 JWT occurrences,0 orphan payload rows/private-key markers,2 queue hashes with0 JWT occurrences, and0 JWT/Bearer/private-key markers in all available final Docker/native-event logs. The earlier paused-worker snapshot explicitly defers that worker's native log. These observations do not establish zero transient persistence or a guaranteed pruning deadline. The recorded disposable PostgreSQL volume is subsequently removed. Existing S04 retention limits and moderate-dependency remediation remain open; successful CI does not erase them.

### Bounded acceptance handoff

Independent QA PASS for the S05a offline CPU Docker increment at `4f1bf000b004e8a488a73268aed6635e8cb88423`. Required QA proof now covers exact committed image/verifier inputs, local and hosted artifact identity, actual numeric/unit OCR through self-test and real PNG/JPEG input, malformed/oversized/local-path/model/result/deadline controls, inspected actual sandbox assertions, owned-container/temporary-file cleanup and both complete hosted jobs. No mandatory assigned QA check remains pending, and no demonstrated unresolved functional defect was found in this bounded review. Earlier initial-source/coverage/provenance checkpoints remain historical; their pending statuses are superseded by these executed results.

QA's completed verdict does not replace the independently usage-blocked security role. Security sign-off is still BLOCKED, so no full security/overall release approval is claimed. Full S05 remains IN_PROGRESS: native/scanned/mixed PDF/DOCX extraction, previews, faithful tables/section/source mappings, embeddings/storage/indexing, authenticated n8n pipeline and job/idempotency/source-eligibility acceptance are not implemented/verified by this component. The approved1,536-dimension synthetic endpoint probe remains prerequisite proof only. Company data, production OCR policy, deployment and V01/V02 remain gated.

Only this QA report was edited. QA made no source/assertion/index mutation, build, runtime/provider call or key/private-configuration read. Protected originals and report whitespace are checked after this update. Edits are held for the lead's closure staging; the lead owns final documentation/status and remaining acceptance decisions.


---

# S05b independent QA (working-tree checkpoint)

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S05b full SOP extraction, OCR, previews, chunking, embeddings, and n8n ingestion pipeline; D3, ADR04/05/08/11/21/22 |
| Branch / base HEAD | `codex/s05-document-processing` at `b9a259d0d5e096ecb1d382846f8e66f691b6e5a7` (uncommitted S05b working tree) |
| Working-tree S05b manifest | 53 modified/added files (excluding `docs/verification/`); ordered JSON SHA-256 `78e7dc08f7b8313f12151ab6110655c4ef345750451fa539eb8ce9118b16c34e` |
| QA ownership / environment | Independent `qa`; read-only source/test audit and local host Node checks on Windows PowerShell (`Node v26.13.0`, `npm.cmd`). Only this report edited; zero implementation/infra/CI/test edits. Docker Desktop pipe unavailable in sandbox — no Docker, PostgreSQL/pgvector, n8n, Playwright, or live provider calls executed. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **FAIL / BLOCKED for S05b closure** — `npm.cmd test` failed twice locally (`Q-S05b-1`), plus 1 HIGH real-runtime coverage gap (`Q-S05b-2`), 3 MODERATE defects/gaps (`Q-S05b-3`, `Q-S05b-4`, `Q-S05b-5`), and 1 LOW defect cluster (`Q-S05b-6`). All Docker/PostgreSQL/Playwright/hosted CI checks remain **NOT RUN**. Full S05 remains **IN_PROGRESS**. |

## Requirement-to-check matrix

| S05 criterion / ADR | Inspected implementation & tests | Local QA result | Runtime / CI gap |
| --- | --- | --- | --- |
| 1. Synthetic native PDF, scanned PDF, mixed pages & DOCX complete with faithful digits/units/tables/section provenance (D3, ADR04/05/21) | `src/server/ingestion/{extract,docx,chunker}.ts`, `infra/{paddleocr,conversion}/server.py`, `tests/unit/ingestion-{docx,extract,chunker}.test.ts`, `tests/integration/ingestion.test.ts`, `tests/e2e/documents.spec.ts` | **PARTIAL / FAIL** — `ingestion-{docx,extract,chunker}.test.ts` pass locally (8 tests), but `ingestion-chunker.test.ts:116` does not assert real overlap (`Q-S05b-3`), chunker can exceed `chunkPracticalMaxTokens` (1000), DOCX nested tables drop silently (`Q-S05b-6`), and scanned/mixed PDFs are mocked-only (`Q-S05b-2`). | Real `paddleocr/server.py` `POST /ocr`, `cli.py --stdin`, `convert-worker` `/pdf/render-page`, PostgreSQL `ingestion.test.ts`, and E2E scanned/mixed/rich-DOCX journeys **NOT RUN** (and not wired in current E2E/container scripts). |
| 2. OCR/conversion/embedding failure & malformed/oversized inputs retry only as allowed, then fail safely with restricted diagnostics (D3, ADR08/22) | `src/server/ingestion/{extract,embeddings,service}.ts`, `src/server/jobs/dispatch.ts`, `src/components/documents/client.ts`, `infra/{paddleocr,conversion}/server.py`, `tests/unit/ingestion-{docx,embeddings,extract}.test.ts`, `tests/integration/ingestion.test.ts` | **PARTIAL** — Unit bounds/classifications pass (`ingestion-docx.test.ts` hostile ZIPs/XXE/macros, `ingestion-embeddings.test.ts` 429 vs 401/bad dims/zero vector with zero secret leak, `ingestion-extract.test.ts` tampered SHA + 503). Missing DB/unit coverage for `NO_EXTRACTABLE_TEXT`, `embedIngestionStage` failures, OCR/conversion permanent failures, encrypted/>100-page PDFs (`Q-S05b-5`). | Real worker 413/422/503/504 and DB retry/timeout reconciliation (`ingestion.test.ts`, `verify.mjs`) **NOT RUN**. |
| 3. Duplicate jobs & worker retries do not duplicate chunks; expired file references renew only via authorized backend access (D3, ADR08/11) | `drizzle/0004_document_processing.sql` (`sop_chunks_job_sequence`, `sop_extraction_pages_job_page`), `src/server/ingestion/{service,http}.ts`, `src/server/documents/service.ts`, `src/server/jobs/signatures.ts`, `n8n/s05-ingestion.v1.json`, `tests/integration/ingestion.test.ts` | **PARTIAL / FAIL** — `claimIngestionStage` allows duplicate `claim` with same `executionId` on terminal `COMPLETED`/`FAILED` jobs before `attemptDeadline`, re-arming `runLeaseUntil` and minting `fileRefToken` (`Q-S05b-4`). Mid-pipeline duplicate `claim`/`extract`/`chunk`/`embed` callbacks lack DB test coverage (`Q-S05b-5`). `n8n` contract test timed out under parallel Vitest (`Q-S05b-1`). | Real PostgreSQL transaction/constraint tests (`ingestion.test.ts`, `documents.test.ts`) and live n8n Queue Mode execution **NOT RUN**. |
| 4. No processing result activates a source or exposes it to Staff retrieval; exported workflow-contract tests & provider compatibility evidence recorded separately (D3, ADR08/22) | `drizzle/0004_document_processing.sql` (`sop_documents_status` excludes `ACTIVE`, `sop_extraction_pages_unverified`, `bind_ingestion_artifact_identity`), `src/server/ingestion/service.ts`, `n8n/s05-ingestion.v1.json`, `tests/unit/ingestion-workflow.test.ts`, `tests/integration/ingestion.test.ts`, `tests/e2e/documents.spec.ts` | **FAIL (workflow test flake)** — Source & DB constraints correctly forbid `ACTIVE` and Staff access; `n8n/s05-ingestion.v1.json` uses native allowlisted nodes, fixed `http://app:3000` URLs, `followRedirects: false`, zero secrets, zero saved executions. However, `npm.cmd test` failed on `vm.runInNewContext` 100ms timeout (`Q-S05b-1`). | Real PostgreSQL constraint/trigger tests (`ingestion.test.ts`), E2E Staff 403 checks, hosted CI run, and S05b security review **NOT RUN**. Note: CI uses `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1` (synthetic vectors), distinct from S05a's standalone live `text-embedding-3-small` compatibility receipt. |

## Executed local commands and results

| Command | Result | Observed details |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` (before review) | **PASS** | Both protected PRDs unchanged (`exit 0`). |
| `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` exited `0` (0 warnings). |
| `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` exited `0`. |
| `npm.cmd test` (Run 1, concurrent with lint/typecheck) | **FAIL** | 52 passed, **2 failed** (12/14 files, 18.70s): `tests/unit/ingestion-workflow.test.ts:120` (`tests/workflows/ingestion-contract.ts:44`) and `tests/unit/jobs-workflow.test.ts:17` (`tests/workflows/probe-contract.ts:25`) threw `Error: Script execution timed out after 100ms`. |
| `npm.cmd test` (Run 2, standalone) | **FAIL** | 53 passed, **1 failed** (13/14 files, 16.27s): `tests/unit/jobs-workflow.test.ts:26` (`tests/workflows/probe-contract.ts:25`) threw `Error: Script execution timed out after 100ms`; `ingestion-workflow.test.ts` passed (1544ms). |
| `npx.cmd vitest run tests/unit/jobs-workflow.test.ts tests/unit/ingestion-workflow.test.ts` | **PASS** | Isolated 2 files: 6/6 passed in 839ms (109ms + 84ms), confirming 100ms VM timeout flakiness under 14-worker parallel startup. |
| `node --test infra/n8n/local-secrets.test.mjs` | **PASS** | 1/1 passed (0 fail, 0 skipped, 3122ms). |
| `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` | **PASS** | 7/7 passed (0 fail, 0 skipped, 1600ms). |
| `node infra/conversion/verify.mjs` | **PASS (static only)** | `{"result":"PASS","mode":"static","checks":["dockerfile-isolation-and-entrypoint","server-endpoints-and-bounds"],"dockerChecksExecuted":false}`. |
| `node --check infra/paddleocr/verify.mjs; node --check infra/conversion/verify.mjs; node --check infra/n8n/bootstrap.mjs` | **PASS** | All 3 infra scripts syntax-valid (`exit 0`). |
| `npm.cmd run build`, Docker builds/verifiers, `verify-db` (`tests/integration/*`), Playwright (`tests/e2e/*`), `verify-workflow-runtime.mjs`, `verify-redirects.mjs`, hosted CI | **NOT RUN** | Docker Desktop pipe unavailable in QA sandbox; no live DB/container/browser/network execution performed by QA. |

## Defects and coverage gaps

### Q-S05b-1 — HIGH: `npm.cmd test` fails under default parallel Vitest workers (`100ms` `vm.runInNewContext` timeout)

- **Location:** `tests/workflows/ingestion-contract.ts:44` and `tests/workflows/probe-contract.ts:25`.
- **Repro:** Run `npm.cmd test` on Windows (14 isolated Vitest workers). Observed failure twice: 2/54 failed under load (`ingestion-workflow.test.ts:120`, `jobs-workflow.test.ts:17`), 1/54 failed completely standalone (`jobs-workflow.test.ts:26`), while isolated execution passes 6/6 in 839ms.
- **Impact:** Mandatory `npm test` CI gate flakes on CPU-contended hosts/runners.
- **Minimal fix:** Raise the `runInNewContext` timeout in both contract helpers (e.g., `1000` ms) while keeping expressions deterministic and bounded.

### Q-S05b-2 — HIGH: New OCR HTTP server (`infra/paddleocr/server.py`), `cli.py --stdin`, `/pdf/render-page`, and real scanned/mixed PDFs are never executed in any container or E2E test

- **Location:** `infra/paddleocr/server.py` (all 208 lines), `infra/paddleocr/cli.py:35-37`, `infra/paddleocr/verify.mjs`, `infra/conversion/verify.mjs`, `tests/e2e/documents.spec.ts:129-172`, `tests/fixtures/document-files.ts`.
- **Observation:**
  - `infra/paddleocr/verify.mjs` tests CLI `--self-test`, `--input`, and 12 bounds checks (including S05a fix `--input ""` -> `OCR_INPUT_PATH`), but never syntax-checks or invokes `server.py` (`GET /healthz`, `POST /ocr`) or `cli.py --stdin`.
  - `infra/conversion/verify.mjs --docker` only probes `/healthz` and invalid-PDF 422 on `/pdf/inspect-and-extract`; it never exercises `/convert/docx-to-pdf`, valid `/pdf/inspect-and-extract`, or `/pdf/render-page`.
  - `tests/e2e/documents.spec.ts:161-168` uploads only `syntheticPdf()` (1 native page, 0 images, no digits/units/tables) and `syntheticDocx()` (1 plain paragraph, no headings/tables/digits/units). Even in hosted CI, `paddleocr` `POST /ocr` and `convert-worker` `POST /pdf/render-page` are never exercised end-to-end; scanned/mixed PDF proof rests solely on mocked `fetchImpl`.
- **Impact:** Cannot satisfy S05 criterion #1 end-to-end or prove the new S05b OCR HTTP boundary works in Docker.
- **Minimal fix:** Add container HTTP checks for `paddleocr/server.py` (`/healthz`, valid PNG `POST /ocr`, 413/415/422 negatives) and `cli.py --stdin` in `infra/paddleocr/verify.mjs`, add valid conversion/render checks in `infra/conversion/verify.mjs --docker`, and exercise a synthetic scanned/mixed PDF + structured DOCX (headings, steps, table, digits/units) through the real E2E stack.

### Q-S05b-3 — MODERATE: Non-observable overlap assertion in `ingestion-chunker.test.ts` and `chunkPracticalMaxTokens` overflow / heading-only split in `chunker.ts`

- **Location:** `tests/unit/ingestion-chunker.test.ts:90,116`; `src/server/ingestion/chunker.ts:281-300`.
- **Observation:**
  - `tests/unit/ingestion-chunker.test.ts:116` tests overlap only via `expect(first[0].text.slice(-80)).toBeTruthy()`, which passes even with 0 overlap between `first[0]` and `first[1]`.
  - In `src/server/ingestion/chunker.ts:288-300`, pushing `overlapUnit` (up to `160` tokens) before a ~`1000`-token split piece exceeds `chunkPracticalMaxTokens` (`1000`, up to ~`1160`), and `tests/unit/ingestion-chunker.test.ts:90` relaxed its bound to `<= 1100`. Also, a heading alone in `buffer` before a ~`1000`-token table piece triggers `exceedsHardMax` and flushes a standalone heading-only `narrative` chunk.
- **Minimal fix:** Check `overlapTokens + unitTokens <= ingestionLimits.chunkPracticalMaxTokens` before re-pushing `overlapUnit`, reserve heading budget when splitting oversized tables/text, and assert actual shared suffix/prefix text between `first[0]` and `first[1]`.

### Q-S05b-4 — MODERATE: `claimIngestionStage` re-arms `runLeaseUntil` and mints `fileRefToken` on duplicate `claim` for terminal `COMPLETED`/`FAILED` jobs

- **Location:** `src/server/ingestion/service.ts:189-200`.
- **Observation:** `if (job.executionId)` runs before `if (job.state !== "QUEUED")` and omits a `job.state === "RUNNING"` guard. Because `completeIngestionStage` (`service.ts:665`) and `applyFailureTransition` (`service.ts:135`) retain `executionId` while clearing `runLeaseUntil`, a duplicate `claim` with matching `executionId` and fresh `jti` before `attemptDeadline` sets a new live `runLeaseUntil` (+210s) and returns a fresh `fileRefToken` on a terminal job.
- **Minimal fix:** Require `job.state === "RUNNING"` inside the `if (job.executionId)` duplicate-claim branch (returning `409 INVALID_WORKFLOW_STATE` for terminal jobs) and add a DB integration test covering duplicate `claim` after `COMPLETED`/`FAILED`.

### Q-S05b-5 — MODERATE: Missing failure-path and mid-pipeline duplicate assertions for S05 criteria #2 & #3

- **Location:** `tests/integration/ingestion.test.ts`, `tests/unit/ingestion-extract.test.ts`.
- **Observation:**
  - `NO_EXTRACTABLE_TEXT` (all-blank PDF / empty DOCX permanently failing in `chunkIngestionStage`) has no test.
  - `embedIngestionStage` transient (429/503 -> retry) and permanent (401/400/invalid vector -> `FAILED`) DB transitions are untested (only `embedTexts` is unit-tested).
  - `extractDocumentContent` OCR failure (`FAIL` JSON / 422 / 503), DOCX conversion failure (422 / 503 / non-PDF), >100-page / encrypted / 0-page PDF, and native PDF `TABLE_STRUCTURE_REVIEW` have no unit tests.
  - Mid-pipeline duplicate callbacks (`claim`, `extract`, `chunk`, `embed` with fresh nonces) are untested in `ingestion.test.ts` (only duplicate `complete` is tested).

### Q-S05b-6 — LOW: Extraction edge cases, per-page conversion timeout vs lock hold, minor schema/workflow notes, and test comment hygiene

- `src/server/ingestion/docx.ts:166-174,238-262`: Nested tables (`tableDepth >= 2`) silently drop cell text; `<w:numPr>` unconditionally prefixes `1., 2., ...` without consulting `word/numbering.xml` (bullet lists become numbered and sub-level counters do not reset).
- `src/server/ingestion/extract.ts:206-222`: `appendUniqueOcrLines` uses substring `.includes()` against flattened native text, which can drop short numeric/unit OCR diagram labels that happen to match native text substrings (mitigated partly by `MIXED_PAGE_OCR` flag for S06 review).
- `infra/conversion/server.py:291-310`: `pdftotext` enforces `15s` per page while holding `CONVERSION_LOCK`, whereas `extract.ts:11` aborts `/pdf/inspect-and-extract` after `60s` total (slow multi-page PDF can hold `CONVERSION_LOCK` past caller abort).
- `infra/paddleocr/server.py:16` vs `infra/paddleocr/cli.py:20`: Both use `75s` (minor race; both return 504 `OCR_DEADLINE_EXCEEDED`). Note: S05a security findings `R-S05a-1` (`cli.py:32` + `verify.mjs:140-141`), `R-S05a-2` (`engine.py:57,63`), and `R-S05a-3` (`memswap_limit: 2g`, `nosuid,nodev`; `noexec` omitted) were verified in source.
- `drizzle/0004_document_processing.sql:54-68`: `sop_verification_issues` lacks `bind_ingestion_artifact_identity` trigger present on `sop_extraction_pages` and `sop_chunks`. `n8n/s05-ingestion.v1.json` never invokes `/fail` (relies on backend `recordStageFailure()` or `210s` `runLeaseUntil` reconciliation on unexpected transport errors).
- `antislop-code` hygiene: Production S05b files (`src/server/ingestion/*`, `infra/{paddleocr,conversion}/server.py`) are clean (6 concise intent/constraint comments, 0 TODOs). `tests/integration/ingestion.test.ts:579` retains a dead-import workaround (`// Ensure SQL helper import is used cleanly.` + dummy query) and 17 step-narrating comments.

## Remaining gates before closing S05

1. Fix `Q-S05b-1` through `Q-S05b-5` (and clean up `Q-S05b-6` items in scope) and commit the finished S05b candidate.
2. Re-run `npm run check:prd`, `npm run lint`, `npm run typecheck`, `npm test` (must pass 100% under default parallel workers), `npm run build`, and infra node tests against the committed SHA.
3. Execute full Docker/PostgreSQL/pgvector/n8n/Playwright verification on the exact committed SHA (hosted CI `paddleocr` + `foundation` jobs and/or local Docker): fresh `0004_document_processing.sql` migration, `verify-db` (`tests/integration/ingestion.test.ts` + regressions), rebuilt 9-input `infra/paddleocr/verify.mjs` (including `server.py` + `--stdin`), `SOP_CONVERSION_VERIFY_DOCKER=1 node infra/conversion/verify.mjs`, `verify-native.mjs`, `npm run test:browser` (including real scanned/mixed PDF + rich DOCX), `scripts/verify-workflow-runtime.mjs`, and `infra/n8n/verify-redirects.mjs`.
4. Complete independent security review for S05b (plus confirm S05a `R-S05a-1..3` closure).
5. Keep live OpenAI `text-embedding-3-small` compatibility evidence explicitly separate from `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1` CI runs; company privacy/residency, production limits, real-SOP processing, and deployment approvals remain open.


---

## S05b independent QA re-verification (post-remediation checkpoint)

### Candidate and verdict

| Field | Recorded value |
| --- | --- |
| Branch / base HEAD | `codex/s05-document-processing` @ `b9a259d0d5e096ecb1d382846f8e66f691b6e5a7` (uncommitted post-fix working tree) |
| Working-tree S05b manifest | 58 modified/added files (excluding `docs/verification/`); ordered JSON SHA-256 `5a2e9a39c78407bb29663e81c9d9ae0719a98472e2313a926237882ded6db077` |
| Environment | Windows PowerShell, Node `v26.13.0`, `npm.cmd`. Docker Desktop pipe unavailable in QA sandbox — zero Docker, PostgreSQL/pgvector, n8n, Playwright, or live-provider execution performed by QA. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **LOCAL STATIC & UNIT QA PASS — OVERALL S05b VERIFICATION REMAINS BLOCKED ON DOCKER / DB / E2E / HOSTED CI EXECUTION.** All local host checks pass (including 2× consecutive `npm.cmd test` 58/58 with zero flake) and all `Q-S05b-1`..`Q-S05b-5` fixes are confirmed in source; Docker/PostgreSQL/Playwright/hosted CI execution on the exact committed SHA is still **NOT RUN** and required before marking S05 **VERIFIED**. |

### Per-finding re-verification status

| Finding | Status | Verified evidence & remaining limit |
| --- | --- | --- |
| `Q-S05b-1` (HIGH: 100ms VM timeout flake in `npm test`) | **RESOLVED (LOCAL PASS)** | `tests/workflows/ingestion-contract.ts:44` and `tests/workflows/probe-contract.ts:25` increased `runInNewContext` timeout to `1000` ms. Two consecutive `npm.cmd test` runs under default 14-worker parallelism passed **58/58 (14/14 files)** in `17.00s` and `14.97s` with zero timeouts. |
| `Q-S05b-2` (HIGH: missing container/E2E proof for `paddleocr/server.py`, `--stdin`, `/pdf/render-page`, scanned PDF, rich DOCX) | **RESOLVED IN SOURCE — RUNTIME NOT RUN** | `infra/paddleocr/verify.mjs:171-240` adds `stdin-png` (`--stdin`) and `http-server` (`server.py` `/healthz`, `POST /ocr` exact 4 lines/SHA/`UNVERIFIED`, 415 `OCR_INPUT_TYPE`, 413 `OCR_INPUT_TOO_LARGE`, clean `SIGTERM` exit 0). `infra/conversion/verify.mjs:116-170` (`--docker`) adds valid synthetic DOCX -> `/convert/docx-to-pdf` -> `/pdf/inspect-and-extract` (`Pressure 2.5 bar`) -> `/pdf/render-page?page=1&dpi=150` (valid PNG <= 4 MB). `tests/fixtures/document-files.ts` adds `syntheticScannedPdf()` + `syntheticRichDocx()` (validated in `tests/unit/documents.test.ts:164-167`) and `tests/e2e/documents.spec.ts:129-183` exercises native PDF, scanned PDF (real OCR), and rich DOCX (LibreOffice preview) + Staff 403. *Limit:* Runtime execution in Docker/Playwright is NOT RUN locally; mixed-page PDF (`mixed_ocr`) remains unit/DB-covered rather than E2E; `syntheticScannedPdf()`'s 5×7 bitmap OCR recognition must be confirmed in actual Docker/CI execution. |
| `Q-S05b-3` (MODERATE: non-observable overlap assertion & chunker `>1000` token / heading-split issues) | **RESOLVED (LOCAL PASS)** | `src/server/ingestion/chunker.ts:120,144,284-306` reserves headroom on split tables (`chunkPracticalMaxTokens - 40`) and split prose (`- 25`), tracks `preOverlapped` to prevent double-overlap, keeps heading attached to the first split table chunk (`hasBodyUnits`), and enforces `estimateTokens(joinUnits([candidateOverlap, unit])) <= 1000`. `tests/unit/ingestion-chunker.test.ts:84,91,117-123` asserts heading attachment, strict `<= 1000` tokens across all table/prose chunks, and literal trailing-to-leading overlap (`sharedTail.length > 20` contained in next chunk's leading slice). Passes locally. |
| `Q-S05b-4` (MODERATE: duplicate `claim` re-arming `runLeaseUntil` on terminal jobs) | **RESOLVED IN SOURCE — DB RUN NOT RUN** | `src/server/ingestion/service.ts:191` adds `if (job.state !== "RUNNING") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);` inside `if (job.executionId)`. `tests/integration/ingestion.test.ts:423-428,478-483` adds PostgreSQL regressions asserting `409 INVALID_WORKFLOW_STATE` and `runLeaseUntil === null` on both `FAILED` and `COMPLETED` jobs. |
| `Q-S05b-5` (MODERATE: missing failure-path & mid-pipeline duplicate tests) | **RESOLVED IN SOURCE — DB RUN NOT RUN** | `tests/unit/ingestion-extract.test.ts:196-368` (5 tests, PASS locally) adds OCR `FAIL`/422/503, encrypted/>100-page/0-page PDF, DOCX conversion 422/503/non-PDF, mixed-page short OCR labels, and native PDF `TABLE_STRUCTURE_REVIEW`. `tests/integration/ingestion.test.ts:447-475,489-563` adds mid-pipeline duplicate `claim`/`extract`/`chunk`/`embed`, `NO_EXTRACTABLE_TEXT`, and `embedIngestionStage` 429 retry / 401 permanent failure transitions. Also verified `R-S05b-1` OOXML external-rel/template SSRF unit tests in `documents.test.ts:139-168` and `ingestion-docx.test.ts:123-159` (PASS locally). |
| `Q-S05b-6` (LOW: mixed-page dedup, per-page conversion timeout, 75s OCR margin, issue trigger, `antislop-code`) | **RESOLVED (2 DOCUMENTED RESIDUAL LIMITS)** | **Fixed:** `src/server/ingestion/extract.ts:206-229` uses canonicalized line-set membership (tested in `ingestion-extract.test.ts:196-251`); `infra/conversion/server.py:47,267-325` enforces `OVERALL_PDF_INSPECT_TIMEOUT_SECONDS = 55.0` across `pdfinfo`/`pdfimages`/`pdftotext` (plus blackhole proxy env vars); `infra/paddleocr/server.py:16-17` sets `OCR_SUBPROCESS_TIMEOUT_SECONDS = 80`; `drizzle/0004_document_processing.sql:121-140` adds `app.bind_verification_issue_identity()` trigger + `sop_runtime` grant (tested in `ingestion.test.ts:584-595`); `tests/integration/ingestion.test.ts` removed the dead `sql` workaround and narrating comments (4 concise comments remain). **Documented non-blocking residual limits:** `src/server/ingestion/docx.ts` does not extract nested tables (`tableDepth >= 2`) or consult `word/numbering.xml`; `n8n/s05-ingestion.v1.json` relies on backend `recordStageFailure()` / `210s` `runLeaseUntil` reconciliation rather than invoking `/fail`. |

### Executed local commands (re-verification)

| Command | Result | Observed details |
| --- | --- | --- |
| `node .codex/scripts/check-prd-integrity.mjs` (before & after) | **PASS** | Both protected PRDs unchanged (`exit 0`). |
| `npm.cmd run lint` | **PASS** | `eslint . --max-warnings 0` exited `0` (0 warnings). |
| `npm.cmd run typecheck` | **PASS** | `next typegen && tsc --noEmit` exited `0`. |
| `npm.cmd test` (Run 1, default parallel workers) | **PASS** | **14/14 files, 58/58 tests** passed in `17.00s` (zero timeouts). |
| `npm.cmd test` (Run 2, back-to-back default parallel workers) | **PASS** | **14/14 files, 58/58 tests** passed in `14.97s` (zero timeouts). |
| `node --test infra/n8n/local-secrets.test.mjs` | **PASS** | 1/1 passed (`1858ms`). |
| `node --test infra/storage-fixture/gateway.test.mjs infra/storage-fixture/secrets.test.mjs` | **PASS** | 7/7 passed (`606ms`). |
| `node infra/conversion/verify.mjs` | **PASS (static only)** | `{"result":"PASS","mode":"static","checks":["dockerignore-default-deny","dockerfile-digest-pin-and-entrypoint","server-endpoints-and-bounds"],"dockerChecksExecuted":false}`. |
| `node --check infra/paddleocr/verify.mjs; node --check infra/conversion/verify.mjs; node --check infra/n8n/bootstrap.mjs` | **PASS** | Exit `0`. |
| `npm.cmd run build`, Docker builds/verifiers, `verify-db`, Playwright (`test:browser`), `verify-workflow-runtime.mjs`, `verify-redirects.mjs`, hosted CI | **NOT RUN** | Docker Desktop pipe blocked in QA sandbox; mandatory on the exact committed candidate before closing S05. |

### Remaining gates required to mark S05 VERIFIED

1. Commit exact S05b candidate and run full hosted CI (`paddleocr` + `foundation` jobs) and/or local Docker verification against that exact committed SHA:
   - `npm run build`
   - Rebuilt 9-input `infra/paddleocr/verify.mjs` (proving `stdin-png`, `http-server` `/healthz` + `POST /ocr` + 415/413, `empty-input`, 12 bounds checks, sandbox & cleanup)
   - `SOP_CONVERSION_VERIFY_DOCKER=1 node infra/conversion/verify.mjs` (proving digest-pinned image, `/convert/docx-to-pdf`, `/pdf/inspect-and-extract`, `/pdf/render-page`)
   - Fresh `0004_document_processing.sql` migration & `verify-db` (`tests/integration/ingestion.test.ts` + full DB regressions, including `bind_verification_issue_identity` trigger and terminal-state `claim` denials)
   - Native storage fixture verifier (`verify-native.mjs`)
   - Playwright `npm run test:browser` (proving 3-document D3 E2E — native PDF, scanned PDF via real PaddleOCR, rich DOCX via LibreOffice preview — plus S02/S03/S04 regressions)
   - `scripts/verify-workflow-runtime.mjs` and `infra/n8n/verify-redirects.mjs`
2. Independent QA decode/reconciliation of the completed exact-SHA hosted CI logs (or full local Docker receipts) and independent S05b security sign-off.
3. Preserve explicit separation between `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1` CI runs and S05a's standalone live OpenAI `text-embedding-3-small` compatibility receipt; company privacy/residency, production limits, real-SOP processing, and deployment approvals remain open.


---

## S05 final closure independent QA (`caf0fc7`)

### Candidate, hosted CI metadata, and verdict

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S05 (S05a + S05b complete); D3, ADR04/05/08/11/21/22 with authorized local PaddleOCR and `text-embedding-3-small` (1,536-dim) prerequisites |
| Published candidate | `caf0fc7d8e8bb879f1162d1d32c174248022ee31` on `codex/s05-document-processing` |
| Commit tree | `ac923727099f080f3923954e573cdcd9f19ca041` |
| Predecessor / delta inspected | `3e7c62624165d91d3ba44525fef91a2798721d1c..caf0fc7d8e8bb879f1162d1d32c174248022ee31` (3 files, +12/-5: `package.json`, `tests/integration/ingestion.test.ts`, `tests/integration/jobs.test.ts`) |
| Hosted CI passing run | [Run `45102843612`](https://github.com/AuserZ/ai-sop-assistant/actions/runs/45102843612), attempt `1`, `completed` / `success` (`2026-11-23T02:54:30Z`–`03:07:57Z`) |
| Hosted jobs independently checked | `paddleocr` job `137457390869` (9/9 steps `success`, `02:54:32Z`–`02:57:19Z`); `foundation` job `137457391121` (20/20 steps `success`, `02:54:33Z`–`03:07:56Z`) |
| Historical failed run | Run `45101706382` on `3e7c62624165d91d3ba44525fef91a2798721d1c` (`foundation` job `137453805446` failed Step 13 due to parallel shared-DB test race; Steps 14–16 skipped; superseded by `caf0fc7`) |
| Observability limit | Independent GitHub public REST API queries (`GET .../actions/runs/45102843612` and `/jobs`) returned HTTP `200`; unauthenticated job log download (`GET .../actions/jobs/137457391121/logs`) returned HTTP `403`, so run/job/step API metadata is independently verified while raw log text was not decoded by QA. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Final QA verdict | **Independent QA PASS for S05 at `caf0fc7d8e8bb879f1162d1d32c174248022ee31`.** All 4 S05 acceptance criteria in `PLANS.md` are verified by local host checks, source/assertion inspection, and exact-SHA hosted CI metadata (29/29 steps across both jobs). Final sprint closure belongs to the project manager alongside independent S05b security review; all PRD section 16 external gates remain open. |

### Exact delta audit (`3e7c626..caf0fc7`)

QA independently inspected `git diff 3e7c626..caf0fc7` (3 files, 12 insertions, 5 deletions):

- `package.json:15`: Changed `"test:db"` from `vitest run tests/integration` to `vitest run --no-file-parallelism tests/integration` so integration suites execute sequentially against the single disposable PostgreSQL database without cross-file job-queue interference.
- `tests/integration/ingestion.test.ts:404-407`: Deferred unrelated `QUEUED` `document_ingestion` rows (`ne(id, job.id)`) via `dispatchNextAt = now + 60_000` before testing single-job `dispatchIngestionJobs()`.
- `tests/integration/jobs.test.ts:120-155`: Scoped `dispatchNextAt` deferrals to `eq(kind, "synthetic_probe")` so probe dispatch tests do not perturb `document_ingestion` jobs.

No production application, migration, infrastructure, workflow JSON, or unit test assertions were altered or weakened between `3e7c626` and `caf0fc7`.

### Independently queried hosted CI step summary (`run 45102843612`)

| Job / ID | Steps | Independently observed API status (`head_sha = caf0fc7...`) |
| --- | --- | --- |
| `paddleocr` (`137457390869`) | 9/9 `success` | `Set up job`, `checkout@d23441a`, `setup-node@2499707`, `check-prd-integrity.mjs`, `Build pinned CPU OCR image`, `Verify offline OCR and sandbox failures` (`infra/paddleocr/verify.mjs` covering `stdin-png`, `http-server`, `empty-input`, 12 bounds checks, sandbox & cleanup), post-actions, `Complete job`. |
| `foundation` (`137457391121`) | 20/20 `success` | `Set up job`, `checkout`, `setup-node`, `npm ci`, `check:prd`, `lint`, `typecheck`, `npm test`, `local-secrets.test.mjs`, storage-fixture gateway/secrets tests, infra verification/bootstrap scripts + static `conversion/verify.mjs`, `npm run build`, Step 13 (`Check Compose and run application smoke and database tests`: `verify-native.mjs`, Docker `infra/conversion/verify.mjs`, fresh `0004` migration, `verify-db`, health smoke, conversion profile), Step 14 (`Verify authentication and workflow browser journeys`: Playwright `test:browser` with 3-document D3 E2E covering native PDF, scanned PDF OCR, rich DOCX LibreOffice preview + S02/S03/S04 regressions), Step 15 (`Verify workflow recovery and proxy timeout`), Step 16 (`Verify native POST redirect controls`), Step 17 (`Stop disposable services` cleanup), post-actions, `Complete job`. |

### S05 acceptance criteria mapping (`PLANS.md`)

| S05 acceptance criterion | Final QA status | Evidence and preserved limits |
| --- | --- | --- |
| 1. Synthetic native PDF, scanned PDF, mixed pages and DOCX complete with faithful digits/units/tables/section provenance | **PASS** | Local unit/chunker/DOCX/extraction checks (58/58 PASS x2) + hosted `paddleocr` (`137457390869`) + hosted `foundation` (`137457391121`) Steps 13–14 (`conversion/verify.mjs --docker`, `verify-db` `ingestion.test.ts`, 3-doc Playwright E2E for native PDF, scanned PDF OCR, and rich DOCX LibreOffice preview). *Limits:* Mixed-page PDF (`mixed_ocr`) is exercised in unit/DB tests with mocked workers rather than a dedicated E2E fixture; `docx.ts` does not extract nested tables (`tableDepth >= 2`) or consult `word/numbering.xml`. |
| 2. OCR/conversion/embedding failure and malformed/oversized inputs retry only as allowed, then fail safely with restricted diagnostics | **PASS** | Local unit tests (hostile ZIP/XXE/OOXML SSRF/macros, OCR `FAIL`/422/503, encrypted/>100-page/0-page PDF, DOCX conversion 422/503/non-PDF, embedding 429 vs 401/bad dims/zero vector without secret leak) + hosted `paddleocr` (12 bounds, 413/415, missing-model, URL/empty-input, hard-timeout) + hosted `foundation` Step 13 (`conversion/verify.mjs --docker` invalid-PDF 422, `verify-db` `NO_EXTRACTABLE_TEXT`, transient retry -> permanent `FAILED`, 3-attempt `INGESTION_TIMEOUT`). |
| 3. Duplicate jobs and worker retries do not duplicate chunks; expired file references renew only through authorized backend access | **PASS** | DB unique constraints (`workflow_jobs_ingestion_identity`, `sop_chunks_job_sequence`, `sop_extraction_pages_job_page`) + hosted `foundation` Step 13 (`ingestion.test.ts`: expired `fileRefToken` `401 SOURCE_REF_EXPIRED`, foreign `executionId` `403 INVALID_SOURCE_REF`, authorized `renew-source-ref`, `409 WORKFLOW_REPLAY`, mid-pipeline duplicate `claim`/`extract`/`chunk`/`embed`/`complete`, terminal `FAILED`/`COMPLETED` duplicate-`claim` `409 INVALID_WORKFLOW_STATE`, Admin requeue cleanup with 0 duplicate chunks) + Step 15 (`verify-workflow-runtime.mjs`). |
| 4. No processing result activates a source or exposes it to Staff retrieval; exported workflow-contract tests and provider compatibility evidence recorded separately | **PASS** | DB `sop_documents_status` CHECK forbids `ACTIVE`, column grants protect original metadata, `sop_extraction_pages_unverified` CHECK enforces `UNVERIFIED`, identity triggers bind pages/chunks/issues to `document_ingestion` jobs; Staff `403 FORBIDDEN` verified in DB & Playwright E2E; `n8n/s05-ingestion.v1.json` contract tests pass locally and in hosted Step 8; S05a's standalone live OpenAI `text-embedding-3-small` (1,536-dim, 17 tokens) compatibility receipt remains recorded separately from CI's `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1` synthetic vectors. |

### Open gates preserved

- Unauthenticated REST log download returned HTTP `403`; raw hosted job log text was not decoded by QA (run/job/step API metadata verified).
- Independent S05b security review and project-manager sprint closure remain distinct from this QA verdict.
- PRD section 16 external gates remain open: company privacy/residency and real-SOP processing approval, production OCR/language/table quality and file-size policy, OpenAI billing/quota/other models, backup/object recovery, deployment/rollback approval, and V01/V02 acceptance.

Protected PRD integrity (`node .codex/scripts/check-prd-integrity.mjs`) passed before and after appending this closure section; only `docs/verification/S05-qa.md` was edited.
