import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AuthFailure } from "../auth/errors";
import { storageConfiguration } from "./config";
import type { UploadAuthorization } from "./contracts";

export type StoredObject = { bytes: Buffer; contentType: string };
export type UploadObjectIdentity = { stagingKey: string; mimeType: string; sizeBytes: number; uploadExpiresAt: Date };
export interface DocumentStorage {
  authorizeUpload(object: UploadObjectIdentity): Promise<UploadAuthorization>;
  read(key: string, maximumBytes: number, signal: AbortSignal): Promise<StoredObject | null>;
  create(key: string, object: StoredObject, signal: AbortSignal): Promise<void>;
}

export async function readBoundedObject(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, maximumBytes: number, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > maximumBytes) throw new AuthFailure("UPLOAD_SIZE_MISMATCH", 422);
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } catch (error) {
    body.destroy?.();
    throw error;
  }
}

export function createR2Storage(configuration = storageConfiguration()): DocumentStorage {
  const client = new S3Client({ ...configuration, region: "auto", maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return {
    async authorizeUpload(object) {
      const expiresIn = Math.floor((object.uploadExpiresAt.getTime() - Date.now()) / 1000);
      if (expiresIn < 1) throw new AuthFailure("UPLOAD_EXPIRED", 410);
      const command = new PutObjectCommand({ Bucket: configuration.bucket, Key: object.stagingKey,
        ContentType: object.mimeType, ContentLength: object.sizeBytes, IfNoneMatch: "*" });
      const url = await getSignedUrl(client, command, { expiresIn,
        signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
      return { url, method: "PUT", headers: { "Content-Type": object.mimeType, "If-None-Match": "*" },
        sizeBytes: object.sizeBytes, expiresAt: object.uploadExpiresAt.toISOString() };
    },
    async read(key, maximumBytes, signal) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: configuration.bucket, Key: key }), { abortSignal: signal });
        if (!object.Body) throw new Error("Missing storage response body.");
        const body = object.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        if (object.ContentLength !== undefined && object.ContentLength > maximumBytes) {
          body.destroy?.();
          throw new AuthFailure("UPLOAD_SIZE_MISMATCH", 422);
        }
        return { bytes: await readBoundedObject(body, maximumBytes, signal), contentType: object.ContentType ?? "" };
      } catch (error) {
        if (error && typeof error === "object" && "name" in error && ["NoSuchKey", "NotFound"].includes(String(error.name))) return null;
        throw error;
      }
    },
    async create(key, object, signal) {
      await client.send(new PutObjectCommand({ Bucket: configuration.bucket, Key: key, Body: object.bytes,
        ContentLength: object.bytes.length, ContentType: object.contentType, IfNoneMatch: "*" }), { abortSignal: signal });
    },
  };
}

let sharedStorage: DocumentStorage | undefined;
export function getDocumentStorage() { return sharedStorage ??= createR2Storage(); }
