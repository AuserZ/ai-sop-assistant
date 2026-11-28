// GPT-5, GPT-6, and o-series models reject non-default temperature values (such as 0).
const fixedTemperatureModelPattern = /^(?:gpt-[56](?:[.\-]|$)|o[134](?:[.\-]|$))/i;

export function supportsZeroTemperature(model: string): boolean {
  return !fixedTemperatureModelPattern.test(model.trim());
}

export function buildOpenAiJsonChatBody(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
) {
  return {
    model,
    ...(supportsZeroTemperature(model) ? { temperature: 0 } : {}),
    response_format: { type: "json_object" as const },
    messages,
  };
}
