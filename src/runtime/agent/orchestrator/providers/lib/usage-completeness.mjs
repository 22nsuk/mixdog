// Measurement evidence only. Never coerce/default a missing wire counter here;
// adapters retain their existing numeric and cost normalization separately.
export const isReportedTokenCount = (value) => Number.isSafeInteger(value) && value >= 0;

// Gemini output includes candidates AND thoughts. An omitted component is
// unknown unless a reported total reconciles exactly with the known components
// (all token classes are nonnegative). Tool-use prompt tokens are a separate
// input class in totalTokenCount, not output. Both SDK/REST spellings are used.
export function geminiUsageCompleteness(raw, inputTokens, outputTokens, derivesInput = false) {
  const input = raw.promptTokenCount ?? raw.prompt_token_count;
  const candidates = raw.candidatesTokenCount ?? raw.candidates_token_count;
  const thoughts = raw.thoughtsTokenCount ?? raw.thoughts_token_count;
  const total = raw.totalTokenCount ?? raw.total_token_count;
  const toolInput = raw.toolUsePromptTokenCount ?? raw.tool_use_prompt_token_count;
  const outputPartsKnown = isReportedTokenCount(candidates) && isReportedTokenCount(thoughts);
  const validOrAbsent = (value) => value == null || isReportedTokenCount(value);
  const knownOutput = (candidates ?? 0) + (thoughts ?? 0);
  const reconciled =
    isReportedTokenCount(input) &&
    isReportedTokenCount(total) &&
    [candidates, thoughts, toolInput].every(validOrAbsent) &&
    total === input + knownOutput + (toolInput ?? 0);
  return {
    inputTokensComplete:
      (isReportedTokenCount(input) && input === inputTokens) ||
      // The legacy Gemini resolver derives total - output when prompt is
      // absent. Only certify that result with an explicit zero tool-input
      // count, otherwise the subtraction can include unreported tool input.
      (derivesInput &&
        !Object.hasOwn(raw, 'promptTokenCount') &&
        !Object.hasOwn(raw, 'prompt_token_count') &&
        outputPartsKnown &&
        toolInput === 0 &&
        isReportedTokenCount(total) &&
        total >= knownOutput &&
        total - knownOutput === inputTokens),
    outputTokensComplete:
      isReportedTokenCount(outputTokens) && outputTokens === knownOutput && (outputPartsKnown || reconciled),
  };
}
