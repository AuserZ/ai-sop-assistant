import io
import json
import os
from pathlib import Path
import signal
import tempfile
import time

from PIL import Image
from engine import (MANIFEST, MAXIMUM_INPUT_BYTES, MAXIMUM_RESULT_BYTES, OcrFailure, decode_image,
                    encode_result, read_input, recognize_bytes, synthetic_image, validate_segments, verify_models)


def rejected(operation, expected):
    try:
        operation()
    except OcrFailure as failure:
        if failure.code == expected:
            return
        raise
    raise AssertionError("Unsafe input was accepted.")


def run_checks():
    checks = []
    image, _, _ = synthetic_image()
    assert image.size == (1100, 420)
    checks.append("valid synthetic image decoding")
    for content in (b"", b"x" * (MAXIMUM_INPUT_BYTES + 1)):
        rejected(lambda: decode_image(content), "OCR_INPUT_SIZE")
    checks.append("empty and oversized bytes denied")
    bmp_buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(bmp_buffer, format="BMP")
    for content in (b"not an image", b"%PDF-1.7\n%%EOF", bmp_buffer.getvalue()):
        rejected(lambda: decode_image(content), "OCR_INPUT_FORMAT")
    checks.append("malformed and unsupported formats denied")
    rejected(lambda: recognize_bytes(b""), "OCR_INPUT_SIZE")
    rejected(lambda: recognize_bytes(b"x" * (MAXIMUM_INPUT_BYTES + 1)), "OCR_INPUT_SIZE")
    rejected(lambda: recognize_bytes(bmp_buffer.getvalue()), "OCR_INPUT_FORMAT")
    checks.append("recognize_bytes bounds denied")
    pixels = io.BytesIO()
    Image.new("1", (4000, 3001)).save(pixels, format="PNG")
    rejected(lambda: decode_image(pixels.getvalue()), "OCR_INPUT_PIXELS")
    checks.append("oversized expanded image denied")
    for path in ("https://example.invalid/image.png", "/etc/passwd", "/input/../etc/passwd", "page.png"):
        rejected(lambda: read_input(path), "OCR_INPUT_PATH")
    checks.append("URL and foreign paths denied")
    input_directory = Path("/input")
    os.symlink("/etc/passwd", input_directory / "link.png")
    os.mkfifo(input_directory / "pipe.png")
    (input_directory / "directory.png").mkdir()
    for name in ("link.png", "pipe.png", "directory.png"):
        rejected(lambda: read_input(input_directory / name), "OCR_INPUT_PATH")
    checks.append("symlink FIFO and directory inputs denied")
    with tempfile.TemporaryDirectory() as temporary:
        rejected(lambda: verify_models(Path(temporary)), "OCR_MODELS_UNAVAILABLE")
    checks.append("missing models denied")
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        files = {}
        for model in MANIFEST["models"]:
            for name in ("inference.json", "inference.pdiparams", "inference.yml"):
                relative = model["name"] + "_infer/" + name
                target = directory / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"corrupt model")
                files[relative] = "0" * 64
        (directory / "files.json").write_text(json.dumps(files))
        rejected(lambda: verify_models(directory), "OCR_MODELS_UNAVAILABLE")
    checks.append("corrupt models denied")
    polygon = [[0, 0], [10, 0], [10, 10], [0, 10]]
    preserved = validate_segments(["Untrusted 2.5 bar"], [0.95], [polygon], 20, 20)
    assert preserved[0]["text"] == "Untrusted 2.5 bar" and preserved[0]["order"] == 0
    for scores, boxes in (([float("nan")], [polygon]), ([1.1], [polygon]), ([0.9], [[[0, 0]]])):
        rejected(lambda: validate_segments(["text"], scores, boxes, 20, 20), "OCR_RESULT_INVALID")
    checks.append("bounded finite results preserve text")
    rejected(lambda: encode_result({"text": "x" * MAXIMUM_RESULT_BYTES}), "OCR_RESULT_SIZE")
    checks.append("oversized result denied")
    from cli import deadline_exceeded
    previous = signal.signal(signal.SIGALRM, deadline_exceeded)
    try:
        signal.setitimer(signal.ITIMER_REAL, 0.05)
        rejected(lambda: time.sleep(1), "OCR_DEADLINE_EXCEEDED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    checks.append("actual deadline signal interrupts work")
    return {"result": "PASS", "check": "OCR input/result/deadline bounds", "checks": checks}
