import argparse
import json
import signal
import sys

from engine import MAXIMUM_INPUT_BYTES, OcrFailure, encode_result, read_input, recognize, recognize_bytes, self_test


class BoundedArguments(argparse.ArgumentParser):
    def error(self, message):
        raise OcrFailure("OCR_ARGUMENTS_INVALID")


def deadline_exceeded(signum, frame):
    raise OcrFailure("OCR_DEADLINE_EXCEEDED")


def main():
    signal.signal(signal.SIGALRM, deadline_exceeded)
    signal.alarm(75)
    try:
        arguments = BoundedArguments(description="Offline local-image OCR worker.")
        operation = arguments.add_mutually_exclusive_group()
        operation.add_argument("--self-test", action="store_true")
        operation.add_argument("--verify-bounds", action="store_true")
        operation.add_argument("--input")
        operation.add_argument("--stdin", action="store_true")
        parsed = arguments.parse_args()
        if parsed.verify_bounds:
            from verify_cases import run_checks
            result = run_checks()
        elif parsed.input is not None:
            image, digest = read_input(parsed.input)
            result = recognize(image, digest)
        elif parsed.stdin:
            raw_bytes = sys.stdin.buffer.read(MAXIMUM_INPUT_BYTES + 1)
            result = recognize_bytes(raw_bytes)
        else:
            result = self_test()
        print(encode_result(result), flush=True)
        return 0
    except OcrFailure as failure:
        print(json.dumps({"result": "FAIL", "code": failure.code}), flush=True)
        return 1
    except Exception:
        print(json.dumps({"result": "FAIL", "code": "OCR_PROCESSING_FAILED"}), flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
