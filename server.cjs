#!/usr/bin/env node
"use strict";

/**
 * Claude Code 本地代理模式（v0.4.0 新增）。
 *
 * Claude Code 没有进程内扩展 API，唯一挂载点是 ANTHROPIC_BASE_URL 指向本代理：
 *
 *   Claude Code ──▶ server.cjs (127.0.0.1:8788) ──▶ UPSTREAM_BASE_URL（中转站 / CC Switch）
 *
 * 与 Pi 扩展（index.ts）共用同一份 filter-core.cjs 纯函数，单一事实来源：
 * - 清理重试链：上游返回白名单兼容性错误（thinking 签名 / 加密 reasoning 校验失败）时，
 *   清理历史推理状态并立即重试一次（与 Pi 版 v0.3.0 的"错误后一次性恢复"对齐）。
 * - 限流重试链：429 / token rate limit 措辞触发带退避的有限次重放（与 Pi 版二十次预算对齐），
 *   终态措辞（鉴权/配额/余额）不重试。
 *
 * 明确边界：只在尚未向客户端写出任何字节前判定重试；200 SSE 流内错误一律透传（v1）。
 */

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream");

const {
  looksLikeAnthropicPayload,
  classifyCompatibilityError,
  filterAnthropicPayload,
  isTokenRateLimitError,
  isTerminalLimitError,
} = require("./filter-core.cjs");

const VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch {
    return "unknown";
  }
})();

const DEFAULT_PORT = 8788;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_MB = 64;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 20;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** retry-after 的绝对上限：超过视为上游明确拒绝节奏，不再无限等待。 */
const RETRY_AFTER_CAP_MS = 60_000;
/** 上游错误 body 读取上限（兼容性错误是短 JSON，超限即截断透传）。 */
const MAX_ERROR_BODY_BYTES = 256 * 1024;
/** 上游 socket 空闲超时（含等待响应头与 SSE chunk 间隔）。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 600_000;

/** 逐字节原样转发，因此响应侧保留 content-length / content-encoding，仅剔除 hop-by-hop。 */
const HOP_BY_HOP_RESPONSE = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
]);

/** 请求侧剔除 hop-by-hop 与由代理重建的头。 */
const HOP_BY_HOP_REQUEST = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "expect",
]);

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

/**
 * 解析环境变量为配置对象。UPSTREAM_BASE_URL 缺失/非法时抛出中文错误。
 * 测试可通过直接构造 config 对象注入小退避值，绕过本函数。
 */
function parseConfig(env) {
  const source = env || process.env;
  const rawUpstream = String(source.UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!rawUpstream) {
    throw new Error("缺少必填环境变量 UPSTREAM_BASE_URL（上游地址，不含 /v1，例如 https://agentrouter.org）");
  }
  let upstream;
  try {
    upstream = new URL(rawUpstream);
  } catch {
    throw new Error(`UPSTREAM_BASE_URL 不是合法 URL：${rawUpstream}`);
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`UPSTREAM_BASE_URL 仅支持 http/https：${rawUpstream}`);
  }

  const parseInteger = (name, fallback, { min = 0 } = {}) => {
    const raw = source[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || !Number.isInteger(value)) {
      throw new Error(`${name} 必须是不小于 ${min} 的整数，当前值：${raw}`);
    }
    return value;
  };

  const config = {
    upstreamBase: upstream,
    host: String(source.HOST || DEFAULT_HOST),
    port: parseInteger("PORT", DEFAULT_PORT, { min: 1 }),
    upstreamApiKey: source.UPSTREAM_API_KEY ? String(source.UPSTREAM_API_KEY) : "",
    debug: source.FILTER_DEBUG === "1",
    logFile: source.FILTER_LOG_FILE ? String(source.FILTER_LOG_FILE) : "",
    maxBodyBytes: parseInteger("MAX_BODY_MB", DEFAULT_MAX_BODY_MB, { min: 1 }) * 1024 * 1024,
    maxRateRetries: parseInteger("RATE_LIMIT_MAX_RETRIES", DEFAULT_RATE_LIMIT_MAX_RETRIES, { min: 0 }),
    backoffBaseMs: Math.max(1, parseInteger("RATE_BACKOFF_BASE_MS", DEFAULT_BACKOFF_BASE_MS, { min: 1 })),
    backoffMaxMs: Math.max(1, parseInteger("RATE_BACKOFF_MAX_MS", DEFAULT_BACKOFF_MAX_MS, { min: 1 })),
  };
  if (config.backoffMaxMs < config.backoffBaseMs) {
    throw new Error("RATE_BACKOFF_MAX_MS 不能小于 RATE_BACKOFF_BASE_MS");
  }
  return config;
}

