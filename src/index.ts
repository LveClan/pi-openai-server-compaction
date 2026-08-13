/**
 * Main extension entrypoint.
 *
 * Wires together request patching, remote compaction, runtime state
 * reconstruction, session lifecycle cleanup, and provider override registration.
 */
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord, loadConfig } from "./config.ts";
import { streamOpenAIResponsesWithPhase2B } from "./custom-stream.ts";
import {
  applyPayloadPatch,
  applyRemoteHistoryPayloadPatch,
  extractAssistantResponseId,
  extractResponsesRequestSnapshot,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  resolveCompactionReasoning,
  supportsPreviousResponseId,
  supportsRemoteCompactionModel,
  usesExplicitRemoteCompactionHistory,
} from "./openai.ts";
import { releaseAllWsSessions, releaseWsSession } from "./openai-ws-stream.ts";
import {
  buildCompactionSummaryText,
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateArtifactPortableSummary,
  generateBestEffortLocalSummary,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
  selectRemoteCompactionInput,
} from "./remote-compaction.ts";
import {
  clearAllContinuationState,
  clearContinuationState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getContinuationState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setContinuationState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function getBranchMessageCount(branchEntries: BranchEntry[]): number {
  return branchEntries.filter((entry) => entry.type === "message" && Boolean(entry.message)).length;
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearLiveContinuation(sessionId: string | undefined): void {
  clearContinuationState(sessionId);
  releaseWsSession(sessionId);
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearLiveContinuation(sessionId);
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function saveResponsesRequestSnapshot(params: {
  sessionId: string;
  payload: unknown;
  model: TargetModel;
}): void {
  const snapshot = extractResponsesRequestSnapshot(params.payload, params.model);
  if (!snapshot) return;
  setResponsesRequestShapeState(params.sessionId, {
    ...snapshot,
    updatedAt: Date.now(),
    suffix: [],
  });
}

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && !messageMatchesModel(params.message, params.model)) {
    return;
  }

  const items = messageToResponseItems(params.message);
  if (items.length === 0) return;

  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

function maybeNotifyRequestFeatures(params: {
  notifiedModels: Set<string>;
  hasUI: boolean;
  notify: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
  model: TargetModel;
  features: string[];
}): void {
  if (!params.notify || !params.hasUI || params.features.length === 0) return;

  const key = `${String(params.model.provider)}/${String(params.model.id)}`;
  const noticeKey = `${key}:${params.features.join(",")}`;
  if (params.notifiedModels.has(noticeKey)) return;

  params.notifiedModels.add(noticeKey);
  params.ui.notify(`OpenAI compaction active for ${key} (${params.features.join(", ")})`, "info");
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  const notifiedModels = new Set<string>();

  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple: streamOpenAIResponsesWithPhase2B,
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearLiveContinuation(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

  pi.on("model_select", (_event, ctx) => {
    clearLiveContinuation(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllContinuationState();
    releaseAllWsSessions();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const model = ctx.model;
    if (!cfg.enabled || !model || !supportsRemoteCompactionModel(model)) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;
    const apiKey = auth.apiKey;

    const sessionId = getSessionId(ctx);
    const branchEntries = event.branchEntries as BranchEntry[];
    const remoteState = getMatchingRemoteState(sessionId, model);
    const observedRequestShape = getResponsesRequestShapeState(sessionId);
    const effectiveMessages = convertToLlm(
      buildSessionContext(event.branchEntries as SessionEntry[]).messages,
    ) as AgentMessage[];
    const fallbackResponseItems = remoteState
      ? remoteState.explicitHistory
      : messagesToResponseItems(effectiveMessages);
    const snapshot = observedRequestShape?.modelKey === modelKey(model)
      ? observedRequestShape
      : undefined;
    const selectedInput = selectRemoteCompactionInput({
      snapshotInput: snapshot?.input,
      snapshotSuffix: snapshot?.suffix,
      fallbackInput: fallbackResponseItems,
      model,
    });
    const promptResponseItems = selectedInput.input;
    const tools = snapshot
      ? snapshot.tools
      : buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
    const thinkingLevel = pi.getThinkingLevel();
    const reasoning = resolveCompactionReasoning({
      model,
      thinkingLevel,
      branchThinkingLevel: getBranchThinkingLevel(branchEntries),
      observed: snapshot?.reasoning,
    });
    const text = snapshot?.text;
    const instructions = snapshot ? snapshot.instructions : ctx.getSystemPrompt();
    const parallelToolCalls = snapshot ? snapshot.parallelToolCalls : true;

    let remoteResult;
    try {
      remoteResult = await callRemoteCompactionEndpoint({
        model,
        apiKey,
        headers: auth.headers,
        sessionId,
        input: promptResponseItems,
        instructions,
        tools,
        parallelToolCalls,
        promptCacheKey: snapshot?.promptCacheKey,
        toolChoice: snapshot?.toolChoice,
        reasoning,
        text,
        signal: event.signal,
      });
    } catch (error) {
      if (cfg.portableSummary) {
        try {
          const fallback = await generateBestEffortLocalSummary({
            preparation: event.preparation,
            messages: effectiveMessages,
            model,
            apiKey,
            headers: auth.headers,
            customInstructions: event.customInstructions,
            signal: event.signal,
            thinkingLevel,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          });
          return { compaction: fallback };
        } catch {
          // Pi's default compactor remains the final fallback below.
        }
      }
      if (!event.signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`OpenAI remote compaction failed; falling back to default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    const localSummary = cfg.portableSummary
      ? await generateArtifactPortableSummary({
          replacementHistory: remoteResult.output,
          model,
          apiKey,
          headers: auth.headers,
          sessionId,
          promptCacheKey: snapshot?.promptCacheKey,
          instructions,
          tools,
          parallelToolCalls,
          toolChoice: snapshot?.toolChoice,
          text,
          reasoning,
          customInstructions: event.customInstructions,
          signal: event.signal,
          thinkingLevel,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        }).catch(async () => {
          if (event.signal.aborted) {
            return {
              summary: buildCompactionSummaryText(model),
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            };
          }
          try {
            return await generateBestEffortLocalSummary({
              preparation: event.preparation,
              messages: effectiveMessages,
              model,
              apiKey,
              headers: auth.headers,
              customInstructions: event.customInstructions,
              signal: event.signal,
              thinkingLevel,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            });
          } catch {
            return {
              summary: buildCompactionSummaryText(model),
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            };
          }
        })
      : {
          summary: buildCompactionSummaryText(model),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        };

    const remoteDetails = buildRemoteCompactionDetails(
      model,
      remoteResult.output,
      remoteResult.usage,
      {
        ...(reasoning ? { reasoning } : {}),
        inputItems: promptResponseItems.length,
        inputSource: selectedInput.source,
      },
    );

    return {
      compaction: {
        summary: localSummary.summary,
        firstKeptEntryId: localSummary.firstKeptEntryId,
        tokensBefore: localSummary.tokensBefore,
        details: {
          ...(localSummary.details !== undefined ? { localSummaryDetails: localSummary.details } : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;

    extendRemoteHistoryIfCompatible({
      sessionId,
      model,
      message: event.message,
    });

    const requestShape = getResponsesRequestShapeState(sessionId);
    if (requestShape && model && requestShape.modelKey === modelKey(model)) {
      const suffixItems = messageToResponseItems(event.message);
      if (suffixItems.length > 0) {
        setResponsesRequestShapeState(sessionId, {
          ...requestShape,
          updatedAt: Date.now(),
          suffix: [...requestShape.suffix, ...suffixItems],
        });
      }
    }

    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled || !supportsPreviousResponseId(model, cfg)) return;
    if (!messageMatchesModel(event.message, model)) return;

    const responseId = extractAssistantResponseId(event.message);
    if (!responseId) return;

    setContinuationState(sessionId, {
      responseId,
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      contextLength: getBranchMessageCount(ctx.sessionManager.getBranch() as BranchEntry[]),
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return undefined;

    const model = ctx.model;
    if (!model || !isRecord(event.payload) || !looksLikeResponsesPayload(event.payload)) return undefined;

    const sessionId = getSessionId(ctx);
    const remoteState = getMatchingRemoteState(sessionId, model);

    if (usesExplicitRemoteCompactionHistory(model)) {
      if (!remoteState) {
        saveResponsesRequestSnapshot({ sessionId, payload: event.payload, model });
        return undefined;
      }
      const payload = applyRemoteHistoryPayloadPatch({
        payload: event.payload,
        explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
      });
      saveResponsesRequestSnapshot({ sessionId, payload, model });
      maybeNotifyRequestFeatures({
        notifiedModels,
        hasUI: ctx.hasUI,
        notify: cfg.notify,
        ui: ctx.ui,
        model,
        features: ["remote_compaction_history"],
      });
      return payload;
    }

    if (!supportsPreviousResponseId(model, cfg)) {
      saveResponsesRequestSnapshot({ sessionId, payload: event.payload, model });
      return undefined;
    }

    const continuation = getContinuationState(sessionId);
    const previousResponseId =
      remoteState === undefined && continuation && continuation.modelKey === modelKey(model)
        ? continuation.responseId
        : undefined;

    const payload = applyPayloadPatch({
      payload: event.payload,
      model,
      cfg,
      previousResponseId,
    });
    saveResponsesRequestSnapshot({ sessionId, payload, model });

    const features = ["store=true", "context_management"];
    if (remoteState !== undefined) {
      features.push("remote_compaction_history");
    } else if (previousResponseId) {
      features.push("previous_response_id");
    }

    maybeNotifyRequestFeatures({
      notifiedModels,
      hasUI: ctx.hasUI,
      notify: cfg.notify,
      ui: ctx.ui,
      model,
      features,
    });

    return payload;
  });
}
