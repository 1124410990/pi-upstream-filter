"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const piDir = process.env.PI_TEST_PACKAGE_DIR;
const {createJiti} = piDir ? require(require.resolve("jiti", {paths: [piDir]})) : require("jiti");

async function harness(t, {config, debug = false, allowAutoContinue = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-recovery-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedDebug = process.env.PI_FILTER_DEBUG;
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedDebug === undefined) delete process.env.PI_FILTER_DEBUG;
    else process.env.PI_FILTER_DEBUG = savedDebug;
    assert.match(path.basename(root), /^pi-filter-recovery-/);
    fs.rmSync(root, {recursive: true, force: true});
  });
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_FILTER_DEBUG = debug ? "1" : "0";
  if (config) fs.writeFileSync(path.join(root, "pi-upstream-filter.json"), JSON.stringify(config));
  const factory = await createJiti(__filename, {moduleCache: false, fsCache: false})
    .import(path.resolve(__dirname, "../index.ts"), {default: true});
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const sent = [];
  const entries = [
    {sourceEntry: {id: "user"}, messages: [{role: "user"}]},
    {sourceEntry: {id: "failure"}, messages: [{role: "assistant"}]},
  ];
  const ctx = {
    model: {baseUrl: "https://agentrouter.org/v1", provider: "test", id: "test", api: "openai-responses"},
    ui: {notify: (message, level) => notices.push({message, level})},
    sessionManager: {buildSessionProjection: () => ({entries: entries.filter(entry => entry.sourceEntry.id !== "failure")})},
    hasPendingMessages: () => false, isIdle: () => true,
  };
  await factory({
    on: (name, handler) => {handlers.set(name, handler); return () => {};},
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (content, options) => {
      assert.ok(allowAutoContinue, "兼容性恢复不得追加用户继续消息");
      sent.push({content, options});
    },
  });
  const emit = (name, event = {}, extra = {}) => handlers.get(name)?.(event, {...ctx, ...extra});
  const payload = {store: false, include: ["reasoning.encrypted_content"], reasoning: {effort: "high"}, input: [
    {type: "reasoning", id: "rs_old", encrypted_content: "sensitive-cipher"},
    {type: "message", id: "msg_old", role: "assistant", content: [{type: "output_text", text: "private-text"}]},
  ]};
  const request = (body = payload, extra = {}) => emit("before_provider_request", {payload: body}, extra);
  const failed = (message = "created under a different Azure OpenAI resource") => emit("turn_end", {
    messageEntryId: "failure", message: {role: "assistant", stopReason: "error", errorMessage: message},
  });
  const boundary = (overrides = {}, extra = {}) => emit("agent_before_settle", {
    outcome: "error", continue: false, entries: [], context: {pendingMessages: [], contextEntries: entries}, ...overrides,
  }, extra);
  const status = async () => {await commands.get("filter").handler("", ctx); return notices.at(-1).message;};
  return {emit, request, failed, boundary, status, payload, notices, sent, ctx, commands, root};
}

test("正常请求不改写；raw400→clean400→clean成功可再次恢复，成功后新请求仍保留历史", async t => {
  const h = await harness(t, {debug: true});
  const original = JSON.stringify(h.payload);
  assert.equal(await h.request(), undefined);
  await h.failed();
  const proposal = await h.boundary({entries: [{type: "custom", customType: "existing"}]});
  assert.deepEqual(proposal, {entries: [
    {type: "custom", customType: "existing"}, {type: "context_edit", targetId: "failure", replacement: null},
  ], continue: true});
  assert.equal(await h.boundary(), undefined, "重复边界不得重复安排或消费授权");
  const result = await h.request();
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0].id, undefined);
  assert.deepEqual(result.include, h.payload.include);
  await h.failed();
  assert.equal((await h.boundary()).continue, true, "清理后再次兼容性400仍可恢复");
  assert.deepEqual(await h.request(), result);
  await h.emit("turn_end", {message: {role: "assistant", stopReason: "stop"}});
  assert.equal(await h.request(), undefined, "成功后不再清理下一请求");
  await h.failed();
  assert.equal((await h.boundary()).continue, true, "成功后恢复预算从头计数");
  assert.match(h.notices.at(-1).message, /恢复 1\/20/);
  assert.equal(JSON.stringify(h.payload), original);
  const status = await h.status();
  assert.match(status, /原样放行：2/);
  assert.match(status, /逻辑恢复：3/);
  assert.match(status, /清理请求（含原生重试继承）：2/);
  assert.match(status, /清理响应失败：1/);
  const logs = fs.readFileSync(path.join(h.root, "pi-upstream-filter.log"), "utf8");
  assert.doesNotMatch(logs, /sensitive-cipher|private-text/);
});

