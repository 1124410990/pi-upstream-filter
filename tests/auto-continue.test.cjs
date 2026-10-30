"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const piDir = process.env.PI_TEST_PACKAGE_DIR;
const {createJiti} = piDir
  ? require(require.resolve("jiti", {paths: [piDir]}))
  : require("jiti");

const rateLimit = {
  role: "assistant", stopReason: "error",
  errorMessage: "Your requests to gpt-6.1-sol for *** in *** have exceeded token rate limit.",
};

async function harness() {
  const factory = await createJiti(__filename, {moduleCache: false, fsCache: false})
    .import(path.resolve(__dirname, "../index.ts"), {default: true});
  const handlers = new Map();
  const sent = [];
  const notices = [];
  const ctx = {
    isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      notify: (message, level) => notices.push({message, level}),
      // 自动续跑不得修改用户正在编辑的草稿。
      setEditorText: () => assert.fail("不得覆盖输入框草稿"),
    },
  };
  await factory({
    on: (event, handler) => {handlers.set(event, handler); return () => {};},
    registerCommand: () => {},
    sendUserMessage: (content, options) => sent.push({content, options}),
  });
  const emit = async (event, extra = {}) => handlers.get(event.type)?.(event, {...ctx, ...extra});
  const input = async (source = "interactive", text = "任务") => {
    await emit({type: "input", source, text});
    await emit({type: "before_agent_start", messageType: "user", prompt: text});
  };
  const turn = message => emit({type: "turn_end", message});
  const boundary = (outcome = "error", overrides = {}, extra = {}) => emit({
    type: "agent_before_settle", outcome, continue: false,
    context: {pendingMessages: []}, ...overrides,
  }, extra);
  const settled = (aborted = false, extra = {}) => emit({type: "agent_settled", aborted}, extra);
  const failedRound = async () => {
    // 宿主默认：首次失败 + 三次重试；每次 agent_end 都不是最终结束边界。
    for (let attempt = 0; attempt < 4; attempt++) {
      await turn({...rateLimit});
      await emit({type: "agent_end", messages: [rateLimit]});
    }
    await boundary();
    await settled();
  };
  await emit({type: "session_start"});
  await input();
  return {emit, input, turn, boundary, settled, failedRound, sent, notices};
}

test("原生重试期间不发送，最终失败后提交真实的继续消息且不覆盖草稿", async () => {
  const h = await harness();
  for (let attempt = 0; attempt < 4; attempt++) {
    await h.turn({...rateLimit});
    await h.emit({type: "agent_end", messages: [rateLimit]});
    assert.equal(h.sent.length, 0);
  }
  await h.boundary();
  assert.equal(h.sent.length, 0);
  await h.settled();
  assert.deepEqual(h.sent, [{content: "继续", options: {deliverAs: "followUp"}}]);
  await h.settled();
  assert.equal(h.sent.length, 1, "重复结束通知不得重复发送");
  assert.match(h.notices[0].message, /1\/5/);
});

test("同一任务最多循环五次，第六轮失败明确提示耗尽", async () => {
  const h = await harness();
  for (let round = 0; round < 6; round++) {
    await h.failedRound();
    assert.equal(h.sent.length, Math.min(round + 1, 5));
    if (round < 5) await h.input("extension", "继续");
  }
  assert.match(h.notices.at(-1).message, /5.*耗尽|耗尽.*5/);
  assert.equal(h.notices.at(-1).level, "warning");
});

test("重复结束通知不能重置正在继续的任务预算，否则会突破五次上限", async () => {
  const h = await harness();
  for (let round = 0; round < 6; round++) {
    await h.failedRound();
    await h.settled();
    assert.equal(h.sent.length, Math.min(round + 1, 5));
    if (round < 5) await h.input("extension", "继续");
  }
});

test("工具轮成功不会重置同一任务的五次上限", async () => {
  const h = await harness();
  for (let round = 0; round < 5; round++) {
    await h.failedRound();
    await h.input("extension", "继续");
    await h.turn({role: "assistant", stopReason: "toolUse"});
  }
  await h.failedRound();
  assert.equal(h.sent.length, 5);
});

test("用户手动发送继续也是新计数链，最终完成后新任务也可自动恢复", async () => {
  const h = await harness();
  for (let round = 0; round < 5; round++) {
    await h.failedRound();
    await h.input("extension", "继续");
  }
  await h.input("interactive", "继续");
  await h.failedRound();
  assert.equal(h.sent.length, 6);
  assert.match(h.notices.at(-1).message, /1\/5/);
  await h.input("extension", "继续");
  await h.turn({role: "assistant", stopReason: "stop"});
  await h.boundary("completed");
  await h.settled();
  assert.equal(h.sent.length, 6, "正常完成不能发送继续");
  await h.input("interactive", "新任务");
  await h.failedRound();
  assert.match(h.notices.at(-1).message, /1\/5/);
});

test("鉴权、余额、其他限流及正常结果不触发自动继续", async () => {
  const h = await harness();
  for (const errorMessage of [
    "401 authentication failed", "insufficient_quota: token rate limit",
    "quota exceeded: token rate limit", "billing error: token rate limit",
    "available balance: token rate limit", "429 too many requests", "500 server error",
  ]) {
    await h.turn({...rateLimit, errorMessage});
    await h.boundary();
    await h.settled();
  }
  await h.turn({...rateLimit, stopReason: "aborted"});
  await h.boundary("aborted");
  await h.settled(true);
  assert.equal(h.sent.length, 0);
});

test("其他续跑、排队消息、取消和会话关闭优先，不复活旧任务", async () => {
  for (const scenario of ["continue", "boundaryQueue", "queue", "abortSignal", "aborted", "shutdown", "manualInput", "busy"]) {
    const h = await harness();
    await h.turn({...rateLimit});
    const overrides = scenario === "continue" ? {continue: true}
      : scenario === "boundaryQueue" ? {context: {pendingMessages: [{role: "user"}]}} : {};
    const extra = scenario === "queue" ? {hasPendingMessages: () => true}
      : scenario === "abortSignal" ? {signal: AbortSignal.abort()} : {};
    await h.boundary("error", overrides, extra);
    if (scenario === "shutdown") await h.emit({type: "session_shutdown", reason: "reload"});
    if (scenario === "manualInput") await h.input("interactive", "别继续，处理新任务");
    await h.settled(scenario === "aborted", scenario === "busy" ? {isIdle: () => false} : {});
    assert.equal(h.sent.length, 0, scenario);
    await h.settled();
    assert.equal(h.sent.length, 0, `${scenario} 不得延迟复活`);
  }
});
