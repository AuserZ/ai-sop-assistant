# S05a independent QA

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Requirement / predecessor | D3; ADR04 and the user's22 November2026 temporary local-OCR follow-up; S04 VERIFIED, closuref81a8d3 |
| Authorized increment | Standalone offline CPU PaddleOCR Docker worker, synthetic numeric/unit OCR and bounded failure/sandbox verification |
| Candidate | Final expanded working candidate on `codex/s05-document-processing`, awaiting published SHA/CI; initial `1eb4adeaf8a5ed5e44e61726fb90a86972f86f14` is historical |
| Local worker image | `sha256:8bfe1e3ce933e57f429c34275252bb418b09123a9de9592dc559755f909852e5` |
| Eight build-input manifest | `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7` |
| Pipeline / models | `local-paddleocr-v1`; `PP-OCRv5_mobile_det` and `en_PP-OCRv5_mobile_rec`; all output remains UNVERIFIED |
| QA ownership / environment | Source/assertions read-only; only this report edited. Host Node read-only consistency checks; no Docker/build/provider/key/private-configuration access or suite execution by QA. |
| Date |22 November2026, Asia/Jakarta |
| Result | Source/assertion and final expanded eight-case local receipt/artifact consistency PASS; exact published-candidate/hosted-CI evidence pending. Independent security review separately BLOCKED by its actual role usage limit. Full S05 remains IN_PROGRESS. |

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
