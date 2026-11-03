"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  FILTER_HOSTS,
  matchesFilterEndpoint,
  filterResponsesPayload,
  filterAnthropicPayload,
  classifyCompatibilityError,
} = require("../filter-core.cjs");

test("只允许用户指定的两个 HTTPS 域名，不能按 URL 子串误匹配", () => {
  assert.deepEqual(FILTER_HOSTS, ["agentrouter.org", "ps.air-outer.com"]);
  for (const url of [
    "https://agentrouter.org",
    "https://agentrouter.org/v1",
    "https://AGENTROUTER.ORG/v1/responses",
    "https://ps.air-outer.com/v1",
  ]) assert.equal(matchesFilterEndpoint(url), true, url);
  for (const url of [
    undefined, null, "", "agentrouter.org", "not a URL",
    "http://agentrouter.org/v1",
    "https://api.agentrouter.org/v1",
    "https://agentrouter.org.evil.test/v1",
    "https://agentrouter.org@evil.test/v1",
    "https://evil.test/agentrouter.org",
    "https://evil.test/?upstream=ps.air-outer.com",
    "https://open.bigmodel.cn/api/anthropic",
    "http://127.0.0.1:15721/v1",
  ]) assert.equal(matchesFilterEndpoint(url), false, String(url));
});

test("清除资源绑定状态而不破坏工具配对、本轮推理和业务内容", () => {
  const payload = {
    model: "mock", store: true, stream: true,
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
    input: [
      { type: "reasoning", id: "rs_old", encrypted_content: "mock-opaque" },
      { type: "message", id: "msg_old", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "keep" }] },
      { type: "function_call", id: "fc_old", call_id: "call_keep", name: "read", arguments: '{"id":"business_keep"}' },
      { type: "function_call_output", id: "fco_old", call_id: "call_keep", output: "result_keep" },
      { type: "message", id: "msg_file", role: "user", content: [{ type: "input_file", file_id: "file_keep" }] },
    ],
  };
  const before = JSON.stringify(payload);
  const result = filterResponsesPayload(payload, {reasoning: true, itemIds: true});
  assert.equal(result.stats.removedReasoningItems, 1);
  assert.equal(result.stats.removedItemIds, 4);
  assert.equal(result.payload.store, true);
  assert.deepEqual(result.payload.include, payload.include);
  assert.ok(result.payload.input.every(item => item.id === undefined && item.type !== "reasoning"));
  assert.equal(result.payload.input[1].call_id, result.payload.input[2].call_id);
  assert.equal(result.payload.input[1].arguments, payload.input[2].arguments);
  assert.equal(result.payload.input[2].output, "result_keep");
  assert.equal(result.payload.input[0].phase, "final_answer");
  assert.equal(result.payload.input[3].content[0].file_id, "file_keep");
  assert.deepEqual(result.payload.reasoning, payload.reasoning);
  assert.equal(JSON.stringify(payload), before);
  assert.equal(filterResponsesPayload(result.payload).stats.removedItemIds, 0);
  assert.equal(filterResponsesPayload(result.payload).stats.removedReasoningItems, 0);
});

test("未知资源引用不得静默删除，否则会丢失服务器保存的上下文", () => {
  const reference = { type: "item_reference", id: "server_owned" };
  const result = filterResponsesPayload({ input: [reference] });
  assert.equal(result.payload.input[0], reference);
});

test("Anthropic 过滤保留当前 thinking 配置和工具调用结果", () => {
  const payload = {
    system: "keep", thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "old", signature: "old" },
        { type: "redacted_thinking", data: "old" },
        { type: "tool_use", id: "tool_keep", name: "read", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_keep", content: "keep" }] },
    ],
  };
  const before = JSON.stringify(payload);
  const result = filterAnthropicPayload(payload);
  assert.equal(result.stats.removedThinkingBlocks, 2);
  assert.equal(result.payload.messages[0].content[0].id, result.payload.messages[1].content[0].tool_use_id);
  assert.deepEqual(result.payload.thinking, payload.thinking);
  assert.equal(JSON.stringify(payload), before);
});

