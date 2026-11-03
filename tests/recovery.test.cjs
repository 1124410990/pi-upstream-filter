"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const piDir = process.env.PI_TEST_PACKAGE_DIR;
const {createJiti} = piDir ? require(require.resolve("jiti", {paths: [piDir]})) : require("jiti");

async function harness(t, {config, debug = false} = {}) {
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
    sendUserMessage: () => assert.fail("兼容性恢复不得追加用户继续消息"),
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
  return {emit, request, failed, boundary, status, payload, notices, ctx, commands, root};
}

test("正常请求对象不改写；恢复限一次；成功后新的请求再次保留历史状态", async t => {
  const h = await harness(t, {debug: true});
  const original = JSON.stringify(h.payload);
  assert.equal(await h.request(), undefined);
  await h.failed();
  const proposal = await h.boundary({entries: [{type: "custom", customType: "existing"}]});
  assert.deepEqual(proposal, {entries: [
    {type: "custom", customType: "existing"}, {type: "context_edit", targetId: "failure", replacement: null},
  ], continue: true});
  assert.equal(await h.boundary(), undefined, "重复边界不得重复安排");
  const result = await h.request();
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0].id, undefined);
  assert.deepEqual(result.include, h.payload.include);
  await h.failed();
  assert.equal(await h.boundary(), undefined, "恢复失败不再剥离");
  assert.equal(await h.request(), undefined, "宿主后续请求仍原样放行");
  await h.emit("turn_end", {message: {role: "assistant", stopReason: "stop"}});
  assert.equal(await h.request(), undefined);
  await h.failed();
  assert.equal((await h.boundary()).continue, true, "成功后新的失败可恢复一次");
  assert.equal(JSON.stringify(h.payload), original);
  const status = await h.status();
  assert.match(status, /原样放行：3/);
  assert.match(status, /清理重试：1/);
  assert.match(status, /失败：1/);
  const logs = fs.readFileSync(path.join(h.root, "pi-upstream-filter.log"), "utf8");
  assert.doesNotMatch(logs, /sensitive-cipher|private-text/);
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
  for (const scenario of ["off", "model", "projection", "edit"]) {
    await t.test(scenario, async t => {
      const h = await harness(t);
      await h.request(); await h.failed(); await h.boundary();
      if (scenario === "off") await h.commands.get("filter").handler("responses off", h.ctx);
      const extra = scenario === "model" ? {model: {...h.ctx.model, id: "other"}}
        : scenario === "projection" ? {sessionManager: {buildSessionProjection: () => ({entries: [
          {sourceEntry: {id: "other"}, messages: [{role: "user"}]},
        ]})}} : scenario === "edit" ? {sessionManager: {buildSessionProjection: () => ({entries: [
          {sourceEntry: {id: "user"}, messages: [{role: "user", content: "changed"}]},
        ]})}} : {};
      assert.equal(await h.request(h.payload, extra), undefined);
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
  assert.match(await h.status(), /清理重试：0/);
  assert.equal(await h.request(), undefined);
});

test("恢复投影检查异常时大声告警，不能报告恢复成功", async t => {
  const h = await harness(t);
  await h.request(); await h.failed(); await h.boundary();
  assert.equal(await h.request(h.payload, {sessionManager: {buildSessionProjection: () => {throw new Error("failure");}}}), undefined);
  assert.equal(h.notices.at(-1).level, "error");
  assert.match(await h.status(), /过滤错误：1/);
  assert.match(await h.status(), /恢复成功：0/);
  assert.equal(await h.request(), undefined, "异常后不得延迟恢复");
});
