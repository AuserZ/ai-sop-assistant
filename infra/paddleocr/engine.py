from contextlib import contextmanager
import ctypes
import hashlib
from importlib.metadata import version
import io
import json
import math
import os
from pathlib import Path
import stat
import sys
import warnings

from PIL import Image, ImageDraw, ImageFont

MAXIMUM_INPUT_BYTES = 4_000_000
MAXIMUM_IMAGE_PIXELS = 12_000_000
MAXIMUM_SEGMENTS = 1024
MAXIMUM_RESULT_BYTES = 1_000_000
MODEL_DIRECTORY = Path("/opt/models")
MANIFEST = json.loads(Path("/opt/ocr/models.json").read_text())
Image.MAX_IMAGE_PIXELS = MAXIMUM_IMAGE_PIXELS


class OcrFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@contextmanager
def muted_engine_output():
    sys.stdout.flush()
    sys.stderr.flush()
    original_stdout, original_stderr = os.dup(1), os.dup(2)
    try:
        with open(os.devnull, "w") as discarded:
            os.dup2(discarded.fileno(), 1)
            os.dup2(discarded.fileno(), 2)
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        ctypes.CDLL(None).fflush(None)
        os.dup2(original_stdout, 1)
        os.dup2(original_stderr, 2)
        os.close(original_stdout)
        os.close(original_stderr)


def decode_image(content):
    if not content or len(content) > MAXIMUM_INPUT_BYTES:
        raise OcrFailure("OCR_INPUT_SIZE")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content), formats=("PNG", "JPEG")) as image:
                if image.format not in {"PNG", "JPEG"} or getattr(image, "n_frames", 1) != 1:
                    raise OcrFailure("OCR_INPUT_FORMAT")
                if image.width * image.height > MAXIMUM_IMAGE_PIXELS:
                    raise OcrFailure("OCR_INPUT_PIXELS")
                image.verify()
            with Image.open(io.BytesIO(content), formats=("PNG", "JPEG")) as image:
                return image.convert("RGB")
    except OcrFailure:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise OcrFailure("OCR_INPUT_PIXELS") from None
    except Exception:
        raise OcrFailure("OCR_INPUT_FORMAT") from None


def read_input(path):
    path = Path(path)
    if not path.is_absolute() or path.parent != Path("/input") or path.name in {"", ".", ".."}:
        raise OcrFailure("OCR_INPUT_PATH")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise OcrFailure("OCR_INPUT_PATH")
            if metadata.st_size > MAXIMUM_INPUT_BYTES:
                raise OcrFailure("OCR_INPUT_SIZE")
            content = source.read(MAXIMUM_INPUT_BYTES + 1)
    except OcrFailure:
        raise
    except OSError:
        raise OcrFailure("OCR_INPUT_PATH") from None
    return decode_image(content), hashlib.sha256(content).hexdigest()


def verify_models(directory=MODEL_DIRECTORY):
    try:
        files = json.loads((directory / "files.json").read_text())
        expected = {model["name"] + "_infer/" + name for model in MANIFEST["models"]
                    for name in ("inference.json", "inference.pdiparams", "inference.yml")}
        if set(files) != expected:
            raise ValueError("Unexpected model files.")
        for name, digest in files.items():
            path = directory / name
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError("Invalid model bytes.")
    except Exception:
        raise OcrFailure("OCR_MODELS_UNAVAILABLE") from None


def validate_segments(texts, scores, polygons, width, height):
    if len(texts) != len(scores) or len(texts) != len(polygons) or len(texts) > MAXIMUM_SEGMENTS:
        raise OcrFailure("OCR_RESULT_INVALID")
    segments = []
    for order, (text, score, polygon) in enumerate(zip(texts, scores, polygons)):
        confidence = float(score)
        if not isinstance(text, str) or len(text.encode("utf8")) > 32768 or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise OcrFailure("OCR_RESULT_INVALID")
        if len(polygon) != 4:
            raise OcrFailure("OCR_RESULT_INVALID")
        box = []
        for point in polygon:
            if len(point) != 2:
                raise OcrFailure("OCR_RESULT_INVALID")
            x, y = float(point[0]), float(point[1])
            if not all(math.isfinite(value) for value in (x, y)) or not 0 <= x <= width or not 0 <= y <= height:
                raise OcrFailure("OCR_RESULT_INVALID")
            box.append([x, y])
        segments.append({"order": order, "text": text, "confidence": confidence, "box": box})
    return segments


def recognize(image, input_sha256):
    verify_models()
    with muted_engine_output():
        import numpy
        from paddleocr import PaddleOCR

        detector, recognizer = MANIFEST["models"]
        pipeline = PaddleOCR(
            device="cpu", cpu_threads=2, enable_mkldnn=False,
            use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name=detector["name"],
            text_detection_model_dir=str(MODEL_DIRECTORY / (detector["name"] + "_infer")),
            text_recognition_model_name=recognizer["name"],
            text_recognition_model_dir=str(MODEL_DIRECTORY / (recognizer["name"] + "_infer")),
        )
        predictions = list(pipeline.predict(numpy.asarray(image), text_rec_score_thresh=0.0))
    if len(predictions) != 1:
        raise OcrFailure("OCR_RESULT_INVALID")
    prediction = predictions[0]
    segments = validate_segments(prediction["rec_texts"], prediction["rec_scores"],
                                 prediction["rec_polys"], image.width, image.height)
    result = {
        "pipelineVersion": MANIFEST["pipelineVersion"],
        "inputSha256": input_sha256, "pageIndex": 0,
        "width": image.width, "height": image.height,
        "models": [{"name": model["name"], "archiveSha256": model["sha256"]} for model in MANIFEST["models"]],
        "packages": {name: version(name) for name in ("paddleocr", "paddlepaddle", "paddlex")},
        "verificationStatus": "UNVERIFIED", "segments": segments,
    }
    encode_result(result)
    return result


def recognize_bytes(raw: bytes):
    if not isinstance(raw, (bytes, bytearray)):
        raise OcrFailure("OCR_INPUT_FORMAT")
    content = bytes(raw)
    image = decode_image(content)
    return recognize(image, hashlib.sha256(content).hexdigest())


def encode_result(result):
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf8")) > MAXIMUM_RESULT_BYTES:
        raise OcrFailure("OCR_RESULT_SIZE")
    return encoded


def synthetic_image():
    image = Image.new("RGB", (1100, 420), "white")
    drawing = ImageDraw.Draw(image)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 44)
    lines = ["SYNTHETIC SOP TEST", "Pressure 2.5 bar", "Wait 10 minutes", "Temperature 75 C"]
    for index, line in enumerate(lines):
        drawing.text((40, 35 + index * 90), line, fill="black", font=font)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    content = encoded.getvalue()
    return decode_image(content), hashlib.sha256(content).hexdigest(), lines


def self_test():
    image, digest, expected_lines = synthetic_image()
    result = recognize(image, digest)
    actual_lines = [segment["text"] for segment in result["segments"]]
    if actual_lines != expected_lines:
        raise OcrFailure("OCR_SYNTHETIC_MISMATCH")
    return {
        "result": "PASS", "check": "offline synthetic numeric/unit OCR",
        "segments": len(actual_lines), "exactLines": len(expected_lines),
        "inputSha256": digest, "verificationStatus": result["verificationStatus"],
        "packages": result["packages"], "models": result["models"],
    }