test("已授权清理贯穿429/5xx原生重试，随后兼容性400继续恢复；终态后原样发送", async t => {
  for (const statusCode of [429, 500]) {
    await t.test(String(statusCode), async t => {
      const h = await harness(t);
      await h.request(); await h.failed(); await h.boundary();
      const first = await h.request();
      await h.emit("after_provider_response", {status: statusCode});
      await h.failed(statusCode === 429 ? "too many requests" : "internal server error");
      await h.emit("turn_start");
      const retry = await h.request();
      assert.deepEqual(retry, first, "会话原生retry重新生成payload也必须继续清理");
      await h.failed();
      assert.equal((await h.boundary()).continue, true);
      assert.deepEqual(await h.request(), first);
      await h.emit("turn_end", {message: {role: "assistant", stopReason: "stop"}});
      assert.equal(await h.request(), undefined);
      assert.doesNotMatch(h.notices.map(notice => notice.message).join("\n"), /不再为本次失败/);
      assert.match(await h.status(), /逻辑恢复：2/);
      assert.match(await h.status(), /清理请求（含原生重试继承）：3/);
    });
  }
  for (const message of ["401 authentication failed", "403 authorization failed", "insufficient_quota", "available balance insufficient"]) {
    const h = await harness(t);
    await h.request(); await h.failed(); await h.boundary(); await h.request();
    await h.failed(message);
    assert.equal(await h.request(), undefined, "终态鉴权或余额错误立即撤销继承");
    assert.equal(await h.boundary(), undefined);
  }
});

test("持续兼容性失败最多20次逻辑恢复，重复边界/settled不能重置预算；新任务与取消重置", async t => {
  const h = await harness(t);
  await h.request();
  for (let attempt = 1; attempt <= 20; attempt++) {
    await h.failed();
    assert.equal((await h.boundary()).continue, true);
    assert.match(h.notices.at(-1).message, new RegExp(`恢复 ${attempt}/20`));
    assert.equal(await h.boundary(), undefined);
    assert.ok(await h.request());
  }
  await h.failed();
  assert.equal(await h.boundary(), undefined);
  assert.match(h.notices.at(-1).message, /20 次已耗尽.*第 21 次/);
  assert.match(await h.status(), /逻辑恢复：20/);
  await h.emit("agent_settled", {aborted: false});
  await h.emit("agent_settled", {aborted: false});
  await h.emit("session_compact");
  await h.commands.get("filter").handler("responses off", h.ctx);
  await h.commands.get("filter").handler("responses on", h.ctx);
  await h.request(); await h.failed();
  assert.equal(await h.boundary(), undefined, "重复settled、压缩及开关切换不能复活预算");
  await h.emit("input", {source: "interactive", text: "新任务"});
  await h.emit("before_agent_start", {messageType: "user"});
  await h.request(); await h.failed();
  assert.equal((await h.boundary()).continue, true);
  assert.match(h.notices.at(-1).message, /恢复 1\/20/);
  await h.emit("agent_settled", {aborted: true});
  await h.request(); await h.failed();
  assert.equal((await h.boundary()).continue, true);
  assert.match(h.notices.at(-1).message, /恢复 1\/20/);
});

