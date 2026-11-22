import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const docker = process.env.SOP_DOCKER_BINARY ?? (process.platform === "win32"
  ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const image = "ai-sop-paddleocr:local";
const project = "ai-sop-s05-paddleocr-20261122";
const root = new URL("./", import.meta.url);
const admittedSources = [".dockerignore", "Dockerfile", "requirements.lock", "models.json",
  "download_models.py", "engine.py", "cli.py", "verify_cases.py"];
const manifest = await Promise.all(admittedSources.map(async (name) => ({
  name, sha256: createHash("sha256").update(await readFile(new URL(name, root))).digest("hex"),
})));
const sourceIdentity = () => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const dockerCall = async (args, timeout = 20_000) => {
  const result = await execute(docker, args, { timeout, maxBuffer: 2_000_000, windowsHide: true });
  return result.stdout.trim();
};
const imageMetadata = JSON.parse(await dockerCall(["image", "inspect", image]))[0];
assert.equal(imageMetadata.Config.User, "10001:10001");
assert.deepEqual(imageMetadata.Config.Entrypoint, ["timeout", "--signal=TERM", "--kill-after=5s", "80s", "python", "/opt/ocr/cli.py"]);
const results = [];
let ownedContainersRemoved = 0;
let inputDirectory;

async function runCase(label, command, extra = [], expectedExitCode = 0) {
  const name = "ai-sop-s05-ocr-" + process.pid + "-" + label;
  const started = Date.now();
  let created = false;
  try {
    await dockerCall(["create", "--name", name, "--label", "com.docker.compose.project=" + project,
      "--network", "none", "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--memory", "2g", "--cpus", "2", "--pids-limit", "128",
      "--shm-size", "128m", "--tmpfs", "/tmp:size=256m,mode=1777",
      "--log-driver", "none", ...extra, imageMetadata.Id, ...command]);
    created = true;
    const configuration = JSON.parse(await dockerCall(["inspect", name]))[0];
    assert.equal(configuration.Config.Labels["com.docker.compose.project"], project);
    assert.equal(configuration.Config.User, "10001:10001");
    assert.equal(configuration.Image, imageMetadata.Id);
    assert.equal(configuration.HostConfig.NetworkMode, "none");
    assert.equal(configuration.HostConfig.ReadonlyRootfs, true);
    assert.equal(configuration.HostConfig.Privileged, false);
    assert.equal(configuration.HostConfig.LogConfig.Type, "none");
    assert.equal(configuration.HostConfig.Memory, 2 * 1024 ** 3);
    assert.equal(configuration.HostConfig.NanoCpus, 2_000_000_000);
    assert.equal(configuration.HostConfig.PidsLimit, 128);
    assert.equal(configuration.HostConfig.ShmSize, 128 * 1024 ** 2);
    assert.equal(configuration.HostConfig.Tmpfs["/tmp"], "size=256m,mode=1777");
    assert.ok(configuration.HostConfig.CapDrop.includes("ALL"));
    assert.ok(configuration.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.deepEqual(configuration.HostConfig.PortBindings, {});
    const bindMounts = configuration.Mounts.filter((mount) => mount.Type !== "tmpfs");
    if (label === "input-png" || label === "input-jpeg") {
      assert.equal(bindMounts.length, 1);
      assert.equal(bindMounts[0].Type, "bind");
      assert.equal(bindMounts[0].Destination, "/input");
      assert.equal(bindMounts[0].RW, false);
      assert.equal(basename(bindMounts[0].Source), basename(inputDirectory));
    } else assert.deepEqual(bindMounts, []);
    let output;
    try {
      output = await dockerCall(["start", "--attach", name], 100_000);
    } catch (error) {
      if (typeof error.code !== "number" || error.killed) throw new Error("OCR container transport/deadline failure.");
      output = error.stdout?.trim() ?? "";
    }
    const completed = JSON.parse(await dockerCall(["inspect", name]))[0];
    assert.equal(completed.State.Running, false);
    assert.equal(completed.State.OOMKilled, false);
    assert.equal(completed.State.ExitCode, expectedExitCode);
    const payload = output ? JSON.parse(output) : null;
    const safePayload = label === "fixture-export" ? { result: payload.result, fixtures: payload.files.length } : payload;
    results.push({ case: label, exitCode: completed.State.ExitCode,
      milliseconds: Date.now() - started, sandbox: "PASS", payload: safePayload });
    return payload;
  } finally {
    if (created) {
      const owned = JSON.parse(await dockerCall(["inspect", name]))[0];
      assert.equal(owned.Config.Labels["com.docker.compose.project"], project);
      assert.equal(owned.Name, "/" + name);
      await dockerCall(["rm", "--force", name]);
      ownedContainersRemoved++;
    }
  }
}

try {
  const positive = await runCase("synthetic", ["--self-test"]);
  assert.equal(positive.result, "PASS");
  assert.equal(positive.exactLines, 4);
  assert.equal(positive.segments, 4);
  assert.equal(positive.verificationStatus, "UNVERIFIED");
  const fixtures = await runCase("fixture-export", ["-c", [
    "import base64,io,json",
    "from engine import synthetic_image",
    "image,_,_=synthetic_image()",
    "files=[]",
    "for name,format in [('page.png','PNG'),('page.jpg','JPEG')]:",
    " output=io.BytesIO()",
    " image.save(output,format=format,quality=95)",
    " files.append({'name':name,'data':base64.b64encode(output.getvalue()).decode('ascii')})",
    "print(json.dumps({'result':'PASS','files':files}))",
  ].join("\n")], ["--entrypoint", "python"]);
  assert.equal(fixtures.result, "PASS");
  assert.equal(fixtures.files.length, 2);
  inputDirectory = await mkdtemp(join(tmpdir(), "ai-sop-s05-ocr-"));
  assert.ok(resolve(inputDirectory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
  await chmod(inputDirectory, 0o755);
  for (const [index, name] of ["page.png", "page.jpg"].entries()) {
    assert.equal(fixtures.files[index].name, name);
    const bytes = Buffer.from(fixtures.files[index].data, "base64");
    assert.ok(bytes.length > 0 && bytes.length <= 4_000_000);
    const path = join(inputDirectory, name);
    await writeFile(path, bytes);
    await chmod(path, 0o444);
    const result = await runCase(index === 0 ? "input-png" : "input-jpeg", ["--input", "/input/" + name],
      ["--mount", "type=bind,src=" + inputDirectory + ",dst=/input,readonly"]);
    assert.equal(result.inputSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.verificationStatus, "UNVERIFIED");
    assert.deepEqual(result.segments.map((segment) => segment.text),
      ["SYNTHETIC SOP TEST", "Pressure 2.5 bar", "Wait 10 minutes", "Temperature 75 C"]);
  }
  const bounds = await runCase("bounds", ["--verify-bounds"], ["--tmpfs", "/input:size=8m,mode=1777"]);
  assert.equal(bounds.result, "PASS");
  assert.equal(bounds.checks.length, 11);
  const missing = await runCase("missing-model", ["--self-test"],
    ["--tmpfs", "/opt/models:size=4k,mode=555"], 1);
  assert.equal(missing.code, "OCR_MODELS_UNAVAILABLE");
  const url = await runCase("url", ["--input", "https://example.invalid/test.png"], [], 1);
  assert.equal(url.code, "OCR_INPUT_PATH");
  await runCase("hard-timeout", ["--signal=TERM", "--kill-after=1s", "1s", "python", "-c",
    "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)"],
  ["--entrypoint", "timeout"], 137);
  const after = await Promise.all(admittedSources.map(async (name) => ({
    name, sha256: createHash("sha256").update(await readFile(new URL(name, root))).digest("hex"),
  })));
  assert.deepEqual(after, manifest);
  console.log(JSON.stringify({ result: "PASS", project, imageId: imageMetadata.Id,
    sourceManifest: sourceIdentity(), sourceFiles: manifest, checks: results,
    ownedContainersRemoved, network: "none", secretMounts: 0, publishedPorts: 0,
    fullIngestionClaimed: false }));
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", errorType: error.name,
    ownedContainersRemoved, completedCases: results.map((result) => ({
      case: result.case, exitCode: result.exitCode, milliseconds: result.milliseconds,
      code: result.payload?.code, result: result.payload?.result,
    })) }));
  process.exitCode = 1;
} finally {
  if (inputDirectory) {
    for (const name of ["page.png", "page.jpg"]) {
      const path = join(inputDirectory, name);
      await chmod(path, 0o600).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    await rmdir(inputDirectory);
  }
}
