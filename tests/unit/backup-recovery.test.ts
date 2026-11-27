import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  computeSha256,
  createBackupManifest,
  decryptBackupPayload,
  decryptKeyEscrowBundle,
  encryptBackupPayload,
  encryptKeyEscrowBundle,
  keyFingerprint,
  parseBackupKey,
  PROVISIONAL_POLICY_NOTICE,
  verifyBackupManifest,
} from "../../infra/backup/crypto.mjs";
import {
  createBackupStorageClient,
  loadBackupStorageConfig,
  validateBackupEndpointUrl,
} from "../../infra/backup/storage.mjs";
import {
  BACKUP_ALERT_CODES,
  buildBackupAlert,
  buildPgDumpArgs,
  dispatchBackupAlert,
  runBackupJob,
  sanitizeAlertMessage,
  validateAlertWebhookUrl,
} from "../../infra/backup/run-backup.mjs";
import {
  createEscrowReceipt,
  parseEscrowCliArgs,
  recoverEscrowKeyToFile,
  verifyEscrowReceipt,
} from "../../infra/backup/escrow-keys.mjs";
import {
  assertIsolatedRestoreTarget,
  buildPgRestoreArgs,
  JOB_RECONCILIATION_SQL,
  RESTORE_ERROR_CODES,
  runIsolatedRestore,
} from "../../infra/backup/run-restore.mjs";
import {
  createBackupScheduler,
  DEFAULT_BACKUP_INTERVAL_SECONDS,
  resolveScheduleIntervalSeconds,
} from "../../infra/backup/schedule.mjs";
import {
  assertValidDrillProjectName,
  buildInNetworkRestoreComposeArgs,
  DEFAULT_DRILL_PROXY_PORT,
  defaultSmokeChecks,
  REQUIRED_SMOKE_CHECKS,
  resolveDrillProxyPort,
  runRestoreDrill,
} from "../../infra/backup/drill.mjs";
import {
  auditBackupCompose,
  auditBackupDockerfile,
  verifyHardening,
} from "../../scripts/verify-hardening.mjs";

const SYNTHETIC_BACKUP_KEY = "0123456789abcdef1032547698badcfe0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SYNTHETIC_WRONG_BACKUP_KEY = "f0e1d2c3b4a5968778695a4b3c2d1e0ffedcba9876543210fedcba9876543210";
const SYNTHETIC_N8N_KEY = "synthetic-n8n-encryption-key-s15-only-0123456789abcdef";
const SYNTHETIC_ESCROW_PASSPHRASE = "synthetic-escrow-passphrase-s15-testing-only-9876543210";

function createInMemoryS3Mock(
  options: { corruptHeadLengthForKey?: string | null; failPutForKey?: string | null } = {},
) {
  const { corruptHeadLengthForKey = null, failPutForKey = null } = options;
  const store = new Map<string, { body: Buffer; contentType: string; metadata: Record<string, string> }>();
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];

  const s3Client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input ?? {};
      commands.push({ name, input });

      if (name === "PutObjectCommand") {
        const key = String(input.Key);
        if (failPutForKey && key.includes(failPutForKey)) {
          throw new Error("Simulated S3 PutObject transport error");
        }
        const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body as Uint8Array);
        store.set(key, {
          body: Buffer.from(body),
          contentType: String(input.ContentType ?? "application/octet-stream"),
          metadata: (input.Metadata as Record<string, string>) ?? {},
        });
        return { ETag: `"${computeSha256(body).slice(0, 16)}"` };
      }

      if (name === "HeadObjectCommand") {
        const key = String(input.Key);
        const entry = store.get(key);
        if (!entry) {
          throw new Error(`NoSuchKey: ${key}`);
        }
        const contentLength =
          corruptHeadLengthForKey && key.includes(corruptHeadLengthForKey)
            ? entry.body.byteLength - 1
            : entry.body.byteLength;
        return {
          ContentLength: contentLength,
          ContentType: entry.contentType,
          ETag: `"${computeSha256(entry.body).slice(0, 16)}"`,
        };
      }

      if (name === "GetObjectCommand") {
        const key = String(input.Key);
        const entry = store.get(key);
        if (!entry) {
          throw new Error(`NoSuchKey: ${key}`);
        }
        return {
          Body: {
            async transformToByteArray() {
              return new Uint8Array(entry.body);
            },
          },
        };
      }

      if (name === "ListObjectsV2Command") {
        const prefix = String(input.Prefix ?? "");
        const contents = [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, entry]) => ({
            Key: key,
            Size: entry.body.byteLength,
            LastModified: new Date("2026-11-27T08:00:00.000Z"),
          }));
        return { Contents: contents };
      }

      throw new Error(`Unsupported mock S3 command: ${name}`);
    },
  };

  return { store, commands, s3Client };
}

