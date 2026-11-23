import { createHash } from "node:crypto";
import { approvedEmbeddingDimensions, embeddingConfiguration } from "./config";
import { ingestionLimits, IngestionStageError, openaiEmbeddingResponseSchema } from "./contracts";

type Environment = Readonly<Record<string, string | undefined>>;

export function validateEmbeddingVector(vector: number[], expectedDimensions: number = approvedEmbeddingDimensions) {
  if (vector.length !== expectedDimensions) return false;
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    squaredNorm += value * value;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0;
}

function syntheticUnitVector(model: string, text: string, dimensions: number): number[] {
  const raw = new Array<number>(dimensions);
  let filled = 0;
  let blockIndex = 0;
  while (filled < dimensions) {
    const digest = createHash("sha256")
      .update(model)
      .update("\0")
      .update(String(blockIndex))
      .update("\0")
      .update(text)
      .digest();
    for (let offset = 0; offset + 4 <= digest.length && filled < dimensions; offset += 4) {
      const sample = digest.readInt32BE(offset) / 0x7fffffff;
      raw[filled++] = sample;
    }
    blockIndex++;
  }
  let squaredNorm = 0;
  for (const value of raw) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new IngestionStageError("EMBEDDING_INVALID_RESPONSE", false, 422);
  }
  return raw.map((value) => Number((value / norm).toFixed(7)));
}

function isTransientHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export async function embedTexts(
  texts: string[],
  options: { env?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ model: string; dimensions: typeof approvedEmbeddingDimensions; vectors: number[][] }> {
  const configuration = embeddingConfiguration(options.env);
  if (texts.length === 0) {
    return { model: configuration.model, dimensions: configuration.dimensions, vectors: [] };
  }

  if (configuration.mode === "synthetic_fixture") {
    const vectors = texts.map((text) => {
      const vector = syntheticUnitVector(configuration.model, text, configuration.dimensions);
      if (!validateEmbeddingVector(vector, configuration.dimensions)) {
        throw new IngestionStageError("EMBEDDING_INVALID_RESPONSE", false, 422);
      }
      return vector;
    });
    return { model: configuration.model, dimensions: configuration.dimensions, vectors };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const vectors: number[][] = [];
  let reportedModel = configuration.model;

  for (let start = 0; start < texts.length; start += ingestionLimits.embeddingBatchSize) {
    const batch = texts.slice(start, start + ingestionLimits.embeddingBatchSize);
    const timeoutSignal = AbortSignal.timeout(ingestionLimits.embeddingTimeoutMilliseconds);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetchImpl(configuration.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${configuration.apiKey}`,
        },
        body: JSON.stringify({
          model: configuration.model,
          input: batch,
          dimensions: configuration.dimensions,
          encoding_format: "float",
        }),
        signal,
      });
    } catch {
      throw new IngestionStageError("EMBEDDING_PROVIDER_TRANSIENT", true, 503);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (isTransientHttpStatus(response.status)) {
        throw new IngestionStageError("EMBEDDING_PROVIDER_TRANSIENT", true, 503);
      }
      throw new IngestionStageError("EMBEDDING_PROVIDER_REJECTED", false, 422);
    }

    const payload: unknown = await response.json().catch(() => null);
    const parsed = openaiEmbeddingResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.length !== batch.length) {
      throw new IngestionStageError("EMBEDDING_INVALID_RESPONSE", false, 422);
    }

    if (parsed.data.model) reportedModel = parsed.data.model;

    const ordered = [...parsed.data.data].sort((left, right) => left.index - right.index);
    for (let index = 0; index < batch.length; index++) {
      const entry = ordered[index];
      if (entry.index !== index || !validateEmbeddingVector(entry.embedding, configuration.dimensions)) {
        throw new IngestionStageError("EMBEDDING_INVALID_RESPONSE", false, 422);
      }
      vectors.push(entry.embedding);
    }
  }

  return { model: reportedModel, dimensions: configuration.dimensions, vectors };
}
