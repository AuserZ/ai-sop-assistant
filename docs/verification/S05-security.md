# S05a independent security review

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S05a bounded local offline PaddleOCR CPU Docker increment; D3, ADR04, ADR22 (OCR-only revision approved 22 November 2026) |
| Base / branch | S04 verified source `1ef852166cda0e07c231ddd4834cf053442bb1dd`, closure `f81a8d33db9aa42f042f51dad49688c18007d086`; `codex/s05-document-processing` |
| Implementation candidate | `4f1bf000b004e8a488a73268aed6635e8cb88423` (tree `24cb68484f7474447bc9bb35d283ad2eaa7bf8c7`) |
| Documentation commits reviewed | `1db0a6dd9c6d2b1f7fdb2d6a2adad7591eec4dfc` (S05 evidence/model choice) and `b9a259d0d5e096ecb1d382846f8e66f691b6e5a7` (HEAD, tree `6ce3673647120af6c6054af6741aabc890a46339`, authorized OCR-only PRD revision) |
| Eight build-input manifest | `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7` (verified equal across working tree, `4f1bf00`, `HEAD`, and permitted receipts) |
| Verifier SHA-256 (`infra/paddleocr/verify.mjs`) | `2003b2ebadc6c3ae3143112363fc734b62b19768b19d140d1c679efef35d3ea0` (verified equal across working tree, `4f1bf00`, `HEAD`, and run receipt) |
| Attributed worker image IDs | Local `sha256:8bfe1e3ce933e57f429c34275252bb418b09123a9de9592dc559755f909852e5`; hosted CI run `45026670726` OCI index `sha256:d08be2d5e36e84b275cef9e5f173168dfc81e4a39040e6727aa0661bce042ad9` |
| Pipeline / models | `local-paddleocr-v1`; `PP-OCRv5_mobile_det` + `en_PP-OCRv5_mobile_rec`; all output `verificationStatus: UNVERIFIED` |
| Reviewer ownership / environment | Independent `security-expert`; read-only source, git, Node consistency, and permitted sanitized receipt inspection only. Only this report created. No code/index/ref edit, no Docker lifecycle action, no network/provider call, no real-key or real-SOP read. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **PASS for bounded S05a** (zero CRITICAL/HIGH/MODERATE demonstrated security blockers; **3 LOW** findings to remediate before S05b runtime wiring). Full S05 remains **IN_PROGRESS**; this review does not close S05 or authorize production, provider use, or real-SOP processing. |

Governed by `AGENTS.md`, `AI SOP Assistant — Technical Product Req.md`, `PRD AI SOP Assistant.pdf`, `.agents/README.md`, `.agents/security-expert.md`, `docs/security.md`, `docs/paddleocr-setup.md`, and `docs/verification/PRD-OCR-2026-11-22.md`. Neither protected PRD nor its integrity script was modified by this reviewer. Among ignored `.local-secrets/` files, only the three permitted sanitized OCR receipts (`s05-ocr-input-build-receipt.json`, `s05-ocr-input-receipt.json`, `s05-ocr-runtime-files.json`) were read; no credential, API key, or private configuration was read.

## Findings

Findings are ranked by demonstrated impact and realistic exploitability. None demonstrated a container sandbox escape, network egress bypass, secret leak, unauthorized host-file access, or document-activation bypass in bounded S05a.

### R-S05a-1 — LOW: `--input ""` fails open to `self_test()` (exit 0 / `PASS`) instead of rejecting with `OCR_INPUT_PATH`

- **Candidate / location:** `4f1bf000b004e8a488a73268aed6635e8cb88423`; `infra/paddleocr/cli.py:30` (SHA-256 `e1cca5d1eb1c5c4ea527ec4d48e85a4eee3c68306ffa9e4b216209a2fcf704ac`).
- **Affected requirement / ADR:** D3, ADR04, ADR22, `docs/paddleocr-setup.md` fail-closed local-path input contract.
- **Trigger / reproducible synthetic scenario:** Invoke the container CLI with an explicit empty path argument: `python /opt/ocr/cli.py --input ""` (e.g., an orchestrator expanding an unset or empty path variable).
  - `argparse` (`cli.py:25-26`) sets `parsed.input = ""` (not `None`), `parsed.verify_bounds = False`, `parsed.self_test = False`.
  - Line 30 checks `elif parsed.input:` (truthiness) instead of `elif parsed.input is not None:`. Because `bool("")` is `False`, execution falls through to line 33 `else: result = self_test()`, runs OCR on the built-in synthetic fixture, and returns exit code `0` with `{"result": "PASS", "check": "offline synthetic numeric/unit OCR", ...}`.
  - By contrast, calling `read_input("")` directly fails closed with `OcrFailure("OCR_INPUT_PATH")` (exit `1`).
- **Impact:** Callers checking exit code `0` or `"result": "PASS"` receive a false success and incur ~10–17s of unnecessary CPU work instead of immediate `OCR_INPUT_PATH` rejection. No host file is read, no secret leaks, no SOP is activated (`verificationStatus: "UNVERIFIED"`), and the `self_test()` JSON schema differs from the `--input` segment-array schema (so strict downstream Zod validation in S05b would still reject the payload).
- **Minimal fix:** Change `infra/paddleocr/cli.py:30` from `elif parsed.input:` to `elif parsed.input is not None:`. Add a negative CLI verification case in `infra/paddleocr/verify.mjs` (or unit check) asserting `--input ""` exits `1` with `{"result": "FAIL", "code": "OCR_INPUT_PATH"}`.
- **Verification status / limit:** Confirmed by deterministic static trace of `cli.py:21-36`; local host has no installed Python runtime and Docker was not executed by this reviewer. Tracked for fix before S05b orchestrator wiring.

### R-S05a-2 — LOW: `Image.open()` does not restrict Pillow decoders to `("PNG", "JPEG")`, exposing ~40+ unused format header parsers

- **Candidate / location:** `4f1bf000b004e8a488a73268aed6635e8cb88423`; `infra/paddleocr/engine.py:57` and `:63` (SHA-256 `71dbfdbcd0c39a3fe4090ed437bc1df5deac602d022b1264a9e8e726473e05c8`).
- **Affected requirement / ADR:** ADR22, `docs/security.md` untrusted document/image parsing boundary.
- **Trigger / reproducible synthetic scenario:** Pass any non-PNG/non-JPEG image container (e.g., crafted TIFF, PSD, FLI, SGI, ICNS, or EPS bytes <= 4 MB) to `decode_image(content)`. Pillow's `Image.open(io.BytesIO(content))` probes all registered format plugins and parses that format's header before `engine.py:58` (`if image.format not in {"PNG", "JPEG"}`) rejects it.
- **Impact:** Increases native/Python parser attack surface to dozens of unneeded legacy image decoders on untrusted inputs. No active CVE exploit in pinned Pillow `13.0.0` was demonstrated, and the worker runs inside a nonroot, read-only, `network_mode: none`, capability-dropped, resource/time-bounded container.
- **Minimal fix:** Pass `formats=("PNG", "JPEG")` to both `Image.open(io.BytesIO(content), formats=("PNG", "JPEG"))` calls at `engine.py:57` and `engine.py:63`. Pillow then immediately raises `UnidentifiedImageError` (mapped to `OCR_INPUT_FORMAT`) without invoking any other format plugin.
- **Verification status / limit:** Confirmed by source inspection of `engine.py:51-70`. Tracked for fix before S05b runtime wiring.

