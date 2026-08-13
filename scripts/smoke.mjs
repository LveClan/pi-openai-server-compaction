import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const {
  buildSessionContext,
  convertToLlm,
} = await import("@earendil-works/pi-coding-agent");
const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");
const { loadConfig } = await import(pathToFileURL(join(repoRoot, "src", "config.ts")).href);
const originalPortableSummaryEnv = process.env.PI_OPENAI_SERVER_COMPACTION_PORTABLE_SUMMARY;
process.env.PI_OPENAI_SERVER_COMPACTION_PORTABLE_SUMMARY = "false";
assert.equal(loadConfig(repoRoot).portableSummary, false);
if (originalPortableSummaryEnv === undefined) {
  delete process.env.PI_OPENAI_SERVER_COMPACTION_PORTABLE_SUMMARY;
} else {
  process.env.PI_OPENAI_SERVER_COMPACTION_PORTABLE_SUMMARY = originalPortableSummaryEnv;
}

const {
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  generateArtifactPortableSummary,
  generatePortableSummary,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
  selectRemoteCompactionInput,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  extractResponsesRequestSnapshot,
  isOpenAIModelId,
  resolveCompactionReasoning,
  supportsRemoteCompactionModel,
  usesExplicitRemoteCompactionHistory,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  selectInputItemsForContinuation,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);
const {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
} = await import("@earendil-works/pi-ai/compat");

const streamProviderSource = "pi-openai-server-compaction-null-header-smoke";
const streamHeaders = {
  "x-forwarded-header": "preserved",
  authorization: null,
};
let forwardedStreamHeaders;
let forwardedSummaryReasoningEffort;
let forwardedSummaryPayload;
const mockSummaryStream = (model, _context, options) => {
  forwardedStreamHeaders = options?.headers;
  forwardedSummaryReasoningEffort = options?.reasoningEffort;
  const originalPayload = {
    model: model.id,
    input: [{ role: "user", content: "placeholder" }],
  };
  forwardedSummaryPayload = options?.onPayload?.(originalPayload, model) ?? originalPayload;
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [{ type: "text", text: "stream summary" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return stream;
};
registerApiProvider({
  api: "null-header-smoke",
  stream: mockSummaryStream,
  streamSimple: mockSummaryStream,
}, streamProviderSource);
try {
  const portableSummary = await generatePortableSummary({
    messages: [{
      role: "user",
      content: [{ type: "text", text: "summarize this" }],
      timestamp: Date.now(),
    }],
    model: {
      provider: "null-header-smoke",
      api: "null-header-smoke",
      id: "null-header-smoke",
    },
    apiKey: "stream-test-key",
    headers: streamHeaders,
    thinkingLevel: "xhigh",
    firstKeptEntryId: "entry-1",
    tokensBefore: 1,
  });
  assert.equal(portableSummary.summary, "stream summary");
  assert.deepStrictEqual(
    forwardedStreamHeaders,
    streamHeaders,
    "pi-ai stream boundary should receive the ProviderHeaders unchanged",
  );
  assert.equal(forwardedStreamHeaders.authorization, null);
  assert.equal(forwardedStreamHeaders["x-forwarded-header"], "preserved");
  assert.equal(forwardedSummaryReasoningEffort, "xhigh");

  const artifactSummary = await generateArtifactPortableSummary({
    replacementHistory: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "retained user context" }],
      },
      { type: "compaction", encrypted_content: "ENCRYPTED_ARTIFACT" },
    ],
    model: {
      provider: "null-header-smoke",
      api: "null-header-smoke",
      id: "null-header-smoke",
    },
    apiKey: "stream-test-key",
    headers: streamHeaders,
    sessionId: "artifact-session",
    promptCacheKey: "stable-cache-key",
    instructions: "stable instructions",
    tools: [{ type: "function", name: "read", parameters: {} }],
    parallelToolCalls: true,
    toolChoice: "auto",
    text: { verbosity: "medium" },
    reasoning: { effort: "high", summary: "detailed" },
    customInstructions: "Keep exact decisions.",
    thinkingLevel: "high",
    firstKeptEntryId: "entry-2",
    tokensBefore: 2,
  });
  assert.equal(artifactSummary.summary, "stream summary");
  assert.equal(artifactSummary.details?.source, "remote_compaction_artifact");
  assert.equal(artifactSummary.details?.reasoningEffort, "high");
  assert.equal(artifactSummary.details?.inputItems, 3);
  assert.equal(forwardedSummaryReasoningEffort, "high");
  assert.equal(forwardedSummaryPayload.prompt_cache_key, "stable-cache-key");
  assert.equal(forwardedSummaryPayload.instructions, "stable instructions");
  assert.equal(forwardedSummaryPayload.parallel_tool_calls, true);
  assert.equal(forwardedSummaryPayload.tool_choice, "auto");
  assert.deepEqual(forwardedSummaryPayload.text, { verbosity: "medium" });
  assert.deepEqual(forwardedSummaryPayload.reasoning, {
    effort: "high",
    summary: "detailed",
  });
  assert.equal(forwardedSummaryPayload.tools[0].name, "read");
  assert.equal(forwardedSummaryPayload.input[1].encrypted_content, "ENCRYPTED_ARTIFACT");
  assert.match(forwardedSummaryPayload.input[2].content[0].text, /Keep exact decisions/);
  assert.doesNotMatch(JSON.stringify(forwardedSummaryPayload.input), /placeholder/);
} finally {
  unregisterApiProviders(streamProviderSource);
}

