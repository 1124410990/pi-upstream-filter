"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  FILTER_HOSTS,
  matchesFilterEndpoint,
  filterResponsesPayload,
  filterAnthropicPayload,
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
  const result = filterResponsesPayload(payload);
  assert.equal(result.stats.removedReasoningItems, 1);
  assert.equal(result.stats.removedItemIds, 4);
  assert.equal(result.payload.store, false);
  assert.deepEqual(result.payload.include, ["message.output_text.logprobs"]);
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
