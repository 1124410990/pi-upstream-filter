"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const piDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(piDir, "请设置 PI_TEST_PACKAGE_DIR 后运行 npm run test:host");
const importHost = relative => import(pathToFileURL(path.join(piDir, relative)).href);
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const rejection = "The requested item was created under a different Azure OpenAI resource.";

function sse(events) {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {status: 200, headers: {"content-type": "text/event-stream"}});
}
function success(api, model) {
  if (api === "anthropic-messages") return sse([
    {type: "message_start", message: {id: "msg_new", model, role: "assistant", content: [], usage: {input_tokens: 1, output_tokens: 0}}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: "完成"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {output_tokens: 1}},
    {type: "message_stop"},
  ]);
  const item = {type: "message", id: "msg_new", role: "assistant", status: "completed",
    content: [{type: "output_text", text: "完成", annotations: []}]};
  return sse([
    {type: "response.output_item.done", output_index: 0, item},
    {type: "response.completed", response: {id: "resp_new", status: "completed", output: [item],
      usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: {}, output_tokens_details: {}}}},
  ]);
}
function fail(message = rejection, status = 400) {
  return new Response(JSON.stringify({error: {type: "invalid_request_error", message}}),
    {status, headers: {"content-type": "application/json"}});
}

async function harness(t, {api = "openai-responses", baseUrl = "https://agentrouter.org/v1", respond,
    history = true, toolHistory = false, retry = false, debug = false, config, extraExtension} = {}) {
  const {createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime} =
    await importHost("dist/index.js");
  const {InMemoryCredentialStore} = await importHost("node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-recovery-host-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedDebug = process.env.PI_FILTER_DEBUG;
  const savedFetch = global.fetch;
  let session;
  t.after(() => {
    session?.dispose();
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedDebug === undefined) delete process.env.PI_FILTER_DEBUG;
    else process.env.PI_FILTER_DEBUG = savedDebug;
    global.fetch = savedFetch;
    assert.match(path.basename(root), /^pi-filter-recovery-host-/);
    fs.rmSync(root, {recursive: true, force: true});
  });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
  process.env.PI_FILTER_DEBUG = debug ? "1" : "0";
  if (config) fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "pi-upstream-filter.json"), JSON.stringify(config));
  const seen = [];
  // 唯一网络入口被替换，仍运行真实 provider、SDK 序列化及全部 Pi 钩子。
  global.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).hostname, new URL(baseUrl).hostname, "不得请求其他端点");
    const body = JSON.parse(init.body);
    seen.push(body);
    assert.ok(seen.length <= 30, "恢复循环不得无限请求");
    return respond ? respond(seen.length, body, session) : success(api, "filter-test");
  };
  const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
  runtime.registerProvider("filter-test", {
    baseUrl, apiKey: "offline-placeholder", api,
    models: [{id: "filter-test", name: "filter-test", reasoning: true, input: ["text"],
      cost: usage.cost, contextWindow: 128000, maxTokens: 8192}],
  });
  const model = runtime.getModel("filter-test", "filter-test");
  assert.ok(model);
  const sm = SessionManager.inMemory(root);
  let historyId;
  if (history) {
    sm.appendMessage({role: "user", content: [{type: "text", text: "原始上下文"}], timestamp: Date.now()});
    historyId = sm.appendMessage({role: "assistant", api, provider: model.provider, model: model.id,
      content: [
        {type: "thinking", thinking: "old", thinkingSignature: api === "anthropic-messages" ? "opaque-signature"
          : JSON.stringify({type: "reasoning", id: "rs_old", encrypted_content: "opaque-cipher", summary: []})},
        {type: "text", text: "历史回答", ...(api === "openai-responses" ? {textSignature: "msg_old"} : {})},
        ...(toolHistory ? [{type: "toolCall", id: api === "openai-responses" ? "call_keep|fc_old" : "tool_keep",
          name: "read", arguments: {path: "business-path"}}] : []),
      ], usage, stopReason: toolHistory ? "toolUse" : "stop", timestamp: Date.now()});
    if (toolHistory) sm.appendMessage({role: "toolResult", toolCallId: api === "openai-responses" ? "call_keep|fc_old" : "tool_keep",
      toolName: "read", content: [{type: "text", text: "business-result"}], isError: false, timestamp: Date.now()});
  }
  const paths = [path.resolve(__dirname, "../index.ts")];
  if (extraExtension) {
    const filename = path.join(root, "observer.ts");
    fs.writeFileSync(filename, extraExtension);
    paths.push(filename);
  }
  const settings = SettingsManager.inMemory({compaction: {enabled: false}, cacheWarming: "off",
    retry: {enabled: retry, baseDelayMs: 0, provider: {maxRetries: 0}}});
  const loader = new DefaultResourceLoader({cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, additionalExtensionPaths: paths});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({session} = await createAgentSession({cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    modelRuntime: runtime, model, thinkingLevel: "high", settingsManager: settings, resourceLoader: loader,
    sessionManager: sm, tools: []}));
  const errors = [];
  await session.bindExtensions({onError: error => errors.push(error)});
  const run = async (text = "完成原任务") => {await session.prompt(text); await session.waitForIdle();};
  return {session, sm, seen, errors, run, historyId,
    logs: () => fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "pi-upstream-filter.log"), "utf8")};
}

