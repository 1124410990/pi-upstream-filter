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
function compatibilityFailure(api, transport = "http") {
  const message = api === "anthropic-messages" ? "Invalid signature in thinking block" : rejection;
  if (transport === "http") return fail(message);
  return api === "anthropic-messages"
    ? sse([{type: "error", error: {type: "invalid_request_error", message}}])
    : sse([{type: "response.failed", response: {status: "failed", error: {code: "invalid_encrypted_content", message}}}]);
}
function transientFailure(api, transport, status) {
  const message = status === 429 ? "Your requests have exceeded token rate limit." : "internal server error";
  if (transport === "http") return fail(message, status);
  return api === "anthropic-messages"
    ? sse([{type: "error", error: {type: status === 429 ? "rate_limit_error" : "api_error", message}}])
    : sse([{type: "response.failed", response: {status: "failed", error: {code: status === 429 ? "rate_limit_exceeded" : "server_error", message}}}]);
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
  const notices = [];
  const retries = [];
  await session.bindExtensions({onError: error => errors.push(error),
    uiContext: {notify: (message, level) => notices.push({message, level})}});
  const unsubscribe = session.subscribe(event => {
    if (["auto_retry_start", "auto_retry_end"].includes(event.type)) retries.push(event);
  });
  t.after(unsubscribe);
  const run = async (text = "完成原任务") => {await session.prompt(text); await session.waitForIdle();};
  return {session, sm, seen, errors, notices, retries, run, historyId,
    logs: () => fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "pi-upstream-filter.log"), "utf8")};
}

function carriesReasoning(body) {
  return body.input?.some(item => item.type === "reasoning") ??
    body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "thinking"));
}

