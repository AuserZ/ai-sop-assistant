import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBackupJob } from "./run-backup.mjs";

export const DEFAULT_BACKUP_INTERVAL_SECONDS = 21_600;
export const MIN_BACKUP_INTERVAL_SECONDS = 300;
export const MAX_BACKUP_INTERVAL_SECONDS = 86_400;

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

export function resolveScheduleIntervalSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return DEFAULT_BACKUP_INTERVAL_SECONDS;
  }
  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("BACKUP_INTERVAL_SECONDS must be a positive integer.");
  }
  const parsed = Number.parseInt(normalized, 10);
  if (parsed < MIN_BACKUP_INTERVAL_SECONDS || parsed > MAX_BACKUP_INTERVAL_SECONDS) {
    throw new Error(
      `BACKUP_INTERVAL_SECONDS must be between ${MIN_BACKUP_INTERVAL_SECONDS} and ${MAX_BACKUP_INTERVAL_SECONDS} seconds (default ${DEFAULT_BACKUP_INTERVAL_SECONDS}).`,
    );
  }
  return parsed;
}

export function createBackupScheduler(options = {}) {
  const {
    intervalSeconds = DEFAULT_BACKUP_INTERVAL_SECONDS,
    runOnce = runBackupJob,
    runOnStart = false,
    log = console.log,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;
  const validatedIntervalSeconds = resolveScheduleIntervalSeconds(intervalSeconds);
  let timer = null;
  let inFlightPromise = null;
  let stopped = false;
  let skippedOverlapCount = 0;

  async function executeTick() {
    if (stopped) {
      return { skipped: true, reason: "stopped" };
    }
    if (inFlightPromise) {
      skippedOverlapCount += 1;
      log(
        JSON.stringify({
          event: "backup_tick_skipped_overlap",
          skippedOverlapCount,
          intervalSeconds: validatedIntervalSeconds,
          timestamp: new Date().toISOString(),
        }),
      );
      return { skipped: true, reason: "overlap" };
    }

    const runPromise = (async () => {
      try {
        const receipt = await runOnce();
        log(
          JSON.stringify({
            event: "backup_run_succeeded",
            backupId: receipt?.backupId ?? null,
            timingsMs: receipt?.timingsMs ?? null,
            timestamp: new Date().toISOString(),
          }),
        );
        return { skipped: false, ok: true, receipt };
      } catch (error) {
        log(
          JSON.stringify({
            event: "backup_run_failed",
            code: error?.code ?? "BACKUP_FAILED",
            timestamp: new Date().toISOString(),
          }),
        );
        return { skipped: false, ok: false, code: error?.code ?? "BACKUP_FAILED" };
      } finally {
        inFlightPromise = null;
      }
    })();

    inFlightPromise = runPromise;
    return runPromise;
  }

  function start() {
    if (stopped) {
      throw new Error("Cannot restart a stopped backup scheduler.");
    }
    if (timer) {
      return;
    }

    log(
      JSON.stringify({
        event: "backup_scheduler_started",
        intervalSeconds: validatedIntervalSeconds,
        runOnStart,
        timestamp: new Date().toISOString(),
      }),
    );

    if (runOnStart) {
      void executeTick();
    }

    timer = setIntervalFn(() => {
      void executeTick();
    }, validatedIntervalSeconds * 1000);
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (inFlightPromise) {
      await inFlightPromise;
    }
    log(
      JSON.stringify({
        event: "backup_scheduler_stopped",
        skippedOverlapCount,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return {
    intervalSeconds: validatedIntervalSeconds,
    start,
    stop,
    executeTick,
    getState: () => ({
      running: timer !== null,
      inFlight: inFlightPromise !== null,
      stopped,
      skippedOverlapCount,
    }),
  };
}

if (isDirectExecution(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const intervalSeconds = resolveScheduleIntervalSeconds(process.env.BACKUP_INTERVAL_SECONDS);

  if (args.has("--run-once")) {
    runBackupJob()
      .then((receipt) => {
        console.log(JSON.stringify(receipt, null, 2));
      })
      .catch(() => {
        process.exitCode = 1;
      });
  } else {
    const scheduler = createBackupScheduler({
      intervalSeconds,
      runOnStart: args.has("--run-on-start") || process.env.BACKUP_RUN_ON_START === "1",
    });

    const shutdown = (signal) => {
      console.log(JSON.stringify({ event: "backup_scheduler_signal", signal, timestamp: new Date().toISOString() }));
      scheduler
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    scheduler.start();
  }
}
