"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// 可使用宿主 Pi 的真实加载器，也可使用开发依赖；缺失时直接报错，不跳过测试。
const piDir = process.env.PI_TEST_PACKAGE_DIR;
const {createJiti} = piDir
  ? require(require.resolve("jiti", {paths: [piDir]}))
  : require("jiti");

for (const tryNative of [true, false]) {
  test(`旧版 CJS 导出已缓存后，重载仍能显示白名单并过滤请求（tryNative=${tryNative}）`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-reload-"));
    const originalDir = path.resolve(__dirname, "..");
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const savedDebug = process.env.PI_FILTER_DEBUG;
    try {
      process.env.PI_CODING_AGENT_DIR = path.join(root, "empty-agent");
      process.env.PI_FILTER_DEBUG = "0";
      const corePath = path.join(root, "filter-core.cjs");
      // 同时覆盖 Git 在 Windows 检出时的 CRLF，以及其他环境常用的 LF。
      const currentCore = fs.readFileSync(path.join(originalDir, "filter-core.cjs"), "utf8")
        .replace(/\r?\n/g, tryNative ? "\r\n" : "\n");
      const legacyCore = currentCore.replace(/  FILTER_HOSTS,\r?\n  matchesFilterEndpoint,\r?\n/, "");
      assert.notEqual(legacyCore, currentCore);
      fs.writeFileSync(corePath, legacyCore);
      fs.copyFileSync(path.join(originalDir, "index.ts"), path.join(root, "index.ts"));
      const oldNamespace = await import(pathToFileURL(corePath).href);
      assert.equal(oldNamespace.FILTER_HOSTS, undefined);
      // 模拟进程未退出，但过滤核心已从旧版更新到新版。
      fs.writeFileSync(corePath, currentCore);
      const jiti = createJiti(__filename, {moduleCache: false, fsCache: false, tryNative});
      const factory = await jiti.import(path.join(root, "index.ts"), {default: true});
      const handlers = new Map();
      const commands = new Map();
      await factory({
        on: (event, handler) => {handlers.set(event, handler); return () => {};},
        registerCommand: (name, options) => commands.set(name, options),
      });
      let status;
      await commands.get("filter").handler("", {ui: {notify: message => {status = message;}}});
      assert.match(status, /agentrouter\.org, ps\.air-outer\.com/);
      const payload = {
        reasoning: {effort: "high"}, include: ["reasoning.encrypted_content"],
        input: [
          {type: "reasoning", id: "rs_old", encrypted_content: "mock"},
          {type: "function_call", id: "fc_old", call_id: "call_keep", name: "read", arguments: "{}"},
          {type: "function_call_output", call_id: "call_keep", output: "keep"},
        ],
      };
      const snapshot = JSON.stringify(payload);
      const handle = handlers.get("before_provider_request");
      for (const baseUrl of ["https://agentrouter.org/v1", "https://ps.air-outer.com/v1"]) {
        const result = await handle({payload}, {model: {baseUrl}});
        assert.equal(result.input.length, 2);
        assert.equal(result.input[0].id, undefined);
        assert.equal(result.input[0].call_id, result.input[1].call_id);
        assert.deepEqual(result.include, []);
        assert.deepEqual(result.reasoning, payload.reasoning);
      }
      for (const baseUrl of ["https://open.bigmodel.cn/api/anthropic", "https://agentrouter.org.evil.test", undefined]) {
        assert.equal(await handle({payload}, {model: {baseUrl}}), undefined);
      }
      assert.equal(JSON.stringify(payload), snapshot);
    } finally {
      if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedDir;
      if (savedDebug === undefined) delete process.env.PI_FILTER_DEBUG;
      else process.env.PI_FILTER_DEBUG = savedDebug;
      // 只清理本测试创建的、前缀固定的临时目录。
      assert.match(path.basename(root), /^pi-filter-reload-/);
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
}
