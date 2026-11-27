import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DIGEST_MISMATCH_CODE,
  checkRollbackCompatibility,
  collectRepoArtifacts,
  createReleaseManifest,
  detectRequiredReverification,
  PATH_TRAVERSAL_ERROR_CODE,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  resolveConfinedRepoPath,
  restoreReleaseArtifacts,
  snapshotReleaseArtifacts,
  validateReleaseManifest,
  verifyRepoArtifactsMatchManifest,
} from "../../infra/deploy/release-manifest.mjs";
import {
  NO_EVIDENCE_FALLBACK,
  parseSseFrames,
  runDeploySmokeChecks,
  verifyCheckedAnswerSseSafety,
} from "../../infra/deploy/smoke-check.mjs";
import {
  assertDeployApproval,
  buildDeployComposeCommands,
  buildReleaseComposeEnv,
  DEPLOY_ERROR_CODES,
  DEPLOY_STEP_ORDER,
  redactSensitiveText,
  runControlledDeploy,
} from "../../infra/deploy/deploy.mjs";
import {
  buildRollbackComposeCommands,
  ROLLBACK_ERROR_CODES,
  ROLLBACK_STEP_ORDER,
  runControlledRollback,
} from "../../infra/deploy/rollback.mjs";
import {
  auditDeployWorkflow,
  auditReleaseCompose,
  verifyHardening,
} from "../../scripts/verify-hardening.mjs";

const SYNTHETIC_SHA_V1 = "1111111111111111111111111111111111111111";
const SYNTHETIC_SHA_V2 = "2222222222222222222222222222222222222222";

function buildPinnedImages(seed = "1") {
  const hex = seed.repeat(64).slice(0, 64);
  return {
    app: `ghcr.io/auserz/ai-sop-assistant-app@sha256:${hex}`,
    migrate: `ghcr.io/auserz/ai-sop-assistant-migrate@sha256:${hex}`,
    paddleocr: `ghcr.io/auserz/ai-sop-assistant-paddleocr@sha256:${hex}`,
    convertWorker: `ghcr.io/auserz/ai-sop-assistant-convert-worker@sha256:${hex}`,
    backupScheduler: `ghcr.io/auserz/ai-sop-assistant-backup-scheduler@sha256:${hex}`,
  };
}

function createSampleManifest(overrides: Record<string, unknown> = {}) {
  return createReleaseManifest({
    rootDir: process.cwd(),
    gitSha: SYNTHETIC_SHA_V1,
    gitRef: "refs/heads/codex/s16-deploy-rollback",
    builtAt: "2026-11-27T12:00:00.000Z",
    images: buildPinnedImages("a"),
    schemaChangeType: "none",
    ...overrides,
  });
}

