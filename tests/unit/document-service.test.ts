import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import type { AuthDatabase } from "../../src/server/auth/rate-limit";
import { authSessions, authUsers, documentUploadIntents, workflowJobs } from "../../src/server/db/schema";
import { initializeDocumentUpload } from "../../src/server/documents/service";
import type { DocumentStorage } from "../../src/server/documents/storage";

it("D2 retry uses the locked accepted intent after an earlier pending snapshot", async () => {
  const owner: CurrentAccount = { id: randomUUID(), name: "Synthetic Admin", email: "admin@example.invalid", role: "ADMIN",
    sessionId: randomUUID(), sessionExpiresAt: new Date(Date.now() + 60_000) };
  const input = { requestKey: randomUUID(), title: "Synthetic retry", fileName: "synthetic.pdf", mimeType: "application/pdf" as const,
    sizeBytes: 1, sha256: "a".repeat(64) };
  const pending: typeof documentUploadIntents.$inferSelect = {
    ...input, id: randomUUID(), ownerId: owner.id, inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    stagingKey: "staging/synthetic", finalKey: "originals/synthetic", reservedBytes: 2,
    state: "AWAITING_UPLOAD", failureCode: null, uploadExpiresAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 600_000), finalizeLeaseToken: null, finalizeLeaseUntil: null, createdAt: new Date(),
  };
  const accepted = { ...pending, state: "ACCEPTED" as const };
  const jobId = randomUUID();
  const transaction = {
    execute: vi.fn(async () => undefined),
    select: (fields?: Record<string, unknown>) => ({ from: (table: unknown) => ({ where: () => {
      const rows = (locked: boolean) => {
        if (table === authUsers) return [{ id: owner.id, active: true, role: "ADMIN" }];
        if (table === authSessions) return [{ id: owner.sessionId }];
        if (table === workflowJobs) return [{ id: jobId }];
        if (table === documentUploadIntents && fields?.intent) return [{ intent: locked ? accepted : pending, expired: false, leaseActive: false }];
        if (table === documentUploadIntents) return [pending];
        throw new Error("Unexpected synthetic query.");
      };
      return {
        for: async (mode: string) => rows(mode === "update"),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows(false)).then(resolve, reject),
      };
    } }) }),
  };
  const database = { transaction: async (work: (connection: typeof transaction) => Promise<unknown>) => work(transaction) } as unknown as AuthDatabase;
  const storage: DocumentStorage = {
    authorizeUpload: vi.fn(async () => ({ url: "http://127.0.0.1/synthetic", method: "PUT" as const,
      headers: { "Content-Type": input.mimeType, "If-None-Match": "*" as const }, sizeBytes: 1, expiresAt: pending.uploadExpiresAt.toISOString() })),
    read: vi.fn(async () => null), create: vi.fn(async () => undefined),
  };
  const result = await initializeDocumentUpload(owner, input, database, storage, 1000);
  expect(result).toMatchObject({ created: false, upload: null, document: { id: pending.id, uploadStatus: "ACCEPTED", status: "UPLOADED", job: { id: jobId } } });
  expect(storage.authorizeUpload).not.toHaveBeenCalled();
});
