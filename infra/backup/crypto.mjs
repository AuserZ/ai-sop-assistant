import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const BACKUP_ENVELOPE_MAGIC = Buffer.from("SOPB", "ascii");
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_FORMAT_VERSION = 1;
export const ESCROW_FORMAT_VERSION = 1;
export const AES_ALGORITHM = "aes-256-gcm";
export const AES_KEY_BYTES = 32;
export const AES_IV_BYTES = 12;
export const AES_AUTH_TAG_BYTES = 16;
export const ESCROW_SALT_BYTES = 16;
export const ESCROW_MIN_PASSPHRASE_LENGTH = 16;

export const ESCROW_SCRYPT_PARAMS = Object.freeze({
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

export const PROVISIONAL_POLICY_NOTICE =
  "30-day retention, up to 6-hour potential database loss, and 4-8-hour recovery remain provisional policy/planning values until approved and measured in isolated drills.";

const HEX_64_PATTERN = /^[a-f0-9]{64}$/i;
const MIN_DISTINCT_KEY_BYTES = 8;
const ENVELOPE_HEADER_BYTES =
  BACKUP_ENVELOPE_MAGIC.length + 1 + AES_IV_BYTES + AES_AUTH_TAG_BYTES;
const FORBIDDEN_MANIFEST_KEY_PATTERN = /(password|secret|passphrase|privatekey|apikey|token)/i;

export function computeSha256(data) {
  if (typeof data !== "string" && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new TypeError("SHA-256 input must be a string, Buffer, or Uint8Array.");
  }
  return createHash("sha256").update(data).digest("hex");
}

export function keyFingerprint(raw) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Key fingerprint input must be non-empty.");
    }
    return computeSha256(Buffer.from(trimmed, "utf8"));
  }
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    if (raw.byteLength === 0) {
      throw new Error("Key fingerprint input must be non-empty.");
    }
    return computeSha256(raw);
  }
  throw new TypeError("Key fingerprint input must be a string or Buffer.");
}

export function parseBackupKey(raw) {
  let keyBuffer;
  if (typeof raw === "string") {
    const normalized = raw.trim();
    if (!HEX_64_PATTERN.test(normalized)) {
      throw new Error("Backup encryption key must be a 64-character hexadecimal string (32 bytes).");
    }
    keyBuffer = Buffer.from(normalized, "hex");
  } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    keyBuffer = Buffer.from(raw);
  } else {
    throw new Error("Backup encryption key must be a 64-character hexadecimal string or 32-byte Buffer.");
  }

  if (keyBuffer.byteLength !== AES_KEY_BYTES) {
    throw new Error("Backup encryption key must be exactly 32 bytes.");
  }

  const distinctBytes = new Set(keyBuffer);
  if (distinctBytes.size < MIN_DISTINCT_KEY_BYTES) {
    throw new Error("Backup encryption key fails minimum entropy check.");
  }

  return keyBuffer;
}

export function buildBackupAad({ database, backupId, plaintextSha256 }) {
  if (typeof database !== "string" || !database.trim()) {
    throw new Error("Backup AAD requires a non-empty database name.");
  }
  if (typeof backupId !== "string" || !backupId.trim()) {
    throw new Error("Backup AAD requires a non-empty backupId.");
  }
  if (typeof plaintextSha256 !== "string" || !HEX_64_PATTERN.test(plaintextSha256)) {
    throw new Error("Backup AAD requires a 64-hex plaintextSha256 digest.");
  }

  return Buffer.from(
    JSON.stringify({
      v: BACKUP_FORMAT_VERSION,
      database: database.trim(),
      backupId: backupId.trim(),
      plaintextSha256: plaintextSha256.toLowerCase(),
    }),
    "utf8",
  );
}

