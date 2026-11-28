import { readServerSecret } from "../auth/config";
import {
  retrievalDefaults,
  RetrievalError,
  retrievalParametersSchema,
  type RetrievalParameters,
} from "./contracts";

type Environment = Readonly<Record<string, string | undefined>>;

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const modelIdentifierPattern = /^[A-Za-z0-9._-]+$/;

export const syntheticRerankerModel = "synthetic-fixture-reranker-v1";
export const syntheticRewriteModel = "synthetic-fixture-rewrite-v1";

export type RetrievalConfiguration =
  | {
      mode: "synthetic_fixture";
      rerankerModel: string;
      rewriteModel: string;
    }
  | {
      mode: "openai";
      endpoint: string;
      apiKey: string;
      rerankerModel: string;
      rewriteModel: string | null;
    };

function isCleanLoopbackHttpOrigin(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "http:" &&
      loopbackHosts.includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function validateModelIdentifier(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > 100 || !modelIdentifierPattern.test(trimmed)) {
    throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
  }
  return trimmed;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
  }
  return parsed;
}

export function resolveRetrievalParameters(
  overrides?: Partial<RetrievalParameters>,
  env: Environment = process.env,
): RetrievalParameters {
  const fromEnv: Partial<RetrievalParameters> = {
    semanticTopK: parseOptionalNumber(env.SOP_RETRIEVAL_SEMANTIC_TOP_K),
    keywordTopK: parseOptionalNumber(env.SOP_RETRIEVAL_KEYWORD_TOP_K),
    finalTopK: parseOptionalNumber(env.SOP_RETRIEVAL_FINAL_TOP_K),
    rrfK: parseOptionalNumber(env.SOP_RETRIEVAL_RRF_K),
    historyMaxTurns: parseOptionalNumber(env.SOP_RETRIEVAL_HISTORY_MAX_TURNS),
    minRerankScore: parseOptionalNumber(env.SOP_RETRIEVAL_MIN_RERANK_SCORE),
    maxRerankCandidates: parseOptionalNumber(env.SOP_RETRIEVAL_MAX_RERANK_CANDIDATES),
  };

  const envValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fromEnv)) {
    if (value !== undefined) envValues[key] = value;
  }

  const envParsed = retrievalParametersSchema.safeParse(envValues);
  if (!envParsed.success) {
    throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
  }

  const merged: Record<string, unknown> = { ...envParsed.data };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) merged[key] = value;
    }
  }

  const parsed = retrievalParametersSchema.safeParse(merged);
  if (!parsed.success) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", false, 400);
  }
  return parsed.data;
}

export function retrievalConfiguration(
  env: Environment = process.env,
  options: { requireRewriteModel?: boolean } = {},
): RetrievalConfiguration {
  const localFixture = env.SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED === "1";
  if (localFixture && !isCleanLoopbackHttpOrigin(env.AUTH_BASE_URL)) {
    throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
  }

  if (env.OPENAI_BASE_URL) {
    if (!localFixture || !isCleanLoopbackHttpOrigin(env.OPENAI_BASE_URL)) {
      throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
    }
    const rerankerModel = validateModelIdentifier(env.OPENAI_RERANKER_MODEL);
    const rewriteModel = env.OPENAI_REWRITE_MODEL
      ? validateModelIdentifier(env.OPENAI_REWRITE_MODEL)
      : options.requireRewriteModel
        ? validateModelIdentifier(undefined)
        : null;

    const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
    let apiKey = "synthetic-local-fixture";
    if (hasKey) {
      try {
        apiKey = readServerSecret("OPENAI_API_KEY", env);
      } catch {
        throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
      }
    }

    return {
      mode: "openai",
      endpoint: new URL("/v1/chat/completions", new URL(env.OPENAI_BASE_URL).origin).toString(),
      apiKey,
      rerankerModel,
      rewriteModel,
    };
  }

  const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
  if (localFixture && !hasKey) {
    return {
      mode: "synthetic_fixture",
      rerankerModel: syntheticRerankerModel,
      rewriteModel: syntheticRewriteModel,
    };
  }

  const rerankerModel = validateModelIdentifier(env.OPENAI_RERANKER_MODEL);
  const rewriteModel = env.OPENAI_REWRITE_MODEL
    ? validateModelIdentifier(env.OPENAI_REWRITE_MODEL)
    : options.requireRewriteModel
      ? validateModelIdentifier(undefined)
      : null;

  let apiKey: string;
  try {
    apiKey = readServerSecret("OPENAI_API_KEY", env);
  } catch {
    throw new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
  }

  return {
    mode: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey,
    rerankerModel,
    rewriteModel,
  };
}

export { retrievalDefaults };
