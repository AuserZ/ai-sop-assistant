# Temporary local PaddleOCR setup

## Approved scope

On22 November2026 the user confirmed OpenAI is ready and explicitly requested PaddleOCR instead of Google OCR for now, installed in Docker. This records that temporary follow-up decision without changing the protected technical PRD or original PDF. The original ADR22 Google choice remains visible in those sources; production OCR selection and representative quality acceptance remain open.

This S05a increment supports D3 and ADR04 with a local CPU OCR worker. S04 is VERIFIED for1ef8521/hosted45018939728; its uploaded objects and parked ingestion jobs are retained. The worker is an independently exercised processing component. Full S05 still requires native PDF/DOCX extraction, scanned/mixed-page routing, derivative previews, faithful table/section mappings, chunks/embeddings, authenticated n8n orchestration and failure/idempotency evidence. A successful image smoke test does not satisfy those gates or activate any source.

DevOps inspected the boundaries and prepared the resolver/71-wheel lock. Its session reached a usage limit; the lead completed the worker, Docker/Compose, verifier and CI without replacing the limited agent or changing models. Independent final security/QA review remains pending. Timebox is unset.

## Local execution contract

- Use a separate, explicitly named synthetic Compose project; preserve current R2/application containers, private files and volumes.
- Pin the Python base, PaddleOCR/PaddlePaddle/PaddleX packages and model identities. Download public models during preparation/build, record SHA256, and use explicit local paths for inference.
- Run one CPU worker with bounded threads, memory, PIDs, temporary storage, input bytes/pixels, result size and execution time. The root filesystem and models are readonly; the process is nonroot with dropped capabilities and no privilege escalation.
- Inference has no network, published port, Docker socket, application credentials, R2 access or database mount. Disable automatic model-source checks and runtime downloads.
- Accept only bounded local image data; reject URL inputs, paths outside the read-only input directory and malformed/oversized images. Image parsing is untrusted processing.
- Preserve recognized text, order, boxes, confidence and model identity as unverified output. Confidence never grants approval or corrects digits/units. Suppress raw provider traces and use no Docker log persistence for processing output.

Initial synthetic verification uses explicit `PP-OCRv5_mobile_det` and `en_PP-OCRv5_mobile_rec`, rather than the library's changing default models. English fixture coverage is an initial test choice, not an approved document-language policy or a claim about Indonesian/table quality. Use two CPU threads for the local trial; measured results determine further tuning.

Pinned versions: PaddleOCR3.7.0, PaddlePaddle3.3.1, PaddleX3.7.2 and Pillow13.0.0, with71 resolved Linux-amd64/CPython3.11 wheel identities in the hash-checked lock. Python3.11.18 base is pinned by digest. Two official model archives total12,943,360 bytes; observed SHA256 values in models.json are rechecked during build. These are observed hashes over official HTTPS downloads, not publisher-signed checksums. Local Python installation is unnecessary.

## Run the local worker

From the repository root:

```powershell
docker compose -f infra/paddleocr/compose.yml --progress plain build paddleocr
docker compose -f infra/paddleocr/compose.yml run --rm -T paddleocr
node infra/paddleocr/verify.mjs
```

This is a one-shot worker. The default command runs synthetic OCR and exits; it starts no web server. The verifier creates and removes only its five owned containers. The image/models remain available. Existing application containers and volumes are retained.

For an operator-only synthetic PNG/JPEG check, mount only a dedicated input directory readonly at /input, then use `--input /input/page.png`. URLs, foreign paths, symlinks and nonregular files are rejected. Recognized JSON is private processing output with `verificationStatus: UNVERIFIED`, never an approved SOP.

Trial bounds:2GiB RAM,2 CPUs/two inference threads,128 PIDs,128MiB shared memory,256MiB tmpfs,4,000,000 input bytes,12,000,000 pixels,1,024 segments and1,000,000 output JSON bytes. A75s Python deadline is backed by an80s outer deadline plus5s forced-kill allowance. These are local-trial settings, not production capacity or document-policy approval.

## Verification and current status

Local build and verification **PASS** on22 November2026. Offline inference matched all four synthetic lines, including2.5bar,10minutes and75C. The cold case including container operations took16.268s. Ten bounds/model/deadline checks and five real container cases passed; an uncooperative process was forcibly stopped, all five containers removed, and the existing R2/application runtime remained healthy.

Local image ID: `sha256:1beb8c94c93276d487624c704cdc3c6f39a71a2e667e1c6ac98ff5517f5e0608`. Eight-input manifest: `00917d29de68de57d3e72654532ac4cefb22bede24b29358577bc94c51880610`. [Detailed evidence](verification/S05.md). Exact hosted CI and independent review remain pending. Full S05 stays **IN_PROGRESS**; image-only proof does not establish native extraction, tables, scanned-PDF routing, embeddings or n8n ingestion.

The user reports OpenAI ready; its secure application credential, exact embedding entitlement and vector dimensions have not been verified. Keep keys out of chat and Git. Company authorization remains required before confidential passages reach external embedding/LLM providers.

## Primary references

- [Official PaddleOCR installation](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/paddlepaddle_installation.en.md): CPU PaddlePaddle installation.
- [PaddleOCR inference parameters](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html): explicit local model directories, CPU/thread selection and model output.
- [Official model list](https://paddlepaddle.github.io/PaddleX/latest/en/pipeline_usage/tutorials/ocr_pipelines/OCR.html): named lightweight detection/English recognition models.
- [PaddleOCR package metadata](https://pypi.org/project/paddleocr/), [PaddlePaddle](https://pypi.org/project/paddlepaddle/) and [PaddleX](https://pypi.org/project/paddlex/): verified package releases; the checked-in lock records the resolved artifacts.