const customProviderModel = {
  provider: "company-gateway",
  api: "openai-responses",
  id: "openai/gpt-5.6-sol",
  name: "Company default model",
  baseUrl: "https://models.example.com/v1",
};
assert.equal(isOpenAIModelId(customProviderModel.id), true);
assert.equal(supportsRemoteCompactionModel(customProviderModel), true);
assert.equal(usesExplicitRemoteCompactionHistory(customProviderModel), true);
assert.equal(
  supportsRemoteCompactionModel({
    ...customProviderModel,
    id: "claude-sonnet-4-6",
  }),
  false,
);
assert.equal(
  supportsRemoteCompactionModel({
    ...customProviderModel,
    id: "internal-alias",
    name: "GPT-5.6 Sol",
  }),
  false,
  "matching the stable model id avoids display-name false positives",
);
assert.equal(
  supportsRemoteCompactionModel({
    ...customProviderModel,
    api: "anthropic-messages",
  }),
  false,
  "model ids alone must not opt non-Responses APIs into OpenAI compaction",
);
assert.equal(
  supportsRemoteCompactionModel({
    provider: "company-gateway",
    api: "openai-responses",
    id: "gpt-5.6-sol",
  }),
  false,
  "custom providers require an explicit base URL instead of falling back to api.openai.com",
);
assert.equal(
  supportsRemoteCompactionModel({
    provider: "azure-openai",
    api: "openai-responses",
    id: "gpt-5.6-sol",
    baseUrl: "https://example.openai.azure.com",
  }),
  false,
  "custom-provider matching must not bypass Azure's separate opt-in behavior",
);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, undefined);
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });

const currentReasoning = resolveCompactionReasoning({
  model: {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  },
  thinkingLevel: "xhigh",
  observed: { summary: "detailed" },
});
assert.deepEqual(currentReasoning, { effort: "xhigh", summary: "detailed" });
assert.deepEqual(
  resolveCompactionReasoning({
    model: { reasoning: true, thinkingLevelMap: { max: "max" } },
    thinkingLevel: "max",
    observed: { effort: "low", summary: "auto" },
  }),
  { effort: "max", summary: "auto" },
);
assert.equal(
  resolveCompactionReasoning({
    model: { reasoning: true, thinkingLevelMap: { off: null } },
    thinkingLevel: "off",
    observed: { effort: "high", summary: "auto" },
  }),
  undefined,
);

const requestSnapshot = extractResponsesRequestSnapshot({
  input: [
    { role: "system", content: "stable system" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  ],
  tools: [{ type: "function", name: "read", parameters: {} }],
  parallel_tool_calls: true,
  prompt_cache_key: "stable-session",
  tool_choice: "auto",
  reasoning: { effort: "xhigh", summary: "auto" },
}, {
  provider: "gptpro",
  api: "openai-responses",
  id: "gpt-5.6-sol",
});
assert.ok(requestSnapshot);
assert.equal(requestSnapshot.modelKey, "gptpro:openai-responses:gpt-5.6-sol");
assert.equal(requestSnapshot.input?.[0]?.role, "system");
assert.equal(requestSnapshot.promptCacheKey, "stable-session");
assert.equal(requestSnapshot.reasoning?.effort, "xhigh");
assert.equal(requestSnapshot.toolChoice, "auto");
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  "https://chatgpt.com/backend-api/codex/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl(customProviderModel),
  "https://models.example.com/v1/responses",
);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const cachedPrefix = [
  { role: "system", content: "stable system prompt" },
  { type: "message", role: "user", content: [{ type: "input_text", text: "cached user" }] },
];
const selectedCachedInput = selectRemoteCompactionInput({
  snapshotInput: cachedPrefix,
  snapshotSuffix: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "latest reply" }] },
  ],
  fallbackInput: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "must not replay" }] },
  ],
  model: { input: ["text"] },
});
assert.equal(selectedCachedInput.source, "wire_snapshot");
assert.deepEqual(selectedCachedInput.input.slice(0, cachedPrefix.length), cachedPrefix);
assert.match(JSON.stringify(selectedCachedInput.input), /latest reply/);
assert.doesNotMatch(JSON.stringify(selectedCachedInput.input), /must not replay/);
const selectedReconstructedInput = selectRemoteCompactionInput({
  fallbackInput: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "reconstructed" }] },
  ],
  model: { input: ["text"] },
});
assert.equal(selectedReconstructedInput.source, "reconstructed");
assert.match(JSON.stringify(selectedReconstructedInput.input), /reconstructed/);

