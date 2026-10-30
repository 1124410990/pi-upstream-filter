"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// 此套件需要真实 Pi 宿主；独立运行，不因普通开发环境只有 jiti 而静默跳过。
const piDir = process.env.PI_TEST_PACKAGE_DIR;
assert.ok(piDir, "请设置 PI_TEST_PACKAGE_DIR 后运行 npm run test:host");
const importHost = relative => import(pathToFileURL(path.join(piDir, relative)).href);

async function hostHarness(t, respond) {
  const {createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime} =
    await importHost("dist/index.js");
  const {InMemoryCredentialStore} = await importHost("node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js");
  const {AssistantMessageEventStream} = await importHost("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-host-"));
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
    assert.match(path.basename(root), /^pi-filter-host-/);
    fs.rmSync(root, {recursive: true, force: true});
  });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_FILTER_DEBUG = "0";
  // 不读取实际凭据、不联网；只替换模型输出，保留宿主的重试与会话生命周期。
  global.fetch = () => assert.fail("离线会话验证不得联网");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const model = modelRuntime.getModels("openai")[0];
  assert.ok(model, "宿主必须包含离线内置模型目录");
  modelRuntime.hasConfiguredAuth = () => true;
  const settingsManager = SettingsManager.inMemory({
    compaction: {enabled: false}, cacheWarming: "off",
    // 保留默认三次重试，仅将等待设为零以加快测试。
    retry: {baseDelayMs: 0},
  });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.resolve(__dirname, "../index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({session} = await createAgentSession({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader,
    modelRuntime, model, thinkingLevel: "off", settingsManager,
    sessionManager: SessionManager.inMemory(root), tools: [],
  }));
  const errors = [];
  await session.bindExtensions({onError: error => errors.push(error)});
  let calls = 0;
  const userCounts = [];
  modelRuntime.streamSimple = (_model, context) => {
    calls++;
    userCounts.push(context.messages.filter(message => message.role === "user").length);
    const stopReason = respond(calls);
    const message = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      stopReason, timestamp: Date.now(),
      ...(stopReason === "error" ? {errorMessage: "Your requests have exceeded token rate limit."} : {}),
    };
    const stream = new AssistantMessageEventStream();
    stream.push(stopReason === "error"
      ? {type: "error", reason: "error", error: message}
      : {type: "done", reason: "stop", message});
    return stream;
  };
  return {session, errors, userCounts, calls: () => calls};
}

test("真实 Pi 会话：持续限流时三次重试与五次继续共24次请求，不产生第六条继续", {timeout: 15000}, async t => {
  const h = await hostHarness(t, () => "error");
  await h.session.prompt("完成原任务");
  await h.session.waitForIdle();
  assert.equal(h.calls(), 24);
  assert.deepEqual(h.userCounts, Array.from({length: 24}, (_, i) => 1 + Math.floor(i / 4)));
  const users = h.session.messages.filter(message => message.role === "user");
  assert.equal(users.length, 6);
  assert.deepEqual(users.slice(1).map(message => message.content),
    Array.from({length: 5}, () => [{type: "text", text: "继续"}]));
  assert.deepEqual(h.errors, []);
});

test("真实 Pi 会话：第三条继续恢复成功后停止，取消重试不自动复活", {timeout: 15000}, async t => {
  let forceFailure = false;
  const h = await hostHarness(t, calls => forceFailure || calls <= 12 ? "error" : "stop");
  await h.session.prompt("完成原任务");
  await h.session.waitForIdle();
  assert.equal(h.calls(), 13);
  assert.equal(h.session.messages.filter(message => message.role === "user").length, 4);
  forceFailure = true;
  const unsub = h.session.subscribe(event => {
    if (event.type === "auto_retry_start") void h.session.abort();
  });
  await h.session.prompt("这个任务需要主动取消");
  await h.session.waitForIdle();
  unsub();
  assert.equal(h.calls(), 14, "取消发生在第一次失败后，不应发起重试或自动继续");
  assert.equal(h.session.messages.filter(message => message.role === "user").length, 5);
  assert.deepEqual(h.errors, []);
});
