import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

class RuntimeVerificationError extends Error {}
class StreamVerificationError extends RuntimeVerificationError {}

const project = process.env.SOP_WORKFLOW_TEST_PROJECT;
if (!project || !/^ai-sop-(?:assistant|s0[34]-[a-z0-9-]+)$/.test(project)) {
  throw new RuntimeVerificationError("An explicitly named synthetic workflow verification project is required.");
}
const docker = process.env.SOP_TEST_DOCKER ?? (process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const baseURL = "http://127.0.0.1:3000";
const fixtureDirectory = resolve(".local-secrets/browser-fixtures");
const fixture = JSON.parse(readFileSync(resolve(fixtureDirectory, "s02-browser-fixture.json"), "utf8"));
if (fixture.baseURL !== baseURL || ![fixture.staff, fixture.workflowRevocationUser].every((user) => user.email.endsWith("@example.invalid"))) {
  throw new RuntimeVerificationError("Only local synthetic browser fixtures are allowed.");
}
const recoveryMilliseconds = 100_000;
const maximumCaptureBytes = 65_536;
const maximumEvents = 64;
const mutationHeaders = { Origin: baseURL, "Content-Type": "application/json" };
const progressStages = new Set(["accepted", "started", "processing", "deterministic_pass", "judge_stub_pass", "retrying"]);
const touchedServices = new Set();
const activeCollectors = new Set();

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function dockerCommand(arguments_) {
  try {
    return execFileSync(docker, arguments_, { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  } catch {
    throw new RuntimeVerificationError("A scoped Docker verification action failed; raw command output was withheld.");
  }
}
function compose(...arguments_) { return dockerCommand(["compose", "-p", project, ...arguments_]); }
function ownedService(service) {
  const id = compose("ps", "--all", "--quiet", service).trim();
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new RuntimeVerificationError("Expected one project-owned service container.");
  const [container] = JSON.parse(dockerCommand(["inspect", id]));
  const labels = container.Config.Labels;
  const normalize = (path) => resolve(path).replaceAll("\\", "/").toLowerCase();
  if (labels["com.docker.compose.project"] !== project || normalize(labels["com.docker.compose.project.working_dir"]) !== normalize(process.cwd())) {
    throw new RuntimeVerificationError("Refusing to control a container outside this project/workspace.");
  }
  return container;
}
async function serviceAction(action, service) {
  ownedService(service);
  touchedServices.add(service);
  if (action === "kill") compose("kill", "--signal", "SIGKILL", service);
  else if (action === "stop") compose("stop", "--timeout", "1", service);
  else if (action === "start") {
    compose("up", "--detach", "--no-deps", service);
    await until(async () => {
      const { State: state } = ownedService(service);
      if (state.Dead || !state.Running) throw new RuntimeVerificationError("A synthetic service stopped during recovery.");
      if (!state.Paused && (!state.Health || state.Health.Status === "healthy")) return true;
      await delay(500);
      return false;
    }, "A synthetic service did not become healthy after recovery.", 90_000);
  }
  else if (action === "restart") compose("restart", "--timeout", "10", service);
  else compose(action, service);
}
async function restoreRuntime() {
  const errors = [];
  for (const collector of activeCollectors) {
    try { await collector.cancel(); } catch (error) { errors.push(error); }
  }
  for (const service of ["redis", "app", "n8n-worker"]) {
    if (!touchedServices.has(service)) continue;
    try {
      if (ownedService(service).State.Paused) await serviceAction("unpause", service);
      await serviceAction("start", service);
      touchedServices.delete(service);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new RuntimeVerificationError("Scoped runtime cleanup failed; inspect the synthetic project before rerunning.");
}
function fixtureControl(action, jobId) {
  const output = compose("--profile", "verify", "run", "--rm", "--no-deps", "-T",
    "--user", process.platform === "win32" ? "1000:1000" : `${process.getuid()}:${process.getgid()}`,
    "-e", "SOP_SYNTHETIC_AUTH=1", "-e", "BROWSER_FIXTURE_DIRECTORY=/browser-fixtures",
    "-v", `${fixtureDirectory}:/browser-fixtures:ro`, "verify-db", "node", "--import", "tsx",
    "tests/e2e/workflow-control.ts", action, ...(jobId ? [jobId] : []));
  if (action === "status") return JSON.parse(output.trim().split("\n").at(-1));
}
function inspectExecutionStorage(phase) {
  try {
    const output = execFileSync(process.execPath, ["infra/n8n/inspect-execution-storage.mjs"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
    });
    console.log(JSON.stringify({ check: "count-only execution storage", phase, ...JSON.parse(output) }));
  } catch { throw new RuntimeVerificationError("Count-only execution storage inspection failed; raw output withheld."); }
}
async function until(predicate, message, timeout = recoveryMilliseconds) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const matched = await predicate();
    if (performance.now() >= deadline) break;
    if (matched) return;
    await delay(100);
  }
  throw new RuntimeVerificationError(message);
}
async function login(user) {
  const response = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ email: user.email, password: fixture.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new RuntimeVerificationError("Synthetic runtime sign-in failed.");
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function createProbe(cookie) {
  const response = await fetch(`${baseURL}/api/jobs/probe`, { method: "POST", headers: { ...mutationHeaders, Cookie: cookie },
    body: JSON.stringify({ requestKey: randomUUID(), scenario: "success" }), signal: AbortSignal.timeout(10_000) });
  const job = await response.json();
  if (response.status !== 202 || !/^[0-9a-f-]{36}$/.test(job.jobId) || job.eventsUrl !== `/api/jobs/${job.jobId}/events`) {
    throw new RuntimeVerificationError("Synthetic runtime job creation failed.");
  }
  return job;
}
function collect(job, cookie, budgetMilliseconds = recoveryMilliseconds) {
  const controller = new AbortController();
  const events = [];
  let failure;
  let lastCursor;
  let bytes = 0;
  let finished = false;
  let timeoutFrames = 0;
  let terminalSeen = false;
  const completion = (async () => {
    const deadline = performance.now() + budgetMilliseconds;
    while (!controller.signal.aborted && performance.now() < deadline) {
      try {
        const response = await fetch(`${baseURL}${job.eventsUrl}`, {
          headers: { Cookie: cookie, ...(lastCursor ? { "Last-Event-ID": lastCursor } : {}) },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))]),
        });
        if (response.status === 401) { finished = true; return; }
        if (!response.ok) throw new RuntimeVerificationError("Workflow stream is unavailable.");
        const reader = response.body.getReader();
        let buffer = "";
        const decoder = new TextDecoder();
        try {
          while (!controller.signal.aborted && performance.now() < deadline) {
            const chunk = await reader.read();
            if (performance.now() >= deadline) throw new StreamVerificationError("Workflow recovery deadline exceeded.");
            if (chunk.done) {
              if (buffer.length) throw new StreamVerificationError("Incomplete workflow frame at stream end.");
              if (terminalSeen) { finished = true; return; }
              break;
            }
            bytes += chunk.value.byteLength;
            if (bytes > maximumCaptureBytes) throw new StreamVerificationError("Workflow stream exceeded its capture bound.");
            buffer += decoder.decode(chunk.value, { stream: true });
            while (buffer.includes("\n\n")) {
              const boundary = buffer.indexOf("\n\n");
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (terminalSeen) throw new StreamVerificationError("Workflow bytes followed a terminal result.");
              if (frame === ": heartbeat") continue;
              const lines = frame.split("\n");
              const timeoutFrame = lines.length === 2 && /^event: stream_timeout$/.test(lines[0]) && /^data: /.test(lines[1]);
              const jobFrame = lines.length === 3 && /^id: /.test(lines[0]) && /^event: /.test(lines[1]) && /^data: /.test(lines[2]);
              if (!timeoutFrame && !jobFrame) throw new StreamVerificationError("Unexpected workflow wire fields.");
              if (/Bearer|eyJ[A-Za-z0-9_-]+\.|https?:\/\/|draft|password|PRIVATE KEY/i.test(frame)) throw new StreamVerificationError("Unsafe stream field detected.");
              const kind = /^event: (.+)$/m.exec(frame)?.[1];
              const id = /^id: (.+)$/m.exec(frame)?.[1];
              let data;
              try { data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "null"); }
              catch { throw new StreamVerificationError("Invalid workflow JSON."); }
              if (kind === "stream_timeout") {
                if (id || !hasExactKeys(data, ["code", "retryable"]) || data.code !== "STREAM_TIMEOUT" || data.retryable !== true) {
                  throw new StreamVerificationError("Invalid workflow timeout frame.");
                }
                timeoutFrames++;
                continue;
              }
              const sequenceText = id?.slice(job.jobId.length + 1) ?? "";
              const sequence = Number(sequenceText);
              if (!id?.startsWith(`${job.jobId}:`) || !/^[1-9]\d*$/.test(sequenceText) || !Number.isSafeInteger(sequence) ||
                  data?.jobId !== job.jobId || data.synthetic !== true ||
                  !["progress", "completed", "failed"].includes(kind)) throw new StreamVerificationError("Invalid workflow frame.");
              if (kind === "progress" && (!hasExactKeys(data, ["jobId", "synthetic", "stage"]) || !progressStages.has(data.stage))) {
                throw new StreamVerificationError("Invalid workflow progress fields.");
              }
              if (kind === "completed" && (!hasExactKeys(data, ["jobId", "synthetic", "kind", "marker"]) ||
                  data.kind !== "synthetic_probe" || data.marker !== "S03_SYNTHETIC_VALIDATED")) {
                throw new StreamVerificationError("Invalid workflow completion fields.");
              }
              if (kind === "failed" && (!hasExactKeys(data, ["jobId", "synthetic", "code", "retryable"]) ||
                  data.code !== "SYNTHETIC_WORKFLOW_FAILED" || data.retryable !== false)) {
                throw new StreamVerificationError("Invalid workflow failure fields.");
              }
              if (lastCursor && sequence <= Number(lastCursor.split(":").at(-1))) throw new StreamVerificationError("Duplicate or reordered workflow frame.");
              lastCursor = id;
              events.push({ kind, data });
              if (events.length > maximumEvents) throw new StreamVerificationError("Workflow event count exceeded its bound.");
              if (kind === "failed") throw new StreamVerificationError("Synthetic runtime job failed.");
              if (kind === "completed") {
                if (data.marker !== "S03_SYNTHETIC_VALIDATED" || !events.some((event) => event.data.stage === "judge_stub_pass")) {
                  throw new StreamVerificationError("Premature synthetic completion.");
                }
                terminalSeen = true;
              }
            }
          }
        } finally { await reader.cancel().catch(() => undefined); }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof StreamVerificationError) throw error;
        if (terminalSeen) throw new StreamVerificationError("Workflow stream did not close cleanly after completion.");
        await delay(100);
      }
    }
    if (!controller.signal.aborted) throw new RuntimeVerificationError("Workflow recovery deadline exceeded.");
  })().catch((error) => { failure = error; }).finally(() => { finished = true; });
  const collector = {
    events,
    async stage(stage) { await until(() => { if (failure) throw failure; return events.some((event) => event.data.stage === stage); }, "Required workflow stage was not observed."); },
    async timeout() { await until(() => { if (failure) throw failure; return timeoutFrames > 0; }, "Proxy stream timeout was not observed.", 75_000); },
    async complete() { await completion; if (failure) throw failure; if (events.filter((event) => event.kind === "completed").length !== 1) throw new RuntimeVerificationError("Expected one synthetic completion."); },
    async closed() { await until(() => finished, "Revoked stream did not close.", 10_000); if (failure) throw failure; },
    async cancel() { controller.abort(); await completion; activeCollectors.delete(collector); },
  };
  activeCollectors.add(collector);
  return collector;
}
async function check(name, work) {
  const started = performance.now();
  let failure;
  let failurePhase;
  try {
    await work();
  } catch (error) { failure = error; failurePhase = "work"; }
  try { await restoreRuntime(); }
  catch (error) { if (!failure) { failure = error; failurePhase = "cleanup"; } }
  if (failure) {
    console.error(JSON.stringify({ check: name, result: "FAIL", phase: failurePhase,
      reason: failure instanceof RuntimeVerificationError ? failure.message : "Unexpected verification failure; raw details withheld." }));
    throw failure;
  }
  console.log(JSON.stringify({ check: name, result: "PASS", milliseconds: Math.round(performance.now() - started) }));
}