### R-S05a-3 — LOW (hardening): `/tmp` tmpfs omits `noexec,nosuid,nodev` and `mem_limit` has no matching `memswap_limit`

- **Candidate / location:** `4f1bf000b004e8a488a73268aed6635e8cb88423`; `infra/paddleocr/compose.yml:13,17` (SHA-256 `ed549cdbd1a0236c518b939f1cfb07c32d61d1d18bac9235170af3429a8c0e90`) and `infra/paddleocr/verify.mjs:40-41,56`.
- **Affected requirement / ADR:** ADR22, `docs/paddleocr-setup.md` container isolation and resource bounds.
- **Trigger / scenario:** `compose.yml:17` and `verify.mjs:41` mount `/tmp` with `size=256m,mode=1777` without `noexec,nosuid,nodev`. In addition, `mem_limit: 2g` / `--memory 2g` without `memswap_limit: 2g` / `--memory-swap 2g` allows swap expansion up to `2x` memory (4 GiB) on swap-enabled Linux hosts (relevant if a hostile image exploits an extreme aspect ratio such as `12,000,000 x 1`, which passes the total-pixel cap).
- **Impact:** Defense-in-depth hardening gap only. `security_opt: [no-new-privileges:true]` already neutralizes setuid/setgid elevation, and `user: "10001:10001"` + `cap_drop: [ALL]` already prevent device node creation. Without `noexec`, `/tmp` remains the one writable path where a compromised native decoder could drop and directly `execve` / `dlopen` an executable file.
- **Minimal fix:** Add `noexec,nosuid,nodev` to `/tmp` tmpfs (`size=256m,mode=1777,noexec,nosuid,nodev`) and set `memswap_limit: 2g` (`--memory-swap 2g` in `verify.mjs`), after confirming in Docker runtime that PaddlePaddle/OpenCV/Pillow do not execute shared objects from `/tmp`.
- **Verification status / limit:** Source-inspected; runtime compatibility of `noexec` with PaddlePaddle was not executed by this reviewer.

## Checks actually executed

| Check | Result / provenance | Evidence and limits |
| --- | --- | --- |
| Protected PRD integrity (`node .codex/scripts/check-prd-integrity.mjs`) | **PASS** (independent) | Both `AI SOP Assistant — Technical Product Req.md` (`12a5c10f505ba7a02d4d48114da05ecc7e8b36a8959610f0e80cc3fa582add47`) and `PRD AI SOP Assistant.pdf` (`a84d9cb74ae572a6b9e2943137277adc372567169f5d5110de29734af0c6ea5e`) pass before and after report creation. |
| Authorized OCR-only PRD revision audit (`git diff 1db0a6d..b9a259d`) | **PASS** (independent) | Inspected all 133 lines of the technical PRD diff hunk-by-hunk plus `.codex/scripts/check-prd-integrity.mjs` diff and `docs/verification/PRD-OCR-2026-11-22.md`. Only OCR references changed; pre-OCR blob in `4f1bf00` matches `d91d6eacc6e390b6f5bf4bb3018d801b2f39b4ae9f4d64f6b1097d0b7a4a2dc1`; original product PDF is byte-identical. |
| Git revision, tree, and 8-build-input manifest binding | **PASS** (independent) | `4f1bf000b004e8a488a73268aed6635e8cb88423` tree equals `24cb68484f7474447bc9bb35d283ad2eaa7bf8c7`; `HEAD` `b9a259d0...` tree equals `6ce36736...`. Recomputed ordered JSON SHA-256 across all 8 build inputs in working tree, `4f1bf00`, and `HEAD`: all equal `1e53ecf1775c66b2bb0818017ffcfe745c614e71051307d15263b122c533f1e7`. Verifier SHA-256 equals `2003b2eb...` across working tree, `4f1bf00`, and `HEAD`. |
| 71-wheel lock vs `requirements.sources.json` & `requirements.in` | **PASS** (independent) | Read-only Node assertion verified 71/71 unique normalized package name/version/SHA-256 tuples match `requirements.sources.json` (`python: 3.11.18`), all 71 URLs are `https://files.pythonhosted.org/.../*.whl`, and all 4 direct pins (`paddleocr==3.7.0`, `paddlepaddle==3.3.1`, `paddlex==3.7.2`, `Pillow==13.0.0`) match `requirements.in`. No PyPI download or CVE scan executed. |
| `models.json` & `download_models.py` static security audit | **PASS** with defense-in-depth note (independent) | Both URLs are HTTPS, exact byte lengths sum to `12,943,360` (within 20 MB cap), valid 64-hex SHA-256s. Tar extraction inspects members in memory without `extractall()`, rejecting traversal, absolute paths, backslashes, wrong root, non-regular entries (symlinks/hardlinks/FIFOs/devices), nested paths, unexpected filenames, duplicates, and >40 MB expansion. Adversarial tar fixtures were not executed locally (no host Python). |
| `engine.py`, `cli.py`, `verify_cases.py`, `compose.yml`, `verify.mjs`, `resolve-lock.py`, `.github/workflows/ci.yml` security audit | **PASS** with 3 LOW findings (independent) | Line-by-line review plus `node --check infra/paddleocr/verify.mjs` (PASS) and `git diff --check f81a8d3..4f1bf00` (PASS). Identified `R-S05a-1`, `R-S05a-2`, and `R-S05a-3` above. |
| Publication & secret hygiene scan (`git ls-files` and `git diff f81a8d3..HEAD`) | **PASS** (independent) | Inspected all 203 tracked paths and full S05 diff: 0 forbidden paths (`.local-secrets/`, `.env*`, keys, `.tar`, `.pdiparams`, weights, logs, real SOPs) and 0 secret-pattern hits (PEM private keys, `sk-*`, `re_*`, JWTs, `X-Amz-Signature`, `AKIA*`). Pattern scanning is bounded and does not substitute for live secret comparison against private key files (which this reviewer did not read). |
| Permitted sanitized receipt reconciliation | **PASS** (independent) | Verified `.local-secrets/s05-ocr-input-build-receipt.json` (SHA-256 `e242e43e...`), `s05-ocr-input-receipt.json` (`d3754dae...`), and BOM-decoded `s05-ocr-runtime-files.json` (`6bda2e54...`) match manifest `1e53ecf1...`, verifier `2003b2eb...`, 6/6 copied runtime file hashes, `ownedContainersRemoved: 8`, `network: "none"`, `secretMounts: 0`, `publishedPorts: 0`, `fullIngestionClaimed: false`. |
| Local Docker execution & hosted CI run `45026670726` | **PASS** (attributed to lead & QA) | Not re-executed by this reviewer (no Docker mutation / no network call). Attributed via `docs/verification/S05.md` and `docs/verification/S05-qa.md` (8 container cases, 11 bounds checks, exact hosted OCR job `137221097795` 9/9 steps + foundation job `137221097593` 19/19 steps). |