function carriesReasoning(body) {
  return body.input?.some(item => item.type === "reasoning") ??
    body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "thinking"));
}

for (const api of ["openai-responses", "anthropic-messages"]) {
  test(`真实 ${api}：成功请求不剥离；相关 400 恢复原任务一次，不增加用户消息`, {timeout: 15000}, async t => {
    const h = await harness(t, {api, debug: true, respond: calls => calls === 2
      ? fail(api === "anthropic-messages" ? "Invalid `signature` in `thinking` block" : rejection)
      : success(api, "filter-test")});
    const original = JSON.stringify(h.sm.getEntry(h.historyId));
    await h.run("第一次正常请求");
    assert.equal(h.seen.length, 1);
    assert.equal(carriesReasoning(h.seen[0]), true);
    await h.run("第二次需恢复的请求");
    assert.equal(h.seen.length, 3, JSON.stringify(h.sm.getEntries()));
    assert.equal(carriesReasoning(h.seen[1]), true);
    assert.equal(carriesReasoning(h.seen[2]), false);
    if (api === "openai-responses") {
      assert.deepEqual(h.seen[2].include, h.seen[1].include);
      assert.ok(h.seen[2].include.includes("reasoning.encrypted_content"));
      assert.deepEqual(h.seen[2].reasoning, h.seen[1].reasoning);
      assert.equal(h.seen[2].store, h.seen[1].store);
      assert.ok(h.seen[1].input.some(item => item.id === "msg_old"));
      assert.ok(h.seen[2].input.every(item => item.id === undefined));
    } else {
      assert.deepEqual(h.seen[2].thinking, h.seen[1].thinking);
    }
    assert.equal(h.session.messages.filter(message => message.role === "user").length, 3);
    assert.equal(h.sm.getEntries().filter(entry => entry.type === "context_edit").length, 1);
    assert.equal(JSON.stringify(h.sm.getEntry(h.historyId)), original, "原始历史推理必须保留");
    await h.run("恢复后再次正常请求");
    assert.equal(h.seen.length, 4);
    assert.equal(carriesReasoning(h.seen[3]), true, "不能永久启用剥离");
    assert.deepEqual(h.errors, []);
    const logs = h.logs();
    assert.match(logs, /recovery-success/);
    assert.doesNotMatch(logs, /opaque-cipher|opaque-signature|原始上下文|历史回答/);
  });
}

