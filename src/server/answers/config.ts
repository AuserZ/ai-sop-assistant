import { readServerSecret } from "../auth/config";
import { answerDefaults, AnswerStageError } from "./contracts";

type Environment = Readonly<Record<string, string | undefined>>;

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const modelIdentifierPattern = /^[A-Za-z0-9._-]+$/;

export const syntheticAnswerModel = "synthetic-fixture-answer-v1";
export const syntheticJudgeModel = "synthetic-fixture-judge-v1";

export type AnswerConfiguration =
  | {
      mode: "synthetic_fixture";
      answerModel: string;
      judgeModel: string;
    }
  | {
      mode: "openai";
      endpoint: string;
      apiKey: string;
      answerModel: string;
      judgeModel: string;
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
    throw new AnswerStageError("ANSWER_CONFIG_MISSING", false, 503);
  }
  return trimmed;
}

export function answerConfiguration(env: Environment = process.env): AnswerConfiguration {
  const localFixture = env.SOP_LOCAL_ANSWER_FIXTURE_ENABLED === "1";
  if (localFixture && !isCleanLoopbackHttpOrigin(env.AUTH_BASE_URL)) {
    throw new AnswerStageError("ANSWER_CONFIG_MISSING", false, 503);
  }

  if (env.OPENAI_BASE_URL) {
    if (!localFixture || !isCleanLoopbackHttpOrigin(env.OPENAI_BASE_URL)) {
      throw new AnswerStageError("ANSWER_CONFIG_MISSING", false, 503);
    }

    const answerModel = validateModelIdentifier(env.OPENAI_ANSWER_MODEL);
    const judgeModel = validateModelIdentifier(env.OPENAI_JUDGE_MODEL);
    const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
    let apiKey = "synthetic-local-fixture";
    if (hasKey) {
      try {
        apiKey = readServerSecret("OPENAI_API_KEY", env);
      } catch {
        throw new AnswerStageError("ANSWER_CONFIG_MISSING", false, 503);
      }
    }

    return {
      mode: "openai",
      endpoint: new URL("/v1/chat/completions", new URL(env.OPENAI_BASE_URL).origin).toString(),
      apiKey,
      answerModel,
      judgeModel,
    };
  }

  const hasKey = Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FILE);
  if (localFixture && !hasKey) {
    return {
      mode: "synthetic_fixture",
      answerModel: syntheticAnswerModel,
      judgeModel: syntheticJudgeModel,
    };
  }

  const answerModel = validateModelIdentifier(env.OPENAI_ANSWER_MODEL);
  const judgeModel = validateModelIdentifier(env.OPENAI_JUDGE_MODEL);

  let apiKey: string;
  try {
    apiKey = readServerSecret("OPENAI_API_KEY", env);
  } catch {
    throw new AnswerStageError("ANSWER_CONFIG_MISSING", false, 503);
  }

  return {
    mode: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey,
    answerModel,
    judgeModel,
  };
}

export { answerDefaults };