test("排队custom实际message_start开启新任务，耗尽旧预算不阻断新恢复且撤销旧授权", async t => {
  const h = await harness(t);
  await h.request();
  for (let attempt = 1; attempt <= 20; attempt++) {
    await h.failed();
    assert.equal((await h.boundary()).continue, true);
    assert.ok(await h.request());
  }
  await h.failed();
  assert.equal(await h.boundary(), undefined);
  assert.match(await h.status(), /当前任务预算：20\/20/);
  const custom = {message: {role: "custom", customType: "new-task", content: "排队的新工作"}};
  await h.emit("message_start", custom);
  assert.equal(await h.request(), undefined, "新任务首请求不得继承旧清理");
  await h.failed();
  assert.equal((await h.boundary()).continue, true);
  assert.match(h.notices.at(-1).message, /恢复 1\/20/);
  await h.emit("message_start", custom);
  assert.equal(await h.request(), undefined, "另一custom开始必须撤销刚安排的清理");
  await h.failed();
  assert.equal((await h.boundary()).continue, true);
  assert.match(h.notices.at(-1).message, /恢复 1\/20/);
});

test("限流自动继续不是真正新任务，不清零兼容性恢复预算", async t => {
  const h = await harness(t, {allowAutoContinue: true});
  await h.request(); await h.failed(); await h.boundary(); await h.request();
  await h.emit("after_provider_response", {status: 429});
  await h.failed("token rate limit");
  assert.equal(await h.boundary(), undefined, "原生重试终态后使用既有自动继续机制");
  await h.emit("agent_settled", {aborted: false});
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], {content: "继续", options: {deliverAs: "followUp"}});
  await h.emit("input", {source: "extension", text: "继续"});
  await h.emit("before_agent_start", {messageType: "user"});
  await h.emit("message_start", {message: {role: "user", content: "继续"}});
  assert.equal(await h.request(), undefined, "新一轮自动继续不是原生retry，原样发送");
  await h.failed();
  assert.equal((await h.boundary()).continue, true);
  assert.match(h.notices.at(-1).message, /恢复 2\/20/);
});

test("同一input[1].id规则在reasoning删除后指向新项，有增量就必须再次追加", async t => {
  const h = await harness(t);
  const payload = {...h.payload, input: [
    h.payload.input[0], {...h.payload.input[1], id: "msg_keep"},
    {type: "function_call", id: "fc_keep", call_id: "business", name: "read", arguments: "{}"},
    {type: "function_call_output", id: "out_keep", call_id: "business", output: "result"},
  ]};
  const original = JSON.stringify(payload);
  await h.request(payload);
  await h.failed("Invalid 'input[1].id': Expected an ID that begins with 'msg_'");
  assert.equal((await h.boundary()).continue, true);
  const first = await h.request(payload);
  assert.deepEqual(first.input.map(item => item.id), ["rs_old", undefined, "fc_keep", "out_keep"]);
  await h.failed("invalid_encrypted_content");
  assert.equal((await h.boundary()).continue, true);
  const second = await h.request(payload);
  assert.deepEqual(second.input.map(item => item.id), [undefined, "fc_keep", "out_keep"]);
  await h.failed("Invalid 'input[1].id': Expected an ID that begins with 'fc_'");
  assert.equal((await h.boundary()).continue, true);
  const third = await h.request(payload);
  assert.deepEqual(third.input.map(item => item.id), [undefined, undefined, "out_keep"]);
  assert.equal(third.input[1].call_id, "business");
  assert.equal(third.input[2].call_id, "business");
  assert.equal(third.input[2].output, "result");
  assert.equal(JSON.stringify(payload), original);
});

test("兼容性措辞混合终态限制时优先停止，原请求和已清理请求都不能再恢复", async t => {
  for (const terminal of ["usage_limit_exceeded: out of budget", "out of budget", "FreeUsageLimitError", "GoUsageLimitError", "available balance insufficient", "401 authentication failed"]) {
    for (const afterClean of [false, true]) {
      const h = await harness(t);
      await h.request();
      if (afterClean) { await h.failed(); await h.boundary(); await h.request(); }
      await h.emit("after_provider_response", {status: 400});
      await h.failed(`created under a different Azure OpenAI resource; invalid_encrypted_content; ${terminal}`);
      assert.equal(await h.request(), undefined, "终态必须立即撤销原生重试可继承的清理授权");
      assert.equal(await h.boundary(), undefined, terminal);
      assert.match(await h.status(), new RegExp(`逻辑恢复：${afterClean ? 1 : 0}`));
    }
  }
});