test("真实 provider 清理不能破坏工具调用配对和业务结果", {timeout: 15000}, async t => {
  for (const api of ["openai-responses", "anthropic-messages"]) {
    await t.test(api, async t => {
      const h = await harness(t, {api, toolHistory: true, respond: calls => calls === 1
        ? fail(api === "anthropic-messages" ? "Invalid signature in thinking block" : rejection)
        : success(api, "filter-test")});
      await h.run();
      assert.equal(h.seen.length, 2);
      const body = h.seen[1];
      if (api === "openai-responses") {
        const call = body.input.find(item => item.type === "function_call");
        const output = body.input.find(item => item.type === "function_call_output");
        assert.ok(call && output);
        assert.equal(call.call_id, output.call_id);
        assert.match(call.arguments, /business-path/);
        assert.match(output.output, /business-result/);
      } else {
        const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const call = blocks.find(block => block.type === "tool_use");
        const output = blocks.find(block => block.type === "tool_result");
        assert.ok(call && output);
        assert.equal(call.id, output.tool_use_id);
        assert.equal(call.input.path, "business-path");
        assert.match(JSON.stringify(output.content), /business-result/);
      }
      assert.deepEqual(h.errors, []);
    });
  }
});

test("真实 Responses：HTTP 200 SSE 密文错误也能一次恢复，保留有效 ID", {timeout: 15000}, async t => {
  const h = await harness(t, {respond: calls => calls === 1 ? sse([
    {type: "response.failed", response: {status: "failed", error: {code: "invalid_encrypted_content", message: "bad ciphertext"}}},
  ]) : success("openai-responses", "filter-test")});
  await h.run();
  assert.equal(h.seen.length, 2);
  assert.equal(carriesReasoning(h.seen[1]), false);
  assert.ok(h.seen[1].input.some(item => item.id === "msg_old"));
  assert.deepEqual(h.errors, []);
});

test("持续兼容性失败只能清理一次；无可清理内容与非白名单不额外重试", {timeout: 15000}, async t => {
  for (const scenario of ["persistent", "empty", "other-host", "disabled", "unrelated"]) {
    await t.test(scenario, async t => {
      const h = await harness(t, {history: scenario !== "empty",
        baseUrl: scenario === "other-host" ? "https://example.test/v1" : undefined,
        config: scenario === "disabled" ? {responses: false} : undefined,
        respond: () => fail(scenario === "unrelated" ? "Invalid request: malformed JSON" : rejection)});
      await h.run();
      assert.equal(h.seen.length, scenario === "persistent" ? 2 : 1);
      if (scenario === "persistent") assert.equal(carriesReasoning(h.seen[1]), false);
      assert.deepEqual(h.errors, []);
    });
  }
});

test("真实宿主无关限流/服务错误原生重试仍保留密文", {timeout: 15000}, async t => {
  for (const scenario of ["server", "rate", "formatted-500"]) {
    await t.test(scenario, async t => {
      const h = await harness(t, {retry: true, respond: calls => calls === 1
        ? fail(scenario === "server" ? "internal server error"
          : scenario === "rate" ? "too many requests" : "invalid_encrypted_content", scenario === "rate" ? 429 : 500)
        : success("openai-responses", "filter-test")});
      await h.run();
      assert.equal(h.seen.length, 2);
      assert.equal(carriesReasoning(h.seen[1]), true);
      assert.equal(h.sm.getEntries().filter(entry => entry.type === "context_edit").length, 1, "仅宿主原生失败排除");
      assert.deepEqual(h.errors, []);
    });
  }
});

test("真实宿主：结束边界取消不复活；人工排队和其他扩展续跑优先", {timeout: 15000}, async t => {
  for (const scenario of ["abort", "queued", "continuation"]) {
    await t.test(scenario, async t => {
      const extraExtension = scenario === "abort"
        ? 'export default pi => { pi.on("agent_before_settle", (_event, ctx) => ctx.abort()); }'
        : scenario === "continuation"
          ? 'export default pi => { let once = false; pi.on("agent_before_settle", event => { if (once) return; once = true; return {entries: [...event.entries, {type:"custom_message", customType:"other", content:"另一项工作", display:false}], continue:true}; }); }'
          : undefined;
      const h = await harness(t, {extraExtension, respond: (calls, _body, session) => {
        if (calls === 1) {
          if (scenario === "queued") session.followUp("人工新任务优先");
          return fail();
        }
        return success("openai-responses", "filter-test");
      }});
      await h.run();
      assert.equal(h.seen.length, scenario === "abort" ? 1 : 2);
      if (scenario !== "abort") assert.equal(carriesReasoning(h.seen[1]), true, "人工或其他扩展的新工作不得继承清理");
      assert.deepEqual(h.errors, []);
    });
  }
});
