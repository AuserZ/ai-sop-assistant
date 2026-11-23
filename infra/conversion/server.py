from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8092
SOCKET_IO_TIMEOUT_SECONDS = 15.0

DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_CONTENT_TYPE = "application/pdf"
PNG_CONTENT_TYPE = "image/png"

ZIP_MAGIC = b"PK\x03\x04"
PDF_MAGIC = b"%PDF-"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

MAX_INPUT_BYTES = 20_000_000
MAX_CONVERTED_PDF_BYTES = 30_000_000
MAX_RENDERED_PNG_BYTES = 4_000_000
MAX_EXTRACTED_TEXT_BYTES = 2_000_000
MAX_CONTROL_STDOUT_BYTES = 2_000_000

DEFAULT_MAX_PAGES = 100
MAX_PAGES_LIMIT = 100
DEFAULT_RENDER_DPI = 150
FALLBACK_RENDER_DPI = 110
MIN_RENDER_DPI = 72
MAX_RENDER_DPI = 200

SOFFICE_TIMEOUT_SECONDS = 45.0
PDFINFO_TIMEOUT_SECONDS = 15.0
PDFIMAGES_TIMEOUT_SECONDS = 20.0
PDFTOTEXT_TIMEOUT_SECONDS = 15.0
PDFTOPPM_TIMEOUT_SECONDS = 25.0
OVERALL_PDF_INSPECT_TIMEOUT_SECONDS = 55.0

REQUIRED_BINARIES = ("soffice", "pdftotext", "pdfinfo", "pdfimages", "pdftoppm")
CONVERSION_LOCK = threading.Lock()


class ConversionFailure(Exception):
    def __init__(self, status_code: int, code: str):
        self.status_code = status_code
        self.code = code
        super().__init__(code)


def kill_process_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


def run_bounded(
    command: list[str],
    timeout_seconds: float,
    max_stdout_bytes: int = MAX_CONTROL_STDOUT_BYTES,
    cwd: Path | None = None,
) -> tuple[int, bytes]:
    # Blackhole proxy vars block outbound or loopback HTTP fetches from LibreOffice/Poppler subprocesses.
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "http_proxy": "http://127.0.0.1:9",
        "https_proxy": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "no_proxy": "",
        "NO_PROXY": "",
    }
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=str(cwd) if cwd is not None else None,
        env=env,
        start_new_session=True,
    )
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    chunks: list[bytes] = []
    total_bytes = 0
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                kill_process_group(process)
                process.wait()
                raise ConversionFailure(504, "CONVERSION_TIMEOUT")
            events = selector.select(timeout=remaining)
            if not events:
                kill_process_group(process)
                process.wait()
                raise ConversionFailure(504, "CONVERSION_TIMEOUT")
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > max_stdout_bytes:
                kill_process_group(process)
                process.wait()
                raise ConversionFailure(422, "CONVERSION_FAILED")
            chunks.append(chunk)
        wait_remaining = max(0.05, deadline - time.monotonic())
        try:
            returncode = process.wait(timeout=wait_remaining)
        except subprocess.TimeoutExpired:
            kill_process_group(process)
            process.wait()
            raise ConversionFailure(504, "CONVERSION_TIMEOUT") from None
        return returncode, b"".join(chunks)
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            kill_process_group(process)
            process.wait()


def create_job_dir() -> Path:
    job_dir = Path("/tmp") / f"job-{uuid.uuid4().hex}"
    job_dir.mkdir(mode=0o700)
    os.chmod(job_dir, 0o700)
    return job_dir


def read_regular_file(path: Path, max_bytes: int) -> bytes | None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return None
        if metadata.st_size > max_bytes:
            return None
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            data = source.read(max_bytes + 1)
        if len(data) > max_bytes:
            return None
        return data
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def parse_strict_int(raw_value: str, minimum: int, maximum: int) -> int | None:
    if not raw_value or not raw_value.isascii() or not raw_value.isdigit():
        return None
    parsed = int(raw_value)
    if parsed < minimum or parsed > maximum:
        return None
    return parsed


