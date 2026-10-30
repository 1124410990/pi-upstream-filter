"use strict";

/**
 * Pi 上游过滤核心 —— 纯函数，无依赖，可被 node:test 直接测试。
 *
 * 借鉴 ccswitch-codex-filter 的过滤思路，映射到 Pi 实际发出的两种请求体：
 *
 * 1. openai-responses（GPT 系）：pi-ai 以 store:false + include reasoning.encrypted_content
 *    发送请求，并把整个 reasoning item（含 rs_ ID 与密文）存进会话、下轮原样回放
 *    （pi-ai openai-responses-shared.js: JSON.parse(block.thinkingSignature) → input）。
 *    跨上游切换时会触发 "created under a different resource" / 解密失败。
 *
 * 2. anthropic-messages（Claude 系）：历史 assistant 消息回传 thinking 块 +
 *    signature；签名与上游账号绑定，切换上游后校验失效。
 *
 * 其余 API（openai-completions、google、mistral、bedrock 等）的请求体不含
 * 上游绑定资源，不做处理。
 */

const RESPONSES_ID_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);

const FILTER_HOSTS = Object.freeze(["agentrouter.org", "ps.air-outer.com"]);

/** 精确匹配 HTTPS 端点域名，不能用子串或供应商名称判断请求去向。 */
function matchesFilterEndpoint(baseUrl) {
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && FILTER_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 识别 openai-responses / azure-openai-responses 请求体：顶层有 input 数组。 */
function looksLikeResponsesPayload(payload) {
  return isPlainObject(payload) && Array.isArray(payload.input);
}

/**
 * 识别 anthropic-messages 请求体：顶层有 messages 数组且带 system 字段。
 * openai-completions 也有 messages 但没有顶层 system（system 是 messages 里的一条）。
 */
function looksLikeAnthropicPayload(payload) {
  return isPlainObject(payload) && Array.isArray(payload.messages) && payload.system !== undefined;
}

/**
 * 过滤 openai-responses 请求体。
 * - 删除 input 中所有历史 type:"reasoning" 项（密文 + rs_ ID）。
 * - 删除历史记录项的顶层 id；保留 call_id（工具配对必需）、name、arguments、output、phase。
 * - include 中删除 reasoning.encrypted_content；store 固定 false。
 * - 保留 reasoning.effort/summary（本轮推理强度）、tools、instructions、prompt_cache_key。
 * - 不认识的 item 类型原样保留：若未来出现 item_reference 等服务器资源引用，
 *   让上游报错（大声失败）而不是静默剥离丢上下文。
 */
function filterResponsesPayload(payload) {
  const stats = {
    responsesRequests: 0,
    removedReasoningItems: 0,
    removedItemIds: 0,
    removedIncludeEntries: 0,
  };
  if (!looksLikeResponsesPayload(payload)) {
    return { payload, stats };
  }
  const kept = [];
  for (const item of payload.input) {
    if (isPlainObject(item) && item.type === "reasoning") {
      stats.removedReasoningItems++;
      continue;
    }
    if (
      isPlainObject(item) &&
      RESPONSES_ID_ITEM_TYPES.has(item.type) &&
      typeof item.id === "string" &&
      item.id.length > 0
    ) {
      const { id: _removed, ...rest } = item;
      stats.removedItemIds++;
      kept.push(rest);
      continue;
    }
    kept.push(item);
  }
  const next = { ...payload, input: kept, store: false };
  if (Array.isArray(next.include)) {
    const include = next.include.filter((entry) => entry !== "reasoning.encrypted_content");
    stats.removedIncludeEntries = next.include.length - include.length;
    next.include = include;
  }
  stats.responsesRequests = 1;
  return { payload: next, stats };
}

/**
 * 过滤 anthropic-messages 请求体。
 * - 删除 assistant 消息中所有 thinking / redacted_thinking 块（含 signature）。
 * - 保留 text / tool_use / image 块与 user / tool_result 消息。
 * - 保留 system、tools、thinking:{type:"enabled"}（本轮推理强度）。
 * - 过滤后 content 为空、而原来非空的 assistant 消息（极端情况：纯 thinking 轮）
 *   整条跳过并计入 warnings——删除该消息会破坏 tool_use/tool_result 配对，
 *   污染上下文也不可取，保留原样最安全。
 */
function filterAnthropicPayload(payload) {
  const stats = {
    anthropicRequests: 0,
    removedThinkingBlocks: 0,
    warnings: 0,
  };
  if (!looksLikeAnthropicPayload(payload)) {
    return { payload, stats };
  }
  let changed = false;
  const messages = payload.messages.map((msg) => {
    if (!isPlainObject(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg;
    }
    const content = msg.content.filter((block) => {
      if (isPlainObject(block) && (block.type === "thinking" || block.type === "redacted_thinking")) {
        stats.removedThinkingBlocks++;
        changed = true;
        return false;
      }
      return true;
    });
    if (content.length === 0 && msg.content.length > 0) {
      stats.warnings++;
      return msg;
    }
    return content.length === msg.content.length ? msg : { ...msg, content };
  });
  stats.anthropicRequests = 1;
  return { payload: changed ? { ...payload, messages } : payload, stats };
}

module.exports = {
  FILTER_HOSTS,
  matchesFilterEndpoint,
  looksLikeResponsesPayload,
  looksLikeAnthropicPayload,
  filterResponsesPayload,
  filterAnthropicPayload,
};
