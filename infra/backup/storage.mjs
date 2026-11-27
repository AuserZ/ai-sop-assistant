import { readFileSync } from "node:fs";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const DEFAULT_BACKUP_S3_REGION = "auto";
export const DEFAULT_BACKUP_S3_PREFIX = "backups/postgres";
export const DEFAULT_BACKUP_S3_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function defaultReadSecretFile(filePath) {
  return readFileSync(filePath, "utf8").trim();
}

export function normalizeBackupPrefix(rawPrefix = DEFAULT_BACKUP_S3_PREFIX) {
  const value = (rawPrefix ?? DEFAULT_BACKUP_S3_PREFIX).trim().replace(/^\/+|\/+$/g, "");
  if (!value) {
    throw new Error("BACKUP_S3_PREFIX must not be empty.");
  }
  if (value.includes("..") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    throw new Error("BACKUP_S3_PREFIX contains unsafe path characters.");
  }
  return value;
}

export function validateBackupEndpointUrl(rawEndpoint, env) {
  const resolvedEnv = env ?? process.env;
  if (typeof rawEndpoint !== "string" || !rawEndpoint.trim()) {
    throw new Error("BACKUP_S3_ENDPOINT is required.");
  }

  let parsed;
  try {
    parsed = new URL(rawEndpoint.trim());
  } catch {
    throw new Error("BACKUP_S3_ENDPOINT must be a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("BACKUP_S3_ENDPOINT must not embed credentials in the URL.");
  }

  if (parsed.protocol === "https:") {
    return parsed.toString().replace(/\/+$/, "");
  }

  const fixtureEnabled = resolvedEnv?.SOP_LOCAL_STORAGE_FIXTURE_ENABLED === "1";
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:" && fixtureEnabled && LOOPBACK_HOSTS.has(hostname)) {
    return parsed.toString().replace(/\/+$/, "");
  }

  throw new Error(
    "BACKUP_S3_ENDPOINT must use https:// (loopback http:// is permitted only when SOP_LOCAL_STORAGE_FIXTURE_ENABLED=1).",
  );
}

export function loadBackupStorageConfig(env, options = {}) {
  const resolvedEnv = env ?? process.env;
  const readSecret = options.readSecret ?? defaultReadSecretFile;
  const bucket = (resolvedEnv?.BACKUP_S3_BUCKET ?? "").trim();
  if (!BUCKET_NAME_PATTERN.test(bucket)) {
    throw new Error("BACKUP_S3_BUCKET is missing or invalid.");
  }

  const endpoint = validateBackupEndpointUrl(resolvedEnv?.BACKUP_S3_ENDPOINT, resolvedEnv);
  const region = (resolvedEnv?.BACKUP_S3_REGION ?? DEFAULT_BACKUP_S3_REGION).trim() || DEFAULT_BACKUP_S3_REGION;
  const prefix = normalizeBackupPrefix(resolvedEnv?.BACKUP_S3_PREFIX ?? DEFAULT_BACKUP_S3_PREFIX);

  const timeoutRaw = resolvedEnv?.BACKUP_S3_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw === undefined || timeoutRaw === ""
      ? DEFAULT_BACKUP_S3_TIMEOUT_MS
      : Number.parseInt(String(timeoutRaw), 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`BACKUP_S3_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }

  const accessKeyFile = (resolvedEnv?.BACKUP_S3_ACCESS_KEY_ID_FILE ?? "").trim();
  const secretKeyFile = (resolvedEnv?.BACKUP_S3_SECRET_ACCESS_KEY_FILE ?? "").trim();
  if (!accessKeyFile || !secretKeyFile) {
    throw new Error("BACKUP_S3_ACCESS_KEY_ID_FILE and BACKUP_S3_SECRET_ACCESS_KEY_FILE are required.");
  }

  const accessKeyId = readSecret(accessKeyFile);
  const secretAccessKey = readSecret(secretKeyFile);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Backup storage credentials must be non-empty.");
  }

  return {
    bucket,
    endpoint,
    region,
    prefix,
    timeoutMs,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  };
}

function assertSafeRelativeKey(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Object relative key must be a non-empty string.");
  }
  const normalized = relativePath.trim().replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\") || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error("Object relative key contains unsafe path segments.");
  }
  return normalized;
}

async function bodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported S3 object body stream.");
}

export function createBackupStorageClient(config, options = {}) {
  const { s3Client, env } = options;
  const bucket = config?.bucket;
  const prefix = normalizeBackupPrefix(config?.prefix ?? DEFAULT_BACKUP_S3_PREFIX);
  const region = config?.region ?? DEFAULT_BACKUP_S3_REGION;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_BACKUP_S3_TIMEOUT_MS;

  if (!bucket || !BUCKET_NAME_PATTERN.test(bucket)) {
    throw new Error("Backup storage client requires a valid bucket name.");
  }

  let client = s3Client;
  if (!client) {
    const validatedEndpoint = validateBackupEndpointUrl(config?.endpoint, env ?? process.env);
    client = new S3Client({
      region,
      endpoint: validatedEndpoint,
      forcePathStyle: true,
      credentials: config.credentials,
      maxAttempts: 2,
    });
  }

  function buildObjectKey(relativePath) {
    return `${prefix}/${assertSafeRelativeKey(relativePath)}`;
  }

  async function sendWithTimeout(command) {
    return client.send(command, {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function putVerifiedObject({ key, body, contentType = "application/octet-stream", metadata = {} }) {
    const bodyBuffer = Buffer.isBuffer(body)
      ? body
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(String(body), "utf8");

    const sanitizedMetadata = Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
    );

    const putResult = await sendWithTimeout(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bodyBuffer,
        ContentType: contentType,
        Metadata: sanitizedMetadata,
      }),
    );

    let headResult;
    try {
      headResult = await sendWithTimeout(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    } catch {
      const error = new Error(`Post-upload HeadObject verification failed for "${key}".`);
      error.code = "BACKUP_VERIFY_FAILED";
      throw error;
    }

    const remoteLength = Number(headResult?.ContentLength);
    if (!Number.isInteger(remoteLength) || remoteLength !== bodyBuffer.byteLength) {
      const error = new Error(
        `Post-upload byte-length mismatch for "${key}": expected ${bodyBuffer.byteLength}, observed ${String(headResult?.ContentLength)}.`,
      );
      error.code = "BACKUP_VERIFY_FAILED";
      throw error;
    }

    return {
      bucket,
      key,
      bytes: bodyBuffer.byteLength,
      etag: headResult?.ETag ?? putResult?.ETag ?? null,
    };
  }

  async function headObject(key) {
    const result = await sendWithTimeout(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return {
      bucket,
      key,
      contentLength: Number(result?.ContentLength ?? 0),
      etag: result?.ETag ?? null,
      contentType: result?.ContentType ?? null,
    };
  }

  async function getObjectBytes(key) {
    const result = await sendWithTimeout(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return bodyToBuffer(result?.Body);
  }

  async function listObjects(subPrefix = "") {
    const targetPrefix = subPrefix ? buildObjectKey(subPrefix) : `${prefix}/`;
    const result = await sendWithTimeout(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: targetPrefix,
      }),
    );
    return (result?.Contents ?? [])
      .filter((item) => typeof item?.Key === "string")
      .map((item) => ({
        key: item.Key,
        size: Number(item.Size ?? 0),
        lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  return {
    bucket,
    prefix,
    region,
    buildObjectKey,
    putVerifiedObject,
    headObject,
    getObjectBytes,
    listObjects,
  };
}