function buildSseFrame(id: string, event: string, data: Record<string, unknown>) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("S16 immutable release manifest and rollback compatibility (ADR 09/14)", () => {
  it("collects real repo migrations, managed workflows, and tracked config digests", () => {
    const artifacts = collectRepoArtifacts(process.cwd());
    expect(artifacts.migrations.headTag).toBe("0007_chat_conversations");
    expect(artifacts.migrations.count).toBe(8);
    expect(artifacts.migrations.entries).toHaveLength(8);
    expect(artifacts.workflows.map((wf: { id: string }) => wf.id)).toEqual([
      "sop-s03-probe-v1",
      "sop-s05-ingestion-v1",
      "sop-s11-chat-v1",
    ]);
    expect(Object.keys(artifacts.configDigests).sort()).toEqual([
      "docker-compose.yml",
      "infra/backup/compose.backup.yml",
      "infra/deploy/compose.release.yml",
      "infra/proxy/nginx.conf",
    ]);

    const manifest = createSampleManifest();
    expect(manifest.schemaVersion).toBe(RELEASE_MANIFEST_SCHEMA_VERSION);
    expect(validateReleaseManifest(manifest)).toEqual({ ok: true, errors: [] });
  });

  it("rejects :latest tags, tag-only refs, tag+digest refs, invalid SHAs, and secret-like fields", () => {
    const base = createSampleManifest();

    const latestManifest = structuredClone(base);
    latestManifest.images.app = "ghcr.io/auserz/ai-sop-assistant-app:latest";
    expect(validateReleaseManifest(latestManifest).ok).toBe(false);

    const tagOnlyManifest = structuredClone(base);
    tagOnlyManifest.images.migrate = "ghcr.io/auserz/ai-sop-assistant-migrate:v1.0.0";
    expect(validateReleaseManifest(tagOnlyManifest).ok).toBe(false);

    const tagPlusDigestManifest = structuredClone(base);
    tagPlusDigestManifest.images.paddleocr =
      `ghcr.io/auserz/ai-sop-assistant-paddleocr:v1@sha256:${"a".repeat(64)}`;
    expect(validateReleaseManifest(tagPlusDigestManifest).ok).toBe(false);

    const badShaManifest = structuredClone(base);
    badShaManifest.gitSha = "not-a-40-hex-sha";
    expect(validateReleaseManifest(badShaManifest).ok).toBe(false);

    const secretFieldManifest = { ...structuredClone(base), apiToken: "must-reject" };
    const secretValidation = validateReleaseManifest(secretFieldManifest);
    expect(secretValidation.ok).toBe(false);
    expect(secretValidation.errors.some((e: string) => e.includes("Forbidden secret-like field"))).toBe(true);
  });

  it("enforces exact allowlist equality and repo path confinement on workflows and configDigests (SEC-S16-01)", () => {
    const base = createSampleManifest();
    const validSha = "a".repeat(64);

    // Extra traversal key in configDigests must fail validation.
    const traversalConfigManifest = structuredClone(base);
    traversalConfigManifest.configDigests["../../outside.conf"] = validSha;
    const traversalConfigResult = validateReleaseManifest(traversalConfigManifest);
    expect(traversalConfigResult.ok).toBe(false);
    expect(traversalConfigResult.errors.some((e: string) => e.includes("TRACKED_CONFIG_FILES"))).toBe(true);

    // Extra non-traversal key in configDigests must also fail exact allowlist check.
    const extraConfigManifest = structuredClone(base);
    extraConfigManifest.configDigests["extra.yml"] = validSha;
    const extraConfigResult = validateReleaseManifest(extraConfigManifest);
    expect(extraConfigResult.ok).toBe(false);
    expect(extraConfigResult.errors.some((e: string) => e.includes("Unexpected configDigests key"))).toBe(true);

    // Extra traversal workflow entry must fail validation.
    const traversalWorkflowManifest = structuredClone(base);
    traversalWorkflowManifest.workflows.push({
      id: "evil-workflow",
      path: "../../evil.json",
      sha256: validSha,
    });
    const traversalWorkflowResult = validateReleaseManifest(traversalWorkflowManifest);
    expect(traversalWorkflowResult.ok).toBe(false);
    expect(traversalWorkflowResult.errors.some((e: string) => e.includes("MANAGED_WORKFLOW_SPECS"))).toBe(true);

    // Duplicate workflow entry must fail validation.
    const dupWorkflowManifest = structuredClone(base);
    dupWorkflowManifest.workflows.push({ ...dupWorkflowManifest.workflows[0] });
    expect(validateReleaseManifest(dupWorkflowManifest).ok).toBe(false);

    // resolveConfinedRepoPath rejects traversal, absolute, Windows drive/UNC, backslash, and null-byte paths.
    const repoRoot = resolve(process.cwd());
    expect(resolveConfinedRepoPath(repoRoot, "docker-compose.yml")).toBe(join(repoRoot, "docker-compose.yml"));
    for (const badPath of [
      "../../outside.conf",
      "n8n/../../evil.json",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "\\\\server\\share\\file.json",
      "n8n\\s03-probe.v1.json",
      "n8n/s03-probe.v1.json\0.txt",
      "n8n//s03-probe.v1.json",
      "./docker-compose.yml",
      "",
    ]) {
      expect(() => resolveConfinedRepoPath(repoRoot, badPath)).toThrow(
        expect.objectContaining({ code: PATH_TRAVERSAL_ERROR_CODE }),
      );
    }

    // snapshotReleaseArtifacts and restoreReleaseArtifacts reject traversal manifests before touching disk.
    const tempBase = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-s16-traversal-"));
    const snapshotDir = join(tempBase, "snapshot");
    const targetDir = join(tempBase, "target");
    try {
      expect(() => snapshotReleaseArtifacts(traversalConfigManifest, process.cwd(), snapshotDir)).toThrow(
        expect.objectContaining({ code: "RELEASE_MANIFEST_INVALID" }),
      );
      expect(() => snapshotReleaseArtifacts(traversalWorkflowManifest, process.cwd(), snapshotDir)).toThrow(
        expect.objectContaining({ code: "RELEASE_MANIFEST_INVALID" }),
      );
      expect(() => restoreReleaseArtifacts(traversalConfigManifest, snapshotDir, targetDir)).toThrow(
        expect.objectContaining({ code: "RELEASE_MANIFEST_INVALID" }),
      );
      expect(existsSync(join(tempBase, "outside.conf"))).toBe(false);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it("distinguishes safe image rollback from schema/data recovery when migrations change", () => {
    const v1 = createSampleManifest({ gitSha: SYNTHETIC_SHA_V1, images: buildPinnedImages("1") });
    const v2SameSchema = createSampleManifest({
      gitSha: SYNTHETIC_SHA_V2,
      images: buildPinnedImages("2"),
      schemaChangeType: "none",
    });

    expect(checkRollbackCompatibility(v2SameSchema, v1)).toMatchObject({
      mode: "image_rollback_safe",
      requiresDataRecovery: false,
      addedMigrations: [],
      modifiedMigrations: [],
    });

    const v2AddedMigration = structuredClone(v2SameSchema);
    v2AddedMigration.schemaChangeType = "additive_backward_compatible";
    v2AddedMigration.migrations.entries.push({
      idx: 8,
      tag: "0008_synthetic_additive",
      sha256: "b".repeat(64),
    });
    v2AddedMigration.migrations.count = v2AddedMigration.migrations.entries.length;
    v2AddedMigration.migrations.headTag = "0008_synthetic_additive";

    const addedCompat = checkRollbackCompatibility(v2AddedMigration, v1);
    expect(addedCompat).toMatchObject({
      mode: "schema_recovery_required",
      requiresDataRecovery: true,
      addedMigrations: ["0008_synthetic_additive"],
      recoveryRunbook: "docs/disaster-recovery.md",
    });

    const v2ModifiedHash = structuredClone(v2SameSchema);
    v2ModifiedHash.migrations.entries[0].sha256 = "f".repeat(64);
    expect(checkRollbackCompatibility(v2ModifiedHash, v1)).toMatchObject({
      mode: "schema_recovery_required",
      requiresDataRecovery: true,
      modifiedMigrations: ["0000_foundation"],
    });

    const v2Breaking = createSampleManifest({
      gitSha: SYNTHETIC_SHA_V2,
      images: buildPinnedImages("2"),
      schemaChangeType: "breaking_requires_restore",
    });
    expect(checkRollbackCompatibility(v2Breaking, v1)).toMatchObject({
      mode: "schema_recovery_required",
      requiresDataRecovery: true,
      recoveryRunbook: "docs/disaster-recovery.md",
    });
  });

  it("detects required re-verification suites for code, migration, workflow, worker, backup, and config changes", () => {
    const base = createSampleManifest();
    expect(detectRequiredReverification(base, structuredClone(base))).toEqual({
      changed: false,
      changedAreas: [],
      changedArtifacts: [],
      requiredChecks: [],
    });

    const next = structuredClone(base);
    next.gitSha = SYNTHETIC_SHA_V2;
    next.images.app = `ghcr.io/auserz/ai-sop-assistant-app@sha256:${"9".repeat(64)}`;
    next.images.paddleocr = `ghcr.io/auserz/ai-sop-assistant-paddleocr@sha256:${"8".repeat(64)}`;
    next.workflows[2].sha256 = "7".repeat(64);
    next.configDigests["infra/proxy/nginx.conf"] = "6".repeat(64);
    next.configDigests["infra/backup/compose.backup.yml"] = "5".repeat(64);
    next.migrations.entries.push({ idx: 8, tag: "0008_reverify_test", sha256: "4".repeat(64) });
    next.migrations.count = next.migrations.entries.length;
    next.migrations.headTag = "0008_reverify_test";

    const reverify = detectRequiredReverification(base, next);
    expect(reverify.changed).toBe(true);
    expect(reverify.changedAreas).toEqual([
      "application",
      "backup-recovery",
      "database-schema",
      "ingestion-workers",
      "n8n-workflows",
      "runtime-config",
    ]);
    expect(reverify.requiredChecks).toEqual(
      expect.arrayContaining([
        "lint",
        "typecheck",
        "unit",
        "test:db",
        "migration-review",
        "isolated-restore-drill",
        "paddleocr-verify",
        "workflow-contract",
        "checked-answer-sse-smoke",
        "golden-benchmark-50",
        "verify-hardening",
        "compose-config",
        "nonprod-rollback-rehearsal",
      ]),
    );
  });
});

describe("S16 post-deploy health and checked-answer SSE smoke checks", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const jobId = "33333333-3333-4333-8333-333333333333";

  it("validates clean allowlisted progress -> completed and no_evidence SSE streams and rejects leaked draft text", () => {
    const cleanCompletedSse = [
      ": heartbeat\n\n",
      buildSseFrame(`${jobId}:1`, "accepted", { v: 1, requestId, conversationId, jobId, stage: "accepted" }),
      buildSseFrame(`${jobId}:2`, "retrieving", { v: 1, requestId, conversationId, jobId, stage: "retrieving" }),
      buildSseFrame(`${jobId}:3`, "reranking", { v: 1, requestId, conversationId, jobId, stage: "reranking" }),
      buildSseFrame(`${jobId}:4`, "generating", { v: 1, requestId, conversationId, jobId, stage: "generating" }),
      buildSseFrame(`${jobId}:5`, "validating", { v: 1, requestId, conversationId, jobId, stage: "validating" }),
      buildSseFrame(`${jobId}:6`, "completed", {
        v: 1,
        requestId,
        conversationId,
        jobId,
        messageId: "44444444-4444-4444-8444-444444444444",
        answer: "1. Inspect seal.\n2. Confirm gauge.",
        isProcedural: true,
        sources: [
          {
            documentId: "55555555-5555-4555-8555-555555555555",
            chunkId: "66666666-6666-4666-8666-666666666666",
            sopTitle: "Synthetic Autoclave SOP",
            section: "Section 1",
            sourcePath: "/api/documents/55555555-5555-4555-8555-555555555555/source",
          },
        ],
      }),
    ].join("");

    const completedResult = verifyCheckedAnswerSseSafety(parseSseFrames(cleanCompletedSse));
    expect(completedResult).toMatchObject({
      ok: true,
      violations: [],
      progressStages: ["accepted", "retrieving", "reranking", "generating", "validating"],
      terminalEvent: "completed",
      sourceCount: 1,
    });

    const cleanNoEvidenceSse = [
      buildSseFrame(`${jobId}:1`, "accepted", { v: 1, requestId, conversationId, jobId, stage: "accepted" }),
      buildSseFrame(`${jobId}:2`, "no_evidence", {
        v: 1,
        requestId,
        conversationId,
        jobId,
        messageId: null,
        message: NO_EVIDENCE_FALLBACK,
        sources: [],
      }),
    ].join("");

    const noEvidenceResult = verifyCheckedAnswerSseSafety(parseSseFrames(cleanNoEvidenceSse));
    expect(noEvidenceResult).toMatchObject({
      ok: true,
      terminalEvent: "no_evidence",
      exactFallbackMatched: true,
      sourceCount: 0,
    });

    const leakedDraftProgressSse = [
      buildSseFrame(`${jobId}:1`, "generating", {
        v: 1,
        requestId,
        conversationId,
        jobId,
        stage: "generating",
        draft: "1. Unverified step leaked before judge pass",
      }),
      buildSseFrame(`${jobId}:2`, "completed", {
        v: 1,
        requestId,
        conversationId,
        jobId,
        messageId: "44444444-4444-4444-8444-444444444444",
        answer: "1. Verified step.",
        isProcedural: true,
        sources: [
          {
            documentId: "55555555-5555-4555-8555-555555555555",
            chunkId: "66666666-6666-4666-8666-666666666666",
            sopTitle: "Synthetic SOP",
            section: "Section 1",
            sourcePath: "/api/documents/55555555-5555-4555-8555-555555555555/source",
          },
        ],
      }),
    ].join("");

    const leakedResult = verifyCheckedAnswerSseSafety(parseSseFrames(leakedDraftProgressSse));
    expect(leakedResult.ok).toBe(false);
    expect(leakedResult.violations.some((v: string) => v.includes("leaked disallowed fields"))).toBe(true);
  });

  it("verifies full smoke suite with separate SSE timings, fails closed without cookie, and honors --health-only", async () => {
    const securityHeaders = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    };

    const syntheticCookie = "better-auth.session_token=synthetic-secret-cookie-value-999";
    let tick = 100;
    const clock = () => {
      tick += 10;
      return tick;
    };

    const mockFetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/health/live") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Request-Id": "req-live-1",
            ...securityHeaders,
          },
        });
      }
      if (path === "/api/health/ready") {
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (
        path === "/api/documents" ||
        path === "/api/users" ||
        path === "/api/chat/conversations" ||
        path === "/api/health/ops"
      ) {
        return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
      }
      if (path.startsWith("/api/internal/")) {
        return new Response("Not Found", { status: 404 });
      }
      if (path === "/api/chat/messages") {
        expect(init?.headers).toMatchObject({
          Accept: "text/event-stream",
          Origin: "https://staging.example.invalid",
          Cookie: syntheticCookie,
        });
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                buildSseFrame(`${jobId}:1`, "accepted", {
                  v: 1,
                  requestId,
                  conversationId,
                  jobId,
                  stage: "accepted",
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(
                buildSseFrame(`${jobId}:2`, "validating", {
                  v: 1,
                  requestId,
                  conversationId,
                  jobId,
                  stage: "validating",
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(
                buildSseFrame(`${jobId}:3`, "completed", {
                  v: 1,
                  requestId,
                  conversationId,
                  jobId,
                  messageId: "44444444-4444-4444-8444-444444444444",
                  answer: "1. Verified synthetic step.",
                  isProcedural: true,
                  sources: [
                    {
                      documentId: "55555555-5555-4555-8555-555555555555",
                      chunkId: "66666666-6666-4666-8666-666666666666",
                      sopTitle: "Synthetic SOP",
                      section: "Section 1",
                      sourcePath: "/api/documents/55555555-5555-4555-8555-555555555555/source",
                    },
                  ],
                }),
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const fullResult = await runDeploySmokeChecks({
      baseUrl: "https://staging.example.invalid",
      sessionCookie: syntheticCookie,
      fetchImpl: mockFetch,
      clock,
    });

    expect(fullResult.ok).toBe(true);
    expect(fullResult.checks.live.ok).toBe(true);
    expect(fullResult.checks.ready.ok).toBe(true);
    expect(fullResult.checks.authBoundary.ok).toBe(true);
    expect(fullResult.checks.internalRouteBlocked.ok).toBe(true);
    expect(fullResult.checks.securityHeaders.ok).toBe(true);
    expect(fullResult.checks.checkedAnswerSse.ok).toBe(true);
    const sseTimings = fullResult.checks.checkedAnswerSse.timingsMs;
    expect(sseTimings).toBeDefined();
    expect(sseTimings).toMatchObject({
      firstProgressMs: expect.any(Number),
      firstAnswerMs: expect.any(Number),
      completedMs: expect.any(Number),
    });
    expect(sseTimings!.firstAnswerMs as number).toBeGreaterThan(
      sseTimings!.firstProgressMs as number,
    );
    expect(JSON.stringify(fullResult)).not.toContain(syntheticCookie);
    expect(JSON.stringify(fullResult)).not.toContain("Verified synthetic step");

    // Fail closed when no session cookie is supplied and healthOnly is false.
    const unexecuted = await runDeploySmokeChecks({
      baseUrl: "https://staging.example.invalid",
      fetchImpl: mockFetch,
    });
    expect(unexecuted.ok).toBe(false);
    expect(unexecuted.checks.checkedAnswerSse).toMatchObject({ ok: false, executed: false });

    // Explicit --health-only passes health/boundary checks while still reporting SSE unexecuted.
    const healthOnly = await runDeploySmokeChecks({
      baseUrl: "https://staging.example.invalid",
      healthOnly: true,
      fetchImpl: mockFetch,
    });
    expect(healthOnly.ok).toBe(true);
    expect(healthOnly.mode).toBe("health_only");
    expect(healthOnly.checks.checkedAnswerSse).toMatchObject({
      ok: false,
      executed: false,
      skippedByHealthOnly: true,
    });

    // Fail closed on unhealthy ready, exposed protected/internal routes, or missing security headers.
    const degraded = await runDeploySmokeChecks({
      baseUrl: "https://staging.example.invalid",
      healthOnly: true,
      fetchImpl: async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/api/health/live") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Cache-Control": "no-store", "X-Request-Id": "req-1" },
          });
        }
        if (path === "/api/health/ready") {
          return new Response(JSON.stringify({ status: "unavailable" }), { status: 503 });
        }
        return new Response("exposed", { status: 200 });
      },
    });
    expect(degraded.ok).toBe(false);
    expect(degraded.checks.ready.ok).toBe(false);
    expect(degraded.checks.authBoundary.ok).toBe(false);
    expect(degraded.checks.internalRouteBlocked.ok).toBe(false);
    expect(degraded.checks.securityHeaders.ok).toBe(false);
  });
});

