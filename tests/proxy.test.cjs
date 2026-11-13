"use strict";

/**
 * Claude Code 代理模式离线测试：脚本化 mock 上游 + createProxyServer 注入小退避。
 * 不依赖 jiti，纯 node:http 全链路（客户端 → 代理 → mock 上游）。
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const zlib = require("node:zlib");

const proxy = require("../server.cjs");

/** 启动脚本化 mock 上游：received 记录每次请求；script 依序出队，耗尽后重复末项（恒定行为）。 */
function startUpstream(script, extra = null) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const step = script[Math.min(received.length - 1, script.length - 1)];
      const apply = () => {
        const headers = { ...(step.headers || {}) };
        if (step.body !== undefined && headers["content-length"] === undefined && !step.stream) {
          headers["content-length"] = String(Buffer.byteLength(step.body));
        }
        res.writeHead(step.status, headers);
        if (step.stream) step.stream(res, () => { received[received.length - 1].finished = true; });
        else res.end(step.body ?? "");
      };
      if (step.delayMs) setTimeout(apply, step.delayMs);
      else apply();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server, received,
        port: server.address().port,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** 启动代理（默认小退避，便于限流用例毫秒级跑完）。 */
function startProxy(upstreamPort, overrides = {}) {
  const config = {
    upstreamBase: new URL(`http://127.0.0.1:${upstreamPort}`),
    host: "127.0.0.1",
    port: 0,
    upstreamApiKey: "",
    debug: false,
    logFile: "",
    maxBodyBytes: 64 * 1024 * 1024,
    maxRateRetries: 20,
    backoffBaseMs: 1,
    backoffMaxMs: 4,
    ...overrides,
  };
  const { server, stats } = proxy.createProxyServer(config);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, stats, config, port: server.address().port, close: () => closeServer(server) });
    });
  });
}

/** 客户端请求；onFirstData 用于流式渐进到达断言。 */
function request(port, { method = "POST", path = "/v1/messages", headers = {}, body = null, onFirstData = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      let firstDataAt = 0;
      res.on("data", (chunk) => {
        if (!firstDataAt) {
          firstDataAt = Date.now();
          if (onFirstData) onFirstData(firstDataAt, res);
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        firstDataAt,
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

const anthropicPayload = {
  model: "claude-sonnet-4-5",
  system: "keep-system",
  thinking: { type: "enabled", budget_tokens: 2048 },
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "old", signature: "old-sig" },
      { type: "redacted_thinking", data: "old-data" },
      { type: "text", text: "answer" },
    ] },
  ],
};

const SIGNATURE_ERROR = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "Invalid `signature` in `thinking` block: signature verification failed" },
});

const RATE_LIMIT_ERROR = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Rate limit exceeded, please retry" },
});

const WRAPPED_RATE_LIMIT_MESSAGE = "格式转换错误: Responses upstream too_many_requests: "
  + "The system is currently experiencing high demand and cannot process your request. "
  + "Your request exceeds the maximum usage size allowed during peak load. "
  + "For improved capacity reliability, consider switching to Provisioned Throughput.";
const WRAPPED_RATE_LIMIT_ERROR = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: WRAPPED_RATE_LIMIT_MESSAGE },
});

test("parseConfig：缺参/非法 URL 中文报错，尾斜杠剥离，默认值齐全", () => {
  assert.throws(() => proxy.parseConfig({}), /UPSTREAM_BASE_URL/);
  assert.throws(() => proxy.parseConfig({ UPSTREAM_BASE_URL: "not a url" }), /合法 URL/);
  assert.throws(() => proxy.parseConfig({ UPSTREAM_BASE_URL: "ftp://a.test" }), /http\/https/);
  assert.throws(() => proxy.parseConfig({ UPSTREAM_BASE_URL: "https://a.test", PORT: "x" }), /PORT/);
  assert.throws(() => proxy.parseConfig({ UPSTREAM_BASE_URL: "https://a.test", RATE_BACKOFF_MAX_MS: "10", RATE_BACKOFF_BASE_MS: "1000" }), /不能小于/);

  const config = proxy.parseConfig({ UPSTREAM_BASE_URL: "https://agentrouter.org///" });
  assert.equal(config.upstreamBase.href, "https://agentrouter.org/");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.equal(config.upstreamApiKey, "");
  assert.equal(config.maxBodyBytes, 64 * 1024 * 1024);
  assert.equal(config.maxRateRetries, 20);
  assert.equal(config.backoffBaseMs, 1000);
  assert.equal(config.backoffMaxMs, 30000);
  assert.equal(config.debug, false);

  const custom = proxy.parseConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:15721/",
    HOST: "127.0.0.1", PORT: "9000", UPSTREAM_API_KEY: "sk-test",
    FILTER_DEBUG: "1", MAX_BODY_MB: "2", RATE_LIMIT_MAX_RETRIES: "3",
    RATE_BACKOFF_BASE_MS: "10", RATE_BACKOFF_MAX_MS: "20",
  });
  assert.equal(custom.upstreamBase.href, "http://127.0.0.1:15721/");
  assert.equal(custom.port, 9000);
  assert.equal(custom.upstreamApiKey, "sk-test");
  assert.equal(custom.debug, true);
  assert.equal(custom.maxBodyBytes, 2 * 1024 * 1024);
  assert.equal(custom.maxRateRetries, 3);
  assert.equal(custom.backoffBaseMs, 10);
  assert.equal(custom.backoffMaxMs, 20);
});

