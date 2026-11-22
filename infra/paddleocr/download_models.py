import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

MODEL_DIRECTORY = Path("/opt/models")
MAXIMUM_ARCHIVE_BYTES = 20_000_000
MAXIMUM_EXPANDED_BYTES = 40_000_000


def prepare_models():
    manifest = json.loads(Path("/opt/ocr/models.json").read_text())
    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    files = {}
    for model in manifest["models"]:
        with urllib.request.urlopen(model["url"], timeout=60) as response:
            archive_bytes = response.read(MAXIMUM_ARCHIVE_BYTES + 1)
        if len(archive_bytes) != model["bytes"] or hashlib.sha256(archive_bytes).hexdigest() != model["sha256"]:
            raise ValueError("Official model archive does not match the pinned bytes.")
        expanded_bytes = 0
        with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
            for member in archive.getmembers():
                relative_path = PurePosixPath(member.name)
                if relative_path.is_absolute() or ".." in relative_path.parts or "\\" in member.name:
                    raise ValueError("Invalid model archive path.")
                if relative_path.parts[0] != model["name"] + "_infer":
                    raise ValueError("Unexpected model archive root.")
                if member.isdir():
                    continue
                if not member.isfile() or len(relative_path.parts) != 2:
                    raise ValueError("Unsupported model archive entry.")
                if relative_path.name not in {"inference.json", "inference.pdiparams", "inference.yml"}:
                    raise ValueError("Unexpected model file.")
                expanded_bytes += member.size
                if expanded_bytes > MAXIMUM_EXPANDED_BYTES:
                    raise ValueError("Model archive expansion exceeds its bound.")
                with archive.extractfile(member) as source:
                    content = source.read(MAXIMUM_EXPANDED_BYTES + 1)
                if len(content) != member.size:
                    raise ValueError("Incomplete model file.")
                target = MODEL_DIRECTORY.joinpath(*relative_path.parts)
                if target.exists():
                    raise ValueError("Duplicate model file.")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                files[str(relative_path)] = hashlib.sha256(content).hexdigest()
        expected = {model["name"] + "_infer/" + name for name in ("inference.json", "inference.pdiparams", "inference.yml")}
        if not expected.issubset(files):
            raise ValueError("Incomplete model archive.")
    (MODEL_DIRECTORY / "files.json").write_text(json.dumps(files, sort_keys=True))
    print(json.dumps({"result": "PASS", "preparedModels": len(manifest["models"]), "verifiedFiles": len(files)}))


if __name__ == "__main__":
    prepare_models()
