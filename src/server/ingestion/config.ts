import { readServerSecret } from "../auth/config";

type Environment = Readonly<Record<string, string | undefined>>;

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
export const approvedEmbeddingDimensions = 1536;
export const defaultEmbeddingModel = "text-embedding-3-small";

function parseWorkerBaseUrl(raw: string | undefined, fallback: string, label: string) {
  const url = new URL(raw ?? fallback);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`Invalid ${label} configuration.`);
  }
  return url.origin;
}

export function paddleOcrUrl(env: Environment = process.env) {
  return parseWorkerBaseUrl(env.PADDLEOCR_URL, "http://paddleocr:8091", "PADDLEOCR_URL");
}

export function conversionWorkerUrl(env: Environment = process.env) {
  return parseWorkerBaseUrl(env.CONVERSION_URL, "http://convert-worker:8092", "CONVERSION_URL");
}

function isLoopbackHttpOrigin(raw: string | undefined) {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" && loopbackHosts.includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export type EmbeddingConfiguration =
  | { mode: "synthetic_fixture"; model: string; dimensions: typeof approvedEmbeddingDimensions }
  | { mode: "openai"; endpoint: string; apiKey: string; model: string; dimensions: typeof approvedEmbeddingDimensions };

export function embeddingConfiguration(env: Environment = process.env): EmbeddingConfiguration {
  const model = (env.OPENAI_EMBEDDING_MODEL ?? defaultEmbeddingModel).trim();
  if (!model || model.length > 100 || !/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("Invalid OPENAI_EMBEDDING_MODEL configuration.");
  }
  const rawDimensions = env.OPENAI_EMBEDDING_DIMENSIONS ?? String(approvedEmbeddingDimensions);
  if (!/^\d+$/.test(rawDimensions) || Number(rawDimensions) !== approvedEmbeddingDimensions) {
    throw new Error(`OPENAI_EMBEDDING_DIMENSIONS must be ${approvedEmbeddingDimensions}.`);
  }

  const localFixture = env.SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED === "1";
  if (localFixture && !isLoopbackHttpOrigin(env.AUTH_BASE_URL)) {
    throw new Error("Local embedding fixture requires a loopback HTTP AUTH_BASE_URL.");
  }

  if (env.OPENAI_BASE_URL) {
    if (!localFixture) {
      throw new Error("OPENAI_BASE_URL override is only allowed with SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED=1.");
    }
    const base = new URL(env.OPENAI_BASE_URL);
    if (
      base.protocol !== "http:" ||
      !loopbackHosts.includes(base.hostname) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error("OPENAI_BASE_URL must be a clean loopback HTTP origin.");
    }
    const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
    const apiKey = hasKey ? readServerSecret("OPENAI_API_KEY", env) : "synthetic-local-fixture";
    return {
      mode: "openai",
      endpoint: new URL("/v1/embeddings", base.origin).toString(),
      apiKey,
      model,
      dimensions: approvedEmbeddingDimensions,
    };
  }

  const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
  if (localFixture && !hasKey) {
    return { mode: "synthetic_fixture", model, dimensions: approvedEmbeddingDimensions };
  }

  return {
    mode: "openai",
    endpoint: "https://api.openai.com/v1/embeddings",
    apiKey: readServerSecret("OPENAI_API_KEY", env),
    model,
    dimensions: approvedEmbeddingDimensions,
  };
}
