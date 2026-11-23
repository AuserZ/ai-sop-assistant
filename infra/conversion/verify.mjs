import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const docker = process.env.SOP_DOCKER_BINARY ?? (process.platform === "win32"
  ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const image = process.env.SOP_CONVERSION_IMAGE ?? "ai-sop-assistant-convert-worker";
const project = "ai-sop-s05-conversion-verify";
const root = new URL("./", import.meta.url);
const runDocker = process.argv.includes("--docker") || process.env.SOP_CONVERSION_VERIFY_DOCKER === "1";

const sourceNames = [".dockerignore", "Dockerfile", "server.py"];
const sources = Object.fromEntries(await Promise.all(sourceNames.map(async (name) => {
  const bytes = await readFile(new URL(name, root));
  return [name, {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: bytes.toString("utf8"),
  }];
})));

const dockerignoreLines = sources[".dockerignore"].text.trim().split(/\r?\n/);
assert.deepEqual(dockerignoreLines, ["**", "!Dockerfile", "!server.py"]);

const dockerfile = sources.Dockerfile.text;
assert.match(dockerfile, /^FROM python:3\.11\.18-slim-bookworm@sha256:[0-9a-f]{64}$/m);
assert.match(dockerfile, /libreoffice-writer/);
assert.match(dockerfile, /fonts-liberation/);
assert.match(dockerfile, /poppler-utils/);
assert.match(dockerfile, /\/opt\/conversion\/server\.py/);
assert.match(dockerfile, /ENV HOME=\/tmp/);
assert.match(dockerfile, /USER 10001:10001/);
assert.match(dockerfile, /ENTRYPOINT \["soffice", "-env:UserInstallation=file:\/\/\/tmp\/lo-profile", "--headless"\]/);
assert.match(dockerfile, /CMD \["--version"\]/);

const server = sources["server.py"].text;
for (const requiredToken of [
  "LISTEN_PORT = 8092",
  "OVERALL_PDF_INSPECT_TIMEOUT_SECONDS = 55.0",
  '"http_proxy": "http://127.0.0.1:9"',
  '"HTTPS_PROXY": "http://127.0.0.1:9"',
  '"/healthz"',
  '"/convert/docx-to-pdf"',
  '"/pdf/inspect-and-extract"',
  '"/pdf/render-page"',
  "start_new_session=True",
  "signal.SIGKILL",
  "def log_message",
  "CONVERSION_LOCK.acquire(blocking=False)",
  "shutil.rmtree(job_dir, ignore_errors=True)",
  "PDF_ENCRYPTED",
  "PDF_PAGE_LIMIT_EXCEEDED",
  "PDF_PAGE_TOO_LARGE",
]) {
  assert.ok(server.includes(requiredToken), `Missing required contract token in server.py: ${requiredToken}`);
}

const staticChecks = [
  "dockerignore-default-deny",
  "dockerfile-digest-pin-and-entrypoint",
  "server-endpoints-and-bounds",
];

if (!runDocker) {
  console.log(JSON.stringify({
    result: "PASS",
    mode: "static",
    checks: staticChecks,
    sources: sourceNames.map((name) => ({ name, sha256: sources[name].sha256 })),
    dockerChecksExecuted: false,
  }));
  process.exit(0);
}

const dockerCall = async (args, timeout = 30_000) => {
  const result = await execute(docker, args, { timeout, maxBuffer: 2_000_000, windowsHide: true });
  return result.stdout.trim();
};

const imageMetadata = JSON.parse(await dockerCall(["image", "inspect", image]))[0];
assert.equal(imageMetadata.Config.User, "10001:10001");

let ownedContainersRemoved = 0;
async function runContainer(label, entrypoint, command, timeoutMs = 60_000) {
  const name = `ai-sop-s05-conv-${process.pid}-${label}`;
  let created = false;
  try {
    await dockerCall([
      "create", "--name", name, "--label", `com.docker.compose.project=${project}`,
      "--network", "none", "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "128",
      "--tmpfs", "/tmp:size=256m,mode=1777,nosuid,nodev",
      "--log-driver", "none",
      ...(entrypoint ? ["--entrypoint", entrypoint] : []),
      imageMetadata.Id, ...command,
    ]);
    created = true;
    const output = await dockerCall(["start", "--attach", name], timeoutMs);
    const completed = JSON.parse(await dockerCall(["inspect", name]))[0];
    assert.equal(completed.State.ExitCode, 0);
    return output;
  } finally {
    if (created) {
      await dockerCall(["rm", "--force", name]);
      ownedContainersRemoved++;
    }
  }
}

const versionOutput = await runContainer("soffice-version", null, ["--version"]);
assert.match(versionOutput, /LibreOffice/i);

const probeScript = [
  "import io, json, py_compile, threading, urllib.error, urllib.request, zipfile",
  "py_compile.compile('/opt/conversion/server.py', cfile='/tmp/server.pyc', doraise=True)",
  "import sys; sys.path.insert(0, '/opt/conversion')",
  "import server",
  "def build_synthetic_docx():",
  "  buf = io.BytesIO()",
  "  with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
  "    archive.writestr('[Content_Types].xml', '<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>')",
  "    archive.writestr('_rels/.rels', '<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>')",
  "    archive.writestr('word/document.xml', '<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>SYNTHETIC SOP DOCX TEST Pressure 2.5 bar</w:t></w:r></w:p></w:body></w:document>')",
  "  return buf.getvalue()",
  "httpd = server.ConversionHttpServer(('127.0.0.1', 0), server.ConversionRequestHandler)",
  "port = httpd.server_address[1]",
  "thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()",
  "try:",
  "  with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=5) as resp:",
  "    health = json.loads(resp.read().decode('utf-8'))",
  "    assert resp.status == 200 and health['status'] == 'ok'",
  "  bad_req = urllib.request.Request(f'http://127.0.0.1:{port}/pdf/inspect-and-extract', data=b'not-a-pdf', headers={'Content-Type': 'application/pdf'})",
  "  try:",
  "    urllib.request.urlopen(bad_req, timeout=5)",
  "    raise AssertionError('Expected 422')",
  "  except urllib.error.HTTPError as err:",
  "    bad_body = json.loads(err.read().decode('utf-8'))",
  "    assert err.code == 422 and bad_body['code'] == 'PDF_INVALID'",
  "  docx_bytes = build_synthetic_docx()",
  "  docx_req = urllib.request.Request(f'http://127.0.0.1:{port}/convert/docx-to-pdf', data=docx_bytes, headers={'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})",
  "  with urllib.request.urlopen(docx_req, timeout=60) as resp:",
  "    assert resp.status == 200",
  "    assert (resp.headers.get('Content-Type') or '').startswith('application/pdf')",
  "    pdf_bytes = resp.read()",
  "  assert pdf_bytes.startswith(b'%PDF-') and len(pdf_bytes) > 100",
  "  inspect_req = urllib.request.Request(f'http://127.0.0.1:{port}/pdf/inspect-and-extract', data=pdf_bytes, headers={'Content-Type': 'application/pdf'})",
  "  with urllib.request.urlopen(inspect_req, timeout=30) as resp:",
  "    assert resp.status == 200",
  "    extracted = json.loads(resp.read().decode('utf-8'))",
  "  assert extracted['result'] == 'PASS' and extracted['pageCount'] == 1",
  "  assert 'Pressure 2.5 bar' in extracted['pages'][0]['nativeText']",
  "  render_req = urllib.request.Request(f'http://127.0.0.1:{port}/pdf/render-page?page=1&dpi=150', data=pdf_bytes, headers={'Content-Type': 'application/pdf'})",
  "  with urllib.request.urlopen(render_req, timeout=30) as resp:",
  "    assert resp.status == 200",
  "    assert (resp.headers.get('Content-Type') or '').startswith('image/png')",
  "    png_bytes = resp.read()",
  "  assert png_bytes.startswith(b'\\x89PNG\\r\\n\\x1a\\n') and 100 < len(png_bytes) <= 4_000_000",
  "  print(json.dumps({'result': 'PASS', 'health': health['status'], 'invalidPdfCode': bad_body['code'], 'pdfBytes': len(pdf_bytes), 'pageCount': extracted['pageCount'], 'pngBytes': len(png_bytes)}))",
  "finally:",
  "  httpd.shutdown(); httpd.server_close()",
].join("\n");

const probeOutput = JSON.parse(await runContainer("http-probe", "python3", ["-c", probeScript], 90_000));
assert.equal(probeOutput.result, "PASS");
assert.equal(probeOutput.pageCount, 1);
assert.ok(probeOutput.pdfBytes > 100);
assert.ok(probeOutput.pngBytes > 100);

console.log(JSON.stringify({
  result: "PASS",
  mode: "docker",
  imageId: imageMetadata.Id,
  checks: [...staticChecks, "soffice-version", "http-healthz-invalid-pdf-docx-convert-extract-render"],
  probe: probeOutput,
  ownedContainersRemoved,
  sources: sourceNames.map((name) => ({ name, sha256: sources[name].sha256 })),
  dockerChecksExecuted: true,
}));