## Reviewed controls by trust boundary

### 1. Protected PRD integrity & authorized OCR-only revision
- `node .codex/scripts/check-prd-integrity.mjs` exits `0`; its comparison/failure logic in `b9a259d` is unchanged (only the technical PRD SHA-256 constant and comment updated).
- `docs/verification/PRD-OCR-2026-11-22.md` accurately records the pre-revision hash (`d91d6eac...`), post-revision hash (`12a5c10f...`), and unchanged product PDF hash (`a84d9cb7...`).
- All 23 ADRs, original P0/P1/P2 priorities, retrieval/activation invariants, answer-validation rules, and section 16 open gates remain intact.

### 2. Supply-chain, pinning & offline enforcement
- **Base image:** `python:3.11.18-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39` is digest-pinned (`Dockerfile:1`).
- **Build context:** `infra/paddleocr/.dockerignore` is default-deny (`**`) with an exact 7-file allowlist (`.dockerignore` + 7 allowed files = 8 build inputs), preventing host configs, `verify.mjs`, `compose.yml`, `resolve-lock.py`, or secrets from entering the image.
- **Python dependencies:** `Dockerfile:7-8` enforces `--no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock` followed by `python -m pip check`. All 71 wheels match `requirements.sources.json` (`files.pythonhosted.org` HTTPS wheels).
- **Model preparation:** `download_models.py` reads at most `MAXIMUM_ARCHIVE_BYTES + 1` (20,000,001 bytes), checks exact `model["bytes"]` and `model["sha256"]` before opening the tar stream in memory, extracts via `extractfile()` + `write_bytes()` (never `extractall()`), and enforces exact archive root (`<name>_infer`), 2-part path, `member.isfile()` (excluding symlinks, hardlinks, FIFOs, devices), allowlisted filenames (`inference.json`, `inference.pdiparams`, `inference.yml`), no duplicates, cumulative expansion <= 40 MB, and all 3 required files present per model.
  - *Defense-in-depth note (non-finding for S05a):* `download_models.py:18` calls `urllib.request.urlopen(model["url"], timeout=60)` without asserting `urlsplit(url).scheme == "https"` or restricting cross-scheme redirects; mitigated in S05a because `models.json` is static HTTPS and exact byte/SHA-256 verification gates extraction. Model SHA-256 digests are observed TOFU hashes over official HTTPS downloads, not publisher-signed checksums.