/**
 * 读取客户端请求体。GET/HEAD/DELETE 不缓冲。
 * 返回 raw（原始字节，未改写转发用）与 decoded（解压后字节，清理判定用）。
 * gzip 解压失败或未知编码时 decoded=null，该请求禁用清理链但照常透传。
 */
function readRequestBody(req, capBytes) {
  return new Promise((resolve) => {
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "DELETE") {
      resolve({ raw: null, decoded: null, encoding: "identity", tooLarge: false, aborted: false });
      return;
    }
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (tooLarge) return; // 超限后不再缓冲，排空剩余字节等待 end 再回 413
      total += chunk.length;
      if (total > capBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        finish({ raw: null, decoded: null, encoding: "identity", tooLarge: true, aborted: false });
        return;
      }
      const raw = Buffer.concat(chunks);
      const encHeader = String(req.headers["content-encoding"] || "").trim().toLowerCase();
      if (!encHeader || encHeader === "identity") {
        finish({ raw, decoded: raw, encoding: "identity", tooLarge: false, aborted: false });
        return;
      }
      if (encHeader === "gzip" || encHeader === "x-gzip") {
        try {
          finish({ raw, decoded: zlib.gunzipSync(raw), encoding: "gzip", tooLarge: false, aborted: false });
        } catch {
          finish({ raw, decoded: null, encoding: "other", tooLarge: false, aborted: false });
        }
        return;
      }
      finish({ raw, decoded: null, encoding: "other", tooLarge: false, aborted: false });
    });
    req.on("error", () => {
      finish({ raw: null, decoded: null, encoding: "identity", tooLarge: false, aborted: true });
    });
  });
}

/** 解析 JSON 请求体；非对象或解析失败返回 undefined，不抛异常。 */
function parseJsonBody(decoded) {
  if (!Buffer.isBuffer(decoded) || decoded.length === 0) return undefined;
  try {
    const parsed = JSON.parse(decoded.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从上游错误 body 提取错误文本：优先 JSON 的 error.message / error / message，否则原文。
 * 截断至 4KB，避免超长 HTML 错误页污染日志与正则匹配成本。
 */
function extractErrorMessage(bodyBuffer) {
  let text = "";
  try {
    text = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.toString("utf8") : String(bodyBuffer || "");
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const error = parsed.error;
      if (error && typeof error === "object" && typeof error.message === "string") return error.message.slice(0, 4096);
      if (typeof error === "string") return error.slice(0, 4096);
      if (typeof parsed.message === "string") return parsed.message.slice(0, 4096);
    }
  } catch {
    /* 非 JSON，走原文 */
  }
  return text.trim().slice(0, 4096);
}

/** 构建上游请求头：剔除 hop-by-hop，accept-encoding 固定 identity（保证 SSE 字节级透传）。 */
function buildUpstreamHeaders(clientHeaders, config, { bodyReplaced = false, newLength = 0 } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(clientHeaders || {})) {
    if (HOP_BY_HOP_REQUEST.has(name)) continue;
    out[name] = Array.isArray(value) ? (name === "set-cookie" ? value : value.join(", ")) : value;
  }
  out["accept-encoding"] = "identity";
  if (bodyReplaced) {
    // 清理后的明文 JSON 重发：删除压缩标记并重算长度，不重新压缩（确定性优先）。
    delete out["content-encoding"];
    out["content-length"] = String(newLength);
  }
  if (config.upstreamApiKey) {
    out["authorization"] = `Bearer ${config.upstreamApiKey}`;
    out["x-api-key"] = config.upstreamApiKey;
  }
  return out;
}

/** 解析 retry-after（秒数或 HTTP-date）为毫秒；无法解析返回 undefined。 */
function parseRetryAfterMs(headerValue) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
  return undefined;
}

