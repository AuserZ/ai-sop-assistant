import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
    assert.ok(configuration.Mounts.every((mount) => mount.Type === "tmpfs"));
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
    results.push({ case: label, exitCode: completed.State.ExitCode,
      milliseconds: Date.now() - started, sandbox: "PASS", payload });
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
  const bounds = await runCase("bounds", ["--verify-bounds"]);
  assert.equal(bounds.result, "PASS");
  assert.equal(bounds.checks.length, 10);
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
}