def parse_pdfinfo(output: str) -> tuple[int, bool]:
    page_count: int | None = None
    encrypted = False
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key_clean = key.strip().lower()
        value_clean = value.strip()
        if key_clean == "encrypted":
            if value_clean.lower().startswith("yes"):
                encrypted = True
        elif key_clean == "pages":
            if value_clean.isascii() and value_clean.isdigit():
                page_count = int(value_clean)
    if encrypted:
        raise ConversionFailure(422, "PDF_ENCRYPTED")
    if page_count is None or page_count < 1:
        raise ConversionFailure(422, "PDF_INVALID")
    return page_count, encrypted


def parse_pdfimages_list(output: str, page_count: int) -> tuple[dict[int, int], dict[int, int]]:
    image_counts = {page: 0 for page in range(1, page_count + 1)}
    max_image_pixels = {page: 0 for page in range(1, page_count + 1)}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if not (parts[0].isascii() and parts[0].isdigit()):
            continue
        if not (parts[3].isascii() and parts[3].isdigit() and parts[4].isascii() and parts[4].isdigit()):
            continue
        # Alpha masks accompany an image object and are not independent scanned page images.
        if parts[2].lower() in {"mask", "smask"}:
            continue
        page_index = int(parts[0])
        if 1 <= page_index <= page_count:
            image_counts[page_index] += 1
            pixels = int(parts[3]) * int(parts[4])
            if pixels > max_image_pixels[page_index]:
                max_image_pixels[page_index] = pixels
    return image_counts, max_image_pixels


def handle_docx_to_pdf(payload: bytes) -> bytes:
    if len(payload) < 4 or payload[:4] != ZIP_MAGIC:
        raise ConversionFailure(422, "CONVERSION_INVALID_INPUT")
    job_dir = create_job_dir()
    try:
        profile_dir = job_dir / "profile"
        out_dir = job_dir / "out"
        profile_dir.mkdir(mode=0o700)
        out_dir.mkdir(mode=0o700)
        input_path = job_dir / "input.docx"
        input_path.write_bytes(payload)
        returncode, _ = run_bounded(
            [
                "soffice",
                f"-env:UserInstallation=file://{profile_dir}",
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--convert-to",
                "pdf",
                "--outdir",
                str(out_dir),
                str(input_path),
            ],
            timeout_seconds=SOFFICE_TIMEOUT_SECONDS,
            max_stdout_bytes=262_144,
            cwd=job_dir,
        )
        if returncode != 0:
            raise ConversionFailure(422, "CONVERSION_FAILED")
        pdf_bytes = read_regular_file(out_dir / "input.pdf", MAX_CONVERTED_PDF_BYTES)
        if not pdf_bytes or not pdf_bytes.startswith(PDF_MAGIC):
            raise ConversionFailure(422, "CONVERSION_FAILED")
        return pdf_bytes
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def handle_pdf_inspect_and_extract(payload: bytes, max_pages: int) -> dict:
    if not payload.startswith(PDF_MAGIC):
        raise ConversionFailure(422, "PDF_INVALID")
    overall_deadline = time.monotonic() + OVERALL_PDF_INSPECT_TIMEOUT_SECONDS

    def bounded_step_timeout(step_timeout: float) -> float:
        remaining = overall_deadline - time.monotonic()
        if remaining <= 0:
            raise ConversionFailure(504, "CONVERSION_TIMEOUT")
        return min(step_timeout, remaining)

    job_dir = create_job_dir()
    try:
        input_path = job_dir / "input.pdf"
        input_path.write_bytes(payload)

        info_code, info_stdout = run_bounded(
            ["pdfinfo", str(input_path)],
            timeout_seconds=bounded_step_timeout(PDFINFO_TIMEOUT_SECONDS),
            max_stdout_bytes=262_144,
            cwd=job_dir,
        )
        if info_code != 0:
            raise ConversionFailure(422, "PDF_INVALID")
        page_count, _ = parse_pdfinfo(info_stdout.decode("utf-8", errors="replace"))
        if page_count > max_pages:
            raise ConversionFailure(422, "PDF_PAGE_LIMIT_EXCEEDED")

        images_code, images_stdout = run_bounded(
            ["pdfimages", "-list", str(input_path)],
            timeout_seconds=bounded_step_timeout(PDFIMAGES_TIMEOUT_SECONDS),
            max_stdout_bytes=MAX_CONTROL_STDOUT_BYTES,
            cwd=job_dir,
        )
        if images_code != 0:
            raise ConversionFailure(422, "PDF_INVALID")
        image_counts, max_image_pixels = parse_pdfimages_list(
            images_stdout.decode("utf-8", errors="replace"),
            page_count,
        )

        pages = []
        total_text_bytes = 0
        for page_index in range(1, page_count + 1):
            remaining_budget = MAX_EXTRACTED_TEXT_BYTES - total_text_bytes
            text_code, text_stdout = run_bounded(
                [
                    "pdftotext",
                    "-f",
                    str(page_index),
                    "-l",
                    str(page_index),
                    "-layout",
                    "-enc",
                    "UTF-8",
                    str(input_path),
                    "-",
                ],
                timeout_seconds=bounded_step_timeout(PDFTOTEXT_TIMEOUT_SECONDS),
                max_stdout_bytes=remaining_budget,
                cwd=job_dir,
            )
            if text_code != 0:
                raise ConversionFailure(422, "CONVERSION_FAILED")
            native_text = text_stdout.decode("utf-8", errors="replace")
            if native_text.endswith("\f"):
                native_text = native_text[:-1]
            total_text_bytes += len(native_text.encode("utf-8"))
            if total_text_bytes > MAX_EXTRACTED_TEXT_BYTES:
                raise ConversionFailure(422, "CONVERSION_FAILED")
            pages.append({
                "pageIndex": page_index,
                "nativeText": native_text,
                "imageCount": image_counts[page_index],
                "maxImagePixels": max_image_pixels[page_index],
            })

        return {"result": "PASS", "pageCount": page_count, "pages": pages}
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def render_pdf_page_once(input_path: Path, out_prefix: Path, page: int, dpi: int, cwd: Path) -> Path:
    returncode, _ = run_bounded(
        [
            "pdftoppm",
            "-png",
            "-r",
            str(dpi),
            "-f",
            str(page),
            "-l",
            str(page),
            "-singlefile",
            str(input_path),
            str(out_prefix),
        ],
        timeout_seconds=PDFTOPPM_TIMEOUT_SECONDS,
        max_stdout_bytes=65_536,
        cwd=cwd,
    )
    output_path = Path(f"{out_prefix}.png")
    if returncode != 0 or not output_path.exists():
        raise ConversionFailure(422, "PDF_INVALID")
    return output_path