const oldMessage = {
  type: "message",
  id: "old-message",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: "OLD_RAW_HISTORY" }], timestamp: 1 },
};
const keptMessage = {
  type: "message",
  id: "kept-message",
  parentId: "old-message",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: "KEPT_TAIL" }], timestamp: 2 },
};
const nativeCompaction = {
  type: "compaction",
  id: "native-compaction",
  parentId: "kept-message",
  timestamp: "2026-01-01T00:00:02.000Z",
  summary: "NATIVE_SUMMARY",
  firstKeptEntryId: "kept-message",
  tokensBefore: 1000,
};
const effectiveAfterNativeCompaction = convertToLlm(
  buildSessionContext([oldMessage, keptMessage, nativeCompaction]).messages,
);
const effectiveJson = JSON.stringify(effectiveAfterNativeCompaction);
assert.match(effectiveJson, /NATIVE_SUMMARY/);
assert.match(effectiveJson, /KEPT_TAIL/);
assert.doesNotMatch(effectiveJson, /OLD_RAW_HISTORY/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-client-request-id"], "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const accountPayload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
})).toString("base64url");
const codexHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  },
  apiKey: `header.${accountPayload}.signature`,
  headers: { "x-extra": "yes" },
  sessionId: "session-123",
});
assert.equal(codexHeaders.authorization, `Bearer header.${accountPayload}.signature`);
assert.equal(codexHeaders["chatgpt-account-id"], "account-123");
assert.equal(codexHeaders["x-extra"], "yes");

const codexOpaqueKeyHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  },
  apiKey: "placeholder-credential-must-stay-deleted",
  headers: {
    Authorization: null,
    "Chatgpt-Account-Id": null,
  },
  sessionId: "session-123",
});
assert.deepEqual(headerValues(Object.entries(codexOpaqueKeyHeaders), "chatgpt-account-id"), []);
assert.deepEqual(headerValues(Object.entries(codexOpaqueKeyHeaders), "authorization"), []);
assert.equal(codexOpaqueKeyHeaders.originator, "pi");

async function captureDirectRequest(params) {
  let capturedHeaders;
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"NULL_HEADER_TEST"}}',
      'data: {"type":"response.completed","response":{}}',
      "",
    ].join("\n\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    await callRemoteCompactionEndpoint({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact" }] }],
      tools: [],
      parallelToolCalls: true,
      ...params,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedHeaders && typeof capturedHeaders === "object");
  assert.ok(capturedBody && typeof capturedBody === "object");
  return { headers: Object.entries(capturedHeaders), body: capturedBody };
}

async function captureDirectRequestHeaders(params) {
  return (await captureDirectRequest(params)).headers;
}

function headerValues(entries, name) {
  return entries.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
}

const directHttpHeaderEntries = await captureDirectRequestHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "placeholder-credential-must-stay-deleted",
  headers: {
    Authorization: null,
    "x-delete-marker": null,
    "x-concrete-header": "preserved",
  },
});
assert.ok(directHttpHeaderEntries.every(([, value]) => typeof value === "string"));
assert.deepEqual(headerValues(directHttpHeaderEntries, "authorization"), []);
assert.deepEqual(headerValues(directHttpHeaderEntries, "x-delete-marker"), []);
assert.equal(directHttpHeaderEntries.some(([, value]) => value === "null" || value === ""), false);
assert.deepEqual(headerValues(directHttpHeaderEntries, "x-concrete-header"), ["preserved"]);

