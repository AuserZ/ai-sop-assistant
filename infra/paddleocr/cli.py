import argparse
import json
import signal

from engine import OcrFailure, encode_result, read_input, recognize, self_test


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
        parsed = arguments.parse_args()
        if parsed.verify_bounds:
            from verify_cases import run_checks
            result = run_checks()
        elif parsed.input:
            image, digest = read_input(parsed.input)
            result = recognize(image, digest)
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