test("错误分类必须点名历史密文或签名，不能用无关错误降级上下文", () => {
  const responses = {input: []};
  const anthropic = {system: "", messages: []};
  for (const message of [
    '400 {"error":{"code":"invalid_encrypted_content","message":"bad"}}',
    "The encrypted content gAAA could not be verified.",
    "reasoning `encrypted_content` was not issued to this caller",
    "Could not decrypt the provided encrypted_content",
    "Item with id 'rs_old' not found. Items are not persisted when store is false.",
  ]) assert.equal(classifyCompatibilityError(message, responses)?.kind, "responses-encrypted", message);
  assert.equal(classifyCompatibilityError("created under a different Azure OpenAI resource", responses)?.kind,
    "responses-resource");
  assert.deepEqual(classifyCompatibilityError("Invalid 'input[2].id': bad. Expected an ID that begins with 'msg'", responses),
    {kind: "responses-id", reasoning: false, itemIds: true, itemIndex: 2});
  for (const message of [
    "Invalid `signature` in `thinking` block", "Thought signature is not valid",
    '400 {"error":{"message":"messages.1.content.0.signature: Field required"}}',
  ]) assert.equal(classifyCompatibilityError(message, anthropic)?.kind, "anthropic-signature", message);
  assert.equal(classifyCompatibilityError("thinking or redacted_thinking blocks cannot be modified", anthropic)?.kind,
    "anthropic-thinking");
  for (const message of [
    "invalid request", "400 malformed JSON", "429 too many requests", "500 server error",
    "401 authentication failed", "insufficient_quota", "token rate limit", "Request timeout",
    "Expected thinking, found text", "signature: Field required", "Invalid input_file",
    "500 invalid_encrypted_content", "403 invalid_encrypted_content", "429 invalid_encrypted_content",
    "Request timeout: invalid_encrypted_content", "OpenAI API error (500): invalid_encrypted_content",
  ]) {
    assert.equal(classifyCompatibilityError(message, responses), undefined, message);
    assert.equal(classifyCompatibilityError(message, anthropic), undefined, message);
  }
  assert.equal(classifyCompatibilityError("invalid_encrypted_content", responses, 500), undefined);
  assert.equal(classifyCompatibilityError("invalid_encrypted_content", responses, 200)?.kind, "responses-encrypted");
  assert.equal(classifyCompatibilityError("invalid_encrypted_content", anthropic), undefined);
});

test("密文拒绝保留有效 ID，ID 格式拒绝只清理点名项，不扩大剥离范围", () => {
  const payload = {input: [
    {type: "reasoning", id: "rs_old", encrypted_content: "opaque"},
    {type: "message", id: "msg_good", content: []},
    {type: "function_call", id: "foreign_fc", call_id: "pair", arguments: "{}"},
  ], include: ["reasoning.encrypted_content"], store: false};
  const encrypted = filterResponsesPayload(payload);
  assert.equal(encrypted.payload.input[0].id, "msg_good");
  assert.equal(encrypted.stats.removedItemIds, 0);
  const idOnly = filterResponsesPayload(payload, {reasoning: false, itemIds: true, itemIndex: 2});
  assert.equal(idOnly.payload.input[0], payload.input[0]);
  assert.equal(idOnly.payload.input[1], payload.input[1]);
  assert.equal(idOnly.payload.input[2].id, undefined);
  assert.equal(idOnly.payload.input[2].call_id, "pair");
  assert.equal(idOnly.stats.removedReasoningItems, 0);
});

test("纯 thinking 消息保留并告警，不虚报已删除的块", () => {
  const payload = {system: "", messages: [
    {role: "assistant", content: [{type: "thinking", signature: "opaque", thinking: "old"}]},
  ]};
  const result = filterAnthropicPayload(payload);
  assert.equal(result.payload, payload);
  assert.equal(result.stats.warnings, 1);
  assert.equal(result.stats.removedThinkingBlocks, 0);
});