const codexHttpHeaderEntries = await captureDirectRequestHeaders({
  model: {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  },
  apiKey: `header.${accountPayload}.signature`,
  sessionId: "session-123",
  headers: {
    Authorization: null,
    "OpenAI-Beta": null,
    "User-Agent": null,
    "Chatgpt-Account-Id": null,
    Originator: "other",
  },
});
assert.ok(codexHttpHeaderEntries.every(([, value]) => typeof value === "string"));
assert.deepEqual(headerValues(codexHttpHeaderEntries, "authorization"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "openai-beta"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "user-agent"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "chatgpt-account-id"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "originator"), ["pi"]);
assert.equal(codexHttpHeaderEntries.some(([, value]) => value === "null" || value === ""), false);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "session_id"), ["session-123"]);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "x-client-request-id"), ["session-123"]);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "accept"), ["text/event-stream"]);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "content-type"), ["application/json"]);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "x-codex-beta-features"), ["remote_compaction_v2"]);

const codexDefaultHeaderEntries = await captureDirectRequestHeaders({
  model: {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  },
  apiKey: `header.${accountPayload}.signature`,
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.deepEqual(
  headerValues(codexDefaultHeaderEntries, "authorization"),
  [`Bearer header.${accountPayload}.signature`],
);
assert.deepEqual(headerValues(codexDefaultHeaderEntries, "originator"), ["pi"]);
assert.deepEqual(headerValues(codexDefaultHeaderEntries, "openai-beta"), ["responses=experimental"]);
assert.deepEqual(headerValues(codexDefaultHeaderEntries, "x-extra"), ["yes"]);

const codexOverrideHeaderEntries = await captureDirectRequestHeaders({
  model: {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  },
  apiKey: `header.${accountPayload}.signature`,
  sessionId: "session-123",
  headers: {
    Authorization: "Bearer provider-token",
    Originator: "codex_cli_rs",
    "OpenAI-BETA": "responses=other",
    "User-Agent": "other-agent",
  },
});
assert.deepEqual(headerValues(codexOverrideHeaderEntries, "originator"), ["pi"]);
assert.deepEqual(headerValues(codexOverrideHeaderEntries, "openai-beta"), ["responses=experimental"]);
assert.deepEqual(headerValues(codexOverrideHeaderEntries, "authorization"), ["Bearer provider-token"]);
assert.equal(headerValues(codexOverrideHeaderEntries, "user-agent").length, 1);
assert.match(headerValues(codexOverrideHeaderEntries, "user-agent")[0], /^pi-openai-server-compaction \(/);

const customProviderHeaders = buildRemoteCompactionHeaders({
  model: customProviderModel,
  apiKey: "sk-proxy-test",
  sessionId: "session-proxy",
  headers: {
    Authorization: null,
    "x-proxy-token": "proxy-token",
  },
});
assert.equal(customProviderHeaders.authorization, undefined);
assert.equal(customProviderHeaders.Authorization, undefined);
assert.equal(customProviderHeaders["x-proxy-token"], "proxy-token");
assert.equal(customProviderHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(customProviderHeaders["chatgpt-account-id"], undefined);

const capturedCompactionRequest = await captureDirectRequest({
  model: customProviderModel,
  apiKey: "sk-proxy-test",
  sessionId: "stable-session-id",
  reasoning: currentReasoning,
});
assert.deepEqual(capturedCompactionRequest.body.reasoning, {
  effort: "xhigh",
  summary: "detailed",
});
assert.equal(capturedCompactionRequest.body.prompt_cache_key, "stable-session-id");
assert.deepEqual(capturedCompactionRequest.body.input.at(-1), { type: "compaction_trigger" });

const websocketHeaders = buildCodexWebSocketHeaders("session-123");
assert.equal(websocketHeaders["x-client-request-id"], "session-123");
assert.equal(websocketHeaders.session_id, "session-123");
assert.equal(websocketHeaders["x-codex-window-id"], "session-123:0");

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    {
      reasoning: { effort: "xhigh", summary: "auto" },
      inputItems: 17,
      inputSource: "wire_snapshot",
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);
assert.deepEqual(detailsRoundTrip.request, {
  reasoning: { effort: "xhigh", summary: "auto" },
  inputItems: 17,
  inputSource: "wire_snapshot",
});

const incrementalInput = selectInputItemsForContinuation({
  context: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user" }],
      },
    ],
  },
  model: { input: ["text"] },
  session: { lastContextLength: 2 },
  currentModelKey: targetModelKey,
  remoteCompactionState: undefined,
  previousResponseId: "resp_123",
});
assert.deepEqual(incrementalInput, [
  {
    type: "message",
    role: "user",
    content: "new user",
  },
]);

console.log("smoke ok");
