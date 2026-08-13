/**
 * OpenAI/Azure/Codex model and payload helpers.
 *
 * Keeps provider-specific detection, request patching, endpoint classification,
 * and model-key logic out of the higher-level extension wiring.
 */
import type { ExtensionConfig, JsonRecord } from "./config.ts";
import type {
  RemoteCompactionReasoningConfig,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./remote-compaction.ts";
import { isRecord, toPositiveInteger } from "./config.ts";

export type ModelLike = {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
  contextWindow?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  input?: readonly unknown[];
};

type AssistantMessageLike = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  responseId?: unknown;
  stopReason?: unknown;
};

export type ResponsesRequestSnapshot = {
  modelKey: string;
  input?: unknown[];
  instructions?: string;
  tools?: JsonRecord[];
  parallelToolCalls?: boolean;
  promptCacheKey?: string;
  toolChoice?: unknown;
  reasoning?: RemoteCompactionReasoningConfig;
  text?: ResponsesTextConfig;
};

export function hostnameFromBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function supportsStore(model: unknown): boolean {
  if (!isRecord(model)) return true;
  const compat = model.compat;
  if (!isRecord(compat)) return true;
  return compat.supportsStore !== false;
}

export function isOpenAIResponsesModel(model: unknown): model is ModelLike {
  return (
    isRecord(model) &&
    (
      model.api === "openai-responses" ||
      model.api === "azure-openai-responses" ||
      model.api === "openai-codex-responses"
    )
  );
}

export function isDirectOpenAIResponsesModel(model: ModelLike): boolean {
  if (model.api !== "openai-responses") return false;
  if (model.provider !== "openai") return false;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return host === undefined || host === "api.openai.com";
}

export function isAzureOpenAIResponsesModel(model: ModelLike): boolean {
  if (model.api !== "azure-openai-responses" && model.api !== "openai-responses") return false;
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (provider === "azure-openai" || provider === "azure-openai-responses") return true;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return typeof host === "string" && host.endsWith(".openai.azure.com");
}

export function isOpenAICodexResponsesModel(model: ModelLike): boolean {
  if (model.api !== "openai-codex-responses") return false;
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (provider === "openai-codex") return true;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return host === "chatgpt.com";
}

const OPENAI_MODEL_ID_PATTERN = /^(?:gpt-|o[1-9](?:-|$)|chatgpt-|codex(?:-|$))/i;

/** Match the canonical model id, including gateway-qualified ids such as openai/gpt-5. */
export function isOpenAIModelId(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const unqualifiedId = value.trim().split("/").at(-1) ?? "";
  return OPENAI_MODEL_ID_PATTERN.test(unqualifiedId);
}

export function isOpenAIResponsesCompactionModel(model: ModelLike): boolean {
  if (model.api !== "openai-responses") return false;
  if (isDirectOpenAIResponsesModel(model)) return true;
  if (isAzureOpenAIResponsesModel(model)) return false;
  return isOpenAIModelId(model.id) && typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0;
}

export function supportsPreviousResponseId(
  model: unknown,
  cfg: Required<ExtensionConfig>,
): model is ModelLike {
  if (!isOpenAIResponsesModel(model)) return false;
  if (isDirectOpenAIResponsesModel(model)) return true;
  return cfg.includeAzure && isAzureOpenAIResponsesModel(model);
}

export function supportsRemoteCompactionModel(model: unknown): model is ModelLike {
  if (!isOpenAIResponsesModel(model)) return false;
  return isOpenAIResponsesCompactionModel(model) || isOpenAICodexResponsesModel(model);
}

/** Models whose normal provider transport needs an explicit replacement-history payload. */
export function usesExplicitRemoteCompactionHistory(model: unknown): model is ModelLike {
  return supportsRemoteCompactionModel(model) && !isDirectOpenAIResponsesModel(model);
}

export function resolveCompactThreshold(
  model: ModelLike,
  cfg: Required<ExtensionConfig>,
): number {
  if (cfg.compactThreshold > 0) return Math.floor(cfg.compactThreshold);
  const contextWindow = toPositiveInteger(model.contextWindow);
  if (contextWindow) return Math.max(1000, Math.floor(contextWindow * cfg.thresholdRatio));
  return 80000;
}

export function looksLikeResponsesPayload(payload: JsonRecord): boolean {
  return "input" in payload || "model" in payload || "messages" in payload;
}

export function modelKey(model: ModelLike): string {
  return `${String(model.provider)}:${String(model.api)}:${String(model.id)}`;
}

