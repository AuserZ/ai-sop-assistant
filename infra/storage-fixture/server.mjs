import { spawn } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createStorageGateway } from "./gateway.mjs";

if (process.env.SOP_LOCAL_STORAGE_FIXTURE_ENABLED !== "1") throw new Error("The synthetic storage fixture must be explicitly enabled.");
const accessKeyId = (await readFile("/run/secrets/storage-fixture-access-key-id", "utf8")).trim();
const secretAccessKey = (await readFile("/run/secrets/storage-fixture-secret-access-key", "utf8")).trim();
if (!/^s04-fixture-access-[a-f0-9]{32}$/.test(accessKeyId) || !/^s04-fixture-secret-[a-f0-9]{64}$/.test(secretAccessKey)) throw new Error("Only synthetic fixture credentials are accepted.");
const directory = await mkdtemp("/tmp/s04-storage-");
const bucket = "s04-synthetic-uploads";
const config = join(directory, "wrangler.json");
const discardedLog = join(directory, "discarded.log");
// Wrangler writes debug files independently of its console level.
await symlink("/dev/null", discardedLog);
await writeFile(config, JSON.stringify({
  name: "s04-storage-fixture", main: fileURLToPath(new URL("./worker.mjs", import.meta.url)),
  compatibility_date: "2026-11-21", send_metrics: false,
  r2_buckets: [{ binding: "SYNTHETIC_BUCKET", bucket_name: bucket, local_dev: { experimental_s3_credentials: { accessKeyId, secretAccessKey } } }],
}), { flag: "wx", mode: 0o600 });
const child = spawn(process.execPath, [fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url)), "dev", "--local", "--no-bundle", "--config", config, "--ip", "127.0.0.1", "--port", "18787", "--inspector-port", "0", "--persist-to", join(directory, "state"), "--log-level", "error"], {
  cwd: directory, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, CI: "true", XDG_CONFIG_HOME: join(directory, "config"), WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: discardedLog, NO_COLOR: "1" },
});
child.stdout.resume();
child.stderr.resume();
let stopped = false;
let gateway;
function stop(code) {
  if (stopped) return;
  stopped = true;
  gateway?.close();
  gateway?.closeAllConnections();
  child.kill("SIGTERM");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}
child.on("error", () => { console.error("Synthetic storage runtime failed to start; diagnostic contents withheld."); stop(1); });
child.on("exit", () => { if (!stopped) { console.error("Synthetic storage runtime exited; diagnostic contents withheld."); stop(1); } });
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
const deadline = Date.now() + 90_000;
let ready = false;
while (!stopped && Date.now() < deadline) {
  try { const response = await fetch("http://127.0.0.1:18787/", { signal: AbortSignal.timeout(1000) }); ready = response.ok; await response.body?.cancel(); } catch { /* The native runtime starts asynchronously. */ }
  if (ready) break;
  await delay(250);
}
if (!ready) { console.error("Synthetic storage readiness deadline exceeded."); stop(1); }
else if (!stopped) {
  gateway = createStorageGateway({ upstreamOrigin: "http://127.0.0.1:18787", bucket });
  gateway.on("error", () => { console.error("Synthetic storage listener failed; diagnostic contents withheld."); stop(1); });
  gateway.listen(8787, "0.0.0.0", () => console.log("Synthetic local storage ready; no remote bucket is configured."));
}