test("buildUpstreamHeaders：剔 hop-by-hop、identity、改写后重算长度、密钥覆写", () => {
  const config = { upstreamApiKey: "" };
  const clientHeaders = {
    host: "client.local:8788",
    connection: "keep-alive",
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": "120",
    authorization: "Bearer client-token",
    "anthropic-version": "2023-06-01",
    "accept-encoding": "gzip, deflate, br",
  };
  const passthrough = proxy.buildUpstreamHeaders(clientHeaders, config, {});
  assert.equal(passthrough.host, undefined);
  assert.equal(passthrough.connection, undefined);
  assert.equal(passthrough["accept-encoding"], "identity");
  assert.equal(passthrough["content-encoding"], "gzip");
  assert.equal(passthrough["content-length"], "120");
  assert.equal(passthrough.authorization, "Bearer client-token");
  assert.equal(passthrough["anthropic-version"], "2023-06-01");

  const replaced = proxy.buildUpstreamHeaders(clientHeaders, config, { bodyReplaced: true, newLength: 80 });
  assert.equal(replaced["content-encoding"], undefined);
  assert.equal(replaced["content-length"], "80");

  const overwritten = proxy.buildUpstreamHeaders(clientHeaders, { upstreamApiKey: "sk-up" }, {});
  assert.equal(overwritten.authorization, "Bearer sk-up");
  assert.equal(overwritten["x-api-key"], "sk-up");
});

test("computeBackoffMs：retry-after 优先并封顶 60s，指数退避夹在区间内", () => {
  const config = { backoffBaseMs: 1000, backoffMaxMs: 30000 };
  assert.equal(proxy.parseRetryAfterMs("30"), 30000);
  assert.equal(proxy.parseRetryAfterMs(undefined), undefined);
  assert.equal(proxy.parseRetryAfterMs("garbage"), undefined);
  const httpDate = new Date(Date.now() + 5000).toUTCString();
  assert.ok(Math.abs(proxy.parseRetryAfterMs(httpDate) - 5000) < 1000);

  assert.equal(proxy.computeBackoffMs(0, "2", config), 2000);
  assert.equal(proxy.computeBackoffMs(0, "0", config), 1000); // 下限不低于 base
  assert.equal(proxy.computeBackoffMs(0, "600", config), 60000); // 封顶 60s
  for (let attempt = 0; attempt < 12; attempt++) {
    const ms = proxy.computeBackoffMs(attempt, undefined, config);
    assert.ok(ms >= 1000 && ms <= 30000, `attempt=${attempt} ms=${ms}`);
  }
  const tiny = { backoffBaseMs: 1, backoffMaxMs: 4 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const ms = proxy.computeBackoffMs(attempt, undefined, tiny);
    assert.ok(ms >= 1 && ms <= 4, `attempt=${attempt} ms=${ms}`);
  }
});

test("extractErrorMessage / isRateLimited：JSON 优先、截断、终态优先", () => {
  assert.equal(proxy.extractErrorMessage(Buffer.from(JSON.stringify({ error: { message: "boom" } }))), "boom");
  assert.equal(proxy.extractErrorMessage(Buffer.from(JSON.stringify({ error: "plain-error" }))), "plain-error");
  assert.equal(proxy.extractErrorMessage(Buffer.from(JSON.stringify({ message: "top-level" }))), "top-level");
  assert.equal(proxy.extractErrorMessage(Buffer.from("raw text")), "raw text");
  assert.equal(proxy.extractErrorMessage(Buffer.from("x".repeat(10000))).length, 4096);

  assert.equal(proxy.isRateLimited(429, "Rate limit exceeded"), true);
  assert.equal(proxy.isRateLimited(500, "Token rate limit reached"), true); // 文本兜底
  assert.equal(proxy.isRateLimited(500, "server exploded"), false);
  assert.equal(proxy.isRateLimited(429, "insufficient available balance"), false); // 终态优先
  assert.equal(proxy.isRateLimited(429, "Token rate limit: 401 authentication required"), false);
});

test("代理限流分类：包装文本与结构化代码命中，HTTP 鉴权及终态代码优先", () => {
  assert.equal(proxy.isRateLimited(422, WRAPPED_RATE_LIMIT_MESSAGE), true);
  assert.equal(proxy.isRateLimited(422, "Responses upstream TOO MANY REQUESTS: please retry"), true);
  assert.equal(proxy.isRateLimited(422, "high demand during peak load"), false);
  assert.equal(proxy.isRateLimited(422, "not_too_many_requests / too_many_requests_extra"), false);
  assert.equal(proxy.isRateLimited(422, "busy", ["too_many_requests"]), true);
  assert.equal(proxy.isRateLimited(422, "busy", ["rate_limit_error"]), true);
  assert.equal(proxy.isRateLimited(401, WRAPPED_RATE_LIMIT_MESSAGE), false);
  assert.equal(proxy.isRateLimited(403, "Token rate limit reached"), false);
  for (const message of ["permission denied", "ACCESS DENIED", "Unauthorized", "Forbidden"]) {
    assert.equal(proxy.isRateLimited(422, message, ["rate_limit_error"]), false, message);
  }
  assert.equal(proxy.isRateLimited(422, "Permission checks queued; please retry", ["too_many_requests"]), true);
  assert.equal(proxy.isRateLimited(422, "Forbidden characters in the submitted business text", ["too_many_requests"]), true);
  assert.equal(proxy.isRateLimited(422, "Forbidden: request not authorized", ["too_many_requests"]), false);
  assert.equal(proxy.isRateLimited(429, "busy", [], ["permission denied"]), false);
  assert.equal(proxy.isRateLimited(422, "busy", ["too_many_requests"], ["Available balance is not enough"]), false);
  for (const code of ["insufficient_quota", "quota_exceeded", "invalid_api_key", "permission_error",
    "permission_denied", "billing_error", "usage_limit_exceeded", "out_of_budget"]) {
    assert.equal(proxy.isRateLimited(422, WRAPPED_RATE_LIMIT_MESSAGE, [code]), false, code);
    assert.equal(proxy.isRateLimited(429, "busy", ["too_many_requests", code]), false, code);
  }
});