describe("S15 authenticated backup and key-escrow crypto (ADR 16)", () => {
  it("validates backup encryption keys and rejects empty, short, non-hex, or weak keys", () => {
    const parsed = parseBackupKey(SYNTHETIC_BACKUP_KEY);
    expect(parsed.byteLength).toBe(32);

    expect(() => parseBackupKey("")).toThrow();
    expect(() => parseBackupKey("abc123")).toThrow();
    expect(() => parseBackupKey("z".repeat(64))).toThrow();
    expect(() => parseBackupKey("0".repeat(64))).toThrow("entropy");
    expect(() => parseBackupKey("ab".repeat(32))).toThrow("entropy");
  });

  it("encrypts and decrypts payloads with AES-256-GCM and fails closed on tamper, wrong key, truncation, or AAD swap", () => {
    const plaintext = Buffer.from("PGDMP-synthetic-sop-app-payload-v1", "utf8");
    const encrypted = encryptBackupPayload(plaintext, {
      key: SYNTHETIC_BACKUP_KEY,
      database: "sop_app",
      backupId: "backup-20261127T060000Z-11111111",
    });

    expect(encrypted.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(encrypted.plaintextSha256).toBe(computeSha256(plaintext));
    expect(encrypted.envelope.includes(plaintext)).toBe(false);

    const decrypted = decryptBackupPayload(encrypted.envelope, {
      key: SYNTHETIC_BACKUP_KEY,
      database: "sop_app",
      backupId: "backup-20261127T060000Z-11111111",
      expectedPlaintextSha256: encrypted.plaintextSha256,
    });
    expect(decrypted.equals(plaintext)).toBe(true);

    const tampered = Buffer.from(encrypted.envelope);
    tampered[tampered.byteLength - 1] ^= 0xff;
    expect(() =>
      decryptBackupPayload(tampered, {
        key: SYNTHETIC_BACKUP_KEY,
        database: "sop_app",
        backupId: "backup-20261127T060000Z-11111111",
        expectedPlaintextSha256: encrypted.plaintextSha256,
      }),
    ).toThrow("authentication failed");

    expect(() =>
      decryptBackupPayload(encrypted.envelope, {
        key: SYNTHETIC_WRONG_BACKUP_KEY,
        database: "sop_app",
        backupId: "backup-20261127T060000Z-11111111",
        expectedPlaintextSha256: encrypted.plaintextSha256,
      }),
    ).toThrow("authentication failed");

    expect(() =>
      decryptBackupPayload(encrypted.envelope, {
        key: SYNTHETIC_BACKUP_KEY,
        database: "sop_n8n",
        backupId: "backup-20261127T060000Z-11111111",
        expectedPlaintextSha256: encrypted.plaintextSha256,
      }),
    ).toThrow("authentication failed");

    expect(() =>
      decryptBackupPayload(encrypted.envelope, {
        key: SYNTHETIC_BACKUP_KEY,
        database: "sop_app",
        backupId: "backup-20261127T120000Z-22222222",
        expectedPlaintextSha256: encrypted.plaintextSha256,
      }),
    ).toThrow("authentication failed");

    expect(() =>
      decryptBackupPayload(encrypted.envelope.subarray(0, 16), {
        key: SYNTHETIC_BACKUP_KEY,
        database: "sop_app",
        backupId: "backup-20261127T060000Z-11111111",
        expectedPlaintextSha256: encrypted.plaintextSha256,
      }),
    ).toThrow("truncated");
  });

  it("encrypts and decrypts key escrow bundles with scrypt + AES-256-GCM, zero plaintext key in headers, and strict scrypt bounds", () => {
    const bundle = encryptKeyEscrowBundle({
      n8nEncryptionKey: SYNTHETIC_N8N_KEY,
      passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
      metadata: {
        migrationHead: "0007_chat_conversations",
        workflowVersions: { "s03-probe.v1.json": "a".repeat(64) },
        storageBucket: "synthetic-dr-backups",
        storagePrefix: "backups/postgres",
        backupKeyFingerprint: keyFingerprint(SYNTHETIC_BACKUP_KEY),
        secretBindings: ["n8n-encryption-key", "backup-encryption-key"],
      },
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(SYNTHETIC_N8N_KEY);
    expect(serialized).not.toContain(SYNTHETIC_ESCROW_PASSPHRASE);
    expect(serialized).not.toContain(SYNTHETIC_BACKUP_KEY);
    expect(bundle.n8nKeyFingerprint).toBe(keyFingerprint(SYNTHETIC_N8N_KEY));

    const recovered = decryptKeyEscrowBundle(bundle, {
      passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
      expectedN8nKeyFingerprint: keyFingerprint(SYNTHETIC_N8N_KEY),
    });
    expect(recovered.n8nEncryptionKey).toBe(SYNTHETIC_N8N_KEY);
    expect(recovered.metadata.migrationHead).toBe("0007_chat_conversations");

    expect(() =>
      decryptKeyEscrowBundle(bundle, {
        passphrase: "wrong-escrow-passphrase-1234567890",
      }),
    ).toThrow("authentication failed");

    const tamperedBundle = structuredClone(bundle);
    tamperedBundle.metadata.storageBucket = "attacker-bucket";
    expect(() =>
      decryptKeyEscrowBundle(tamperedBundle, {
        passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
      }),
    ).toThrow("authentication failed");

    // Non-power-of-two N and excessive 128*N*r > maxmem must fail closed before scryptSync.
    const badPowerBundle = structuredClone(bundle) as unknown as { kdf: { N: number; r: number } };
    badPowerBundle.kdf.N = 30_000;
    expect(() =>
      decryptKeyEscrowBundle(badPowerBundle, { passphrase: SYNTHETIC_ESCROW_PASSPHRASE }),
    ).toThrow("unsafe scrypt parameters");

    const excessMemBundle = structuredClone(bundle) as unknown as { kdf: { N: number; r: number } };
    excessMemBundle.kdf.N = 131_072;
    excessMemBundle.kdf.r = 16;
    expect(() =>
      decryptKeyEscrowBundle(excessMemBundle, { passphrase: SYNTHETIC_ESCROW_PASSPHRASE }),
    ).toThrow("unsafe scrypt parameters");

    expect(() =>
      decryptKeyEscrowBundle(bundle, {
        passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
        expectedN8nKeyFingerprint: "b".repeat(64),
      }),
    ).toThrow("fingerprint");
  });

  it("rejects backup manifests containing secret-like fields or missing required databases", () => {
    expect(() =>
      verifyBackupManifest({
        formatVersion: 1,
        cipher: "aes-256-gcm",
        backupId: "backup-test-1",
        createdAt: "2026-11-27T06:00:00.000Z",
        n8nKeyFingerprint: "a".repeat(64),
        backupKeyFingerprint: "b".repeat(64),
        rawPassword: "must-not-be-allowed",
        artifacts: {},
      }),
    ).toThrow("Forbidden secret-like field");

    expect(() =>
      createBackupManifest({
        backupId: "backup-test-2",
        migrationHead: "0007_chat_conversations",
        n8nKeyFingerprint: "a".repeat(64),
        backupKeyFingerprint: "b".repeat(64),
        storage: { bucket: "b", prefix: "p", region: "auto" },
        artifacts: {
          sop_app: {
            formatVersion: 1,
            objectKey: "backups/postgres/b/sop_app.dump.enc",
            plaintextSha256: "c".repeat(64),
            plaintextBytes: 100,
            ciphertextSha256: "d".repeat(64),
            ciphertextBytes: 140,
          },
        },
      }),
    ).toThrow("sop_n8n");
  });
});

describe("S15 private offsite backup storage client", () => {
  it("enforces HTTPS by default including direct createBackupStorageClient calls, and permits loopback HTTP only in fixture mode", () => {
    expect(validateBackupEndpointUrl("https://account.r2.cloudflarestorage.com", {})).toBe(
      "https://account.r2.cloudflarestorage.com",
    );
    expect(() => validateBackupEndpointUrl("http://remote.example.com", {})).toThrow("https://");
    expect(() => validateBackupEndpointUrl("http://127.0.0.1:8787", {})).toThrow("https://");
    expect(() => validateBackupEndpointUrl("https://user:pass@account.r2.cloudflarestorage.com", {})).toThrow(
      "credentials",
    );
    expect(() =>
      createBackupStorageClient(
        {
          bucket: "sop-backups-private",
          endpoint: "http://remote.example.com",
          credentials: { accessKeyId: "k", secretAccessKey: "s" },
        },
        { env: {} },
      ),
    ).toThrow("https://");
    expect(
      validateBackupEndpointUrl("http://127.0.0.1:8787/cdn-cgi/local/r2/s3", {
        SOP_LOCAL_STORAGE_FIXTURE_ENABLED: "1",
      }),
    ).toBe("http://127.0.0.1:8787/cdn-cgi/local/r2/s3");
  });

  it("uploads private objects without public ACL and verifies byte length via HeadObject", async () => {
    const mock = createInMemoryS3Mock();
    const config = loadBackupStorageConfig(
      {
        BACKUP_S3_BUCKET: "sop-backups-private",
        BACKUP_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        BACKUP_S3_ACCESS_KEY_ID_FILE: "/fake/access",
        BACKUP_S3_SECRET_ACCESS_KEY_FILE: "/fake/secret",
      },
      { readSecret: (file: string) => (file.includes("access") ? "synthetic-access" : "synthetic-secret") },
    );

    const storage = createBackupStorageClient(config, { s3Client: mock.s3Client });
    const key = storage.buildObjectKey("backup-1/sop_app.dump.enc");
    const payload = Buffer.from("encrypted-bytes-123456", "utf8");
    const uploaded = await storage.putVerifiedObject({ key, body: payload });

    expect(uploaded.bytes).toBe(payload.byteLength);
    const putCmd = mock.commands.find((c) => c.name === "PutObjectCommand");
    expect(putCmd?.input.ACL).toBeUndefined();
    expect(mock.commands.some((c) => c.name === "HeadObjectCommand")).toBe(true);

    const downloaded = await storage.getObjectBytes(key);
    expect(downloaded.equals(payload)).toBe(true);

    const listed = await storage.listObjects("backup-1");
    expect(listed.map((item: { key: string }) => item.key)).toEqual([key]);
  });

  it("fails closed with BACKUP_VERIFY_FAILED when post-upload HeadObject byte length mismatches", async () => {
    const mock = createInMemoryS3Mock({ corruptHeadLengthForKey: "sop_app.dump.enc" });
    const storage = createBackupStorageClient(
      {
        bucket: "sop-backups-private",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        prefix: "backups/postgres",
        timeoutMs: 5000,
      },
      { s3Client: mock.s3Client },
    );

    await expect(
      storage.putVerifiedObject({
        key: storage.buildObjectKey("backup-1/sop_app.dump.enc"),
        body: Buffer.from("encrypted-bytes", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "BACKUP_VERIFY_FAILED" });
  });
});

describe("S15 encrypted 6-hour backup runner and safe alerting", () => {
  it("preserves role ownership and least-privilege grants in pg_dump and pg_restore args", () => {
    const dumpArgs = buildPgDumpArgs({ host: "postgres", port: 5432, user: "sop_bootstrap", database: "sop_app" });
    expect(dumpArgs).toContain("--format=custom");
    expect(dumpArgs).toContain("--lock-wait-timeout=30000");
    expect(dumpArgs).not.toContain("--no-owner");
    expect(dumpArgs).not.toContain("--no-privileges");

    const restoreArgs = buildPgRestoreArgs({ host: "postgres", port: 5432, user: "sop_bootstrap", database: "sop_app" });
    expect(restoreArgs).toContain("--clean");
    expect(restoreArgs).toContain("--if-exists");
    expect(restoreArgs).toContain("--exit-on-error");
    expect(restoreArgs).not.toContain("--no-owner");
    expect(restoreArgs).not.toContain("--no-privileges");
  });

  it("dumps, encrypts, uploads, and verifies both sop_app and sop_n8n using only n8nKeyFingerprint (least privilege)", async () => {
    const mock = createInMemoryS3Mock();
    const storage = createBackupStorageClient(
      {
        bucket: "sop-backups-private",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        prefix: "backups/postgres",
        timeoutMs: 5000,
      },
      { s3Client: mock.s3Client },
    );

    const dbPassword = "super-secret-pg-password-s15";
    const expectedFp = keyFingerprint(SYNTHETIC_N8N_KEY);
    const receipt = await runBackupJob({
      backupId: "backup-20261127T060000Z-aaaaaaaa",
      backupKey: SYNTHETIC_BACKUP_KEY,
      n8nKeyFingerprint: expectedFp,
      dbPassword,
      storageClient: storage,
      dumpDatabase: async ({ database }: { database: string }) =>
        Buffer.from(`PGDMP-logical-dump-for-${database}-with-pgvector`, "utf8"),
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.n8nKeyFingerprint).toBe(expectedFp);
    expect(receipt.migrationHead).toBe("0007_chat_conversations");
    expect(Object.keys(receipt.workflowVersions).length).toBeGreaterThanOrEqual(3);
    expect(mock.store.size).toBe(3);

    const serializedReceipt = JSON.stringify(receipt);
    expect(serializedReceipt).not.toContain(SYNTHETIC_BACKUP_KEY);
    expect(serializedReceipt).not.toContain(SYNTHETIC_N8N_KEY);
    expect(serializedReceipt).not.toContain(dbPassword);

    const manifestJson = JSON.parse(
      (await storage.getObjectBytes(receipt.manifestKey)).toString("utf8"),
    );
    expect(verifyBackupManifest(manifestJson).ok).toBe(true);
    expect(JSON.stringify(manifestJson)).not.toContain(SYNTHETIC_N8N_KEY);
    expect(JSON.stringify(manifestJson)).not.toContain(SYNTHETIC_BACKUP_KEY);
  });

  it("emits redacted critical alerts on dump, encryption, upload, and verify failures without leaking secrets or SQL", async () => {
    const dbPassword = "very-sensitive-db-password-999";
    const capturedAlerts: Array<Record<string, unknown>> = [];

    const runFailureCase = async (overrides: Record<string, unknown>) => {
      capturedAlerts.length = 0;
      const storage = createBackupStorageClient(
        {
          bucket: "sop-backups-private",
          endpoint: "https://example.r2.cloudflarestorage.com",
          region: "auto",
          prefix: "backups/postgres",
          timeoutMs: 5000,
        },
        { s3Client: createInMemoryS3Mock().s3Client },
      );

      let caught: { code?: string; alert?: Record<string, unknown> } | null = null;
      try {
        await runBackupJob({
          backupId: "backup-fail-case",
          backupKey: SYNTHETIC_BACKUP_KEY,
          n8nKeyFingerprint: keyFingerprint(SYNTHETIC_N8N_KEY),
          dbPassword,
          storageClient: storage,
          dumpDatabase: async ({ database }: { database: string }) => Buffer.from(`dump-${database}`),
          dispatchAlert: async (alert: Record<string, unknown>) => {
            capturedAlerts.push(alert);
            return { logged: true, webhookSent: false };
          },
          ...overrides,
        });
      } catch (error) {
        caught = error as { code?: string; alert?: Record<string, unknown> };
      }

      expect(caught).not.toBeNull();
      expect(capturedAlerts).toHaveLength(1);
      const serialized = JSON.stringify(capturedAlerts[0]);
      expect(serialized).not.toContain(SYNTHETIC_BACKUP_KEY);
      expect(serialized).not.toContain(SYNTHETIC_N8N_KEY);
      expect(serialized).not.toContain(dbPassword);
      expect(serialized).not.toContain("SELECT * FROM");
      return capturedAlerts[0];
    };

    const configAlert = await runFailureCase({ backupKey: "too-short" });
    expect(configAlert.code).toBe(BACKUP_ALERT_CODES.CONFIG_INVALID);
    expect(configAlert.severity).toBe("critical");

    const dumpAlert = await runFailureCase({
      dumpDatabase: async () => {
        throw new Error(
          `pg_dump failed PGPASSWORD=${dbPassword} postgresql://sop_bootstrap:${dbPassword}@postgres:5432/sop_app SELECT * FROM app.auth_users`,
        );
      },
    });
    expect(dumpAlert.code).toBe(BACKUP_ALERT_CODES.DUMP_FAILED);
    expect(dumpAlert.database).toBe("sop_app");

    const encryptAlert = await runFailureCase({
      encryptPayload: () => {
        throw new Error(`cipher failed with key=${SYNTHETIC_BACKUP_KEY}`);
      },
    });
    expect(encryptAlert.code).toBe(BACKUP_ALERT_CODES.ENCRYPTION_FAILED);

    const uploadFailMock = createInMemoryS3Mock({ failPutForKey: "sop_n8n.dump.enc" });
    const uploadAlert = await runFailureCase({
      storageClient: createBackupStorageClient(
        { bucket: "sop-backups-private", endpoint: "https://example.r2.cloudflarestorage.com", prefix: "backups/postgres" },
        { s3Client: uploadFailMock.s3Client },
      ),
    });
    expect(uploadAlert.code).toBe(BACKUP_ALERT_CODES.UPLOAD_FAILED);
    expect(uploadAlert.database).toBe("sop_n8n");

    const verifyFailMock = createInMemoryS3Mock({ corruptHeadLengthForKey: "sop_app.dump.enc" });
    const verifyAlert = await runFailureCase({
      storageClient: createBackupStorageClient(
        { bucket: "sop-backups-private", endpoint: "https://example.r2.cloudflarestorage.com", prefix: "backups/postgres" },
        { s3Client: verifyFailMock.s3Client },
      ),
    });
    expect(verifyAlert.code).toBe(BACKUP_ALERT_CODES.VERIFY_FAILED);
    expect(verifyAlert.database).toBe("sop_app");
  });

  it("blocks private/loopback/link-local/ULA alert webhook SSRF targets and dispatches with redirect: error", async () => {
    expect(() => validateAlertWebhookUrl("http://alerts.example.com/hook", {})).toThrow("https://");
    expect(() => validateAlertWebhookUrl("https://127.0.0.1/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://10.0.0.5/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://172.16.0.10/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://192.168.1.50/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://169.254.169.254/latest/meta-data", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://[fe80::1]/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://[fd00::1]/hook", {})).toThrow("private");
    expect(() => validateAlertWebhookUrl("https://[::1]/hook", {})).toThrow("private");
    expect(
      validateAlertWebhookUrl("http://127.0.0.1:9999/hook", { SOP_LOCAL_STORAGE_FIXTURE_ENABLED: "1" }),
    ).toBe("http://127.0.0.1:9999/hook");

    const alert = buildBackupAlert({
      code: BACKUP_ALERT_CODES.UPLOAD_FAILED,
      stage: "upload",
      database: "sop_app",
      message: "Upload failed with X-Amz-Signature=secret123456 and PGPASSWORD=abc",
    });
    expect(alert.message).not.toContain("secret123456");
    expect(alert.message).not.toContain("PGPASSWORD=abc");

    let fetchInit: RequestInit | undefined;
    const logged: string[] = [];
    const result = await dispatchBackupAlert(alert, {
      webhookUrl: "https://alerts.example.invalid/backup",
      log: (line: string) => logged.push(line),
      fetchImpl: async (_url: string, init: RequestInit) => {
        fetchInit = init;
        return new Response("ok", { status: 202 });
      },
    });

    expect(logged).toHaveLength(1);
    expect(result.webhookSent).toBe(true);
    expect(result.statusCode).toBe(202);
    expect(fetchInit?.redirect).toBe("error");
    expect(sanitizeAlertMessage("PGPASSWORD=mySecret123 failed")).toContain("PGPASSWORD=[REDACTED]");
  });
});

describe("S15 key escrow CLI helper and isolated restore runner", () => {
  it("creates, verifies without a local key file, and recovers N8N_ENCRYPTION_KEY safely with overwrite protection", () => {
    const workDir = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-s15-escrow-"));
    try {
      const outputFile = join(workDir, "n8n-escrow.json");
      const recoveredKeyFile = join(workDir, "recovered-n8n-key");

      // Verify CLI defaults do not silently require .local-secrets/n8n-encryption-key in --verify mode.
      const parsedVerify = parseEscrowCliArgs(["--verify", "--input", outputFile], {});
      expect(parsedVerify.n8nKeyFile).toBe("");

      const created = createEscrowReceipt({
        n8nEncryptionKey: SYNTHETIC_N8N_KEY,
        passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
        backupKey: SYNTHETIC_BACKUP_KEY,
        storageBucket: "sop-backups-private",
        storagePrefix: "backups/postgres",
        outputFile,
      });
      expect(created.ok).toBe(true);
      expect(created.n8nKeyFingerprint).toBe(keyFingerprint(SYNTHETIC_N8N_KEY));

      const diskBundle = JSON.parse(readFileSync(outputFile, "utf8"));
      expect(JSON.stringify(diskBundle)).not.toContain(SYNTHETIC_N8N_KEY);
      expect(JSON.stringify(diskBundle)).not.toContain(SYNTHETIC_ESCROW_PASSPHRASE);

      // Verify succeeds without local key file.
      const verifiedWithoutKey = verifyEscrowReceipt({
        bundle: diskBundle,
        passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
      });
      expect(verifiedWithoutKey.ok).toBe(true);
      expect(verifiedWithoutKey.keyMatchesExpected).toBeNull();
      expect(JSON.stringify(verifiedWithoutKey)).not.toContain(SYNTHETIC_N8N_KEY);

      // Recover writes exact key to disk with 0600 permissions and emits redacted receipt.
      const recoveredReceipt = recoverEscrowKeyToFile({
        bundle: diskBundle,
        passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
        outputKeyFile: recoveredKeyFile,
      });
      expect(recoveredReceipt.ok).toBe(true);
      expect(recoveredReceipt.mode).toBe("recover");
      expect(recoveredReceipt.n8nKeyFingerprint).toBe(keyFingerprint(SYNTHETIC_N8N_KEY));
      expect(JSON.stringify(recoveredReceipt)).not.toContain(SYNTHETIC_N8N_KEY);
      expect(readFileSync(recoveredKeyFile, "utf8")).toBe(SYNTHETIC_N8N_KEY);

      // Refuses overwrite without force: true.
      expect(() =>
        recoverEscrowKeyToFile({
          bundle: diskBundle,
          passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
          outputKeyFile: recoveredKeyFile,
        }),
      ).toThrow();

      expect(() =>
        verifyEscrowReceipt({
          bundle: diskBundle,
          passphrase: SYNTHETIC_ESCROW_PASSPHRASE,
          expectedN8nKey: "different-n8n-encryption-key-0000000000",
        }),
      ).toThrow();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("matches every column in JOB_RECONCILIATION_SQL against the real Drizzle schema and forbids fictional column names", () => {
    const schemaSource = readFileSync(resolve(process.cwd(), "src/server/db/schema.ts"), "utf8");
    const migrationSql = readdirSync(resolve(process.cwd(), "drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(resolve(process.cwd(), "drizzle", name), "utf8"))
      .join("\n");

    const requiredColumns = [
      "state",
      "stage",
      "error_code",
      "error_retryable",
      "attempt_id",
      "attempt_number",
      "dispatch_nonce",
      "dispatch_count",
      "dispatch_next_at",
      "dispatch_lease_token",
      "dispatch_lease_until",
      "dispatch_accepted_at",
      "execution_id",
      "run_lease_until",
      "step",
      "attempt_deadline",
      "updated_at",
      "job_id",
    ];
    for (const column of requiredColumns) {
      expect(JOB_RECONCILIATION_SQL).toContain(column);
      expect(schemaSource.includes(column) || migrationSql.includes(`"${column}"`)).toBe(true);
    }

    expect(JOB_RECONCILIATION_SQL).toContain("DELETE FROM app.chat_turn_artifacts");
    for (const fictional of ["lease_expires_at", "attempt_count", "max_attempts"]) {
      expect(JOB_RECONCILIATION_SQL).not.toContain(fictional);
    }
    expect(JOB_RECONCILIATION_SQL).not.toMatch(/\bstatus\b/);
  });

  it("enforces hard production guardrails on isolated restore", () => {
    expect(() =>
      assertIsolatedRestoreTarget({
        isolatedTarget: false,
        targetProject: "ai-sop-dr-drill-20261127",
      }),
    ).toThrow(expect.objectContaining({ code: RESTORE_ERROR_CODES.ISOLATED_TARGET_REQUIRED }));

    expect(() =>
      assertIsolatedRestoreTarget({
        isolatedTarget: true,
        targetProject: "ai-sop-dr-drill-20261127",
        env: { NODE_ENV: "production" },
      }),
    ).toThrow(expect.objectContaining({ code: RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED }));

    expect(() =>
      assertIsolatedRestoreTarget({
        isolatedTarget: true,
        targetProject: "ai-sop-assistant",
        env: { NODE_ENV: "test" },
      }),
    ).toThrow(expect.objectContaining({ code: RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED }));

    expect(() =>
      assertIsolatedRestoreTarget({
        isolatedTarget: true,
        targetProject: "ai-sop-dr-drill-20261127",
        targetHost: "prod-db.internal",
        env: { NODE_ENV: "test" },
      }),
    ).toThrow(expect.objectContaining({ code: RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED }));
  });

  it("restores encrypted backup, verifies pgvector/tables/n8n key, reconciles jobs, rejects key mismatch, and blocks forged manifest object keys", async () => {
    const mock = createInMemoryS3Mock();
    const storage = createBackupStorageClient(
      {
        bucket: "sop-backups-private",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        prefix: "backups/postgres",
        timeoutMs: 5000,
      },
      { s3Client: mock.s3Client },
    );

    const appDump = Buffer.from("PGDMP-sop-app-synthetic-dump", "utf8");
    const n8nDump = Buffer.from("PGDMP-sop-n8n-synthetic-dump", "utf8");
    const backupReceipt = await runBackupJob({
      backupId: "backup-20261127T060000Z-restore1",
      backupKey: SYNTHETIC_BACKUP_KEY,
      n8nKeyFingerprint: keyFingerprint(SYNTHETIC_N8N_KEY),
      dbPassword: "synthetic-pg-password",
      storageClient: storage,
      dumpDatabase: async ({ database }: { database: string }) => (database === "sop_app" ? appDump : n8nDump),
    });

    const executedSql: Array<{ database: string; sql: string }> = [];
    const restoredDbs: Array<{ database: string; bytes: Buffer }> = [];

    const mockExecSql = async ({ database, sql }: { database: string; sql: string }) => {
      executedSql.push({ database, sql });
      if (sql.includes("pg_extension")) return "vector";
      if (sql.includes("table_schema = 'app'")) {
        return "app.auth_users\napp.sop_documents\napp.workflow_jobs\napp.chat_conversations";
      }
      if (sql.includes("table_schema = 'public'")) {
        return "credentials_entity\nworkflow_entity";
      }
      if (sql.includes("WITH exhausted AS")) {
        return "2|1|3";
      }
      return "1.414";
    };

    const restoreReceipt = await runIsolatedRestore({
      isolatedTarget: true,
      targetProject: "ai-sop-dr-drill-20261127",
      targetHost: "postgres",
      backupId: backupReceipt.backupId,
      storageClient: storage,
      backupKey: SYNTHETIC_BACKUP_KEY,
      n8nEncryptionKey: SYNTHETIC_N8N_KEY,
      targetPassword: "synthetic-pg-password",
      execSql: mockExecSql,
      restoreDatabase: async ({ database, dumpBytes }: { database: string; dumpBytes: Buffer }) => {
        restoredDbs.push({ database, bytes: dumpBytes });
        return { restored: true, database, bytes: dumpBytes.byteLength };
      },
    });

    expect(restoreReceipt.ok).toBe(true);
    expect(restoreReceipt.n8nKeyFingerprintVerified).toBe(true);
    expect(restoreReceipt.integrity.pgvectorVerified).toBe(true);
    expect(restoreReceipt.reconciliation).toEqual({
      requeuedRunningJobs: 2,
      exhaustedRunningJobs: 1,
      prunedChatTurnArtifacts: 3,
      redisTransientStateCleared: true,
    });
    expect(executedSql.some((q) => q.sql.includes("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public"))).toBe(
      true,
    );
    expect(restoredDbs.find((d) => d.database === "sop_app")?.bytes.equals(appDump)).toBe(true);
    expect(restoredDbs.find((d) => d.database === "sop_n8n")?.bytes.equals(n8nDump)).toBe(true);
    expect(restoreReceipt.timingsMs).toMatchObject({
      downloadMs: expect.any(Number),
      decryptMs: expect.any(Number),
      restoreAppMs: expect.any(Number),
      restoreN8nMs: expect.any(Number),
      verifyMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(restoreReceipt.recoveryGaps.length).toBeGreaterThanOrEqual(2);
    expect(restoreReceipt.policyNotice).toBe(PROVISIONAL_POLICY_NOTICE);

    // Wrong N8N_ENCRYPTION_KEY fails closed before any pg_restore runs.
    await expect(
      runIsolatedRestore({
        isolatedTarget: true,
        targetProject: "ai-sop-dr-drill-20261127",
        targetHost: "postgres",
        backupId: backupReceipt.backupId,
        storageClient: storage,
        backupKey: SYNTHETIC_BACKUP_KEY,
        n8nEncryptionKey: "wrong-n8n-encryption-key-000000000000000",
        targetPassword: "synthetic-pg-password",
        execSql: mockExecSql,
        restoreDatabase: async () => {
          throw new Error("Should never execute pg_restore on n8n key mismatch");
        },
      }),
    ).rejects.toMatchObject({ code: RESTORE_ERROR_CODES.N8N_KEY_MISMATCH });

    // Manifest referencing object key outside requested backup prefix fails closed.
    const manifestEntry = mock.store.get(backupReceipt.manifestKey)!;
    const tamperedManifest = JSON.parse(manifestEntry.body.toString("utf8"));
    tamperedManifest.artifacts.sop_app.objectKey = "backups/postgres/other-backup/sop_app.dump.enc";
    mock.store.set(backupReceipt.manifestKey, {
      ...manifestEntry,
      body: Buffer.from(JSON.stringify(tamperedManifest), "utf8"),
    });
    await expect(
      runIsolatedRestore({
        isolatedTarget: true,
        targetProject: "ai-sop-dr-drill-20261127",
        targetHost: "postgres",
        backupId: backupReceipt.backupId,
        storageClient: storage,
        backupKey: SYNTHETIC_BACKUP_KEY,
        n8nEncryptionKey: SYNTHETIC_N8N_KEY,
        targetPassword: "synthetic-pg-password",
        execSql: mockExecSql,
        restoreDatabase: async () => {
          throw new Error("Should never execute pg_restore on escaped objectKey");
        },
      }),
    ).rejects.toMatchObject({ code: RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED });
  });
});

describe("S15 6-hour scheduler, monthly drill orchestrator, Compose hardening, and local secrets", () => {
  it("validates 6-hour default interval and prevents overlapping backup runs", async () => {
    expect(resolveScheduleIntervalSeconds(undefined)).toBe(DEFAULT_BACKUP_INTERVAL_SECONDS);
    expect(DEFAULT_BACKUP_INTERVAL_SECONDS).toBe(21_600);
    expect(resolveScheduleIntervalSeconds("3600")).toBe(3600);
    expect(() => resolveScheduleIntervalSeconds("299")).toThrow();
    expect(() => resolveScheduleIntervalSeconds("86401")).toThrow();
    expect(() => resolveScheduleIntervalSeconds("21600.5")).toThrow();
    expect(() => resolveScheduleIntervalSeconds("abc")).toThrow();

    let releaseRun!: () => void;
    let calls = 0;
    const logs: string[] = [];

    const scheduler = createBackupScheduler({
      intervalSeconds: 21_600,
      log: (entry: string) => logs.push(entry),
      runOnce: async () => {
        calls += 1;
        await new Promise<void>((resolvePromise) => {
          releaseRun = resolvePromise;
        });
        return { backupId: "backup-sched-1", timingsMs: { totalMs: 5 } };
      },
    });

    const firstTick = scheduler.executeTick();
    const overlappingTick = await scheduler.executeTick();
    expect(overlappingTick).toEqual({ skipped: true, reason: "overlap" });
    expect(calls).toBe(1);

    releaseRun();
    const firstResult = await firstTick;
    expect(firstResult).toMatchObject({ skipped: false, ok: true });
    await scheduler.stop();
    expect(scheduler.getState().skippedOverlapCount).toBe(1);
  });

  it("enforces disposable project names, non-colliding proxy port, never fabricates smoke passes, and fails on teardown errors", async () => {
    expect(() => assertValidDrillProjectName("ai-sop-assistant")).toThrow(
      expect.objectContaining({ code: RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED }),
    );
    expect(assertValidDrillProjectName("ai-sop-dr-drill-20261127")).toBe("ai-sop-dr-drill-20261127");
    expect(resolveDrillProxyPort(undefined)).toBe(DEFAULT_DRILL_PROXY_PORT);
    expect(() => resolveDrillProxyPort("3000")).toThrow("3000");

    const inNetArgs = buildInNetworkRestoreComposeArgs({
      drillProject: "ai-sop-dr-drill-20261127",
      backupId: "backup-1",
    });
    expect(inNetArgs).toContain("infra/backup/compose.backup.yml");
    expect(inNetArgs).toContain("postgres");
    expect(inNetArgs).toContain("--isolated-target");

    // Default smoke checks probe real unauthenticated fail-closed endpoints and NEVER fabricate functional passes.
    const defaultChecks = (await defaultSmokeChecks({
      baseUrl: "http://127.0.0.1:3099",
      fetchImpl: async (url: string) => {
        if (url.endsWith("/api/health/ready")) return new Response("ready", { status: 200 });
        return new Response("unauthorized", { status: 401 });
      },
    })) as Record<string, { ok: boolean; executed: boolean }>;
    expect(defaultChecks.unauthenticatedFailClosed.ok).toBe(true);
    for (const suite of REQUIRED_SMOKE_CHECKS) {
      expect(defaultChecks[suite].ok).toBe(false);
      expect(defaultChecks[suite].executed).toBe(false);
    }

    // Passing drill with supplied functional smoke checks.
    const receipt = await runRestoreDrill({
      drillProject: "ai-sop-dr-drill-20261127",
      manageStack: false,
      restoreRunner: async () => ({
        ok: true,
        backupId: "backup-20261127T060000Z-drill1",
        migrationHead: "0007_chat_conversations",
        n8nKeyFingerprintVerified: true,
        timingsMs: { downloadMs: 1, decryptMs: 2, restoreAppMs: 3, restoreN8nMs: 4, verifyMs: 5, totalMs: 15 },
        reconciliation: {
          requeuedRunningJobs: 1,
          exhaustedRunningJobs: 0,
          prunedChatTurnArtifacts: 1,
          redisTransientStateCleared: true,
        },
        recoveryGaps: ["Point-in-time gap observed."],
      }),
      verifyObjectAccess: async () => ({ verified: true, mode: "head_object", contentLength: 2048 }),
      runSmokeChecks: async () =>
        Object.fromEntries(REQUIRED_SMOKE_CHECKS.map((check) => [check, { ok: true, executed: true }])),
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.drillProject).toBe("ai-sop-dr-drill-20261127");
    expect(receipt.drillProxyPort).toBe(DEFAULT_DRILL_PROXY_PORT);
    expect(receipt.objectAccess.verified).toBe(true);
    expect(receipt.teardownSucceeded).toBeNull();
    expect(Object.keys(receipt.smokeChecks)).toEqual([...REQUIRED_SMOKE_CHECKS]);
    expect(receipt.policyNotice).toBe(PROVISIONAL_POLICY_NOTICE);

    // Failed teardown must be recorded and fail the drill (ok: false).
    const failedTeardownReceipt = await runRestoreDrill({
      drillProject: "ai-sop-dr-drill-20261127",
      manageStack: true,
      composeRunner: (_project: string, args: string[]) => {
        if (args[0] === "down") {
          throw new Error("Simulated compose down failure");
        }
        return "";
      },
      restoreRunner: async () => ({
        ok: true,
        backupId: "backup-20261127T060000Z-drill2",
        migrationHead: "0007_chat_conversations",
        n8nKeyFingerprintVerified: true,
        timingsMs: { downloadMs: 1, decryptMs: 1, restoreAppMs: 1, restoreN8nMs: 1, verifyMs: 1, totalMs: 5 },
        reconciliation: { requeuedRunningJobs: 0, exhaustedRunningJobs: 0, prunedChatTurnArtifacts: 0, redisTransientStateCleared: true },
        recoveryGaps: [],
      }),
      verifyObjectAccess: async () => ({ verified: true, mode: "head_object", contentLength: 2048 }),
      runSmokeChecks: async () =>
        Object.fromEntries(REQUIRED_SMOKE_CHECKS.map((check) => [check, { ok: true, executed: true }])),
    });
    expect(failedTeardownReceipt.teardownSucceeded).toBe(false);
    expect(failedTeardownReceipt.ok).toBe(false);
  });

  it("audits infra/backup/Dockerfile and infra/backup/compose.backup.yml via verify-hardening.mjs", () => {
    const hardening = verifyHardening(process.cwd());
    expect(hardening.ok).toBe(true);
    expect(hardening.checkedFiles).toContain("infra/backup/Dockerfile");
    expect(hardening.checkedFiles).toContain("infra/backup/compose.backup.yml");

    const composeText = readFileSync(resolve(process.cwd(), "infra/backup/compose.backup.yml"), "utf8");
    expect(auditBackupCompose(composeText).ok).toBe(true);
    expect(composeText).toContain("n8n-encryption-key-fingerprint");
    expect(composeText).toContain("backup-s3-access-key-id");
    expect(composeText).toContain("backup-s3-secret-access-key");
    expect(composeText).not.toMatch(/(?:^|\W)n8n-encryption-key(?!-fingerprint)(?:\W|$)/m);
    expect(composeText).not.toContain("backup-escrow-passphrase");

    const backupDockerfile = readFileSync(resolve(process.cwd(), "infra/backup/Dockerfile"), "utf8");
    expect(auditBackupDockerfile(backupDockerfile).ok).toBe(true);

    // Negative check: mounting raw n8n-encryption-key fails hardening audit.
    const insecureBackupCompose = `${composeText}\n      - n8n-encryption-key\n`;
    expect(auditBackupCompose(insecureBackupCompose).ok).toBe(false);
  });

  it("generates backup secrets and derived n8n fingerprint idempotently via scripts/local-secrets.mjs --with-backup", () => {
    const parent = realpathSync(tmpdir());
    const workspace = mkdtempSync(join(parent, "ai-sop-s15-secrets-"));
    const secretsDirectory = join(workspace, ".local-secrets");

    try {
      mkdirSync(join(workspace, "scripts"));
      mkdirSync(secretsDirectory, { mode: 0o700 });
      const script = join(workspace, "scripts", "local-secrets.mjs");
      copyFileSync(resolve(process.cwd(), "scripts/local-secrets.mjs"), script);

      const originalAuthSecret = randomBytes(32).toString("hex");
      writeFileSync(join(secretsDirectory, "auth-secret"), originalAuthSecret, { mode: 0o444 });

      const first = spawnSync(process.execPath, [script, "--with-backup"], { encoding: "utf8" });
      expect(first.status).toBe(0);

      const files = readdirSync(secretsDirectory);
      expect(files).toContain("backup-encryption-key");
      expect(files).toContain("backup-escrow-passphrase");
      expect(files).toContain("backup-s3-access-key-id");
      expect(files).toContain("backup-s3-secret-access-key");
      expect(files).toContain("n8n-encryption-key-fingerprint");
      expect(files.length).toBe(17);
      expect(readFileSync(join(secretsDirectory, "auth-secret"), "utf8")).toBe(originalAuthSecret);

      const backupKey = readFileSync(join(secretsDirectory, "backup-encryption-key"), "utf8");
      const escrowPass = readFileSync(join(secretsDirectory, "backup-escrow-passphrase"), "utf8");
      const n8nKey = readFileSync(join(secretsDirectory, "n8n-encryption-key"), "utf8");
      const n8nFp = readFileSync(join(secretsDirectory, "n8n-encryption-key-fingerprint"), "utf8");
      expect(parseBackupKey(backupKey).byteLength).toBe(32);
      expect(escrowPass.length).toBe(64);
      expect(n8nFp).toBe(keyFingerprint(n8nKey));

      const second = spawnSync(process.execPath, [script, "--with-backup"], { encoding: "utf8" });
      expect(second.status).toBe(0);
      expect(readFileSync(join(secretsDirectory, "backup-encryption-key"), "utf8")).toBe(backupKey);
      expect(readFileSync(join(secretsDirectory, "backup-escrow-passphrase"), "utf8")).toBe(escrowPass);
      expect(readFileSync(join(secretsDirectory, "n8n-encryption-key-fingerprint"), "utf8")).toBe(n8nFp);
      expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toContain(backupKey);
      expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toContain(escrowPass);
    } finally {
      for (const name of readdirSync(secretsDirectory)) {
        chmodSync(join(secretsDirectory, name), 0o600);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