describe("S16 controlled deploy and rollback runners", () => {
  it("blocks production deployment without manual gate and matching V01 candidate SHA", () => {
    const manifest = createSampleManifest({ gitSha: SYNTHETIC_SHA_V1 });

    expect(() =>
      assertDeployApproval({
        environment: "production",
        manifest,
        env: {},
        v01CandidateSha: SYNTHETIC_SHA_V1,
      }),
    ).toThrow(expect.objectContaining({ code: DEPLOY_ERROR_CODES.APPROVAL_REQUIRED }));

    expect(() =>
      assertDeployApproval({
        environment: "production",
        manifest,
        env: { GITHUB_ENVIRONMENT: "production" },
        v01CandidateSha: SYNTHETIC_SHA_V2,
      }),
    ).toThrow(expect.objectContaining({ code: DEPLOY_ERROR_CODES.APPROVAL_REQUIRED }));

    expect(
      assertDeployApproval({
        environment: "production",
        manifest,
        env: { GITHUB_ENVIRONMENT: "production" },
        v01CandidateSha: SYNTHETIC_SHA_V1,
      }),
    ).toEqual({ ok: true, environment: "production" });

    expect(buildReleaseComposeEnv(manifest)).toMatchObject({
      APP_IMAGE_DIGEST: manifest.images.app,
      MIGRATE_IMAGE_DIGEST: manifest.images.migrate,
      PADDLEOCR_IMAGE_DIGEST: manifest.images.paddleocr,
      CONVERSION_IMAGE_DIGEST: manifest.images.convertWorker,
      BACKUP_SCHEDULER_IMAGE_DIGEST: manifest.images.backupScheduler,
    });
  });

  it("executes deterministic deploy order, retains previous-known-good, handles smoke failure safely, and rehearses rollback", async () => {
    const stateDir = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-s16-state-"));
    try {
      const v1 = createSampleManifest({ gitSha: SYNTHETIC_SHA_V1, images: buildPinnedImages("1") });
      const v2 = createSampleManifest({ gitSha: SYNTHETIC_SHA_V2, images: buildPinnedImages("2") });

      const executedDeploySteps: string[] = [];
      const makeDeployRunners = (smokeOk: boolean) => ({
        validateManifest: async () => {
          executedDeploySteps.push("validateManifest");
        },
        pullImages: async () => {
          executedDeploySteps.push("pullImages");
        },
        runMigrations: async () => {
          executedDeploySteps.push("runMigrations");
        },
        bootstrapWorkflows: async () => {
          executedDeploySteps.push("bootstrapWorkflows");
        },
        startServices: async () => {
          executedDeploySteps.push("startServices");
        },
        runSmokeChecks: async () => {
          executedDeploySteps.push("runSmokeChecks");
          return { ok: smokeOk, mode: "full_checked_answer" };
        },
      });

      // 1. Initial staging deploy of v1 succeeds and records current-release.json.
      const firstDeploy = await runControlledDeploy({
        environment: "staging",
        manifest: v1,
        stateDir,
        runners: makeDeployRunners(true),
      });
      expect(firstDeploy.ok).toBe(true);
      expect(firstDeploy.status).toBe("SUCCEEDED");
      expect(firstDeploy.steps.map((s: { name: string }) => s.name)).toEqual(DEPLOY_STEP_ORDER);
      expect(JSON.parse(readFileSync(join(stateDir, "current-release.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );

      // 2. Failing deploy of v2 (smoke failure) preserves previous-known-good.json (v1) and does NOT promote v2.
      const failedV2 = await runControlledDeploy({
        environment: "staging",
        manifest: v2,
        stateDir,
        runners: makeDeployRunners(false),
      });
      expect(failedV2.ok).toBe(false);
      expect(failedV2.status).toBe("FAILED");
      expect(failedV2.errorCode).toBe(DEPLOY_ERROR_CODES.SMOKE_FAILED);
      expect(failedV2.previousKnownGoodPreserved).toBe(true);
      expect(failedV2.rollbackAssessment).toMatchObject({
        mode: "image_rollback_safe",
        requiresDataRecovery: false,
      });
      expect(JSON.parse(readFileSync(join(stateDir, "previous-known-good.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );
      expect(JSON.parse(readFileSync(join(stateDir, "current-release.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );

      // 3. Successful deploy of v2 promotes current-release.json to v2 while retaining v1 in previous-known-good.json.
      const secondDeploy = await runControlledDeploy({
        environment: "staging",
        manifest: v2,
        stateDir,
        runners: makeDeployRunners(true),
      });
      expect(secondDeploy.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(stateDir, "current-release.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V2,
      );
      expect(JSON.parse(readFileSync(join(stateDir, "previous-known-good.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );

      // 4. Non-prod rollback rehearsal restores pinned v1 images + workflows and updates current-release.json.
      const rollbackEvents: string[] = [];
      const rollbackReceipt = await runControlledRollback({
        stateDir,
        runners: {
          pullTargetImages: async ({ targetManifest }: { targetManifest: { gitSha: string } }) => {
            expect(targetManifest.gitSha).toBe(SYNTHETIC_SHA_V1);
            rollbackEvents.push("pullTargetImages");
          },
          restoreWorkflowArtifacts: async () => {
            rollbackEvents.push("restoreWorkflowArtifacts");
          },
          startTargetServices: async () => {
            rollbackEvents.push("startTargetServices");
          },
          runSmokeChecks: async () => {
            rollbackEvents.push("runSmokeChecks");
            return { ok: true, mode: "full_checked_answer" };
          },
        },
      });
      expect(rollbackReceipt.ok).toBe(true);
      expect(rollbackReceipt.status).toBe("ROLLED_BACK");
      expect(rollbackReceipt.fromGitSha).toBe(SYNTHETIC_SHA_V2);
      expect(rollbackReceipt.toGitSha).toBe(SYNTHETIC_SHA_V1);
      expect(rollbackReceipt.steps.map((s: { name: string }) => s.name)).toEqual(ROLLBACK_STEP_ORDER);
      expect(JSON.parse(readFileSync(join(stateDir, "current-release.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );

      // 5. Incompatible rollback (added migration) refuses blind image rollback with ROLLBACK_REQUIRES_DATA_RECOVERY.
      const v3WithMigration = structuredClone(v2);
      v3WithMigration.schemaChangeType = "additive_backward_compatible";
      v3WithMigration.migrations.entries.push({
        idx: 8,
        tag: "0008_added_col",
        sha256: "c".repeat(64),
      });
      v3WithMigration.migrations.count = v3WithMigration.migrations.entries.length;
      v3WithMigration.migrations.headTag = "0008_added_col";
      writeFileSync(join(stateDir, "current-release.json"), JSON.stringify(v3WithMigration), "utf8");

      await expect(
        runControlledRollback({
          stateDir,
          runners: {
            pullTargetImages: async () => {
              throw new Error("Must never pull images when rollback is blocked");
            },
          },
        }),
      ).rejects.toMatchObject({
        code: ROLLBACK_ERROR_CODES.REQUIRES_DATA_RECOVERY,
        recoveryRunbook: "docs/disaster-recovery.md",
      });

      // Explicit override allows verified additive_backward_compatible rollback with audit flag.
      const additiveOverrideReceipt = await runControlledRollback({
        stateDir,
        allowAdditiveSchemaRollback: true,
        runners: {
          pullTargetImages: async () => undefined,
          restoreWorkflowArtifacts: async () => undefined,
          startTargetServices: async () => undefined,
          runSmokeChecks: async () => ({ ok: true, mode: "full_checked_answer" }),
        },
      });
      expect(additiveOverrideReceipt.ok).toBe(true);
      expect(additiveOverrideReceipt.additiveSchemaOverrideUsed).toBe(true);

      // Breaking schema change refuses rollback even with allowAdditiveSchemaRollback: true.
      const v3Breaking = structuredClone(v3WithMigration);
      v3Breaking.schemaChangeType = "breaking_requires_restore";
      await expect(
        runControlledRollback({
          currentManifest: v3Breaking,
          targetManifest: v1,
          allowAdditiveSchemaRollback: true,
        }),
      ).rejects.toMatchObject({
        code: ROLLBACK_ERROR_CODES.REQUIRES_DATA_RECOVERY,
        recoveryRunbook: "docs/disaster-recovery.md",
      });

      // Redaction helper scrubs secrets from deploy failure diagnostics.
      const secretMsg = "Failed with password=superSecret99 Bearer eyJhbGciOiJIUzI1NiJ9 sk-proj-secretToken123456";
      const redacted = redactSensitiveText(secretMsg);
      expect(redacted).not.toContain("superSecret99");
      expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(redacted).not.toContain("secretToken123456");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("records in-progress-release.json before migrations so failed breaking/added-migration deploys block blind rollback (Q-S16-1)", async () => {
    const stateDir = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-s16-inprogress-"));
    try {
      const v1 = createSampleManifest({ gitSha: SYNTHETIC_SHA_V1, images: buildPinnedImages("1") });
      const okRunners = {
        pullImages: async () => undefined,
        runMigrations: async () => undefined,
        bootstrapWorkflows: async () => undefined,
        startServices: async () => undefined,
        runSmokeChecks: async () => ({ ok: true, mode: "full_checked_answer" }),
      };

      const deployV1 = await runControlledDeploy({
        environment: "staging",
        manifest: v1,
        stateDir,
        runners: okRunners,
      });
      expect(deployV1.ok).toBe(true);
      expect(existsSync(join(stateDir, "in-progress-release.json"))).toBe(false);

      // Failed v2 with added migration + breaking_requires_restore leaves in-progress-release.json on disk.
      const v2Breaking = createSampleManifest({
        gitSha: SYNTHETIC_SHA_V2,
        images: buildPinnedImages("2"),
        schemaChangeType: "breaking_requires_restore",
      });
      v2Breaking.migrations.entries.push({
        idx: 8,
        tag: "0008_breaking_drop_column",
        sha256: "d".repeat(64),
      });
      v2Breaking.migrations.count = v2Breaking.migrations.entries.length;
      v2Breaking.migrations.headTag = "0008_breaking_drop_column";

      const failedV2 = await runControlledDeploy({
        environment: "staging",
        manifest: v2Breaking,
        stateDir,
        runners: {
          ...okRunners,
          runSmokeChecks: async () => ({ ok: false, mode: "full_checked_answer" }),
        },
      });
      expect(failedV2.ok).toBe(false);
      expect(failedV2.inProgressReleaseRecorded).toBe(true);
      expect(existsSync(join(stateDir, "in-progress-release.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(stateDir, "current-release.json"), "utf8")).gitSha).toBe(
        SYNTHETIC_SHA_V1,
      );

      // Subsequent rollback without --current-manifest MUST inspect in-progress-release.json and refuse!
      await expect(
        runControlledRollback({
          stateDir,
          runners: {
            pullTargetImages: async () => {
              throw new Error("Must never pull images on post-migration breaking rollback");
            },
          },
        }),
      ).rejects.toMatchObject({
        code: ROLLBACK_ERROR_CODES.REQUIRES_DATA_RECOVERY,
        recoveryRunbook: "docs/disaster-recovery.md",
      });

      // Also test failed v2 with additive migration (no breaking flag): blind rollback still blocked!
      const v2Additive = structuredClone(v2Breaking);
      v2Additive.schemaChangeType = "additive_backward_compatible";
      const failedAdditive = await runControlledDeploy({
        environment: "staging",
        manifest: v2Additive,
        stateDir,
        runners: {
          ...okRunners,
          runSmokeChecks: async () => ({ ok: false, mode: "full_checked_answer" }),
        },
      });
      expect(failedAdditive.ok).toBe(false);
      await expect(
        runControlledRollback({
          stateDir,
          runners: { pullTargetImages: async () => undefined },
        }),
      ).rejects.toMatchObject({
        code: ROLLBACK_ERROR_CODES.REQUIRES_DATA_RECOVERY,
        recoveryRunbook: "docs/disaster-recovery.md",
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("verifies on-disk workflow/config SHA-256 digests and restores snapshotted target bundle on rollback (Q-S16-4)", async () => {
    const workDir = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-s16-artifacts-"));
    const stateDir = join(workDir, ".deploy-state");
    try {
      // Copy required repository artifacts into isolated temp workspace.
      const filesToCopy = [
        "drizzle/meta/_journal.json",
        ...collectRepoArtifacts(process.cwd()).migrations.entries.map(
          (entry: { tag: string }) => `drizzle/${entry.tag}.sql`,
        ),
        "n8n/s03-probe.v1.json",
        "n8n/s05-ingestion.v1.json",
        "n8n/s11-chat.v1.json",
        "docker-compose.yml",
        "infra/deploy/compose.release.yml",
        "infra/proxy/nginx.conf",
        "infra/backup/compose.backup.yml",
      ];
      for (const relPath of filesToCopy) {
        const dest = join(workDir, ...relPath.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(process.cwd(), ...relPath.split("/")), dest);
      }

      const v1 = createReleaseManifest({
        rootDir: workDir,
        gitSha: SYNTHETIC_SHA_V1,
        gitRef: "refs/heads/codex/s16-deploy-rollback",
        builtAt: "2026-11-27T12:00:00.000Z",
        images: buildPinnedImages("1"),
        schemaChangeType: "none",
      });
      expect(verifyRepoArtifactsMatchManifest(v1, workDir).ok).toBe(true);

      const noopRunners = {
        pullImages: async () => undefined,
        runMigrations: async () => undefined,
        bootstrapWorkflows: async () => undefined,
        startServices: async () => undefined,
        runSmokeChecks: async () => ({ ok: true, mode: "full_checked_answer" }),
      };

      const deployedV1 = await runControlledDeploy({
        environment: "staging",
        manifest: v1,
        rootDir: workDir,
        stateDir,
        verifyArtifacts: true,
        runners: noopRunners,
      });
      expect(deployedV1.ok).toBe(true);
      expect(existsSync(join(stateDir, "releases", SYNTHETIC_SHA_V1, "n8n", "s11-chat.v1.json"))).toBe(true);

      // Mutate workflow on disk for v2 release and verify v1 manifest detects drift!
      const chatWorkflowPath = join(workDir, "n8n", "s11-chat.v1.json");
      const v1ChatBytes = readFileSync(chatWorkflowPath, "utf8");
      const v2ChatParsed = JSON.parse(v1ChatBytes);
      v2ChatParsed.name = "S11 Safe SOP chat orchestration (v2 synthetic)";
      const v2ChatBytes = `${JSON.stringify(v2ChatParsed, null, 2)}\n`;
      writeFileSync(chatWorkflowPath, v2ChatBytes, "utf8");

      expect(() => verifyRepoArtifactsMatchManifest(v1, workDir)).toThrow(
        expect.objectContaining({ code: ARTIFACT_DIGEST_MISMATCH_CODE }),
      );

      // Deploy v2 with matching updated manifest.
      const v2 = createReleaseManifest({
        rootDir: workDir,
        gitSha: SYNTHETIC_SHA_V2,
        gitRef: "refs/heads/codex/s16-deploy-rollback",
        builtAt: "2026-11-27T12:10:00.000Z",
        images: buildPinnedImages("2"),
        schemaChangeType: "none",
      });
      const deployedV2 = await runControlledDeploy({
        environment: "staging",
        manifest: v2,
        rootDir: workDir,
        stateDir,
        verifyArtifacts: true,
        runners: noopRunners,
      });
      expect(deployedV2.ok).toBe(true);
      expect(readFileSync(chatWorkflowPath, "utf8")).toBe(v2ChatBytes);

      // Rollback restores v1's snapshotted workflow bytes onto disk BEFORE running n8n-bootstrap.
      let observedWorkflowDuringBootstrap = "";
      const rollbackReceipt = await runControlledRollback({
        rootDir: workDir,
        stateDir,
        restoreArtifacts: true,
        runners: {
          pullTargetImages: async () => undefined,
          restoreWorkflowArtifacts: async () => {
            observedWorkflowDuringBootstrap = readFileSync(chatWorkflowPath, "utf8");
          },
          startTargetServices: async () => undefined,
          runSmokeChecks: async () => ({ ok: true, mode: "full_checked_answer" }),
        },
      });
      expect(rollbackReceipt.ok).toBe(true);
      expect(observedWorkflowDuringBootstrap).toBe(v1ChatBytes);
      expect(verifyRepoArtifactsMatchManifest(v1, workDir).ok).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("aborts stalled SSE streams cleanly within timeoutMs and enforces redirect: error (Q-S16-5)", async () => {
    const seenRedirects: Array<RequestRedirect | undefined> = [];
    const stalledStart = performance.now();
    const result = await runDeploySmokeChecks({
      baseUrl: "https://staging.example.invalid",
      sessionCookie: "better-auth.session_token=synthetic-timeout-cookie",
      timeoutMs: 80,
      fetchImpl: async (url: string, init?: RequestInit) => {
        seenRedirects.push(init?.redirect);
        const path = new URL(url).pathname;
        if (path === "/api/health/live") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "X-Request-Id": "req-timeout-1",
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
            },
          });
        }
        if (path === "/api/health/ready") {
          return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
        }
        if (path.startsWith("/api/internal/")) {
          return new Response("Not Found", { status: 404 });
        }
        if (path === "/api/chat/messages") {
          const encoder = new TextEncoder();
          const stalledStream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  buildSseFrame("job-1:1", "accepted", {
                    v: 1,
                    requestId: "11111111-1111-4111-8111-111111111111",
                    conversationId: "22222222-2222-4222-8222-222222222222",
                    jobId: "33333333-3333-4333-8333-333333333333",
                    stage: "accepted",
                  }),
                ),
              );
              // Never close stream to simulate hung upstream SSE connection.
            },
          });
          return new Response(stalledStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          });
        }
        return new Response("Unauthorized", { status: 401 });
      },
    });
    const elapsed = performance.now() - stalledStart;
    expect(result.ok).toBe(false);
    expect(result.checks.checkedAnswerSse.ok).toBe(false);
    expect(elapsed).toBeLessThan(1500);
    expect(seenRedirects.length).toBeGreaterThan(0);
    expect(seenRedirects.every((mode) => mode === "error")).toBe(true);
  });

  it("orders deploy dependencies cleanly, avoids migrate on rollback, and fails closed without smoke cookie (Q-S16-6, Q-S16-7)", async () => {
    const deployCmds = buildDeployComposeCommands();
    expect(deployCmds.runMigrations[0]).toEqual([
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "180",
      "postgres",
    ]);
    expect(deployCmds.runMigrations[1]).toEqual(["run", "--rm", "--no-deps", "migrate"]);
    expect(deployCmds.bootstrapWorkflows[0]).toEqual([
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "180",
      "redis",
      "n8n-main",
    ]);

    const rollbackCmds = buildRollbackComposeCommands();
    expect(rollbackCmds.restoreWorkflowArtifacts[0]).toContain("postgres");
    expect(rollbackCmds.restoreWorkflowArtifacts[0]).toContain("redis");
    expect(rollbackCmds.restoreWorkflowArtifacts[0]).toContain("n8n-main");
    for (const cmd of rollbackCmds.startTargetServices) {
      expect(cmd).toContain("--no-deps");
      expect(cmd).not.toContain("migrate");
    }
    expect(rollbackCmds.pullTargetImages[0]).not.toContain("migrate");

    // Step 1 fails closed when neither sessionCookie nor healthOnly nor custom smoke runner is supplied.
    await expect(
      runControlledDeploy({
        environment: "staging",
        manifest: createSampleManifest(),
        verifyArtifacts: false,
      }),
    ).rejects.toMatchObject({ code: DEPLOY_ERROR_CODES.CONFIG_INVALID });
  });
});

describe("S16 hardening audits across deploy workflow and release Compose overlay", () => {
  it("passes verifyHardening across all 10 audited repository manifests", () => {
    const result = verifyHardening(process.cwd());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checkedFiles).toHaveLength(10);
    expect(result.checkedFiles).toContain("infra/deploy/compose.release.yml");
    expect(result.checkedFiles).toContain(".github/workflows/deploy.yml");
  });

  it("rejects insecure release Compose overrides (mutable :latest, missing backup-scheduler digest, enabled fixtures, extra ports)", () => {
    const validReleaseCompose = readFileSync(
      resolve(process.cwd(), "infra/deploy/compose.release.yml"),
      "utf8",
    );
    expect(auditReleaseCompose(validReleaseCompose).ok).toBe(true);

    const insecureReleaseCompose = `
services:
  app:
    image: ghcr.io/auserz/ai-sop-assistant-app:latest
    ports: ["0.0.0.0:3000:3000"]
    environment:
      SOP_WORKFLOW_PROBE_ENABLED: "1"
      SOP_LOCAL_ANSWER_FIXTURE_ENABLED: "1"
`;
    const audit = auditReleaseCompose(insecureReleaseCompose);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((v: string) => v.includes(":latest"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("backup-scheduler"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("must not publish additional host ports"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("SOP_WORKFLOW_PROBE_ENABLED"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("SOP_LOCAL_ANSWER_FIXTURE_ENABLED"))).toBe(true);
  });

  it("rejects insecure deploy workflows (push trigger, unpinned actions, inline inputs in run:, missing needs or production gate)", () => {
    const validDeployWorkflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/deploy.yml"),
      "utf8",
    );
    expect(auditDeployWorkflow(validDeployWorkflow).ok).toBe(true);
    expect(validDeployWorkflow).toContain("printf '%q'");
    expect(validDeployWorkflow).toContain("umask 077");
    expect(validDeployWorkflow).toContain("mktemp");
    expect(validDeployWorkflow).toContain("/api/auth/sign-out");
    expect(validDeployWorkflow).not.toContain("/tmp/smoke-session.cookie");

    const insecureWorkflow = `
name: Bad deploy
on:
  push:
  workflow_dispatch:
permissions: write-all
jobs:
  deploy-production:
    runs-on: ubuntu-latest
    # mentioning verify-candidate build-immutable-artifacts deploy-nonprod in comments must not satisfy needs!
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo \${{ secrets.PROD_VPS_SSH_KEY }}
          echo "\${{ inputs.v01_candidate_sha }}"
          docker push app:latest
`;
    const audit = auditDeployWorkflow(insecureWorkflow);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((v: string) => v.includes('forbidden "push"'))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("40-hex commit SHA"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("environment: production"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes('must require "verify-candidate" in needs'))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("interpolating \${{ inputs.* }} inside run:"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes("never echo secret values"))).toBe(true);
    expect(audit.violations.some((v: string) => v.includes(":latest"))).toBe(true);
  });
});
