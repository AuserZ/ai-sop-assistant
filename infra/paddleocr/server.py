from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from urllib.parse import urlsplit

from engine import MAXIMUM_INPUT_BYTES, MAXIMUM_RESULT_BYTES, OcrFailure, verify_models

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8091
SOCKET_IO_TIMEOUT_SECONDS = 15.0
# 5s margin over cli.py's 75s SIGALRM lets structured OCR_DEADLINE_EXCEEDED JSON flush before SIGKILL.
OCR_SUBPROCESS_TIMEOUT_SECONDS = 80
ALLOWED_CONTENT_TYPES = frozenset({"image/png", "image/jpeg"})
CLI_PATH = Path(__file__).resolve().with_name("cli.py")
OCR_LOCK = threading.Lock()

ERROR_STATUS_BY_CODE = {
    "OCR_INPUT_TOO_LARGE": 413,
    "OCR_INPUT_SIZE": 413,
    "OCR_INPUT_FORMAT": 422,
    "OCR_INPUT_PIXELS": 422,
    "OCR_IMAGE_INVALID": 422,
    "OCR_IMAGE_TOO_LARGE": 422,
    "OCR_MULTIFRAME_UNSUPPORTED": 422,
    "OCR_MODELS_UNAVAILABLE": 503,
    "OCR_DEADLINE_EXCEEDED": 504,
}


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


def parse_safe_error_code(raw_output: bytes) -> str:
    try:
        parsed = json.loads(raw_output.decode("utf-8"))
    except Exception:
        return "OCR_PROCESSING_FAILED"
    if not isinstance(parsed, dict):
        return "OCR_PROCESSING_FAILED"
    code = parsed.get("code")
    if isinstance(code, str) and 1 <= len(code) <= 64 and code.isascii() and code.replace("_", "").isalnum():
        return code
    return "OCR_PROCESSING_FAILED"


class OcrHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class OcrRequestHandler(BaseHTTPRequestHandler):
    timeout = SOCKET_IO_TIMEOUT_SECONDS
    server_version = "sop-ocr"
    sys_version = ""

    def log_message(self, format, *args):
        return

    def _send_json_bytes(self, status_code: int, body: bytes) -> None:
        self.close_connection = True
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._send_json_bytes(status_code, body)

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

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path != "/healthz":
            self._send_json(404, {"result": "FAIL", "code": "NOT_FOUND"})
            return
        try:
            verify_models()
        except (OcrFailure, Exception):
            self._send_json(503, {"status": "unavailable"})
            return
        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path != "/ocr":
            self._send_json(404, {"result": "FAIL", "code": "NOT_FOUND"})
            return

        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type not in ALLOWED_CONTENT_TYPES:
            self._send_json(415, {"result": "FAIL", "code": "OCR_INPUT_TYPE"})
            return

        if self.headers.get("Transfer-Encoding") is not None:
            self._send_json(400, {"result": "FAIL", "code": "OCR_INPUT_SIZE"})
            return

        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isascii() or not raw_length.isdigit():
            self._send_json(400, {"result": "FAIL", "code": "OCR_INPUT_SIZE"})
            return
        content_length = int(raw_length)
        if content_length < 1:
            self._send_json(400, {"result": "FAIL", "code": "OCR_INPUT_SIZE"})
            return
        if content_length > MAXIMUM_INPUT_BYTES:
            self._send_json(413, {"result": "FAIL", "code": "OCR_INPUT_TOO_LARGE"})
            return

        if not OCR_LOCK.acquire(blocking=False):
            self._send_json(503, {"result": "FAIL", "code": "OCR_BUSY"})
            return

        try:
            try:
                payload = self._read_exact(content_length)
            except OSError:
                self._send_json(400, {"result": "FAIL", "code": "OCR_INPUT_SIZE"})
                return
            if payload is None or len(payload) != content_length:
                self._send_json(400, {"result": "FAIL", "code": "OCR_INPUT_SIZE"})
                return

            # Isolated child process ensures clean memory reclamation and hard SIGKILL on C++ hangs.
            process = subprocess.Popen(
                [sys.executable, str(CLI_PATH), "--stdin"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                stdout, _ = process.communicate(input=payload, timeout=OCR_SUBPROCESS_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                kill_process_group(process)
                process.communicate()
                self._send_json(504, {"result": "FAIL", "code": "OCR_DEADLINE_EXCEEDED"})
                return

            if process.returncode == 0:
                if not stdout or len(stdout) > MAXIMUM_RESULT_BYTES:
                    self._send_json(500, {"result": "FAIL", "code": "OCR_RESULT_SIZE"})
                    return
                try:
                    parsed = json.loads(stdout.decode("utf-8"))
                    if not isinstance(parsed, dict) or parsed.get("verificationStatus") != "UNVERIFIED":
                        raise ValueError("Invalid OCR payload.")
                    encoded = json.dumps(parsed, ensure_ascii=False, allow_nan=False).encode("utf-8")
                    if len(encoded) > MAXIMUM_RESULT_BYTES:
                        raise ValueError("Encoded result too large.")
                except Exception:
                    self._send_json(500, {"result": "FAIL", "code": "OCR_RESULT_INVALID"})
                    return
                self._send_json_bytes(200, encoded)
                return

            error_code = parse_safe_error_code(stdout)
            status_code = ERROR_STATUS_BY_CODE.get(error_code, 500)
            self._send_json(status_code, {"result": "FAIL", "code": error_code})
        except Exception:
            self._send_json(500, {"result": "FAIL", "code": "OCR_PROCESSING_FAILED"})
        finally:
            OCR_LOCK.release()


def main() -> int:
    server = OcrHttpServer((LISTEN_HOST, LISTEN_PORT), OcrRequestHandler)

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