export function encryptBackupPayload(plaintext, { key, database, backupId, iv } = {}) {
  const plaintextBuffer =
    typeof plaintext === "string"
      ? Buffer.from(plaintext, "utf8")
      : Buffer.isBuffer(plaintext) || plaintext instanceof Uint8Array
        ? Buffer.from(plaintext)
        : null;

  if (!plaintextBuffer) {
    throw new TypeError("Backup plaintext must be a string, Buffer, or Uint8Array.");
  }

  const keyBuffer = parseBackupKey(key);
  const plaintextSha256 = computeSha256(plaintextBuffer);
  const ivBuffer = iv !== undefined ? Buffer.from(iv) : randomBytes(AES_IV_BYTES);
  if (ivBuffer.byteLength !== AES_IV_BYTES) {
    throw new Error(`Backup IV must be exactly ${AES_IV_BYTES} bytes.`);
  }

  const aad = buildBackupAad({ database, backupId, plaintextSha256 });
  const cipher = createCipheriv(AES_ALGORITHM, keyBuffer, ivBuffer, {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const versionByte = Buffer.from([BACKUP_FORMAT_VERSION]);
  const envelope = Buffer.concat([BACKUP_ENVELOPE_MAGIC, versionByte, ivBuffer, authTag, ciphertext]);

  return {
    envelope,
    formatVersion: BACKUP_FORMAT_VERSION,
    plaintextBytes: plaintextBuffer.byteLength,
    plaintextSha256,
    ciphertextBytes: envelope.byteLength,
    ciphertextSha256: computeSha256(envelope),
    keyFingerprint: keyFingerprint(keyBuffer.toString("hex")),
  };
}

export function decryptBackupPayload(envelope, { key, database, backupId, expectedPlaintextSha256 } = {}) {
  if (!Buffer.isBuffer(envelope) && !(envelope instanceof Uint8Array)) {
    throw new TypeError("Encrypted backup payload must be a Buffer or Uint8Array.");
  }
  const envelopeBuffer = Buffer.from(envelope);
  if (envelopeBuffer.byteLength < ENVELOPE_HEADER_BYTES) {
    throw new Error("Encrypted backup envelope is truncated.");
  }

  const magic = envelopeBuffer.subarray(0, BACKUP_ENVELOPE_MAGIC.length);
  if (!timingSafeEqual(magic, BACKUP_ENVELOPE_MAGIC)) {
    throw new Error("Encrypted backup envelope has an invalid magic header.");
  }

  const version = envelopeBuffer[BACKUP_ENVELOPE_MAGIC.length];
  if (version !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported encrypted backup format version: ${version}.`);
  }

  const keyBuffer = parseBackupKey(key);
  const aad = buildBackupAad({
    database,
    backupId,
    plaintextSha256: expectedPlaintextSha256,
  });

  const ivStart = BACKUP_ENVELOPE_MAGIC.length + 1;
  const tagStart = ivStart + AES_IV_BYTES;
  const ciphertextStart = tagStart + AES_AUTH_TAG_BYTES;

  const iv = envelopeBuffer.subarray(ivStart, tagStart);
  const authTag = envelopeBuffer.subarray(tagStart, ciphertextStart);
  const ciphertext = envelopeBuffer.subarray(ciphertextStart);

  const decipher = createDecipheriv(AES_ALGORITHM, keyBuffer, iv, {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Backup payload authentication failed; wrong key, tampered bytes, or mismatched AAD.");
  }

  const actualSha256 = computeSha256(plaintext);
  const expectedNormalized = expectedPlaintextSha256.toLowerCase();
  if (!timingSafeEqual(Buffer.from(actualSha256, "hex"), Buffer.from(expectedNormalized, "hex"))) {
    throw new Error("Decrypted backup plaintext digest does not match expected SHA-256.");
  }

  return plaintext;
}

function assertNoForbiddenSecretKeys(value, path = "manifest") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenSecretKeys(value[index], `${path}[${index}]`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      FORBIDDEN_MANIFEST_KEY_PATTERN.test(key) &&
      !key.endsWith("Fingerprint") &&
      key !== "secretBindings"
    ) {
      throw new Error(`Forbidden secret-like field "${path}.${key}" is not allowed in backup metadata.`);
    }
    assertNoForbiddenSecretKeys(nested, `${path}.${key}`);
  }
}

export function createBackupManifest({
  backupId,
  createdAt = new Date().toISOString(),
  migrationHead,
  workflowVersions = {},
  n8nKeyFingerprint,
  backupKeyFingerprint,
  storage,
  artifacts,
}) {
  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    cipher: AES_ALGORITHM,
    backupId,
    createdAt,
    migrationHead: typeof migrationHead === "string" && migrationHead.trim() ? migrationHead.trim() : "unknown",
    workflowVersions,
    n8nKeyFingerprint: typeof n8nKeyFingerprint === "string" ? n8nKeyFingerprint.toLowerCase() : "",
    backupKeyFingerprint: typeof backupKeyFingerprint === "string" ? backupKeyFingerprint.toLowerCase() : "",
    storage: {
      bucket: storage?.bucket ?? "",
      prefix: storage?.prefix ?? "",
      region: storage?.region ?? "auto",
    },
    artifacts,
    policyNotice: PROVISIONAL_POLICY_NOTICE,
  };

  return verifyBackupManifest(manifest).manifest;
}

export function verifyBackupManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Backup manifest must be a JSON object.");
  }
  assertNoForbiddenSecretKeys(manifest);

  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(`Unsupported backup manifest formatVersion: ${String(manifest.formatVersion)}.`);
  }
  if (manifest.cipher !== AES_ALGORITHM) {
    throw new Error(`Unsupported backup manifest cipher: ${String(manifest.cipher)}.`);
  }
  if (typeof manifest.backupId !== "string" || !/^[a-zA-Z0-9._-]{3,128}$/.test(manifest.backupId)) {
    throw new Error("Backup manifest backupId is missing or invalid.");
  }
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("Backup manifest createdAt must be a valid ISO timestamp.");
  }
  if (typeof manifest.n8nKeyFingerprint !== "string" || !HEX_64_PATTERN.test(manifest.n8nKeyFingerprint)) {
    throw new Error("Backup manifest requires a valid 64-hex n8nKeyFingerprint.");
  }
  if (typeof manifest.backupKeyFingerprint !== "string" || !HEX_64_PATTERN.test(manifest.backupKeyFingerprint)) {
    throw new Error("Backup manifest requires a valid 64-hex backupKeyFingerprint.");
  }
  if (!manifest.artifacts || typeof manifest.artifacts !== "object") {
    throw new Error("Backup manifest artifacts map is required.");
  }

  for (const database of ["sop_app", "sop_n8n"]) {
    const artifact = manifest.artifacts[database];
    if (!artifact || typeof artifact !== "object") {
      throw new Error(`Backup manifest is missing required artifact metadata for "${database}".`);
    }
    if (artifact.formatVersion !== BACKUP_FORMAT_VERSION) {
      throw new Error(`Backup manifest artifact "${database}" has invalid formatVersion.`);
    }
    if (typeof artifact.objectKey !== "string" || !artifact.objectKey.trim() || artifact.objectKey.includes("..")) {
      throw new Error(`Backup manifest artifact "${database}" has an invalid objectKey.`);
    }
    if (typeof artifact.plaintextSha256 !== "string" || !HEX_64_PATTERN.test(artifact.plaintextSha256)) {
      throw new Error(`Backup manifest artifact "${database}" has an invalid plaintextSha256.`);
    }
    if (typeof artifact.ciphertextSha256 !== "string" || !HEX_64_PATTERN.test(artifact.ciphertextSha256)) {
      throw new Error(`Backup manifest artifact "${database}" has an invalid ciphertextSha256.`);
    }
    if (!Number.isInteger(artifact.plaintextBytes) || artifact.plaintextBytes <= 0) {
      throw new Error(`Backup manifest artifact "${database}" must record positive plaintextBytes.`);
    }
    if (!Number.isInteger(artifact.ciphertextBytes) || artifact.ciphertextBytes < ENVELOPE_HEADER_BYTES) {
      throw new Error(`Backup manifest artifact "${database}" must record valid ciphertextBytes.`);
    }
  }

  return { ok: true, manifest };
}

function buildEscrowAad({ n8nKeyFingerprint, saltHex, metadata }) {
  return Buffer.from(
    JSON.stringify({
      v: ESCROW_FORMAT_VERSION,
      n8nKeyFingerprint: n8nKeyFingerprint.toLowerCase(),
      saltHex: saltHex.toLowerCase(),
      metadata,
    }),
    "utf8",
  );
}

function sanitizeEscrowMetadata(metadata = {}) {
  const safeMetadata = {
    migrationHead:
      typeof metadata.migrationHead === "string" && metadata.migrationHead.trim()
        ? metadata.migrationHead.trim()
        : "unknown",
    workflowVersions:
      metadata.workflowVersions && typeof metadata.workflowVersions === "object" && !Array.isArray(metadata.workflowVersions)
        ? Object.fromEntries(
            Object.entries(metadata.workflowVersions)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, digest]) => [String(name), String(digest)]),
          )
        : {},
    storageBucket: typeof metadata.storageBucket === "string" ? metadata.storageBucket.trim() : "",
    storagePrefix: typeof metadata.storagePrefix === "string" ? metadata.storagePrefix.trim() : "",
    backupKeyFingerprint:
      typeof metadata.backupKeyFingerprint === "string" && HEX_64_PATTERN.test(metadata.backupKeyFingerprint.trim())
        ? metadata.backupKeyFingerprint.trim().toLowerCase()
        : null,
    secretBindings: Array.isArray(metadata.secretBindings)
      ? [...new Set(metadata.secretBindings.map((name) => String(name).trim()).filter(Boolean))].sort()
      : [],
  };

  assertNoForbiddenSecretKeys(safeMetadata, "escrow.metadata");
  return safeMetadata;
}

export function encryptKeyEscrowBundle(options = {}) {
  const {
    n8nEncryptionKey,
    metadata = {},
    passphrase,
    createdAt = new Date().toISOString(),
  } = options;
  if (typeof n8nEncryptionKey !== "string" || n8nEncryptionKey.trim().length < 16) {
    throw new Error("N8N_ENCRYPTION_KEY must be a non-empty string of at least 16 characters.");
  }
  if (typeof passphrase !== "string" || passphrase.trim().length < ESCROW_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Escrow passphrase must be at least ${ESCROW_MIN_PASSPHRASE_LENGTH} characters.`);
  }

  const normalizedKey = n8nEncryptionKey.trim();
  const normalizedPassphrase = passphrase.trim();
  const n8nKeyFp = keyFingerprint(normalizedKey);
  const safeMetadata = sanitizeEscrowMetadata(metadata);

  const salt = randomBytes(ESCROW_SALT_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const derivedKey = scryptSync(normalizedPassphrase, salt, AES_KEY_BYTES, ESCROW_SCRYPT_PARAMS);

  const aad = buildEscrowAad({
    n8nKeyFingerprint: n8nKeyFp,
    saltHex: salt.toString("hex"),
    metadata: safeMetadata,
  });

  const secretPayload = Buffer.from(
    JSON.stringify({
      n8nEncryptionKey: normalizedKey,
      n8nKeyFingerprint: n8nKeyFp,
      metadata: safeMetadata,
      createdAt,
    }),
    "utf8",
  );

  const cipher = createCipheriv(AES_ALGORITHM, derivedKey, iv, {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(secretPayload), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    formatVersion: ESCROW_FORMAT_VERSION,
    createdAt,
    kdf: {
      algorithm: "scrypt",
      N: ESCROW_SCRYPT_PARAMS.N,
      r: ESCROW_SCRYPT_PARAMS.r,
      p: ESCROW_SCRYPT_PARAMS.p,
      keyLength: AES_KEY_BYTES,
      saltHex: salt.toString("hex"),
    },
    cipher: AES_ALGORITHM,
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    n8nKeyFingerprint: n8nKeyFp,
    metadata: safeMetadata,
    ciphertextBase64: ciphertext.toString("base64"),
  };
}

export function decryptKeyEscrowBundle(bundle, { passphrase, expectedN8nKeyFingerprint } = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Key escrow bundle must be a JSON object.");
  }
  if (bundle.formatVersion !== ESCROW_FORMAT_VERSION) {
    throw new Error(`Unsupported key escrow formatVersion: ${String(bundle.formatVersion)}.`);
  }
  if (bundle.cipher !== AES_ALGORITHM) {
    throw new Error(`Unsupported key escrow cipher: ${String(bundle.cipher)}.`);
  }
  if (typeof passphrase !== "string" || passphrase.trim().length < ESCROW_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Escrow passphrase must be at least ${ESCROW_MIN_PASSPHRASE_LENGTH} characters.`);
  }
  if (typeof bundle.n8nKeyFingerprint !== "string" || !HEX_64_PATTERN.test(bundle.n8nKeyFingerprint)) {
    throw new Error("Key escrow bundle is missing a valid n8nKeyFingerprint.");
  }

  const kdf = bundle.kdf;
  const isPowerOfTwo = (value) => Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
  if (
    !kdf ||
    kdf.algorithm !== "scrypt" ||
    !isPowerOfTwo(kdf.N) ||
    kdf.N < 16_384 ||
    kdf.N > 131_072 ||
    !Number.isInteger(kdf.r) ||
    kdf.r < 1 ||
    kdf.r > 16 ||
    !Number.isInteger(kdf.p) ||
    kdf.p < 1 ||
    kdf.p > 8 ||
    128 * kdf.N * kdf.r > ESCROW_SCRYPT_PARAMS.maxmem ||
    kdf.keyLength !== AES_KEY_BYTES ||
    typeof kdf.saltHex !== "string" ||
    !/^[a-f0-9]{32}$/i.test(kdf.saltHex)
  ) {
    throw new Error("Key escrow bundle has invalid or unsafe scrypt parameters.");
  }

  if (typeof bundle.ivHex !== "string" || !/^[a-f0-9]{24}$/i.test(bundle.ivHex)) {
    throw new Error("Key escrow bundle has an invalid IV.");
  }
  if (typeof bundle.authTagHex !== "string" || !/^[a-f0-9]{32}$/i.test(bundle.authTagHex)) {
    throw new Error("Key escrow bundle has an invalid auth tag.");
  }
  if (typeof bundle.ciphertextBase64 !== "string" || !bundle.ciphertextBase64.length) {
    throw new Error("Key escrow bundle ciphertext is missing.");
  }

  const salt = Buffer.from(kdf.saltHex, "hex");
  const iv = Buffer.from(bundle.ivHex, "hex");
  const authTag = Buffer.from(bundle.authTagHex, "hex");
  const ciphertext = Buffer.from(bundle.ciphertextBase64, "base64");
  const safeMetadata = sanitizeEscrowMetadata(bundle.metadata);

  const derivedKey = scryptSync(passphrase.trim(), salt, AES_KEY_BYTES, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: ESCROW_SCRYPT_PARAMS.maxmem,
  });

  const aad = buildEscrowAad({
    n8nKeyFingerprint: bundle.n8nKeyFingerprint,
    saltHex: kdf.saltHex,
    metadata: safeMetadata,
  });

  const decipher = createDecipheriv(AES_ALGORITHM, derivedKey, iv, {
    authTagLength: AES_AUTH_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let decoded;
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Key escrow bundle authentication failed; wrong passphrase or tampered bundle.");
  }

  if (typeof decoded?.n8nEncryptionKey !== "string" || decoded.n8nEncryptionKey.trim().length < 16) {
    throw new Error("Key escrow bundle payload does not contain a valid N8N_ENCRYPTION_KEY.");
  }

  const actualFingerprint = keyFingerprint(decoded.n8nEncryptionKey);
  if (
    !timingSafeEqual(
      Buffer.from(actualFingerprint, "hex"),
      Buffer.from(bundle.n8nKeyFingerprint.toLowerCase(), "hex"),
    )
  ) {
    throw new Error("Decrypted N8N_ENCRYPTION_KEY does not match bundle fingerprint.");
  }

  if (expectedN8nKeyFingerprint !== undefined) {
    if (typeof expectedN8nKeyFingerprint !== "string" || !HEX_64_PATTERN.test(expectedN8nKeyFingerprint)) {
      throw new Error("expectedN8nKeyFingerprint must be a 64-hex SHA-256 digest.");
    }
    if (
      !timingSafeEqual(
        Buffer.from(actualFingerprint, "hex"),
        Buffer.from(expectedN8nKeyFingerprint.toLowerCase(), "hex"),
      )
    ) {
      throw new Error("Escrowed N8N_ENCRYPTION_KEY fingerprint does not match expected fingerprint.");
    }
  }

  return {
    n8nEncryptionKey: decoded.n8nEncryptionKey,
    n8nKeyFingerprint: actualFingerprint,
    metadata: safeMetadata,
    createdAt: decoded.createdAt ?? bundle.createdAt,
  };
}