test("Anthropic不同错误预检同一纯thinking消息，warning每次评估只计一次且无增量仍跳过", async t => {
  const h = await harness(t);
  const payload = {system: "", thinking: {type: "enabled", budget_tokens: 1024},
    tools: [{name: "read", input_schema: {type: "object"}}], messages: [
    {role: "assistant", content: [{type: "thinking", thinking: "pure", signature: "keep"}]},
    {role: "assistant", content: [{type: "thinking", thinking: "mixed", signature: "old"}, {type: "text", text: "keep-text"}]},
  ]};
  const original = JSON.stringify(payload);
  await h.request(payload); await h.failed("Invalid signature in thinking block");
  assert.equal((await h.boundary()).continue, true);
  assert.match(await h.status(), /警告：1/);
  const cleaned = await h.request(payload);
  assert.deepEqual(cleaned.messages[0], payload.messages[0]);
  assert.deepEqual(cleaned.messages[1].content, [{type: "text", text: "keep-text"}]);
  assert.deepEqual(cleaned.thinking, payload.thinking);
  assert.deepEqual(cleaned.tools, payload.tools);
  await h.failed("must start with a thinking block");
  assert.equal(await h.boundary(), undefined, "新的分类没有增量可清理内容");
  assert.match(await h.status(), /警告：2/);
  assert.match(await h.status(), /逻辑恢复：1/);
  assert.equal(JSON.stringify(payload), original);
});

test("新错误以实际清理payload索引更新策略，旧密文和ID不得复活或误清工具项", async t => {
  const h = await harness(t);
  const payload = {...h.payload, input: [
    h.payload.input[0], h.payload.input[1],
    {type: "function_call", id: "fc_keep", call_id: "business", name: "read", arguments: "{}"},
    {type: "function_call_output", id: "out_keep", call_id: "business", output: "result"},
  ]};
  await h.request(payload); await h.failed("invalid_encrypted_content"); await h.boundary();
  const encryptedClean = await h.request(payload);
  assert.equal(encryptedClean.input[0].id, "msg_old");
  await h.failed("Invalid 'input[0].id': Expected an ID that begins with 'msg_'");
  assert.equal((await h.boundary()).continue, true);
  const idClean = await h.request(payload);
  assert.deepEqual(idClean.input.map(item => item.id), [undefined, "fc_keep", "out_keep"]);
  assert.equal(idClean.input.some(item => item.type === "reasoning"), false);
  await h.failed("Invalid 'input[1].id': Expected an ID that begins with 'fc_'");
  assert.equal((await h.boundary()).continue, true);
  const toolClean = await h.request(payload);
  assert.deepEqual(toolClean.input.map(item => item.id), [undefined, undefined, "out_keep"]);
  assert.equal(toolClean.input[1].call_id, toolClean.input[2].call_id);
  await h.failed("Invalid 'input[9].id': Expected an ID that begins with 'msg_'");
  assert.equal(await h.boundary(), undefined, "新错误没有可清理的点名项时不得盲目重发");
  assert.equal(await h.request(payload), undefined);
});

test("输入、模型/会话切换、压缩、结束与取消撤销已安排的清理，不泄漏到下个请求", async t => {
  for (const event of ["input", "before_agent_start", "model_select", "session_tree", "session_compact", "session_shutdown", "session_start", "agent_settled"]) {
    await t.test(event, async t => {
      const h = await harness(t);
      await h.request(); await h.failed(); await h.boundary();
      await h.emit(event, {source: "interactive", text: "新任务", messageType: "user", aborted: false});
      assert.equal(await h.request(), undefined);
    });
  }
  const h = await harness(t);
  await h.request(); await h.failed(); await h.boundary();
  assert.equal(await h.request(h.payload, {signal: AbortSignal.abort()}), undefined);
  assert.equal(await h.request(), undefined, "取消后不得延迟清理");
});