test("extractErrorMetadata：只读取指定错误字段，不以完整 JSON 或 details 为错误文本", () => {
  const input = JSON.stringify({
    code: "too_many_requests", type: "error",
    error: { code: "insufficient_quota", type: "rate_limit_error", message: "busy" },
    message: "Available balance is not enough",
    details: { code: "invalid_api_key", message: "too many requests" },
    request: { error: { message: "permission denied" } },
  });
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(input)), {
    message: "busy", messages: ["busy", "Available balance is not enough"],
    codes: ["insufficient_quota", "rate_limit_error", "too_many_requests", "error"],
  });
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(JSON.stringify({
    error: { code: "too_many_requests" }, details: { message: "billing" },
  }))), { message: "", messages: [], codes: ["too_many_requests"] });
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(JSON.stringify({
    details: { code: "too_many_requests" }, request: { message: "token rate limit" },
  }))), { message: "", messages: [], codes: [] });
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(JSON.stringify({
    error: "busy", message: "permission denied", code: { value: "too_many_requests" }, type: ["rate_limit_error"],
  }))), { message: "busy", messages: ["busy", "permission denied"], codes: [] });
  for (const value of [[{ error: { message: "too many requests" } }], "too_many_requests", null]) {
    assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(JSON.stringify(value))), { message: "", messages: [], codes: [] });
  }
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from("  too many requests  ")),
    { message: "too many requests", messages: ["too many requests"], codes: [] });
  // 既有导出继续保留原始 JSON 兜底，不改变兼容性错误提取行为。
  const noMessage = JSON.stringify({ details: { code: "too_many_requests" } });
  assert.equal(proxy.extractErrorMessage(Buffer.from(noMessage)), noMessage);
});

test("extractErrorMetadata：主文本优先级不变，每个指定文本与代码分别有界", () => {
  const fields = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(10000));
  const metadata = proxy.extractErrorMetadata(Buffer.from(JSON.stringify({
    error: { message: fields[0], code: fields[2], type: fields[3] },
    message: fields[1], code: fields[4], type: fields[5],
    details: { message: "permission denied" },
  })));
  assert.equal(metadata.message, fields[0].slice(0, 4096));
  assert.deepEqual(metadata.messages, fields.slice(0, 2).map((text) => text.slice(0, 4096)));
  assert.deepEqual(metadata.codes, fields.slice(2).map((text) => text.slice(0, 4096)));
  const stringError = proxy.extractErrorMetadata(Buffer.from(JSON.stringify({ error: fields[0], message: fields[1] })));
  assert.deepEqual(stringError, { message: fields[0].slice(0, 4096), messages: metadata.messages, codes: [] });
  const emptyPrimary = proxy.extractErrorMetadata(Buffer.from(JSON.stringify({ error: { message: "" }, message: "billing" })));
  assert.deepEqual(emptyPrimary, { message: "", messages: ["", "billing"], codes: [] });
  assert.equal(proxy.isRateLimited(429, emptyPrimary.message, emptyPrimary.codes, emptyPrimary.messages), false);
  const outOfBoundsTerminal = proxy.extractErrorMetadata(Buffer.from(JSON.stringify({
    error: { message: "busy", code: "too_many_requests" }, message: "x".repeat(4096) + " available balance",
  })));
  assert.equal(proxy.isRateLimited(422, outOfBoundsTerminal.message, outOfBoundsTerminal.codes, outOfBoundsTerminal.messages), true);
  const raw = proxy.extractErrorMetadata(Buffer.from("x".repeat(10000)));
  assert.equal(raw.message.length, 4096);
  assert.deepEqual(raw.messages, [raw.message]);
});

test("extractErrorMetadata：已知 JSON 或截断时解析失败不扫描，完整纯文本继续识别", () => {
  const empty = { message: "", messages: [], codes: [] };
  for (const contentType of ["application/json", "application/problem+json; charset=utf-8", "TEXT/JSON"]) {
    assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(WRAPPED_RATE_LIMIT_MESSAGE), { contentType }), empty);
  }
  const invalidJson = '{"details":{"code":"too_many_requests"},"padding":';
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(invalidJson), { contentType: "text/plain" }), empty);
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from('[{"code":"too_many_requests"}')), empty);
  assert.deepEqual(proxy.extractErrorMetadata(Buffer.from(WRAPPED_RATE_LIMIT_MESSAGE), { truncated: true, contentType: "text/plain" }), empty);
  const text = proxy.extractErrorMetadata(Buffer.from(WRAPPED_RATE_LIMIT_MESSAGE), { contentType: "text/plain" });
  assert.deepEqual(text, { message: WRAPPED_RATE_LIMIT_MESSAGE, messages: [WRAPPED_RATE_LIMIT_MESSAGE], codes: [] });
  assert.equal(proxy.isRateLimited(422, text.message, text.codes, text.messages), true);
  assert.equal(proxy.extractErrorMessage(Buffer.from(invalidJson)), invalidJson);
});