/**
 * 退避毫秒数：retry-after 优先（夹在 [base, 60s]）；否则 base*2^attempt 夹在 [base, max]，
 * 指数路径叠加 ±25% 抖动避免固定节奏重放。
 */
function computeBackoffMs(attempt, retryAfterHeader, config) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, config.backoffBaseMs), RETRY_AFTER_CAP_MS);
  }
  const exponential = Math.min(config.backoffBaseMs * 2 ** attempt, config.backoffMaxMs);
  const jitter = exponential * (0.75 + Math.random() * 0.5);
  return Math.round(Math.min(Math.max(jitter, config.backoffBaseMs), config.backoffMaxMs));
}

/**
 * 限流判定：状态码 429 为主，文本兜底（对齐 Pi 仅凭错误文本也能触发）；
 * 终态措辞（鉴权/配额/余额）命中则不重试——重试无法恢复账号级限制。
 */
function isRateLimited(status, message) {
  return (status === 429 || isTokenRateLimitError(message)) && !isTerminalLimitError(message);
}

/** 剔除 hop-by-hop 头，其余原样保留（字节级透传，content-length/encoding 有效）。 */
function filterResponseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP_RESPONSE.has(name)) continue;
    out[name] = Array.isArray(value) ? (name === "set-cookie" ? value : value.join(", ")) : value;
  }
  return out;
}

/** 发起上游请求，resolve 响应流；signal 中止 / 网络错误 / 头超时 reject。 */
function sendUpstream(config, method, url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url, config.upstreamBase);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(
      target,
      { method, headers, agent: config.agent, signal },
      (response) => resolve(response),
    );
    request.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`上游 ${config.upstreamBase.href} 响应超时（${UPSTREAM_IDLE_TIMEOUT_MS}ms 空闲）`));
    });
    request.on("error", reject);
    if (body) request.end(body);
    else request.end();
  });
}

/** 读取整个流，超过 cap 截断并销毁流。 */
function readAll(stream, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      if (total + chunk.length > cap) {
        const keep = cap - total;
        if (keep > 0) chunks.push(chunk.subarray(0, keep));
        stream.destroy();
        resolve({ buffer: Buffer.concat(chunks), truncated: true });
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    stream.on("end", () => resolve({ buffer: Buffer.concat(chunks), truncated: false }));
    stream.on("error", reject);
  });
}

/** 2xx 响应管道透传（不缓冲）；客户端中途断开按正常结束处理（abort 已另行触发）。 */
function relaySuccess(clientRes, upstreamRes, action) {
  const headers = filterResponseHeaders(upstreamRes.headers);
  headers["x-upstream-filter"] = action;
  clientRes.writeHead(upstreamRes.statusCode || 502, headers);
  return new Promise((resolve) => {
    pipeline(upstreamRes, clientRes, () => resolve());
  });
}

/** 非 2xx 终态回传：原 status + 原头 + 已读 body（截断时不给 content-length，交给 chunked）。 */
function relayFailure(clientRes, upstreamRes, bodyBuffer, truncated, action) {
  const headers = filterResponseHeaders(upstreamRes.headers);
  if (truncated) delete headers["content-length"];
  else headers["content-length"] = String(bodyBuffer.length);
  headers["x-upstream-filter"] = action;
  clientRes.writeHead(upstreamRes.statusCode || 502, headers);
  clientRes.end(clientRes.req && clientRes.req.method === "HEAD" ? undefined : bodyBuffer);
}

/** 可中断 sleep：signal 中止时 reject AbortError，调用方据此放弃（客户端已断开）。 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function newStats() {
  return {
    requests: 0,
    proxied: 0,
    cleanupRetries: 0,
    cleanupSuccesses: 0,
    cleanupFailures: 0,
    rateRetries: 0,
    rateExhausted: 0,
    terminalRateLimits: 0,
    errors: 0,
    lastEventAt: null,
  };
}

/**
 * 创建代理服务器（不监听）。测试可直接注入 config（小退避值）。
 * 每请求的重试状态全部是闭包局部量；进程级可变状态只有 stats。
 */