let cookie;
try {
  for (const service of ["app", "n8n-worker", "redis"]) {
    const container = ownedService(service);
    if (!container.State.Running || container.State.Paused) throw new RuntimeVerificationError("Runtime checks require running, unpaused synthetic services.");
  }
  cookie = await login(fixture.staff);
  await check("queued work waits for a worker and survives worker pause", async () => {
    await serviceAction("pause", "n8n-worker");
    try {
      const job = await createProbe(cookie);
      const stream = collect(job, cookie);
      await stream.stage("accepted");
      await until(() => fixtureControl("status", job.jobId).dispatchAccepted, "n8n did not acknowledge queued dispatch.", 30_000);
      inspectExecutionStorage("queued worker pause");
      if (stream.events.some((event) => event.data.stage === "started")) throw new RuntimeVerificationError("Work ran while the worker was paused.");
      await serviceAction("unpause", "n8n-worker");
      await stream.complete();
    } finally {
      if (ownedService("n8n-worker").State.Paused) await serviceAction("unpause", "n8n-worker");
    }
  });
  await check("in-flight worker loss fences the abandoned attempt", async () => {
    const job = await createProbe(cookie);
    const stream = collect(job, cookie);
    await stream.stage("started");
    await serviceAction("kill", "n8n-worker");
    try { await stream.stage("retrying"); }
    finally { await serviceAction("start", "n8n-worker"); }
    await stream.complete();
    const state = fixtureControl("status", job.jobId);
    if (state.attemptNumber < 2 || state.attemptNumber > 3 || state.state !== "COMPLETED") throw new RuntimeVerificationError("Abandoned attempt recovery was not proven.");
  });
  await check("Redis interruption preserves durable work", async () => {
    const minimumRedisOutageMilliseconds = 12_000;
    const maximumAttempts = 3;
    const attemptMilliseconds = 60_000;
    const deliveryAllowanceMilliseconds = 20_000;
    const retryHorizonMilliseconds = maximumAttempts * attemptMilliseconds;
    const collectorBudgetMilliseconds = retryHorizonMilliseconds + deliveryAllowanceMilliseconds;
    const queueServices = ["n8n-main", "n8n-worker"];
    const before = queueServices.map(service => ({ service, container: ownedService(service) }));
    if (before.some(({ container }) => container.HostConfig.RestartPolicy.Name !== "unless-stopped" || container.State.Health?.Status !== "healthy")) {
      throw new RuntimeVerificationError("Redis recovery requires healthy queue processes with their configured restart policy.");
    }
    await serviceAction("stop", "redis");
    let job;
    let stream;
    try {
      job = await createProbe(cookie); stream = collect(job, cookie, collectorBudgetMilliseconds);
      await stream.stage("accepted");
      await until(() => fixtureControl("status", job.jobId).dispatchCount > 0, "Interrupted dispatch was not attempted.", 20_000);
      const attemptedAt = performance.now();
      await delay(minimumRedisOutageMilliseconds);
      if (performance.now() - attemptedAt < minimumRedisOutageMilliseconds) throw new RuntimeVerificationError("The deliberate Redis outage was too short.");
    } finally { await serviceAction("start", "redis"); }
    await until(() => before.every(({ service, container }) => {
      const current = ownedService(service);
      return current.State.Running && !current.State.Paused && current.State.Health?.Status === "healthy" &&
        current.RestartCount > container.RestartCount && current.State.StartedAt !== container.State.StartedAt;
    }), "Queue processes did not automatically restart and recover after Redis returned.");
    console.log(JSON.stringify({ phase: "automatic queue recovery", minimumRedisOutageAfterAttemptMilliseconds: minimumRedisOutageMilliseconds,
      collectorBudgetMilliseconds, retryHorizonMilliseconds, deliveryAllowanceMilliseconds,
      services: before.map(({ service, container }) => { const current = ownedService(service); return { service, restartsBefore: container.RestartCount,
        restartsAfter: current.RestartCount, healthy: current.State.Health.Status === "healthy" }; }),
      queueProcessesManuallyStarted: false }));
    await stream.complete();
  });
  await check("app restart preserves the job and reconnect cursor", async () => {
    await serviceAction("pause", "n8n-worker");
    const job = await createProbe(cookie);
    const stream = collect(job, cookie);
    try {
      await stream.stage("accepted");
      await serviceAction("restart", "app");
      await until(async () => { try { return (await fetch(`${baseURL}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "App did not recover.", 30_000);
    } finally { await serviceAction("unpause", "n8n-worker"); }
    await stream.complete();
  });
  await check("account deactivation closes an open stream", async () => {
    await serviceAction("pause", "n8n-worker");
    try {
      const revokedCookie = await login(fixture.workflowRevocationUser);
      const job = await createProbe(revokedCookie);
      const stream = collect(job, revokedCookie);
      await stream.stage("accepted");
      fixtureControl("deactivate");
      await stream.closed();
      if (stream.events.some((event) => event.kind !== "progress" || event.data.stage !== "accepted")) throw new RuntimeVerificationError("Revoked stream emitted later data.");
      const denied = await fetch(`${baseURL}${job.eventsUrl}`, { headers: { Cookie: revokedCookie } });
      if (denied.status !== 401) throw new RuntimeVerificationError("Revoked session retained access.");
      await stream.cancel();
    } finally { await serviceAction("unpause", "n8n-worker"); }
  });
  await check("proxy stream timeout reconnects to the durable job", async () => {
    await serviceAction("pause", "n8n-worker");
    try {
      const job = await createProbe(cookie);
      const stream = collect(job, cookie);
      await stream.stage("accepted");
      await stream.timeout();
      await serviceAction("unpause", "n8n-worker");
      await stream.complete();
    } finally {
      if (ownedService("n8n-worker").State.Paused) await serviceAction("unpause", "n8n-worker");
    }
  });
  inspectExecutionStorage("after recovery checks");
} catch {
  console.error("Workflow runtime verification failed; credentials, tokens and raw output were withheld.");
  process.exitCode = 1;
} finally {
  try { await restoreRuntime(); }
  catch { console.error("Synthetic runtime restoration failed."); process.exitCode = 1; }
  if (cookie) await fetch(`${baseURL}/api/auth/sign-out`, { method: "POST", headers: { ...mutationHeaders, Cookie: cookie }, body: "{}", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}
