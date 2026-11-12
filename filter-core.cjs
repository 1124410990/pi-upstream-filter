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
 * 其余 API 不在本扩展的处理范围内，不做处理。
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
 * 只识别上游明确点名的兼容性错误；状态码、invalid request 本身不是触发依据。
 * HTTP 200 可承载 SSE 错误；缺失状态时仅接受 SDK 的行首状态码/格式化前缀。
 */
function classifyCompatibilityError(errorMessage, payload, status) {
  if (typeof errorMessage !== "string" || !errorMessage) return undefined;
  const prefixStatus = /^\s*(?:[^\n]* API error \((\d{3})\):|(\d{3})\b)/.exec(errorMessage);
  const httpStatus = status ?? (prefixStatus ? Number(prefixStatus[1] ?? prefixStatus[2]) : undefined);
  if (httpStatus !== undefined && httpStatus !== 200 &&
      (httpStatus < 400 || httpStatus >= 500 || [401, 403, 429].includes(httpStatus))) return undefined;
  const text = errorMessage.toLowerCase();
  if (/authentication|authorization|invalid api key|insufficient_quota|quota exceeded|billing|available balance|rate[\s_-]*limit|too many requests|timeout|connection refused/.test(text)) {
    return undefined;
  }
  if (looksLikeResponsesPayload(payload)) {
    if (text.includes("created under a different") && text.includes("resource")) {
      return { kind: "responses-resource", reasoning: true, itemIds: true };
    }
    const invalidId = /invalid\s+['`"]input\[(\d+)\]\.id['`"][\s\S]*expected an id that begins with/.exec(text);
    if (invalidId) {
      return { kind: "responses-id", reasoning: false, itemIds: true, itemIndex: Number(invalidId[1]) };
    }
    if (/\binvalid_encrypted_content\b/.test(text) ||
        (text.includes("encrypted content") && text.includes("could not be verified")) ||
        (text.includes("was not issued to this caller") && /encrypted_content|reasoning/.test(text)) ||
        (text.includes("encrypted_content") && /could not decrypt|could not be decrypted/.test(text)) ||
        (text.includes("not found") && text.includes("items are not persisted when") && /\brs_/.test(text))) {
      return { kind: "responses-encrypted", reasoning: true, itemIds: false };
    }
  } else if (looksLikeAnthropicPayload(payload)) {
    if ((text.includes("signature") && /thinking|thought/.test(text) &&
         /invalid|not valid|verification failed/.test(text)) ||
        (/\bsignature\b/.test(text) && /field required|extra inputs are not permitted/.test(text) &&
         /messages[.\[]|thinking/.test(text))) {
      return { kind: "anthropic-signature" };
    }
    if ((/thinking|redacted_thinking/.test(text) && text.includes("cannot be modified")) ||
        text.includes("must start with a thinking block") ||
        (text.includes("expected") && /thinking|redacted_thinking/.test(text) &&
         text.includes("found") && text.includes("tool_use"))) {
      return { kind: "anthropic-thinking" };
    }
  }
  return undefined;
}

const TOKEN_RATE_LIMIT = /\btoken(?:s)?[\s_-]+rate[\s_-]+limit\b/i;
// 持久性账号限制不能靠“继续”恢复，即使错误正文同时提及 Token 限流。
const TERMINAL_LIMIT_ERROR = /\b(?:401|403)\b|authentication|authorization|invalid api key|insufficient_quota|quota exceeded|billing|available balance|out of budget|usage_limit_exceeded|(?:monthly|daily|weekly) usage limit|GoUsageLimitError|FreeUsageLimitError/i;

/** Token 限流措辞判定（Pi 自动继续与 Claude Code 代理限流重试共用）。 */
function isTokenRateLimitError(message) {
  return typeof message === "string" && TOKEN_RATE_LIMIT.test(message);
}

/** 终态账号限制措辞（鉴权/配额/余额类），重试或“继续”都无法恢复。 */
function isTerminalLimitError(message) {
  return typeof message === "string" && TERMINAL_LIMIT_ERROR.test(message);
}

/**
 * 仅在错误恢复时清理 Responses 历史状态，不修改 include/store/本轮 reasoning。
 * 密文错误只移除 reasoning；跨资源错误同时清理已知记录的 id；格式错误只清理点名项。
 * 未知类型（包括 item_reference）保留，不能通过删除唯一引用来丢弃上下文。
 */
function filterResponsesPayload(payload, options = { reasoning: true, itemIds: false }) {
  const stats = {
    responsesRequests: 0,
    removedReasoningItems: 0,
    removedItemIds: 0,
  };
  if (!looksLikeResponsesPayload(payload)) {
    return { payload, stats };
  }
  const kept = [];
  for (const [index, item] of payload.input.entries()) {
    if (options.reasoning && isPlainObject(item) && item.type === "reasoning") {
      stats.removedReasoningItems++;
      continue;
    }
    if (
      options.itemIds && (options.itemIndex === undefined || options.itemIndex === index) &&
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
  stats.responsesRequests = 1;
  const changed = stats.removedReasoningItems + stats.removedItemIds > 0;
  return { payload: changed ? { ...payload, input: kept } : payload, stats };
}

/**
 * 过滤 anthropic-messages 请求体。
 * - 删除 assistant 消息中所有 thinking / redacted_thinking 块（含 signature）。
 * - 保留 text / tool_use / image 块与 user / tool_result 消息。
 * - 保留 system、tools、thinking:{type:"enabled"}（本轮推理强度）。
 * - 过滤后 content 为空的 assistant 消息保留原样并计入 warnings，
 *   不发送空消息，不把实际保留的块计入删除数量。
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
    const content = msg.content.filter((block) =>
      !isPlainObject(block) || (block.type !== "thinking" && block.type !== "redacted_thinking"));
    if (content.length === 0 && msg.content.length > 0) {
      stats.warnings++;
      return msg;
    }
    if (content.length === msg.content.length) return msg;
    stats.removedThinkingBlocks += msg.content.length - content.length;
    changed = true;
    return { ...msg, content };
  });
  stats.anthropicRequests = 1;
  return { payload: changed ? { ...payload, messages } : payload, stats };
}

module.exports = {
  FILTER_HOSTS,
  matchesFilterEndpoint,
  looksLikeResponsesPayload,
  looksLikeAnthropicPayload,
  classifyCompatibilityError,
  isTokenRateLimitError,
  isTerminalLimitError,
  filterResponsesPayload,
  filterAnthropicPayload,
};