function createProxyServer(config) {
  const stats = newStats();
  const fs = config.logFile ? require("node:fs") : null;
  const log = (action, data = {}) => {
    stats.lastEventAt = new Date().toISOString();
    if (!config.debug && !fs) return;
    const entry = JSON.stringify({ ts: stats.lastEventAt, action, ...data });
    if (config.debug) process.stderr.write(`${entry}\n`);
    if (fs) {
      try {
        fs.appendFileSync(config.logFile, `${entry}\n`, "utf8");
      } catch {
        /* 日志失败不阻断转发 */
      }
    }
  };

  const server = http.createServer((clientReq, clientRes) => {
    handleClient(config, clientReq, clientRes, stats, log).catch((error) => {
      // 客户端中断会以 AbortError 冒泡到任意 await 点，属正常生命周期，不计错误。
      if (isAbortError(error) || clientRes.writableEnded || clientRes.destroyed) return;
      stats.errors++;
      log("handler-error", { message: String(error && error.message) });
      if (!clientRes.headersSent) {
        writeJsonError(clientRes, 500, "proxy_internal_error", `代理内部错误：${error && error.message}`);
      } else {
        clientRes.destroy();
      }
    });
  });
  // Node 22 默认 requestTimeout 300s 会掐断慢速大请求体上传；显式关闭。
  server.requestTimeout = 0;

  return { server, stats, log };
}

function writeJsonError(clientRes, status, type, message) {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  clientRes.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "x-upstream-filter": "error",
  });
  clientRes.end(body);
}

