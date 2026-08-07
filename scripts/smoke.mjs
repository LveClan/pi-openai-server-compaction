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

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  generatePortableSummary,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
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
const mockSummaryStream = (model, _context, options) => {
  forwardedStreamHeaders = options?.headers;
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
} finally {
  unregisterApiProviders(streamProviderSource);
}

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
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
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

async function captureDirectRequestHeaders(params) {
  let captured;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = init?.headers;
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
  assert.ok(captured && typeof captured === "object");
  return Object.entries(captured);
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
    Originator: "other",
  },
});
assert.ok(codexHttpHeaderEntries.every(([, value]) => typeof value === "string"));
assert.deepEqual(headerValues(codexHttpHeaderEntries, "authorization"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "openai-beta"), []);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "originator"), ["other"]);
assert.equal(codexHttpHeaderEntries.some(([, value]) => value === "null" || value === ""), false);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "chatgpt-account-id"), ["account-123"]);
assert.deepEqual(headerValues(codexHttpHeaderEntries, "session_id"), ["session-123"]);

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
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

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