test("排队、其他续跑与缺失原任务上下文时不安排恢复", async t => {
  for (const scenario of ["queue", "continue", "abort", "no-context"]) {
    await t.test(scenario, async t => {
      const h = await harness(t);
      await h.request(); await h.failed();
      const overrides = scenario === "continue" ? {continue: true}
        : scenario === "no-context" ? {context: {pendingMessages: []}} : {};
      const extra = scenario === "queue" ? {hasPendingMessages: () => true}
        : scenario === "abort" ? {signal: AbortSignal.abort()} : {};
      assert.equal(await h.boundary(overrides, extra), undefined);
      assert.equal(await h.request(), undefined);
    });
  }
});

test("关闭开关、无可清理内容、纯 thinking 消息不得做无意义重试", async t => {
  const h = await harness(t, {config: {responses: false, anthropic: true}});
  assert.equal(await h.request(), undefined);
  await h.failed(); assert.equal(await h.boundary(), undefined);
  const empty = await harness(t);
  await empty.request({input: []}); await empty.failed();
  assert.equal(await empty.boundary(), undefined);
  assert.match(empty.notices.at(-1).message, /没有可安全清理/);
  const anthropic = await harness(t);
  const payload = {system: "", messages: [{role: "assistant", content: [{type: "thinking", thinking: "old", signature: "opaque"}]}]};
  await anthropic.request(payload); await anthropic.failed("Invalid signature in thinking block");
  assert.equal(await anthropic.boundary(), undefined);
  assert.match(await anthropic.status(), /删除 thinking 块：0/);
  assert.match(await anthropic.status(), /警告：1/);
});

test("开关在恢复期间关闭、模型身份改变、投影中出现新工作均不得继承清理", async t => {
  for (const scenario of ["off", "model", "endpoint", "protocol", "projection", "edit", "queue", "abort"]) {
    await t.test(scenario, async t => {
      const h = await harness(t);
      await h.request(); await h.failed(); await h.boundary();
      assert.ok(await h.request());
      await h.emit("after_provider_response", {status: 429});
      await h.failed("too many requests");
      await h.emit("turn_start");
      if (scenario === "off") await h.commands.get("filter").handler("responses off", h.ctx);
      const extra = scenario === "model" ? {model: {...h.ctx.model, id: "other"}}
        : scenario === "endpoint" ? {model: {...h.ctx.model, baseUrl: "https://example.test/v1"}}
        : scenario === "queue" ? {hasPendingMessages: () => true}
        : scenario === "abort" ? {signal: AbortSignal.abort()}
        : scenario === "projection" ? {sessionManager: {buildSessionProjection: () => ({entries: [
          {sourceEntry: {id: "other"}, messages: [{role: "user"}]},
        ]})}} : scenario === "edit" ? {sessionManager: {buildSessionProjection: () => ({entries: [
          {sourceEntry: {id: "user"}, messages: [{role: "user", content: "changed"}]},
        ]})}} : {};
      const payload = scenario === "protocol" ? {system: "", messages: []} : h.payload;
      assert.equal(await h.request(payload, extra), undefined);
      assert.equal(await h.request(), undefined);
    });
  }
});

test("过滤逻辑异常时告警并停止恢复，不能静默视为已完成", async t => {
  const h = await harness(t);
  const item = {type: "message", get id() {throw new Error("filter failure");}};
  await h.request({input: [item]}); await h.failed();
  assert.equal(await h.boundary(), undefined);
  assert.equal(h.notices.at(-1).level, "error");
  assert.match(await h.status(), /过滤错误：1/);
  assert.match(await h.status(), /逻辑恢复：0/);
  assert.equal(await h.request(), undefined);
});

test("恢复投影检查异常时大声告警，不能报告恢复成功", async t => {
  const h = await harness(t);
  await h.request(); await h.failed(); await h.boundary();
  assert.equal(await h.request(h.payload, {sessionManager: {buildSessionProjection: () => {throw new Error("failure");}}}), undefined);
  assert.equal(h.notices.at(-1).level, "error");
  assert.match(await h.status(), /过滤错误：1/);
  assert.match(await h.status(), /清理响应成功：0/);
  assert.equal(await h.request(), undefined, "异常后不得延迟恢复");
});