async function handleClient(config, clientReq, clientRes, stats, log) {
  stats.requests++;
  const url = clientReq.url || "/";
  const pathOnly = url.split("?")[0];

  if ((clientReq.method === "GET" || clientReq.method === "HEAD") && pathOnly === "/healthz") {
    clientRes.writeHead(200, { "content-type": "application/json", "x-upstream-filter": "healthz" });
    clientRes.end(clientReq.method === "HEAD" ? undefined : JSON.stringify({
      ok: true,
      version: VERSION,
      upstream: config.upstreamBase.href,
      stats,
    }));
    return;
  }

  const abortController = new AbortController();
  clientReq.on("error", () => abortController.abort());
  clientRes.on("close", () => {
    if (!clientRes.writableEnded) abortController.abort();
  });
  const signal = abortController.signal;

  const bodyCtx = await readRequestBody(clientReq, config.maxBodyBytes);
  if (bodyCtx.aborted || signal.aborted) return;
  if (bodyCtx.tooLarge) {
    writeJsonError(clientRes, 413, "request_too_large",
      `请求体超过 MAX_BODY_MB 上限（${Math.floor(config.maxBodyBytes / 1024 / 1024)}MB），已拒绝转发。`);
    return;
  }

  // 清理判定基于内容形态（messages + system），与路径/模型无关；count_tokens、小模型请求同形态适用。
  let payload;
  if (bodyCtx.decoded && String(clientReq.headers["content-type"] || "").includes("application/json")) {
    const parsed = parseJsonBody(bodyCtx.decoded);
    if (looksLikeAnthropicPayload(parsed)) payload = parsed;
  }

  let bytes = bodyCtx.raw;
  let cleaned = false;
  let cleanupEvaluated = false;
  let rateRetries = 0;

  for (;;) {
    const headers = buildUpstreamHeaders(clientReq.headers, config, {
      bodyReplaced: cleaned,
      newLength: bytes ? bytes.length : 0,
    });
    let upstreamRes;
    try {
      upstreamRes = await sendUpstream(config, clientReq.method, url, headers, bytes, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      stats.errors++;
      log("upstream-error", { path: pathOnly, message: String(error && error.message).slice(0, 300) });
      writeJsonError(clientRes, 502, "upstream_unreachable", `上游不可达：${error && error.message}`);
      return;
    }
    if (signal.aborted) {
      upstreamRes.destroy();
      return;
    }

    const status = upstreamRes.statusCode || 502;
    if (status >= 200 && status < 300) {
      const action = cleaned ? "cleaned" : rateRetries > 0 ? "rate-retried" : "pass";
      stats.proxied++;
      if (cleaned) stats.cleanupSuccesses++;
      log("relay", { path: pathOnly, status, action, rateRetries });
      await relaySuccess(clientRes, upstreamRes, action);
      return;
    }

    const { buffer: errorBuffer, truncated } = await readAll(upstreamRes, MAX_ERROR_BODY_BYTES);
    if (signal.aborted) return;
    const message = extractErrorMessage(errorBuffer);

    // ① 清理链（优先，至多一次）：白名单兼容性错误 → 清历史 thinking → 立即重试。
    if (!cleanupEvaluated && payload) {
      const rejection = classifyCompatibilityError(message, payload, status);
      if (rejection) {
        cleanupEvaluated = true;
        const result = filterAnthropicPayload(payload);
        if (result.stats.removedThinkingBlocks > 0) {
          cleaned = true;
          payload = result.payload;
          bytes = Buffer.from(JSON.stringify(payload), "utf8");
          stats.cleanupRetries++;
          log("cleanup-retry", {
            path: pathOnly, status, kind: rejection.kind,
            removedThinkingBlocks: result.stats.removedThinkingBlocks,
          });
          continue;
        }
        log("cleanup-skipped", { path: pathOnly, status, kind: rejection.kind });
      }
    }

    // ② 限流链（独立预算）：带退避重放同一字节；终态措辞已由 isRateLimited 排除。
    if (isRateLimited(status, message)) {
      if (rateRetries < config.maxRateRetries) {
        const delay = computeBackoffMs(rateRetries, upstreamRes.headers["retry-after"], config);
        try {
          await abortableSleep(delay, signal);
        } catch {
          return; // 客户端已断开，放弃重放
        }
        rateRetries++;
        stats.rateRetries++;
        log("rate-retry", { path: pathOnly, status, attempt: rateRetries, delayMs: delay });
        continue;
      }
      stats.rateExhausted++;
      log("relay", { path: pathOnly, status, action: "rate-exhausted", rateRetries });
      relayFailure(clientRes, upstreamRes, errorBuffer, truncated, "rate-exhausted");
      return;
    }

    if (isTerminalLimitError(message)) stats.terminalRateLimits++;
    const action = cleaned ? "cleaned-failed" : "pass";
    if (cleaned) stats.cleanupFailures++;
    log("relay", { path: pathOnly, status, action, rateRetries });
    relayFailure(clientRes, upstreamRes, errorBuffer, truncated, action);
    return;
  }
}

function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    process.stderr.write(`[pi-upstream-filter] 配置错误：${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const transport = config.upstreamBase.protocol === "http:" ? http : https;
  config.agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 64 });

  if (config.debug || config.logFile) {
    process.stderr.write(
      `[pi-upstream-filter] v${VERSION} 调试已开启；上游：${config.upstreamBase.href}\n`);
  }
  if (config.host === "0.0.0.0" || config.host === "::") {
    process.stderr.write("[pi-upstream-filter] 警告：监听所有网卡，鉴权头将以明文经过本机网络，请确认信任环境。\n");
  }

  const { server, stats } = createProxyServer(config);
  server.listen(config.port, config.host, () => {
    process.stderr.write(
      `[pi-upstream-filter] v${VERSION} 代理已启动：http://${config.host}:${config.port} → ${config.upstreamBase.href}\n`);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `[pi-upstream-filter] 端口 ${config.port} 已被占用，请用 PORT 环境变量换一个端口。\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`[pi-upstream-filter] 服务器错误：${error.message}\n`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode);
  });

  let shuttingDown = false;
  const shutdown = (label) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(
      `\n[pi-upstream-filter] 收到 ${label}，停止接受新连接；统计：${JSON.stringify(stats)}\n`);
    server.close(() => process.exit(0));
    // 10s 排空窗口：在途流式响应结束或超时强退。
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

module.exports = {
  parseConfig,
  readRequestBody,
  parseJsonBody,
  extractErrorMessage,
  buildUpstreamHeaders,
  computeBackoffMs,
  parseRetryAfterMs,
  isRateLimited,
  createProxyServer,
  main,
};

if (require.main === module) main();