- **Runtime offline enforcement:** `Dockerfile:12-15` sets `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; `engine.py:137-145` disables optional auxiliary models (`use_doc_orientation_classify=False`, `use_doc_unwarping=False`, `use_textline_orientation=False`) and supplies explicit local `/opt/models/<name>_infer` directories; `compose.yml:8` and `verify.mjs:38,48` enforce `network_mode: none` at the kernel namespace level (critical because transitive PaddleX dependencies include hub/HTTP SDKs such as `huggingface_hub`, `modelscope`, `aistudio_sdk`, `bce-python-sdk`, `requests`, `httpx`, `aiohttp`).
- **Model integrity check:** `verify_models()` (`engine.py:93-105`) validates the exact 6 expected files against `/opt/models/files.json` (rejecting symlinks and SHA-256 mismatches) before every `recognize()` call. Because `/opt/models` resides inside the read-only image rootfs, runtime code cannot tamper with `files.json` or weights.

### 3. Untrusted input, resource bounds & output safety
- **Path & file-type controls (`engine.py:73-90`):** Requires absolute direct child of `/input`, rejects `""`, `"."`, `".."` and traversal, opens with `os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK`, verifies `stat.S_ISREG(metadata.st_mode)` and `st_size <= 4_000_000` via `fstat` on the open descriptor, and caps read at `MAXIMUM_INPUT_BYTES + 1` (preventing TOCTOU symlink swaps, FIFO open hangs, and growing-file overreads). NUL bytes in paths raise `ValueError`, which fails closed safely in `cli.py:40` (`OCR_PROCESSING_FAILED`, exit 1).
- **Image decode controls (`engine.py:51-70`):** Caps bytes at 4 MB, sets `Image.MAX_IMAGE_PIXELS = 12_000_000`, escalates `DecompressionBombWarning` to error, enforces `PNG`/`JPEG` and `n_frames == 1`, runs `image.verify()` before re-opening immutable in-memory bytes for `convert("RGB")`. (See `R-S05a-2` to restrict `Image.open(..., formats=("PNG", "JPEG"))`.)
- **Result fidelity & caps (`engine.py:108-168`):** Enforces <= 1,024 segments, <= 32,768 UTF-8 bytes per segment text, finite confidence in `[0, 1]`, 4-point polygons with finite coordinates in `[0, width]` x `[0, height]`, `allow_nan=False`, total encoded JSON <= 1,000,000 UTF-8 bytes, and hardcoded `"verificationStatus": "UNVERIFIED"`. No text normalization, digit/unit auto-correction, or activation authority exists in the worker.
- **Timeouts & trace suppression (`Dockerfile:17`, `cli.py:13-44`, `engine.py:31-48`):** 75s Python `SIGALRM` deadline backed by an outer GNU `timeout --signal=TERM --kill-after=5s 80s` entrypoint to hard-kill C++ hangs (exit 137). `muted_engine_output()` redirects OS fds 1/2 to `/dev/null` and flushes Python and C stdio (`ctypes.CDLL(None).fflush(None)`) during PaddleOCR import/inference; `cli.py:37-42` emits only fixed static error codes without raw exceptions or tracebacks. (See `R-S05a-1` for `--input ""` CLI routing.)

### 4. Container, Compose & CI isolation
- `compose.yml` and `verify.mjs` both enforce nonroot `10001:10001`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `network_mode: none`, `2g` memory, `2.0` CPUs, `128` PIDs, `128m` shm, `256m` `/tmp` tmpfs, `logging: driver: none`, `stop_grace_period: 5s`, and zero published ports, secrets, Docker sockets, DB/R2 mounts, or HTTP listeners.
- `verify.mjs` resolves `imageMetadata.Id` once, creates every container by immutable ID, asserts `configuration.Image === imageMetadata.Id` and sandbox flags on every case, permits one read-only `/input` bind only for `input-png` and `input-jpeg` (zero non-tmpfs mounts for the other 6 cases), removes only project-labeled owned containers, and cleans up only its two known temp files plus `rmdir` (non-recursive) in `finally`.
- `.github/workflows/ci.yml` `paddleocr` job uses top-level `permissions: contents: read`, SHA-pinned `actions/checkout` (`persist-credentials: false`) and `actions/setup-node`, `timeout-minutes: 20`, zero secrets, and runs PRD integrity, pinned build, and `node infra/paddleocr/verify.mjs`.

## S05b integration constraints, residual risks & open gates

1. **Host staging directory permissions for real SOPs (S05b mandatory control):** `verify.mjs:116,123` uses `chmod(0o755)` on a directory under `os.tmpdir()` and `chmod(0o444)` on synthetic `page.png`/`page.jpg`. That is acceptable only for S05a synthetic verification. When S05b wires real/confidential SOP rasterization into this worker, it **must not** place SOP page images in world-readable `/tmp` with `0o755`/`0o444`; use a dedicated `0o700` directory or private volume scoped to UID/GID `10001` (or dedicated group `0o750`/`0o440`) and delete rasterized pages deterministically after OCR.
2. **Unpinned Debian OS packages & pending dependency/image vulnerability scanning:** `Dockerfile:2-4` installs `libglib2.0-0`, `libgomp1`, `libgl1`, and `fonts-dejavu-core` from unpinned Bookworm apt repos, and no `pip-audit`/Trivy/Grype image scan runs in CI yet (tracked for S14 / pre-V01 alongside existing 4 moderate Node advisories). No bit-for-bit reproducibility or CVE-free claim is made.
3. **Unexecuted edge-case guards:** Multiframe APNG rejection, individual segment/coordinate boundary thresholds (`> 1024` segments, `> 32,768` text bytes, negative/`> width` coordinates), extreme-aspect-ratio images (`12,000,000 x 1`), and adversarial tar inputs to `download_models.py` are source-verified only, not runtime-executed.
4. **Offline developer helper (`resolve-lock.py:7-8`):** Writes to fixed `/tmp/paddleocr-lock.json` and `/tmp/paddleocr-lock.log`. Excluded from Docker build context and CI; if run on a shared host, switch to `tempfile.TemporaryDirectory()`.
5. **Open S05 & PRD section 16 gates:** Full S05 remains **IN_PROGRESS** (native PDF/DOCX extraction, scanned/mixed-page routing, LibreOffice derivatives, table/section mappings, chunks/embeddings, authenticated n8n orchestration, idempotency/failure tests, S06 verification/activation). Company approval for real SOP processing with local PaddleOCR and OpenAI, language/table OCR benchmarks, storage provider/recovery, retention/MFA/account-recovery policies, and V01/V02 remain open.

## Final verdict

**PASS for bounded S05a** (`4f1bf000b004e8a488a73268aed6635e8cb88423` + documentation commits `1db0a6d` / `b9a259d`). No CRITICAL, HIGH, or MODERATE demonstrated security or publication blocker remains in the standalone offline PaddleOCR Docker increment. Remediate the 3 LOW items (`R-S05a-1` `--input ""` fail-open, `R-S05a-2` Pillow `formats=("PNG", "JPEG")`, `R-S05a-3` `/tmp` `noexec,nosuid,nodev` + `memswap_limit: 2g`) and enforce the S05b private host-staging permission constraint before wiring n8n/application orchestration to this worker.


---

# S05b independent security review (full ingestion pipeline)

## Candidate and scope

| Field | Recorded value |
| --- | --- |
| Sprint / mapping | S05b full SOP processing, OCR, DOCX previews, chunking, embeddings, and n8n ingestion pipeline; D3, ADR02/03/04/05/08/11/21/22 |
| Base / branch | S05a + OCR PRD revision `b9a259d0d5e096ecb1d382846f8e66f691b6e5a7`; uncommitted working copy on `codex/s05-document-processing` |
| Reviewed working snapshot | 53 modified/new S05b files (excluding this report); SHA-256 manifest `b9dcac8b99693d00d7b5413b9c7d3e8e521c5c592c4d4ae221bdea11351ce857` |
| Updated 9-input `infra/paddleocr` manifest | `94ae14a5698bc9f6bcfd6aebb64daebd24fa7cea3c979baa6a0c96d172f6cab5` (adds `server.py` + S05a fixes) |
| Reviewer ownership / environment | Independent `security-expert`; read-only source, SQL, workflow JSON, syntax, and in-memory Node/tsx adversarial checks. Only this report edited. No code/index/ref edit, no Docker/DB execution, no network/provider call, no real-key or real-SOP read. |
| Date | 23 November 2026 (Asia/Jakarta) |
| Verdict | **FAIL (changes required before S05 closure)** — **2 MODERATE** (`R-S05b-1`, `R-S05b-2`) and **2 LOW** (`R-S05b-3`, `R-S05b-4`) findings identified; full Docker/PostgreSQL/E2E/hosted-CI runtime verification remains required after fixes. |

## S05a remediation verification

| S05a Finding | Status in S05b working copy | Evidence and limit |
| --- | --- | --- |
| `R-S05a-1` (`--input ""` fail-open) | **FIXED IN SOURCE** | `infra/paddleocr/cli.py:32` (`7e279815...`) now uses `elif parsed.input is not None:`; `infra/paddleocr/verify.mjs:140-141` (`9b45eabb...`) asserts `--input ""` exits `1` with `OCR_INPUT_PATH`. Runtime Docker execution pending. |
| `R-S05a-2` (Pillow `formats` allowlist) | **FIXED IN SOURCE** | `infra/paddleocr/engine.py:57,63` (`1f2ba26e...`) pass `formats=("PNG", "JPEG")` to both `Image.open` calls; `infra/paddleocr/verify_cases.py:32-40` adds BMP denial checks. Runtime Docker execution pending. |
| `R-S05a-3` (`/tmp` options & swap cap) | **PARTIALLY FIXED IN SOURCE** | `infra/paddleocr/compose.yml:14,18` (`a69c3f6d...`), `docker-compose.yml:247,251`, and `verify.mjs:40-41,53,57` now enforce `memswap_limit: 2g` (`--memory-swap 2g`) and `nosuid,nodev`. `noexec` on `/tmp` remains omitted (optional defense-in-depth subject to PaddlePaddle runtime check). |

## S05b findings (ranked by impact and exploitability)

### R-S05b-1 — MODERATE: Unfiltered OOXML external relationships in `word/_rels/*.rels` allow LibreOffice file-reference SSRF on the shared `processing` network

- **Candidate / location:** `src/server/documents/format.ts:105-111`, `src/server/ingestion/docx.ts:359-363` (SHA-256 `38953944e8bb068a111614c3dae303b7bf1951494b5b8ae42f682f541bcbcc13`), `src/server/ingestion/extract.ts:265-278` (`aa232956...`), `docker-compose.yml:112,245,270,303-304` (`4a58a803...`).
- **Affected requirement / ADR:** PRD section 12 ("unsafe file conversion", "SSRF from file references"), `docs/security.md` ("file-reference SSRF", "malicious conversion inputs"), ADR21.
- **Demonstration (independent in-memory reproduction):** Constructed a valid stored-ZIP DOCX containing `word/_rels/document.xml.rels` with `Type=".../image" Target="http://app:3000/api/health/ready" TargetMode="External"` and `Type=".../subDocument" Target="file:///etc/passwd" TargetMode="External"`. Invoking actual `validateDocumentObject` (`format.ts`) AND `extractDocxStructure` (`docx.ts`) accepted the archive without error (`ssrfDocxAcceptedByFormatAndDocx: true`), meaning `extract.ts:267` forwards the raw DOCX bytes directly to `convert-worker` (`soffice --headless --convert-to pdf`).
- **Impact & mitigating controls:** `processing` has `internal: true` (blocks outbound internet egress), `database` and `workflow` networks are unreachable from `convert-worker`, `convert-worker` holds zero secrets and runs nonroot/read-only with per-request `0o700` tmpdir, and all protected `app:3000` endpoints require Admin session cookies or RS256 Bearer JWTs. However, LibreOffice can still issue unauthenticated HTTP GETs to `http://app:3000/*`, `http://paddleocr:8091/*`, or `http://127.0.0.1:8092/*` (including self-targeting `convert-worker` and holding `CONVERSION_LOCK` until the 45s `soffice` timeout) and render container-local `file://` content into the Admin derivative PDF preview.
- **Minimal fix:**
  1. In `src/server/ingestion/docx.ts` (and `src/server/documents/format.ts`): parse every `*.rels` entry in the DOCX archive with `SaxesParser` (rejecting DOCTYPE/errors) and reject any `Relationship` with `TargetMode="External"` unless its `Type` is `.../hyperlink` with an `http:` or `https:` target (blocking external `image`, `subDocument`, `frame`, `oleObject`, `attachedTemplate`, `externalLink`, and any `file:` URI). Also reject external template/mail-merge references (`attachedTemplate`, `mailMerge`) if `word/settings.xml` is present.
  2. In `docker-compose.yml`: separate `convert-worker` and `paddleocr` onto distinct `internal: true` networks (e.g., `conversion` and `ocr`) so `convert-worker` cannot reach `paddleocr:8091`, and set `http_proxy=http://127.0.0.1:9`, `https_proxy=http://127.0.0.1:9`, `no_proxy=""` in `infra/conversion/server.py` `run_bounded()` env as defense-in-depth against LibreOffice HTTP fetches.
- **Verification needed:** Unit tests proving DOCX with external `image`/`subDocument`/`file://` relationships in `word/_rels/*.rels` is rejected (`UPLOAD_INVALID_FORMAT` / `DOCX_EXTRACTION_INVALID`) while standard `https://` hyperlinks remain accepted.

### R-S05b-2 — MODERATE: Unbounded cumulative per-page `pdftotext` timeout in `convert-worker` enables ~25-minute `CONVERSION_LOCK` starvation from one PDF

- **Candidate / location:** `infra/conversion/server.py:256-328` (SHA-256 `803430a8917428b0cf35785ce64325268dd4c0f3f49094da6944d7d0de98f556`), specifically lines 291-309.
- **Affected requirement / ADR:** PRD section 6 ("Limit page count, conversion CPU/RAM, OCR concurrency... to protect the VPS"), ADR21, `docs/security.md`.
- **Trigger / scenario:** `handle_pdf_inspect_and_extract` executes while holding global `CONVERSION_LOCK` (`server.py:490`). It invokes `pdfinfo` (`15s`), `pdfimages` (`20s`), and then up to `max_pages = 100` sequential `pdftotext` calls each with an independent `15.0s` timeout (`PDFTOTEXT_TIMEOUT_SECONDS`), with **no overall request deadline**. Next.js aborts its HTTP call after `60s` (`ingestionLimits.pdfInspectTimeoutMilliseconds`), but `convert-worker` continues running all remaining pages (up to `1,535s` / ~25 minutes worst case), returning `503 CONVERSION_BUSY` to all other DOCX conversions and PDF inspections until the loop finishes.
- **Impact:** Single-file denial-of-service / lock starvation on the shared single-concurrency `convert-worker` container caused by a slow or crafted 100-page PDF.
- **Minimal fix:** Establish `overall_deadline = time.monotonic() + 55.0` at the entry of `handle_pdf_inspect_and_extract`, compute `remaining = overall_deadline - time.monotonic()` before each `run_bounded` call, raise `ConversionFailure(504, "CONVERSION_TIMEOUT")` if `remaining <= 0`, and pass `timeout_seconds=min(step_timeout, remaining)`.
- **Verification needed:** Unit/probe test confirming multi-page inspection respects the overall request deadline and releases `CONVERSION_LOCK` on timeout.

### R-S05b-3 — LOW: `claimIngestionStage` resurrects `runLeaseUntil` and issues a fresh `fileRefToken` on duplicate `claim` for terminal (`FAILED` / `COMPLETED`) jobs

- **Candidate / location:** `src/server/ingestion/service.ts:189-199` (SHA-256 `db579b1e94f64d610e06039007fd26cc28ec21f77bdd80dc70efde198e5bf6b6`).
- **Affected requirement / ADR:** PRD section 5 & 6 (strict job state transitions & short-lived source references), ADR08.
- **Demonstration (independent in-memory reproduction):** Invoked actual `claimIngestionStage` with a mocked transaction returning a `FAILED` job whose `executionId` matched `claims.executionId` and `runLeaseUntil` was `null`. Because `if (job.executionId)` executes before checking `job.state === "RUNNING"`, it updated `runLeaseUntil` to a new 210s future lease and returned `{ accepted: true, duplicate: true, fileRefToken: "<valid RS256 JWT>" }` (`claimResurrectedLeaseOnFailedJob: true`).
- **Impact:** Exploitable only with a valid n8n-signed RS256 callback JWT carrying a fresh `jti` for the same `attemptId`/`executionId` before `attemptDeadline`; downstream stages still enforce `job.state === "RUNNING"` before mutating artifacts. Still violates terminal-state immutability and mints an unnecessary source-read token for a terminal job.
- **Minimal fix:** Inside `if (job.executionId)` at `service.ts:189-199`, reject non-running states with `if (job.state !== "RUNNING") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);` before refreshing `runLeaseUntil` or signing `fileRefToken`.
- **Verification needed:** Regression test confirming duplicate `claim` on `FAILED` or `COMPLETED` job returns `409 INVALID_WORKFLOW_STATE` without modifying `runLeaseUntil` or issuing a token.

### R-S05b-4 — LOW (supply-chain / build hygiene): `infra/conversion/Dockerfile` uses unpinned `FROM debian:bookworm-slim` and omits `.dockerignore`

- **Candidate / location:** `infra/conversion/Dockerfile:1` (SHA-256 `c4b5dae14a74cf43d69f120573059cdf900c217d4a3c1c9771ae79de6b5102c4`) and `infra/conversion/` directory.
- **Affected requirement / ADR:** PRD section 12 & 14 (pinned immutable container builds), ADR14.
- **Impact:** Unlike `postgres`, `proxy`, `redis`, `n8n`, and `paddleocr` (all digest-pinned), `convert-worker` resolves a floating `debian:bookworm-slim` tag at build time and lacks a default-deny `.dockerignore` (passing `verify.mjs` into build context even though not `COPY`ed).
- **Minimal fix:** Pin `FROM debian:bookworm-slim@sha256:<digest>` (adjust `infra/conversion/verify.mjs:25` regex to require `@sha256:[a-f0-9]{64}`) and add `infra/conversion/.dockerignore` (`**`, `!Dockerfile`, `!server.py`).

## S05b checks actually executed

| Check | Result / provenance | Evidence and limits |
| --- | --- | --- |
| Protected PRD integrity (`node .codex/scripts/check-prd-integrity.mjs`) | **PASS** (independent) | Both protected sources unchanged before and after report update. |
| Syntax & static verifier (`node --check` on `paddleocr/verify.mjs`, `conversion/verify.mjs`, `n8n/bootstrap.mjs`; `node infra/conversion/verify.mjs`) | **PASS** (independent) | All 3 scripts pass syntax; static conversion verifier passes (`dockerChecksExecuted: false`). |
| In-memory adversarial Node/tsx harness (actual `format.ts`, `docx.ts`, `config.ts`, `embeddings.ts`, `signatures.ts`, `http.ts`, `service.ts`) | **2 FAIL / 3 PASS** (independent) | **Reproduced `R-S05b-1`** (`ssrfDocxAcceptedByFormatAndDocx: true`) and **`R-S05b-3`** (`claimResurrectedLeaseOnFailedJob: true`). **PASS** on DOCX XXE/DOCTYPE (`document.xml` & `styles.xml`), macro (`vbaProject.bin`), case-variant duplicate ZIP entry; `embeddingConfiguration` loopback/dimension/base-URL guards; `embedTexts` invalid-dimension rejection; `verifySourceRefToken` expiry (`SOURCE_REF_EXPIRED`), wrong-audience callback rejection, non-JSON 415, invalid-UUID 404. |
| `n8n/s05-ingestion.v1.json` static audit | **PASS** (independent) | 27 nodes; only allowlisted node types (`webhook`, `if`, `stopAndError`, `set`, `jwt`, `httpRequest`); all 7 `httpRequest` nodes target `http://app:3000/api/internal/ingestion/...` with `followRedirects: false`; `active: false`; all execution-data persistence flags disabled. |
| Secret & publication hygiene across all 53 S05b files | **PASS** with synthetic note (independent) | 0 non-synthetic secret pattern hits (PEM, `sk-*`, `re_*`, JWT, `X-Amz-Signature`, `AKIA*`). Only `sk-synthetic-secret-do-not-leak` appears in `tests/unit/ingestion-embeddings.test.ts:52,75` as an intentional synthetic redaction assertion. Pattern scan is bounded; no real key file was read. |
| Docker builds/workers, PostgreSQL migration/tests, Playwright E2E, hosted CI | **NOT RUN by security** | Mandatory runtime proof must be executed by engineers/QA/CI after remediating findings above. |

## S05b reviewed controls (verified in source)

- **Worker isolation (`infra/paddleocr/server.py`, `infra/conversion/server.py`, `docker-compose.yml`):** Both `paddleocr` and `convert-worker` run nonroot `10001:10001`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `logging: driver: none`, `memswap_limit == mem_limit`, `pids_limit: 128`, `nosuid,nodev` `/tmp` tmpfs, zero secrets, zero host ports, on `internal: true` networking (zero internet egress). Both suppress HTTP access logs (`log_message` no-op), reject `Transfer-Encoding`, enforce strict ASCII `Content-Length` bounds, isolate subprocesses with `start_new_session=True` + `os.killpg(..., SIGKILL)` on timeout, and serialize concurrency with non-blocking locks (`503 OCR_BUSY` / `CONVERSION_BUSY`). `convert-worker` uses per-request `0o700` `/tmp/job-<uuid>` directories cleaned in `finally` and reads output via `O_NOFOLLOW` + `fstat` `S_ISREG`. `paddleocr/server.py` enforces `verificationStatus == "UNVERIFIED"` and `MAXIMUM_RESULT_BYTES` on child output.
- **Database invariants (`drizzle/0004_document_processing.sql`, `src/server/db/schema.ts`):** `sop_documents_status` CHECK strictly forbids `'ACTIVE'` in S05 (`UPLOADED`, `PROCESSING`, `PENDING_VERIFICATION`, `FAILED` only); column-level `GRANT UPDATE (status, preview_key, latest_job_id, processed_job_id, processed_pipeline_version, processing_error_code, updated_at)` preserves S04's `42501` immutability on `sha256`, `original_key`, `size_bytes`, `uploaded_by`, `title`, `file_name`, `mime_type`; `bind_ingestion_artifact_identity()` trigger binds `sop_extraction_pages` and `sop_chunks` `(job_id, document_id, source_sha256, pipeline_version)` to a `document_ingestion` job; `sop_extraction_pages_unverified` CHECK locks `verification_status = 'UNVERIFIED'`; `sop_chunks_embedding_dimensions` CHECK locks `1536`; `sop_n8n` remains isolated in `sop_n8n` DB with zero `sop_app` grants.
- **Internal callback auth, replay & source-ref boundary (`src/server/ingestion/http.ts`, `service.ts`, `src/server/jobs/signatures.ts`, `infra/proxy/nginx.conf:16`):** Reverse proxy blocks `/api/internal/` (`404`). Internal stage routes require JSON content-type, exact UUID `jobId`, RS256 callback JWT (`iss: "sop-n8n"`, `aud: "sop-app"`, 60s max lifetime, 3s clock skew), exact `purpose`/`path`/`method`/no-query binding, row-locked `workflow_jobs` identity match (`documentId`, `sourceSha256`, `pipelineVersion`, `attemptId`, `attemptNumber`, `dispatchNonce`, `dispatchCount > 0`, live `attemptDeadline`), and single-use `jti` insertion into `workflow_nonce_receipts` (`409 WORKFLOW_REPLAY`). Short-lived `fileRefToken` (45s max, `clockTolerance: 0`, RS256 signed by app-only `dispatchPrivateKey`) is bound to `(jobId, documentId, sourceSha256, attemptId, executionId)` and renewed only through authenticated `/renew-source-ref` with live run lease.
- **Embedding & RBAC / leak hygiene (`src/server/ingestion/config.ts`, `embeddings.ts`, `documents/service.ts`, `documents/http.ts`, `upload-panel.tsx`):** `SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1` requires loopback HTTP `AUTH_BASE_URL` and is present only in `infra/storage-fixture/compose.yml`, not base `docker-compose.yml`. OpenAI requests enforce `redirect: "error"`, exact `1536` finite nonzero vectors, and static safe error codes without leaking keys or chunk text. Document endpoints continue to enforce `requireMutationOrigin`, active Admin session (`lockCurrentAdmin`), uploader ownership, rate limits, and Staff `403` denial. Neither n8n responses, audit metadata, nor Admin UI error messages emit raw SOP text, storage keys, signed URLs, or secrets; `completeIngestionStage` transitions strictly to `PENDING_VERIFICATION` (zero auto-activation).

## Required gates before S05 closure

1. Remediate `R-S05b-1` (MODERATE) and `R-S05b-2` (MODERATE), plus `R-S05b-3` (LOW) and `R-S05b-4` (LOW), and allow independent security re-verification of the fixes.
2. Execute and record passing verification across: unit tests, PostgreSQL migration + `verify-db` (`42501` immutability, trigger enforcement, ACTIVE forbidden, `sop_n8n` isolation), PaddleOCR 9-input Docker build + `verify.mjs` (verifying `empty-input` and BMP checks), Conversion Docker build + `SOP_CONVERSION_VERIFY_DOCKER=1 node infra/conversion/verify.mjs`, end-to-end live ingestion (PDF native/scanned/mixed, DOCX + derivative preview, chunking, 1536-dim embeddings, transient retry, permanent failure, `fileRefToken` expiry + renewal, Staff denial), Playwright E2E, and exact hosted CI run.
3. Open PRD section 16 gates (company privacy/residency approval for real SOPs with PaddleOCR + OpenAI, language/table benchmarks, S06 manual verification/activation, storage recovery, retention/MFA, V01/V02) remain open and are not waived by S05.


---

## S05b remediation re-verification

- **Date:** 23 November 2026 (Asia/Jakarta).
- **Rechecked working snapshot:** 59 modified/new S05b files (excluding this report); SHA-256 manifest `ae86bc95742ed40f71f47f186ef0f743624d74525b841dae08254430cee0ea8d`.
- **Result (source & in-memory scope):** **PASS — all 4 S05b findings (`R-S05b-1`..`R-S05b-4`) verified fixed in source and original in-memory reproductions; zero demonstrated security blockers remain in source/in-memory scope.** Runtime Docker/PostgreSQL/E2E/hosted-CI gates remain mandatory before S05 closure.

### Finding recheck matrix

| Finding | Status | Remediated files & SHA-256 | Independent re-verification evidence |
| --- | --- | --- | --- |
| `R-S05b-1` (MODERATE — DOCX external-relationship SSRF) | **FIX VERIFIED IN SOURCE & ORIGINAL REPRODUCTIONS** | `src/server/documents/format.ts` (`658616c27b64891eea25d86ac6599f795355b52a3610abb6975bb6f88c7b711c`); `src/server/ingestion/docx.ts` (`617d760e20554d7d32e5d368e3bd2fb97e402e5e662aef3976fcd15dce29fac6`); `docker-compose.yml` (`62eec5f1ad9156813838cb35c8dd5dbf8b4e1cb0222ea04896c3117cec81fcf8`); `infra/conversion/server.py` (`79aafb7e22b1b0d12a4819499cb81de58d6f9c1e6d283c6ecb5004c63245676d`) | Both `format.ts` and `docx.ts` parse all `*.rels` entries and `word/settings.xml` with `SaxesParser` (rejecting DOCTYPE/errors), blocking non-hyperlink external relationships, non-`http(s)` URI schemes (`file://`, `//`, `\\`), `attachedTemplate`, and `mailMerge`. Re-ran original in-memory adversarial harness against BOTH `validateDocumentObject` and `extractDocxStructure`: external `image` (`http://app:3000/api/health/ready`), external `subDocument` (`file:///etc/passwd`), `hyperlink` (`file:///etc/passwd`), `attachedTemplate`, and `mailMerge` were all rejected (`UPLOAD_INVALID_FORMAT` / `DOCX_EXTRACTION_INVALID`), while valid `https://` hyperlink passed both. `docker-compose.yml` splits `processing` into separate `internal: true` `ocr` and `conversion` networks (`convert-worker` cannot reach `paddleocr:8091`); `run_bounded()` sets `http_proxy`/`https_proxy`/`HTTP_PROXY`/`HTTPS_PROXY` to `http://127.0.0.1:9` with empty `no_proxy`/`NO_PROXY`. |
| `R-S05b-2` (MODERATE — unbounded per-page `pdftotext` timeout) | **FIX VERIFIED IN SOURCE** | `infra/conversion/server.py:47,264-344` (`79aafb7e...`) | `OVERALL_PDF_INSPECT_TIMEOUT_SECONDS = 55.0` establishes `overall_deadline` at entry to `handle_pdf_inspect_and_extract` and clamps `pdfinfo`, `pdfimages`, and every per-page `pdftotext` call via `bounded_step_timeout()`, raising `504 CONVERSION_TIMEOUT` and releasing `CONVERSION_LOCK` + `job_dir` via `finally`. Runtime timeout behavior not executed by security. |
| `R-S05b-3` (LOW — terminal-job lease resurrection in `claimIngestionStage`) | **FIX VERIFIED IN SOURCE & ORIGINAL REPRODUCTION** | `src/server/ingestion/service.ts:189-200` (`61fedfd1413f92746dc6c32167fe9bc1b3c29a9fafa89c768bcb2d93bbb242b8`) | Line 191 enforces `if (job.state !== "RUNNING") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409)` before extending `runLeaseUntil` or signing `fileRefToken`. Re-ran original in-memory harness for both `FAILED` and `COMPLETED` terminal jobs: both rejected `409 INVALID_WORKFLOW_STATE` with `updatedLease === false`. |
| `R-S05b-4` (LOW — unpinned conversion base image & missing `.dockerignore`) | **FIX VERIFIED IN SOURCE & STATIC CHECK** | `infra/conversion/Dockerfile` (`4ff024fcab00c099c0dd93bc38ea6b670fdc28df9bc7355ebbff2dc26a5ebc8a`); `infra/conversion/.dockerignore` (`51d7b9a04e1593a41ea273b5bcf92100739cb7dafb1dc4418d2df5214dd8cb02`); `infra/conversion/verify.mjs` (`e11ef023d346924f1d3c1dd57c97fa3984d2bff05a074d0bc15fc03ffc7b242c`) | Base image digest-pinned to `python:3.11.18-slim-bookworm@sha256:a83ba18a...`; default-deny `.dockerignore` allows only `Dockerfile` and `server.py`; `node infra/conversion/verify.mjs` passed all 3 static checks (`dockerignore-default-deny`, `dockerfile-digest-pin-and-entrypoint`, `server-endpoints-and-bounds`). |

### Additional S05b deltas inspected

- **Database verification-issue identity trigger (`drizzle/0004_document_processing.sql:121-140`, SHA-256 `ce229fc9e2bb71d090ae358838197c0148d503a51e1a1bf2a9ff3bfea58b7c1e`):** `app.bind_verification_issue_identity()` (`BEFORE INSERT OR UPDATE ON app.sop_verification_issues`) requires matching `workflow_jobs` row with `kind = 'document_ingestion'` and `document_id = NEW.document_id` (`23514` on mismatch), with `REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO sop_runtime`. Prevents cross-document or non-ingestion issue injection.
- **Expanded PaddleOCR verifier (`infra/paddleocr/verify.mjs`, SHA-256 `3a6b82938b6bdb306cfdec8f3048f280b6bc4b228ad3d15573ded0e7c3f39d7f`):** `node --check` passed. New `stdin-png` and `http-server` cases both execute inside the existing `--network none`, `--read-only`, `10001:10001`, `--cap-drop ALL`, `no-new-privileges:true`, `--memory 2g --memory-swap 2g`, `nosuid,nodev` `/tmp`, `--log-driver none`, zero-bind-mount, zero-secret, zero-port sandbox. `http-server` probes loopback `/healthz`, `POST /ocr` (asserting `UNVERIFIED`, exact SHA-256, 4 literal lines), `415 OCR_INPUT_TYPE`, and `413 OCR_INPUT_TOO_LARGE`, terminates `server.py` cleanly, and logs only counts/hash/status codes.
- **Secret & PRD integrity recheck:** `node .codex/scripts/check-prd-integrity.mjs` passed before and after this update; bounded secret-pattern scan across all 59 remediated S05b files found `0` non-synthetic secret hits.

### Remaining gates (must pass before S05 VERIFIED)

- Execute and record passing results for: full unit suite, PostgreSQL migration + `verify-db` (including `bind_verification_issue_identity`, `bind_ingestion_artifact_identity`, `42501` immutability, ACTIVE forbidden, `sop_n8n` isolation), PaddleOCR 9-input Docker build + `verify.mjs` (`empty-input`, BMP, `stdin-png`, `http-server`), Conversion Docker build + `SOP_CONVERSION_VERIFY_DOCKER=1 node infra/conversion/verify.mjs`, end-to-end live ingestion + Playwright E2E, and exact published-candidate hosted CI.
- PRD section 16 open gates (company real-SOP processing approval, OCR language/table benchmarks, S06 manual verification/activation, storage recovery, retention/MFA, V01/V02) remain open.


---

## Final S05 closure security verification (`caf0fc7`)

| Field | Independently verified value |
| --- | --- |
| Published candidate | `caf0fc7d8e8bb879f1162d1d32c174248022ee31` on `codex/s05-document-processing` |
| Commit tree SHA-1 | `ac923727099f080f3923954e573cdcd9f19ca041` |
| Commits since `b9a259d` | `3e7c626` (S05b implementation + remediations) -> `caf0fc7` (3 test-isolation files only) |
| Committed 9-input `infra/paddleocr` manifest | `3cbd9d63390c8da4949e1c645095b512dd58a98634d5e17fead5b5020032f83b` |
| Hosted CI run | `45102843612` (attempt 1, `2026-11-23T02:54:30Z`–`03:07:57Z`), `head_sha = caf0fc7d8e8bb879f1162d1d32c174248022ee31`, `conclusion = success` |
| Hosted CI jobs (public REST API) | `paddleocr` (`137457390869`): `9/9` steps `success`; `foundation` (`137457391121`): `20/20` steps `success` |
| Final S05 security verdict | **PASS for bounded S05 closure** (`caf0fc7d8e8bb879f1162d1d32c174248022ee31`); zero demonstrated security or publication blockers remain. Lead owns sprint closure; no production, provider, or real-SOP authorization is granted. |

### Closure checks executed

1. **Delta audit (`git diff 3e7c626..caf0fc7`):** Verified only 3 test-isolation files changed (`package.json`, `tests/integration/ingestion.test.ts`, `tests/integration/jobs.test.ts`; `+12/-5` lines: `--no-file-parallelism` for `test:db` and kind-scoped `dispatchNextAt` updates). Zero changes to application code, SQL migrations, Docker/Compose, n8n workflow, or security boundaries.
2. **Remediated blob binding (`caf0fc7`):** Verified all 10 security-remediated files (`format.ts`, `docx.ts`, `service.ts`, `docker-compose.yml`, `0004_document_processing.sql`, `infra/conversion/{.dockerignore,Dockerfile,server.py,verify.mjs}`, `infra/paddleocr/verify.mjs`) in committed tree `caf0fc7` match their exact re-verified SHA-256 digests (`10/10` match).
3. **Publication, secret & PRD hygiene (`caf0fc7`):** Inspected all 232 tracked paths in `caf0fc7` (`60` changed since `b9a259d`): `0` forbidden paths (`.local-secrets/`, `.env*`, keys, weights, logs, real SOPs) and `0` non-synthetic secret-pattern hits. `node .codex/scripts/check-prd-integrity.mjs` passed before and after this update (`AI SOP Assistant — Technical Product Req.md` `12a5c10f505ba7a02d4d48114da05ecc7e8b36a8959610f0e80cc3fa582add47`, `PRD AI SOP Assistant.pdf` `a84d9cb74ae572a6b9e2943137277adc372567169f5d5110de29734af0c6ea5e`).
4. **Hosted CI metadata (`45102843612`):** Independently queried GitHub public REST API (`/actions/runs/45102843612` and `/jobs`), confirming `head_sha = caf0fc7d8e8bb879f1162d1d32c174248022ee31`, `conclusion = success`, `paddleocr` `137457390869` (`9/9` steps `success`), and `foundation` `137457391121` (`20/20` steps `success`).

### Explicit limits & open PRD section 16 gates

- **Unauthenticated CI log limit:** Public GitHub REST API returned HTTP `403` on `/actions/jobs/137457390869/logs`; therefore step-level API metadata is independently verified by security while raw job log bodies were not decoded by this reviewer.
- **Residual hardening & audit limits:** `/tmp` tmpfs uses `nosuid,nodev` without `noexec`; Bookworm apt packages in `paddleocr` and `convert-worker` are unpinned and automated Python/OS image CVE scans (`pip-audit`/Trivy) plus existing 4 moderate Node advisories remain tracked for S14 / pre-V01. Pattern secret scanning is bounded and does not substitute for comparison against private credential values (not read by security).
- **Open PRD section 16 gates:** S06 assisted manual verification/activation (documents remain non-ACTIVE / `PENDING_VERIFICATION`), company approval for real confidential SOP processing with local PaddleOCR and OpenAI (privacy/residency/no-training), OCR language/table/numeral benchmarks on representative documents, production storage provider/recovery, chat/audit retention, backup expiry, Admin MFA, account recovery, and V01/V02 acceptance remain open.