test("纯透传：POST/GET 字节与头原样、host 改写、查询串保留", async () => {
  const responseBody = JSON.stringify({ ok: true, id: "msg_1" });
  const upstream = await startUpstream([{
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req_abc", "anthropic-ratelimit-remaining": "99" },
    body: responseBody,
  }, {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: [] }),
  }]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const body = JSON.stringify(anthropicPayload);
    const post = await request(proxyServer.port, {
      path: "/v1/messages?beta=true",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body,
    });
    assert.equal(post.status, 200);
    assert.equal(post.body.toString(), responseBody);
    assert.equal(post.headers["x-request-id"], "req_abc");
    assert.equal(post.headers["anthropic-ratelimit-remaining"], "99");
    assert.equal(post.headers["x-upstream-filter"], "pass");
    assert.equal(post.headers["transfer-encoding"], undefined);

    assert.equal(upstream.received.length, 1);
    const seen = upstream.received[0];
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.body.toString(), body); // 字节级一致
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`); // host 改写为上游
    assert.equal(seen.headers["accept-encoding"], "identity");
    assert.equal(seen.headers.authorization, "Bearer tok");

    const get = await request(proxyServer.port, { method: "GET", path: "/v1/models" });
    assert.equal(get.status, 200);
    assert.equal(upstream.received.length, 2);
    assert.equal(upstream.received[1].method, "GET");
    assert.equal(upstream.received[1].body.length, 0);
    assert.equal(proxyServer.stats.proxied, 2);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("SSE 渐进到达：首块早于上游收尾，未整体缓冲", async () => {
  let upstreamFinishedAt = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
        upstreamFinishedAt = Date.now();
      }, 300);
    });
  });
  const upstream = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const proxyServer = await startProxy(upstream.address().port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), "data: first\n\ndata: second\n\n");
    assert.ok(upstreamFinishedAt - response.firstDataAt >= 200,
      `首块 ${response.firstDataAt} 应早于上游收尾 ${upstreamFinishedAt}`);
  } finally {
    await proxyServer.close();
    await closeServer(upstream);
  }
});

test("gzip 请求体透明透传，上游收到可解压等值", async () => {
  const upstream = await startUpstream([{
    status: 200, headers: { "content-type": "application/json" }, body: "{}",
  }]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const plain = Buffer.from(JSON.stringify(anthropicPayload), "utf8");
    const gzipped = zlib.gzipSync(plain);
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gzipped.length) },
      body: gzipped,
    });
    assert.equal(response.status, 200);
    const seen = upstream.received[0];
    assert.equal(seen.headers["content-encoding"], "gzip");
    assert.equal(zlib.gunzipSync(seen.body).toString(), plain.toString());
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("清理重试成功：400 签名错误 → 清 thinking → 200", async () => {
  const upstream = await startUpstream([
    { status: 400, headers: { "content-type": "application/json" }, body: SIGNATURE_ERROR },
    { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const body = JSON.stringify(anthropicPayload);
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream-filter"], "cleaned");
    assert.equal(upstream.received.length, 2); // 恰两次

    assert.equal(upstream.received[0].body.toString(), body); // 首次字节不变
    const second = JSON.parse(upstream.received[1].body.toString());
    const assistantContent = second.messages[1].content;
    assert.ok(assistantContent.every((block) => block.type !== "thinking" && block.type !== "redacted_thinking"));
    assert.deepEqual(assistantContent.map((block) => block.type), ["text"]);
    assert.deepEqual(second.thinking, anthropicPayload.thinking); // 顶层配置保留
    assert.equal(second.system, "keep-system");
    assert.equal(second.messages[0].content[0].text, "hi");

    assert.equal(upstream.received[1].headers["content-encoding"], undefined); // 明文重发
    assert.equal(upstream.received[1].headers["content-length"], String(upstream.received[1].body.length));
    assert.equal(proxyServer.stats.cleanupRetries, 1);
    assert.equal(proxyServer.stats.cleanupSuccesses, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("清理重试失败：二次仍 400 则原样回传，不第三次", async () => {
  const upstream = await startUpstream([
    { status: 400, headers: { "content-type": "application/json" }, body: SIGNATURE_ERROR },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.toString(), SIGNATURE_ERROR);
    assert.equal(response.headers["x-upstream-filter"], "cleaned-failed");
    assert.equal(upstream.received.length, 2);
    assert.equal(proxyServer.stats.cleanupRetries, 1);
    assert.equal(proxyServer.stats.cleanupFailures, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("不误触发：泛化 400 / 401 / 403 单次透传；thinking 措辞走一次清理", async () => {
  const cases = [
    { message: "invalid request body", status: 400 },
    { message: "authentication failed", status: 401 },
    { message: "forbidden", status: 403 },
    { message: "thinking or redacted_thinking blocks cannot be modified", status: 400, cleaned: true },
  ];
  for (const item of cases) {
    const upstream = await startUpstream(item.cleaned ? [
      { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { message: item.message } }) },
      { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
    ] : [{
      status: item.status, headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: item.message } }),
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicPayload),
      });
      assert.equal(response.status, item.cleaned ? 200 : item.status, item.message);
      assert.equal(upstream.received.length, item.cleaned ? 2 : 1, item.message);
      assert.equal(response.headers["x-upstream-filter"], item.cleaned ? "cleaned" : "pass", item.message);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("429 重试成功：同字节重放，响应头标记 rate-retried", async () => {
  const upstream = await startUpstream([
    { status: 429, headers: { "content-type": "application/json", "retry-after": "0" }, body: RATE_LIMIT_ERROR },
    { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const body = JSON.stringify(anthropicPayload);
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream-filter"], "rate-retried");
    assert.equal(upstream.received.length, 2);
    assert.deepEqual(upstream.received[1].body, upstream.received[0].body); // 逐字节相同
    assert.equal(upstream.received[1].headers.authorization, "Bearer tok");
    assert.equal(proxyServer.stats.rateRetries, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("422 包装限流重试成功：文本、指定 code/type 和 gzip 均原字节重放", async () => {
  const cases = [
    { body: WRAPPED_RATE_LIMIT_MESSAGE, contentType: "text/plain" },
    { body: WRAPPED_RATE_LIMIT_ERROR },
    { body: JSON.stringify({ error: WRAPPED_RATE_LIMIT_MESSAGE }) },
    { body: JSON.stringify({ message: "Responses upstream too many requests: busy" }) },
    { body: JSON.stringify({ error: { code: "too_many_requests", message: "high demand" } }) },
    { body: JSON.stringify({ error: { type: "too_many_requests" } }) },
    { body: JSON.stringify({ error: { type: "rate_limit_error", message: "busy" } }) },
    { body: JSON.stringify({ code: "too_many_requests", message: "busy" }) },
    { body: JSON.stringify({ type: "too_many_requests" }) },
    { body: JSON.stringify({ error: { code: "too_many_requests", message: "Permission checks queued; please retry" } }) },
    { body: JSON.stringify({ error: { code: "too_many_requests", message: "Forbidden characters in the submitted business text" } }) },
    { body: JSON.stringify({
      error: { code: "too_many_requests", message: "busy" },
      details: { message: "permission denied" }, request: { error: { message: "Available balance is not enough" } },
    }) },
    { body: WRAPPED_RATE_LIMIT_ERROR, gzip: true },
  ];
  for (const item of cases) {
    const upstream = await startUpstream([
      { status: 422, headers: { "content-type": item.contentType || "application/json", "retry-after": "0" }, body: item.body },
      { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' },
    ]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const plain = Buffer.from(JSON.stringify(anthropicPayload, null, 2));
      const bytes = item.gzip ? zlib.gzipSync(plain) : plain;
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json", authorization: "Bearer tok",
          "content-length": String(bytes.length), ...(item.gzip ? { "content-encoding": "gzip" } : {}) },
        body: bytes,
      });
      assert.equal(response.status, 200, item.body);
      assert.equal(response.body.toString(), '{"ok":true}');
      assert.equal(response.headers["x-upstream-filter"], "rate-retried");
      assert.equal(upstream.received.length, 2);
      for (const seen of upstream.received) {
        assert.deepEqual(seen.body, bytes); // 不清 thinking，不插入“继续”，也不重新序列化或压缩
        assert.equal(seen.headers.authorization, "Bearer tok");
        assert.equal(seen.headers["content-encoding"], item.gzip ? "gzip" : undefined);
      }
      assert.equal(proxyServer.stats.rateRetries, 1);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("普通 422 和非错误字段不重试，终态措辞、代码与 HTTP 鉴权优先", async () => {
  const cases = [
    { body: "invalid request body" },
    { body: "The system is currently experiencing high demand during peak load." },
    { body: JSON.stringify({ error: { type: "invalid_request_error", message: "invalid schema" } }) },
    { body: JSON.stringify({ details: { code: "too_many_requests", message: "too many requests" } }) },
    { body: JSON.stringify({ request: { error: { code: "too_many_requests" } } }) },
    { body: JSON.stringify([{ error: { code: "too_many_requests" } }]) },
    { body: JSON.stringify({ error: { code: { value: "too_many_requests" }, type: ["rate_limit_error"] } }) },
    { body: JSON.stringify({ error: { message: "invalid schema", details: { code: "too_many_requests" } } }) },
    { body: JSON.stringify({ error: { message: WRAPPED_RATE_LIMIT_MESSAGE + " insufficient_quota" } }), terminal: true },
    { body: JSON.stringify({ error: { type: "rate_limit_error", message: "available balance is not enough" } }), terminal: true },
    { body: JSON.stringify({ error: { code: "insufficient_quota", message: JSON.parse(SIGNATURE_ERROR).error.message } }), terminal: true },
    { body: JSON.stringify({ code: "too_many_requests", error: { code: "quota_exceeded", message: "busy" } }), terminal: true },
    { body: JSON.stringify({ error: { code: "too_many_requests" }, type: "invalid_api_key" }), terminal: true },
    { status: 429, body: JSON.stringify({ error: { type: "permission_error", message: "busy" } }), terminal: true },
    { status: 401, body: WRAPPED_RATE_LIMIT_ERROR, terminal: true },
    { status: 403, body: JSON.stringify({ error: { code: "too_many_requests", message: "busy" } }), terminal: true },
  ];
  for (const item of cases) {
    const status = item.status || 422;
    const upstream = await startUpstream([{
      status, headers: { "content-type": "application/json", "x-request-id": "req_rejected" }, body: item.body,
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
      });
      assert.equal(response.status, status, item.body);
      assert.equal(response.body.toString(), item.body);
      assert.equal(response.headers["x-upstream-filter"], "pass");
      assert.equal(response.headers["x-request-id"], "req_rejected");
      assert.equal(upstream.received.length, 1);
      assert.equal(proxyServer.stats.rateRetries, 0);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
      assert.equal(proxyServer.stats.terminalRateLimits, item.terminal ? 1 : 0);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("422 分类边界 A：截断或无法解析的 JSON 不从原文扫描嵌套代码", async () => {
  const oversized = JSON.stringify({ details: { code: "too_many_requests" }, padding: "x".repeat(300000) });
  assert.equal(Buffer.byteLength(oversized), 300053);
  const malformed = '{"details":{"code":"too_many_requests"},"padding":';
  const cases = [
    { body: oversized, contentType: "application/json", truncated: true },
    { body: oversized, contentType: "text/plain", truncated: true },
    { body: malformed, contentType: "application/problem+json" },
    { body: malformed, contentType: "text/plain" },
    { body: "too many requests " + "x".repeat(300000), contentType: "text/plain", truncated: true },
    { body: WRAPPED_RATE_LIMIT_MESSAGE, contentType: "application/json" },
  ];
  for (const item of cases) {
    const upstream = await startUpstream([{
      status: 422, headers: { "content-type": item.contentType, "x-request-id": "req_parse_boundary" }, body: item.body,
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
      });
      const expected = Buffer.from(item.body).subarray(0, 256 * 1024);
      assert.equal(response.status, 422);
      assert.equal(upstream.received.length, 1, item.contentType);
      assert.deepEqual(response.body, expected);
      assert.equal(response.headers["content-length"], item.truncated ? undefined : String(expected.length));
      if (item.truncated) assert.equal(response.headers["transfer-encoding"], "chunked");
      assert.equal(response.headers["x-upstream-filter"], "pass");
      assert.equal(response.headers["x-request-id"], "req_parse_boundary");
      assert.equal(proxyServer.stats.rateRetries, 0);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("422 分类边界 B：次优先指定文本中的终态也排除重放和清理", async () => {
  const cases = [
    { error: { message: "busy", code: "too_many_requests" }, message: "Available balance is not enough, please recharge" },
    { error: "Responses upstream too_many_requests: busy", message: "insufficient_quota" },
    { error: { message: JSON.parse(SIGNATURE_ERROR).error.message }, message: "invalid api key" },
  ];
  for (const item of cases) {
    const errorBody = JSON.stringify(item);
    const upstream = await startUpstream([{
      status: 422, headers: { "content-type": "application/json" }, body: errorBody,
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
      });
      assert.equal(response.status, 422);
      assert.equal(upstream.received.length, 1, errorBody);
      assert.equal(response.body.toString(), errorBody);
      assert.equal(response.headers["x-upstream-filter"], "pass");
      assert.equal(proxyServer.stats.rateRetries, 0);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
      assert.equal(proxyServer.stats.terminalRateLimits, 1);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("422 分类边界 C：明确权限拒绝文本优先于结构化限流代码", async () => {
  for (const message of ["permission denied", "Access denied", "Unauthorized", "Forbidden"]) {
    const errorBody = JSON.stringify({ type: "rate_limit_error", error: { message } });
    const upstream = await startUpstream([{
      status: 422, headers: { "content-type": "application/json" }, body: errorBody,
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
      });
      assert.equal(response.status, 422);
      assert.equal(upstream.received.length, 1, message);
      assert.equal(response.body.toString(), errorBody);
      assert.equal(response.headers["x-upstream-filter"], "pass");
      assert.equal(proxyServer.stats.rateRetries, 0);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
      assert.equal(proxyServer.stats.terminalRateLimits, 1);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("422 分类边界 D：限流代码与签名错误冲突时只退避重放原字节", async () => {
  const errorBody = JSON.stringify({
    error: { code: "too_many_requests", message: "Invalid signature in thinking block: signature verification failed" },
  });
  for (const gzip of [false, true]) {
    const upstream = await startUpstream([
      { status: 422, headers: { "content-type": "application/json", "retry-after": "0" }, body: errorBody },
      { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' },
    ]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const plain = Buffer.from(JSON.stringify(anthropicPayload, null, 2));
      const bytes = gzip ? zlib.gzipSync(plain) : plain;
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json", "content-length": String(bytes.length),
          ...(gzip ? { "content-encoding": "gzip" } : {}) }, body: bytes,
      });
      assert.equal(response.status, 200);
      assert.equal(upstream.received.length, 2);
      for (const seen of upstream.received) {
        assert.deepEqual(seen.body, bytes);
        assert.equal(seen.headers["content-encoding"], gzip ? "gzip" : undefined);
        assert.equal(seen.headers["content-length"], String(bytes.length));
      }
      assert.equal(response.headers["x-upstream-filter"], "rate-retried");
      assert.equal(proxyServer.stats.rateRetries, 1);
      assert.equal(proxyServer.stats.cleanupRetries, 0);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("422 包装限流预算耗尽：首次 + 20 次重放后保留 422 和错误字节", async () => {
  const upstream = await startUpstream([{
    status: 422, headers: { "content-type": "application/json", "x-request-id": "req_peak", "retry-after": "0" },
    body: WRAPPED_RATE_LIMIT_ERROR,
  }]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const bytes = Buffer.from(JSON.stringify(anthropicPayload, null, 2));
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" }, body: bytes,
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.toString(), WRAPPED_RATE_LIMIT_ERROR);
    assert.equal(response.headers["x-upstream-filter"], "rate-exhausted");
    assert.equal(response.headers["x-request-id"], "req_peak");
    assert.equal(response.headers["retry-after"], "0");
    assert.equal(upstream.received.length, 21);
    assert.ok(upstream.received.every((seen) => seen.body.equals(bytes)));
    assert.equal(proxyServer.stats.rateRetries, 20);
    assert.equal(proxyServer.stats.rateExhausted, 1);
    assert.equal(proxyServer.stats.cleanupRetries, 0);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("422 限流继续尊重 retry-after：未到 1 秒不重放", async () => {
  const upstream = await startUpstream([
    { status: 422, headers: { "content-type": "application/json", "retry-after": "1" }, body: WRAPPED_RATE_LIMIT_ERROR },
    { status: 200, body: "{}" },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const start = Date.now();
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.received.length, 2);
    assert.ok(Date.now() - start >= 1000, "retry-after 应覆盖毫秒级默认退避");
    assert.equal(proxyServer.stats.rateRetries, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("422 限流退避中取消：超过 retry-after 窗口后仍无迟到重放", { timeout: 10000 }, async () => {
  const upstream = await startUpstream([{
    status: 422, headers: { "content-type": "application/json", "retry-after": "1" }, body: WRAPPED_RATE_LIMIT_ERROR,
  }]);
  const proxyServer = await startProxy(upstream.port, { backoffBaseMs: 500, backoffMaxMs: 1000 });
  try {
    await new Promise((resolve, reject) => {
      const cancelled = new Error("test client cancel");
      const req = http.request({
        host: "127.0.0.1", port: proxyServer.port, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json" },
      }, (res) => {
        res.resume();
        reject(new Error("422 应进入退避，不应在取消前透传给客户端"));
      });
      const timer = setTimeout(() => req.destroy(cancelled), 100);
      req.on("error", (error) => {
        clearTimeout(timer);
        if (error === cancelled) resolve();
        else reject(error);
      });
      req.end(JSON.stringify(anthropicPayload));
    });
    await new Promise((resolve) => setTimeout(resolve, 1200)); // 完整越过 1s 退避，检查迟到重放
    assert.equal(upstream.received.length, 1);
    assert.equal(proxyServer.stats.rateRetries, 0);
    assert.equal(proxyServer.stats.errors, 0);
    const health = await request(proxyServer.port, { method: "GET", path: "/healthz" });
    assert.equal(health.status, 200);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("HTTP 200 SSE 内 too_many_requests 错误事件原样透传，不启动重放", async () => {
  const sse = `event: error\ndata: ${WRAPPED_RATE_LIMIT_ERROR}\n\n`;
  const upstream = await startUpstream([{
    status: 200, headers: { "content-type": "text/event-stream" },
    stream: (res) => { res.write(sse); res.end(); },
  }]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" }, body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream-filter"], "pass");
    assert.equal(response.body.toString(), sse);
    assert.equal(upstream.received.length, 1);
    assert.equal(proxyServer.stats.rateRetries, 0);
    assert.equal(proxyServer.stats.cleanupRetries, 0);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("终态限流不重试：余额/鉴权措辞即便配 429 也单次透传", async () => {
  const terminalBodies = [
    "Available balance is not enough, please recharge",
    "Token rate limit reached and 401 authentication required",
  ];
  for (const message of terminalBodies) {
    const upstream = await startUpstream([{
      status: 429, headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message } }),
    }]);
    const proxyServer = await startProxy(upstream.port);
    try {
      const response = await request(proxyServer.port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicPayload),
      });
      assert.equal(response.status, 429, message);
      assert.equal(upstream.received.length, 1, message);
      assert.equal(proxyServer.stats.rateRetries, 0, message);
      assert.equal(proxyServer.stats.terminalRateLimits, 1, message);
    } finally {
      await proxyServer.close();
      await upstream.close();
    }
  }
});

test("预算耗尽：恒 429 共 1+20 次上游调用后透传", async () => {
  const upstream = await startUpstream([{
    status: 429, headers: { "content-type": "application/json" }, body: RATE_LIMIT_ERROR,
  }]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 429);
    assert.equal(response.body.toString(), RATE_LIMIT_ERROR);
    assert.equal(response.headers["x-upstream-filter"], "rate-exhausted");
    assert.equal(upstream.received.length, 21); // 首次 + 20 次重放
    assert.equal(proxyServer.stats.rateRetries, 20);
    assert.equal(proxyServer.stats.rateExhausted, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("链式组合：签名错误 → 清理 → 429 → 退避重放 → 200", async () => {
  const upstream = await startUpstream([
    { status: 400, headers: { "content-type": "application/json" }, body: SIGNATURE_ERROR },
    { status: 429, headers: { "content-type": "application/json", "retry-after": "0" }, body: RATE_LIMIT_ERROR },
    { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream-filter"], "cleaned");
    assert.equal(upstream.received.length, 3);
    // 第 2、3 次均为清理后的明文体，且逐字节相同（重放不变形）
    const second = JSON.parse(upstream.received[1].body.toString());
    assert.ok(second.messages[1].content.every((block) => block.type !== "thinking"));
    assert.deepEqual(upstream.received[2].body, upstream.received[1].body);
    assert.equal(proxyServer.stats.cleanupRetries, 1);
    assert.equal(proxyServer.stats.rateRetries, 1);
    assert.equal(proxyServer.stats.cleanupSuccesses, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("文本兜底：500 + token rate limit 措辞仍触发限流链", async () => {
  const upstream = await startUpstream([
    { status: 500, headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "Token rate limit reached, slow down" } }) },
    { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
  ]);
  const proxyServer = await startProxy(upstream.port);
  try {
    const response = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream-filter"], "rate-retried");
    assert.equal(upstream.received.length, 2);
    assert.equal(proxyServer.stats.rateRetries, 1);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("客户端退避期间断开：上游无第二次调用，代理不崩溃", async () => {
  const upstream = await startUpstream([{
    status: 429, headers: { "content-type": "application/json", "retry-after": "1" }, body: RATE_LIMIT_ERROR,
  }]);
  // retry-after 1s → 夹到 [500ms, 60s]；客户端 100ms 后断开，退避尚未结束
  const proxyServer = await startProxy(upstream.port, { backoffBaseMs: 500, backoffMaxMs: 1000 });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: proxyServer.port, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json" },
      }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      req.end(JSON.stringify(anthropicPayload));
      setTimeout(() => req.destroy(), 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 800)); // 等待退避窗口过去

    assert.equal(upstream.received.length, 1); // 无第二次上游调用
    assert.equal(proxyServer.stats.rateRetries, 0);
    // 代理进程仍健康：healthz 可用
    const health = await request(proxyServer.port, { method: "GET", path: "/healthz" });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body.toString()).ok, true);
    assert.equal(proxyServer.stats.errors, 0);
  } finally {
    await proxyServer.close();
    await upstream.close();
  }
});

test("/healthz 不转发且返回统计；413 超限不上游；502 上游不可达", async () => {
  const upstream = await startUpstream([{
    status: 200, headers: { "content-type": "application/json" }, body: "{}",
  }]);
  const proxyServer = await startProxy(upstream.port, { maxBodyBytes: 1024 });
  try {
    const health = await request(proxyServer.port, { method: "GET", path: "/healthz" });
    assert.equal(health.status, 200);
    const payload = JSON.parse(health.body.toString());
    assert.equal(payload.ok, true);
    assert.ok(payload.version);
    assert.deepEqual(Object.keys(payload.stats).sort(), [
      "cleanupFailures", "cleanupRetries", "cleanupSuccesses", "errors", "lastEventAt",
      "proxied", "rateExhausted", "rateRetries", "requests", "terminalRateLimits",
    ]);
    assert.equal(upstream.received.length, 0); // 未转发

    const head = await request(proxyServer.port, { method: "HEAD", path: "/healthz" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);

    const tooLarge = await request(proxyServer.port, {
      headers: { "content-type": "application/json" },
      body: "x".repeat(2048),
    });
    assert.equal(tooLarge.status, 413);
    const error413 = JSON.parse(tooLarge.body.toString());
    assert.equal(error413.error.type, "request_too_large");
    assert.equal(upstream.received.length, 0); // 未达上游
  } finally {
    await proxyServer.close();
    await upstream.close();
  }

  // 上游不可达：占用后释放的端口 → 502 单次，不无限重试
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const deadPort = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  const deadProxy = await startProxy(deadPort);
  try {
    const response = await request(deadProxy.port, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicPayload),
    });
    assert.equal(response.status, 502);
    const error502 = JSON.parse(response.body.toString());
    assert.equal(error502.error.type, "upstream_unreachable");
    assert.match(error502.error.message, /上游不可达/);
    assert.equal(deadProxy.stats.errors, 1);
  } finally {
    await deadProxy.close();
  }
});

test("EADDRINUSE：同端口二次监听得到占用错误", async () => {
  const upstream = await startUpstream([{
    status: 200, headers: { "content-type": "application/json" }, body: "{}",
  }]);
  const first = await startProxy(upstream.port);
  const second = proxy.createProxyServer({
    upstreamBase: new URL(`http://127.0.0.1:${upstream.port}`),
    host: "127.0.0.1", port: 0, upstreamApiKey: "", debug: false, logFile: "",
    maxBodyBytes: 1024, maxRateRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1,
  });
  try {
    const error = await new Promise((resolve, reject) => {
      second.server.on("error", resolve);
      second.server.listen(first.port, "127.0.0.1");
      setTimeout(() => reject(new Error("未收到 error 事件")), 2000);
    });
    assert.equal(error.code, "EADDRINUSE");
  } finally {
    await first.close();
    await closeServer(second.server);
    await upstream.close();
  }
});