for (const api of ["openai-responses", "anthropic-messages"]) {
  test(`真实 ${api}：成功请求不剥离；相关 400 恢复原任务，不增加用户消息`, {timeout: 15000}, async t => {
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

for (const api of ["openai-responses", "anthropic-messages"]) {
  for (const transport of ["http", "sse"]) {
    test(`真实 ${api}/${transport}：raw400→clean400→clean成功，成功后重新raw且预算重置`, {timeout: 15000}, async t => {
      let cleaned = 0;
      let recovered = false;
      const h = await harness(t, {api, respond: (_calls, body) => {
        if (recovered) return success(api, "filter-test");
        if (carriesReasoning(body) || cleaned++ === 0) return compatibilityFailure(api, transport);
        return success(api, "filter-test");
      }});
      const original = JSON.stringify(h.sm.getEntry(h.historyId));
      await h.run();
      assert.equal(h.seen.length, 3);
      assert.deepEqual(h.seen.map(carriesReasoning), [true, false, false]);
      assert.equal(h.sm.getEntries().filter(entry => entry.type === "context_edit").length, 2);
      assert.equal(h.session.messages.filter(message => message.role === "user").length, 2);
      assert.ok(h.notices.some(notice => /恢复 2\/20/.test(notice.message)));
      assert.equal(JSON.stringify(h.sm.getEntry(h.historyId)), original);
      recovered = true;
      await h.run("成功后新任务");
      assert.equal(carriesReasoning(h.seen[3]), true);
      recovered = false;
      cleaned = 0;
      await h.run("新的兼容性失败");
      assert.deepEqual(h.seen.slice(4).map(carriesReasoning), [true, false, false]);
      assert.match(h.notices.filter(notice => /兼容性恢复 \d+\/20/.test(notice.message)).at(-2).message, /恢复 1\/20/);
      assert.deepEqual(h.errors, []);
    });

    for (const scenario of ["rate", "server", "rate-then-400"]) {
      test(`真实 ${api}/${transport}：兼容性400后${scenario}原生retry仍clean`, {timeout: 15000}, async t => {
        let cleaned = 0;
        const h = await harness(t, {api, retry: true, respond: (_calls, body) => {
          if (carriesReasoning(body)) return compatibilityFailure(api, transport);
          const attempt = cleaned++;
          if (attempt === 0) return transientFailure(api, transport, scenario === "server" ? 500 : 429);
          if (scenario === "rate-then-400" && attempt === 1) return compatibilityFailure(api, transport);
          return success(api, "filter-test");
        }});
        const original = JSON.stringify(h.sm.getEntry(h.historyId));
        await h.run();
        assert.equal(h.seen.length, scenario === "rate-then-400" ? 4 : 3);
        assert.deepEqual(h.seen.map(carriesReasoning), [true, ...Array(h.seen.length - 1).fill(false)]);
        assert.equal(h.retries.filter(event => event.type === "auto_retry_start").length, 1, "保留宿主原生retry，不额外增加预算");
        assert.equal(h.session.messages.filter(message => message.role === "user").length, 2, "恢复不能发送用户继续");
        assert.equal(h.sm.getEntries().filter(entry => entry.type === "context_edit").length, h.seen.length - 1);
        assert.equal(JSON.stringify(h.sm.getEntry(h.historyId)), original);
        const scheduled = h.notices.filter(notice => /兼容性恢复 \d+\/20/.test(notice.message));
        assert.equal(scheduled.length, scenario === "rate-then-400" ? 2 : 1, "原生retry继承不消耗逻辑恢复预算");
        assert.doesNotMatch(h.notices.map(notice => notice.message).join("\n"), /不再为本次失败/);
        assert.deepEqual(h.errors, []);
      });
    }
  }
}

test("真实 Responses：不同兼容性错误连续更新规则，input[N]定位实际发送项而不误清工具配对", {timeout: 15000}, async t => {
  let cleaned = 0;
  const h = await harness(t, {toolHistory: true, respond: (_calls, body) => {
    if (carriesReasoning(body)) return fail("invalid_encrypted_content");
    const attempt = cleaned++;
    if (attempt === 0) {
      const index = body.input.findIndex(item => item.id === "msg_old");
      assert.ok(index >= 0);
      return fail(`Invalid 'input[${index}].id': Expected an ID that begins with 'msg_'`);
    }
    assert.equal(body.input.some(item => item.id === "msg_old"), false);
    return success("openai-responses", "filter-test");
  }});
  await h.run();
  assert.equal(h.seen.length, 3);
  assert.deepEqual(h.seen.map(carriesReasoning), [true, false, false]);
  assert.ok(h.seen[1].input.some(item => item.id === "msg_old"));
  const calls = h.seen.slice(1).map(body => body.input.find(item => item.type === "function_call"));
  assert.ok(calls[0]?.id);
  assert.equal(calls[0].id, calls[1].id, "点名普通消息的id不能误清后面的工具id");
  const output = h.seen[2].input.find(item => item.type === "function_call_output");
  assert.equal(calls[1].call_id, output.call_id);
  assert.match(output.output, /business-result/);
  assert.deepEqual(h.errors, []);
});

test("真实 Responses：ID→密文→相同索引ID错误仍定位移动后的工具项", {timeout: 15000}, async t => {
  let index;
  const h = await harness(t, {toolHistory: true, respond: (calls, body) => {
    if (calls === 1) {
      index = body.input.findIndex(item => item.id === "msg_old");
      assert.ok(index >= 0);
      return fail(`Invalid 'input[${index}].id': Expected an ID that begins with 'msg_'`);
    }
    assert.equal(body.input.some(item => item.id === "msg_old"), false);
    if (calls === 2) {
      assert.equal(carriesReasoning(body), true);
      return fail("invalid_encrypted_content");
    }
    assert.equal(carriesReasoning(body), false);
    assert.equal(body.input[index].type, "function_call", "删除reasoning后同索引应已指向工具项");
    if (calls === 3) {
      assert.ok(body.input[index].id);
      return fail(`Invalid 'input[${index}].id': Expected an ID that begins with 'fc_'`);
    }
    assert.equal(body.input[index].id, undefined);
    return success("openai-responses", "filter-test");
  }});
  const original = JSON.stringify(h.sm.getEntry(h.historyId));
  await h.run();
  assert.equal(h.seen.length, 4);
  assert.deepEqual(h.seen.map(carriesReasoning), [true, true, false, false]);
  const body = h.seen[3];
  const call = body.input.find(item => item.type === "function_call");
  const output = body.input.find(item => item.type === "function_call_output");
  const originalCall = h.seen[0].input.find(item => item.type === "function_call");
  const originalOutput = h.seen[0].input.find(item => item.type === "function_call_output");
  assert.equal(call.call_id, originalCall.call_id);
  assert.equal(output.call_id, originalOutput.call_id);
  assert.equal(output.id, originalOutput.id);
  assert.match(call.arguments, /business-path/);
  assert.match(output.output, /business-result/);
  assert.equal(JSON.stringify(h.sm.getEntry(h.historyId)), original);
  assert.deepEqual(h.errors, []);
});

test("真实宿主：原请求和兼容性清理后混合余额终态HTTP/SSE错误必须停止", {timeout: 15000}, async t => {
  for (const api of ["openai-responses", "anthropic-messages"]) {
    for (const transport of ["http", "sse"]) {
      for (const afterClean of [false, true]) {
        await t.test(`${api}/${transport}/${afterClean ? "clean" : "raw"}`, async t => {
          const message = `${api === "anthropic-messages" ? "Invalid signature in thinking block" : rejection}; usage_limit_exceeded: out of budget; FreeUsageLimitError`;
          const h = await harness(t, {api, respond: calls => {
            if (afterClean && calls === 1) return compatibilityFailure(api, transport);
            if (transport === "http") return fail(message);
            return api === "anthropic-messages"
              ? sse([{type: "error", error: {type: "invalid_request_error", message}}])
              : sse([{type: "response.failed", response: {status: "failed", error: {code: "invalid_encrypted_content", message}}}]);
          }});
          await h.run();
          assert.equal(h.seen.length, afterClean ? 2 : 1, "终态限制不能被兼容性措辞覆盖而追加清理");
          assert.deepEqual(h.seen.map(carriesReasoning), afterClean ? [true, false] : [true]);
          assert.equal(h.session.messages.at(-1).stopReason, "error");
          assert.equal(h.notices.filter(notice => /兼容性恢复 \d+\/20/.test(notice.message)).length, afterClean ? 1 : 0);
          assert.deepEqual(h.errors, []);
        });
      }
    }
  }
});

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

for (const api of ["openai-responses", "anthropic-messages"]) {
  for (const transport of ["http", "sse"]) {
    test(`真实 ${api}/${transport}：持续兼容性失败20次恢复上限，不发第21次`, {timeout: 15000}, async t => {
      const h = await harness(t, {api, respond: () => compatibilityFailure(api, transport)});
      await h.run();
      assert.equal(h.seen.length, 21, "原请求加20次恢复，不发第22个模型请求");
      assert.deepEqual(h.seen.map(carriesReasoning), [true, ...Array(20).fill(false)]);
      assert.equal(h.sm.getEntries().filter(entry => entry.type === "context_edit").length, 20);
      assert.equal(h.notices.filter(notice => /兼容性恢复 \d+\/20/.test(notice.message)).length, 20);
      assert.match(h.notices.at(-1).message, /20 次已耗尽.*第 21 次/);
      assert.equal(h.session.messages.filter(message => message.role === "user").length, 2);
      assert.deepEqual(h.errors, []);
    });
  }
}

test("真实宿主：耗尽旧预算后排队user/custom新任务仍raw→clean恢复成功", {timeout: 15000}, async t => {
  for (const role of ["user", "custom"]) {
    await t.test(role, async t => {
      const text = role === "custom" ? "排队自定义新任务" : "排队真人新任务";
      const h = await harness(t, {respond: async (calls, body, session) => {
        if (calls === 21) {
          if (role === "custom") {
            await session.sendCustomMessage({customType: "queued-new-task", content: text, display: true},
              {triggerTurn: true, deliverAs: "followUp"});
          } else {
            await session.followUp(text);
          }
        }
        return JSON.stringify(body).includes(text) && !carriesReasoning(body)
          ? success("openai-responses", "filter-test") : fail();
      }});
      const original = JSON.stringify(h.sm.getEntry(h.historyId));
      await h.run();
      assert.equal(h.seen.length, 23, "旧任务21次请求，加新任务raw与clean各一次");
      assert.deepEqual(h.seen.slice(-3).map(carriesReasoning), [false, true, false]);
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      assert.match(h.notices.filter(notice => /兼容性恢复 \d+\/20/.test(notice.message)).at(-1).message, /恢复 1\/20/);
      assert.equal(h.session.messages.filter(message => message.role === "user").length, role === "user" ? 3 : 2);
      assert.equal(JSON.stringify(h.sm.getEntry(h.historyId)), original);
      assert.deepEqual(h.errors, []);
    });
  }
});

test("无可清理内容、非白名单、关闭与无关400不额外重试", {timeout: 15000}, async t => {
  for (const scenario of ["empty", "other-host", "disabled", "unrelated"]) {
    await t.test(scenario, async t => {
      const h = await harness(t, {history: scenario !== "empty",
        baseUrl: scenario === "other-host" ? "https://example.test/v1" : undefined,
        config: scenario === "disabled" ? {responses: false} : undefined,
        respond: () => fail(scenario === "unrelated" ? "Invalid request: malformed JSON" : rejection)});
      await h.run();
      assert.equal(h.seen.length, 1);
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