def handle_pdf_render_page(payload: bytes, page: int, dpi: int) -> bytes:
    if not payload.startswith(PDF_MAGIC):
        raise ConversionFailure(422, "PDF_INVALID")
    job_dir = create_job_dir()
    try:
        input_path = job_dir / "input.pdf"
        input_path.write_bytes(payload)
        out_prefix = job_dir / "out"

        output_path = render_pdf_page_once(input_path, out_prefix, page, dpi, job_dir)
        png_bytes = read_regular_file(output_path, MAX_RENDERED_PNG_BYTES)
        if png_bytes is None and output_path.exists() and dpi > FALLBACK_RENDER_DPI:
            output_path.unlink(missing_ok=True)
            output_path = render_pdf_page_once(input_path, out_prefix, page, FALLBACK_RENDER_DPI, job_dir)
            png_bytes = read_regular_file(output_path, MAX_RENDERED_PNG_BYTES)

        if png_bytes is None:
            if output_path.exists():
                raise ConversionFailure(422, "PDF_PAGE_TOO_LARGE")
            raise ConversionFailure(422, "CONVERSION_FAILED")
        if len(png_bytes) == 0 or not png_bytes.startswith(PNG_MAGIC):
            raise ConversionFailure(422, "CONVERSION_FAILED")
        return png_bytes
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


class ConversionHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class ConversionRequestHandler(BaseHTTPRequestHandler):
    timeout = SOCKET_IO_TIMEOUT_SECONDS
    server_version = "sop-conversion"
    sys_version = ""

    def log_message(self, format, *args):
        return

    def _send_bytes(self, status_code: int, content_type: str, body: bytes) -> None:
        self.close_connection = True
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._send_bytes(status_code, "application/json; charset=utf-8", body)

    def _read_exact(self, expected_length: int) -> bytes | None:
        chunks = []
        remaining = expected_length
        while remaining > 0:
            chunk = self.rfile.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _validate_post_headers(self, expected_content_type: str) -> int:
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != expected_content_type:
            raise ConversionFailure(415, "CONVERSION_INVALID_INPUT")
        if self.headers.get("Transfer-Encoding") is not None:
            raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isascii() or not raw_length.isdigit():
            raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
        content_length = int(raw_length)
        if content_length < 1:
            raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
        if content_length > MAX_INPUT_BYTES:
            raise ConversionFailure(413, "CONVERSION_INVALID_INPUT")
        return content_length

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path != "/healthz":
            self._send_json(404, {"result": "FAIL", "code": "NOT_FOUND"})
            return
        if all(shutil.which(binary) is not None for binary in REQUIRED_BINARIES):
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(503, {"status": "unavailable"})

    def do_POST(self) -> None:
        parsed_url = urlsplit(self.path)
        path = parsed_url.path

        try:
            if path == "/convert/docx-to-pdf":
                content_length = self._validate_post_headers(DOCX_CONTENT_TYPE)
                extra: dict = {}
            elif path == "/pdf/inspect-and-extract":
                content_length = self._validate_post_headers(PDF_CONTENT_TYPE)
                raw_max_pages = self.headers.get("X-Max-Pages")
                if raw_max_pages is None:
                    max_pages = DEFAULT_MAX_PAGES
                else:
                    max_pages = parse_strict_int(raw_max_pages.strip(), 1, MAX_PAGES_LIMIT)
                    if max_pages is None:
                        raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
                extra = {"max_pages": max_pages}
            elif path == "/pdf/render-page":
                content_length = self._validate_post_headers(PDF_CONTENT_TYPE)
                query = parse_qs(parsed_url.query, keep_blank_values=True)
                page_values = query.get("page")
                if not page_values or len(page_values) != 1:
                    raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
                page = parse_strict_int(page_values[0], 1, MAX_PAGES_LIMIT)
                if page is None:
                    raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
                dpi_values = query.get("dpi")
                if dpi_values is None:
                    dpi = DEFAULT_RENDER_DPI
                elif len(dpi_values) != 1:
                    raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
                else:
                    dpi = parse_strict_int(dpi_values[0], MIN_RENDER_DPI, MAX_RENDER_DPI)
                    if dpi is None:
                        raise ConversionFailure(400, "CONVERSION_INVALID_INPUT")
                extra = {"page": page, "dpi": dpi}
            else:
                self._send_json(404, {"result": "FAIL", "code": "NOT_FOUND"})
                return
        except ConversionFailure as failure:
            self._send_json(failure.status_code, {"result": "FAIL", "code": failure.code})
            return

        if not CONVERSION_LOCK.acquire(blocking=False):
            self._send_json(503, {"result": "FAIL", "code": "CONVERSION_BUSY"})
            return

        try:
            try:
                payload = self._read_exact(content_length)
            except OSError:
                self._send_json(400, {"result": "FAIL", "code": "CONVERSION_INVALID_INPUT"})
                return
            if payload is None or len(payload) != content_length:
                self._send_json(400, {"result": "FAIL", "code": "CONVERSION_INVALID_INPUT"})
                return

            if path == "/convert/docx-to-pdf":
                pdf_bytes = handle_docx_to_pdf(payload)
                self._send_bytes(200, PDF_CONTENT_TYPE, pdf_bytes)
            elif path == "/pdf/inspect-and-extract":
                result = handle_pdf_inspect_and_extract(payload, extra["max_pages"])
                self._send_json(200, result)
            elif path == "/pdf/render-page":
                png_bytes = handle_pdf_render_page(payload, extra["page"], extra["dpi"])
                self._send_bytes(200, PNG_CONTENT_TYPE, png_bytes)
        except ConversionFailure as failure:
            self._send_json(failure.status_code, {"result": "FAIL", "code": failure.code})
        except Exception:
            self._send_json(500, {"result": "FAIL", "code": "CONVERSION_FAILED"})
        finally:
            CONVERSION_LOCK.release()


def main() -> int:
    server = ConversionHttpServer((LISTEN_HOST, LISTEN_PORT), ConversionRequestHandler)

    def handle_shutdown(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
