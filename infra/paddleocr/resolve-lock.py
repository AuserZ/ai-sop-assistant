import json
import pathlib
import subprocess
import sys

requirements = pathlib.Path(__file__).with_name("requirements.in").read_text().splitlines()
report_path = pathlib.Path("/tmp/paddleocr-lock.json")
with open("/tmp/paddleocr-lock.log", "w") as diagnostics:
    completed = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
         "--only-binary=:all:", "--report", str(report_path), *requirements],
        stdout=diagnostics, stderr=subprocess.STDOUT, timeout=600, check=False,
    )
if completed.returncode:
    print(json.dumps({"status": "FAIL", "code": "DEPENDENCY_RESOLUTION_FAILED"}))
    sys.exit(1)
report = json.loads(report_path.read_text())
packages = []
for package in report["install"]:
    archive = package["download_info"]["archive_info"]
    packages.append({
        "name": package["metadata"]["name"], "version": package["metadata"]["version"],
        "url": package["download_info"]["url"], "sha256": archive["hashes"]["sha256"],
    })
print(json.dumps({"status": "PASS", "python": sys.version.split()[0],
                  "packages": sorted(packages, key=lambda package: package["name"].lower())}))
