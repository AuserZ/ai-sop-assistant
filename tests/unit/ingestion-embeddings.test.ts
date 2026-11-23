import { describe, expect, it, vi } from "vitest";
import { approvedEmbeddingDimensions, embeddingConfiguration } from "../../src/server/ingestion/config";
import { embedTexts, validateEmbeddingVector } from "../../src/server/ingestion/embeddings";

function unitVector(seed: number) {
  const vector = Array.from({ length: approvedEmbeddingDimensions }, (_, index) => (index === seed % approvedEmbeddingDimensions ? 1 : 0.001));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

describe("D3/ADR22 embedding configuration, batching and validation", () => {
  it("fails closed when local fixture mode is enabled on a non-loopback origin or dimensions differ from 1536", () => {
    expect(() =>
      embeddingConfiguration({
        SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
        AUTH_BASE_URL: "https://sop.company.invalid",
      }),
    ).toThrow();
    expect(() =>
      embeddingConfiguration({
        SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
        AUTH_BASE_URL: "http://127.0.0.1:3000",
        OPENAI_EMBEDDING_DIMENSIONS: "3072",
      }),
    ).toThrow();
    expect(() =>
      embeddingConfiguration({
        OPENAI_BASE_URL: "http://127.0.0.1:9000",
        OPENAI_API_KEY: "synthetic-key",
      }),
    ).toThrow();
  });

  it("generates deterministic finite unit-norm 1536-dim vectors in synthetic loopback fixture mode", async () => {
    const env = {
      SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
      AUTH_BASE_URL: "http://127.0.0.1:3000",
    };
    const first = await embedTexts(["Step 1: Verify pressure is 2.5 bar.", "Step 2: Wait 10 minutes."], { env });
    const second = await embedTexts(["Step 1: Verify pressure is 2.5 bar.", "Step 2: Wait 10 minutes."], { env });
    expect(first).toEqual(second);
    expect(first.model).toBe("text-embedding-3-small");
    expect(first.dimensions).toBe(1536);
    expect(first.vectors).toHaveLength(2);
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
    for (const vector of first.vectors) {
      expect(validateEmbeddingVector(vector, 1536)).toBe(true);
    }
  });

  it("batches up to 16 inputs per OpenAI request, classifies transient vs permanent failures and validates vectors", async () => {
    const env = { OPENAI_API_KEY: "sk-synthetic-secret-do-not-leak" };
    const batches: number[] = [];
    const fetchOk = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions: number };
      expect(body.dimensions).toBe(1536);
      batches.push(body.input.length);
      return Response.json({
        model: "text-embedding-3-small",
        data: body.input.map((_value, index) => ({ index, embedding: unitVector(index + batches.length) })),
      });
    });

    const inputs = Array.from({ length: 20 }, (_, index) => `Chunk ${index}`);
    const result = await embedTexts(inputs, { env, fetchImpl: fetchOk });
    expect(batches).toEqual([16, 4]);
    expect(result.vectors).toHaveLength(20);

    const fetchRateLimit = vi.fn<typeof fetch>(async () => new Response("rate limit", { status: 429 }));
    await expect(embedTexts(["a"], { env, fetchImpl: fetchRateLimit })).rejects.toMatchObject({
      code: "EMBEDDING_PROVIDER_TRANSIENT",
      transient: true,
    });

    const fetchDenied = vi.fn<typeof fetch>(async () => new Response("invalid key sk-synthetic-secret-do-not-leak", { status: 401 }));
    await expect(embedTexts(["a"], { env, fetchImpl: fetchDenied })).rejects.toSatisfy((error: unknown) => {
      const err = error as { code: string; transient: boolean; message: string };
      return err.code === "EMBEDDING_PROVIDER_REJECTED" && err.transient === false && !err.message.includes("sk-synthetic");
    });

    const fetchWrongDims = vi.fn<typeof fetch>(async () => Response.json({ data: [{ index: 0, embedding: [0.5, 0.5] }] }));
    await expect(embedTexts(["a"], { env, fetchImpl: fetchWrongDims })).rejects.toMatchObject({
      code: "EMBEDDING_INVALID_RESPONSE",
      transient: false,
    });

    const fetchZeroVec = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] }),
    );
    await expect(embedTexts(["a"], { env, fetchImpl: fetchZeroVec })).rejects.toMatchObject({
      code: "EMBEDDING_INVALID_RESPONSE",
      transient: false,
    });
  });
});