export function applyPayloadPatch(params: {
  payload: JsonRecord;
  model: ModelLike;
  cfg: Required<ExtensionConfig>;
  previousResponseId?: string;
}): JsonRecord {
  const nextPayload: JsonRecord = { ...params.payload };

  if (supportsStore(params.model)) {
    nextPayload.store = true;
  }

  if (nextPayload.context_management === undefined) {
    nextPayload.context_management = [
      {
        type: "compaction",
        compact_threshold: resolveCompactThreshold(params.model, params.cfg),
      },
    ];
  }

  if (
    params.cfg.usePreviousResponseId &&
    params.previousResponseId &&
    nextPayload.previous_response_id === undefined
  ) {
    nextPayload.previous_response_id = params.previousResponseId;
  }

  return nextPayload;
}

export function thinkingLevelToResponsesReasoning(
  thinkingLevel: unknown,
): ResponsesReasoningConfig | undefined {
  if (thinkingLevel === "minimal") return { effort: "minimal", summary: "auto" };
  if (thinkingLevel === "low") return { effort: "low", summary: "auto" };
  if (thinkingLevel === "medium") return { effort: "medium", summary: "auto" };
  if (thinkingLevel === "high") return { effort: "high", summary: "auto" };
  if (thinkingLevel === "xhigh") return { effort: "xhigh", summary: "auto" };
  return undefined;
}

export function resolveCompactionReasoning(params: {
  model: ModelLike;
  thinkingLevel: unknown;
  branchThinkingLevel?: unknown;
  observed?: RemoteCompactionReasoningConfig;
}): RemoteCompactionReasoningConfig | undefined {
  if (!params.model.reasoning) return undefined;

  const thinkingLevel = params.thinkingLevel ?? params.branchThinkingLevel;
  if (typeof thinkingLevel !== "string") return undefined;

  const effortMap = isRecord(params.model.thinkingLevelMap) ? params.model.thinkingLevelMap : undefined;
  const mappedEffort = effortMap?.[thinkingLevel];
  if (mappedEffort === null) return undefined;

  const effort = typeof mappedEffort === "string"
    ? mappedEffort
    : thinkingLevel === "off"
      ? undefined
      : thinkingLevel;
  if (!effort || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    return undefined;
  }

  return {
    effort: effort as RemoteCompactionReasoningConfig["effort"],
    summary: params.observed?.summary ?? "auto",
  };
}

export function applyRemoteHistoryPayloadPatch(params: {
  payload: JsonRecord;
  explicitHistory: unknown[];
}): JsonRecord {
  const nextPayload: JsonRecord = {
    ...params.payload,
    input: params.explicitHistory,
  };
  delete nextPayload.messages;
  delete nextPayload.previous_response_id;
  return nextPayload;
}

export function extractResponsesReasoningConfig(payload: unknown): RemoteCompactionReasoningConfig | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const effort = payload.reasoning.effort;
  const summary = payload.reasoning.summary;
  const normalized: RemoteCompactionReasoningConfig = {
    ...(typeof effort === "string" ? { effort: effort as RemoteCompactionReasoningConfig["effort"] } : {}),
    ...(
      summary === null || typeof summary === "string"
        ? { summary: summary as ResponsesReasoningConfig["summary"] }
        : {}
    ),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function extractResponsesTextConfig(payload: unknown): ResponsesTextConfig | undefined {
  return isRecord(payload) && isRecord(payload.text) ? structuredClone(payload.text) : undefined;
}

export function extractResponsesRequestSnapshot(
  payload: unknown,
  model: ModelLike,
): ResponsesRequestSnapshot | undefined {
  if (!isRecord(payload)) return undefined;

  const input = Array.isArray(payload.input) ? structuredClone(payload.input) : undefined;
  const tools = Array.isArray(payload.tools)
    ? payload.tools.filter(isRecord).map((tool) => structuredClone(tool))
    : undefined;
  const parallelToolCalls = typeof payload.parallel_tool_calls === "boolean"
    ? payload.parallel_tool_calls
    : undefined;
  const promptCacheKey = typeof payload.prompt_cache_key === "string"
    ? payload.prompt_cache_key
    : undefined;
  const reasoning = extractResponsesReasoningConfig(payload);
  const text = extractResponsesTextConfig(payload);

  return {
    modelKey: modelKey(model),
    ...(input ? { input } : {}),
    ...(typeof payload.instructions === "string" ? { instructions: payload.instructions } : {}),
    ...(tools ? { tools } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    ...(promptCacheKey ? { promptCacheKey } : {}),
    ...(payload.tool_choice !== undefined ? { toolChoice: structuredClone(payload.tool_choice) } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
  };
}

export function extractAssistantResponseId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const msg = message as AssistantMessageLike;
  if (msg.role !== "assistant") return undefined;
  if (msg.stopReason === "error" || msg.stopReason === "aborted") return undefined;
  return typeof msg.responseId === "string" && msg.responseId.trim()
    ? msg.responseId
    : undefined;
}

export function messageMatchesModel(message: unknown, model: ModelLike): boolean {
  if (!isRecord(message)) return false;
  return message.provider === model.provider && message.model === model.id;
}
