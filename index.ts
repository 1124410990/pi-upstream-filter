/**
 * Pi 上游错误恢复扩展（pi-upstream-filter）。
 * 正常请求原样放行；明确的密文/签名/跨资源错误后有界清理请求副本，
 * 使用 agent_before_settle + context_edit 续跑原任务，不发送用户“继续”。
 * 仅处理两个 HTTPS 白名单端点，保留本轮推理、include/store 和历史文件。
 * Token 限流自动继续独立运行，规则不变。/filter 查看统计与协议开关。
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

interface UiLike {
  notify(message: string, level?: "info" | "warning" | "error"): unknown;
}

interface AssistantMessageLike {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  api?: string;
}

type Rejection = import("./filter-core.cjs").CompatibilityRejection;
type FilterResult = import("./filter-core.cjs").FilterResult;
type FilterTarget = "responses" | "anthropic";

interface BoundaryDraftLike {
  type: string;
  targetId?: string;
  replacement?: unknown;
}

interface RequestLike {
  key: string;
  target: FilterTarget;
  payload: unknown;
  rawPayload: unknown;
  rejections: Rejection[];
  status?: number;
  filtered: boolean;
}

interface EventContextLike {
  ui: UiLike;
  model?: { baseUrl?: string; provider?: string; id?: string; api?: string };
  sessionManager?: {
    buildSessionProjection(): {
      entries: { sourceEntry: { id: string }; messages: AssistantMessageLike[] }[];
    };
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  signal?: AbortSignal;
}

interface ExtensionEventsLike {
  before_provider_request: { type: "before_provider_request"; payload: unknown };
  input: { source: string; text: string };
  before_agent_start: { messageType: "user" | "custom" };
  message_start: { message: AssistantMessageLike };
  turn_start: unknown;
  after_provider_response: { status: number };
  turn_end: { message: AssistantMessageLike; messageEntryId?: string };
  agent_before_settle: {
    outcome: "completed" | "aborted" | "error";
    continue: boolean;
    entries?: BoundaryDraftLike[];
    context: {
      pendingMessages: unknown[];
      contextEntries?: { sourceEntry: { id: string }; messages: AssistantMessageLike[] }[];
    };
  };
  agent_settled: { aborted: boolean };
  session_start: unknown;
  session_shutdown: unknown;
  model_select: unknown;
  session_tree: unknown;
  session_compact: unknown;
}

interface ExtensionApiLike {
  on<K extends keyof ExtensionEventsLike>(
    event: K,
    handler: (event: ExtensionEventsLike[K], ctx: EventContextLike) => unknown,
  ): () => void;
  sendUserMessage(content: string, options: { deliverAs: "followUp" }): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: { ui: UiLike }) => void | Promise<void>;
    },
  ): void;
}

interface FilterConfig {
  responses: boolean;
  anthropic: boolean;
}

interface Totals {
  requests: number;
  passedRequests: number;
  compatibleErrors: number;
  recoveryAttempts: number;
  cleanedRequests: number;
  recoverySuccesses: number;
  recoveryFailures: number;
  recoverySkipped: number;
  responsesRequests: number;
  anthropicRequests: number;
  removedReasoningItems: number;
  removedItemIds: number;
  removedThinkingBlocks: number;
  warnings: number;
  errors: number;
  lastFilteredAt: string | null;
}

const DEFAULT_CONFIG: FilterConfig = { responses: true, anthropic: true };
const MAX_AUTO_CONTINUES = 20;
const MAX_COMPATIBILITY_RECOVERIES = 20;

function agentDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.length > 0) return override;
  return home ? `${home}\\.pi\\agent` : ".pi\\agent";
}

function configPath(): string {
  return `${agentDir()}\\pi-upstream-filter.json`;
}

/**
 * PI_FILTER_DEBUG=1 时把每次过滤的数量统计追加到日志（不含请求内容，对应 Codex 版 filter.log 的角色）。
 * 日志失败不阻断会话，也不计入过滤错误（日志是辅助诊断，不是过滤本身）。
 */
function makeDebugLogger(fs: typeof import("node:fs")): (entry: Record<string, unknown>) => void {
  const enabled = process.env.PI_FILTER_DEBUG === "1";
  if (!enabled) return () => {};
  const logPath = `${agentDir()}\\pi-upstream-filter.log`;
  return (entry) => {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      /* 忽略 */
    }
  };
}

async function loadConfig(): Promise<FilterConfig> {
  try {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<FilterConfig>;
    return {
      responses: parsed.responses !== false,
      anthropic: parsed.anthropic !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: FilterConfig): Promise<void> {
  const fs = await import("node:fs");
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function newTotals(): Totals {
  return {
    requests: 0,
    passedRequests: 0,
    compatibleErrors: 0,
    recoveryAttempts: 0,
    cleanedRequests: 0,
    recoverySuccesses: 0,
    recoveryFailures: 0,
    recoverySkipped: 0,
    responsesRequests: 0,
    anthropicRequests: 0,
    removedReasoningItems: 0,
    removedItemIds: 0,
    removedThinkingBlocks: 0,
    warnings: 0,
    errors: 0,
    lastFilteredAt: null,
  };
}

export default async function (pi: ExtensionApiLike) {
  // /reload 后旧的 CJS 命名导出可能仍被缓存；只重新加载本扩展自己的核心模块。
  const require = createRequire(import.meta.url);
  const corePath = require.resolve("./filter-core.cjs");
  delete require.cache[corePath];
  const {
    FILTER_HOSTS,
    matchesFilterEndpoint,
    filterAnthropicPayload,
    filterResponsesPayload,
    looksLikeAnthropicPayload,
    looksLikeResponsesPayload,
    classifyCompatibilityError,
    isTokenRateLimitError,
    isTerminalLimitError,
  } = require(corePath) as typeof import("./filter-core.cjs");
  const fs = await import("node:fs");
  const config = await loadConfig();
  const totals = newTotals();
  const appendDebugLog = makeDebugLogger(fs);
  let autoContinues = 0;
  let afterAutoContinue = false;
  let lastAssistant: AssistantMessageLike | undefined;
  let pendingAutoContinue = false;
  let expectingAutoInput = false;
  let lastRequest: RequestLike | undefined;
  let candidate: { request: RequestLike; rejection: Rejection; entryId?: string } | undefined;
  let recovery: { key: string; target: FilterTarget; rejections: Rejection[]; contextKey: string; started: boolean } | undefined;
  let compatibilityRecoveries = 0;

  const modelKey = (ctx: EventContextLike) => JSON.stringify([
    ctx.model?.baseUrl, ctx.model?.provider, ctx.model?.id, ctx.model?.api,
  ]);
  const contextKey = (entries: { sourceEntry: { id: string }; messages: AssistantMessageLike[] }[]) =>
    createHash("sha256").update(JSON.stringify(entries.flatMap((entry) => {
      const messages = entry.messages.filter((message) => message.role !== "system");
      return messages.length ? [{ id: entry.sourceEntry.id, messages }] : [];
    }))).digest("hex");
  const revokeRecovery = () => {
    lastRequest = undefined;
    candidate = undefined;
    recovery = undefined;
  };
  const resetRecovery = () => {
    revokeRecovery();
    compatibilityRecoveries = 0;
  };
  const clean = (request: RequestLike, rejections: Rejection[]): FilterResult => {
    let payload = request.payload;
    const stats: FilterResult["stats"] = {};
    // 新错误中的 input[N] 以已发送的清理结果为准，旧规则必须先应用，不能回到原始索引。
    for (const rejection of rejections) {
      const result = request.target === "responses"
        ? filterResponsesPayload(payload, rejection) : filterAnthropicPayload(payload);
      payload = result.payload;
      for (const [key, value] of Object.entries(result.stats)) {
        stats[key] = key === "warnings" || key.endsWith("Requests")
          ? Math.max(stats[key] ?? 0, value) : (stats[key] ?? 0) + value;
      }
    }
    return { payload, stats };
  };
  const removedCount = (result: FilterResult) =>
    (result.stats.removedReasoningItems ?? 0) + (result.stats.removedItemIds ?? 0) +
    (result.stats.removedThinkingBlocks ?? 0);
  const log = (action: string, data: Record<string, unknown> = {}) =>
    appendDebugLog({ ts: new Date().toISOString(), action, ...data });
  const filterError = (ctx: EventContextLike) => {
    totals.errors++;
    ctx.ui.notify("错误恢复过滤器异常，保留原请求并停止本次恢复。", "error");
    log("filter-error");
  };

  pi.on("model_select", resetRecovery);
  pi.on("session_tree", resetRecovery);
  pi.on("session_compact", revokeRecovery);
  pi.on("turn_start", () => { lastRequest = undefined; candidate = undefined; });
  pi.on("after_provider_response", (event) => {
    if (lastRequest) lastRequest.status = event.status;
  });

  const resetAutoContinue = () => {
    autoContinues = 0;
    afterAutoContinue = false;
    lastAssistant = undefined;
    pendingAutoContinue = false;
    expectingAutoInput = false;
  };

  pi.on("session_start", () => { resetAutoContinue(); resetRecovery(); });
  pi.on("session_shutdown", () => { resetAutoContinue(); resetRecovery(); });
  pi.on("input", (event) => {
    const ownContinue = expectingAutoInput && event.source === "extension" && event.text === "继续";
    if (ownContinue) revokeRecovery();
    else { resetRecovery(); resetAutoContinue(); }
    expectingAutoInput = false;
    lastAssistant = undefined;
    pendingAutoContinue = false;
  });
  pi.on("before_agent_start", (event) => {
    if (afterAutoContinue && event.messageType === "user") revokeRecovery();
    else resetRecovery();
    if (event.messageType !== "user") resetAutoContinue();
    lastAssistant = undefined;
    pendingAutoContinue = false;
  });
  pi.on("message_start", (event) => {
    // 活跃会话的排队 custom 工作不会再次触发 before_agent_start；按实际开始划分新任务。
    // user 输入已有 input 边界，不能在这里清零扩展自动“继续”的累计预算。
    if (event.message.role === "custom") { resetRecovery(); resetAutoContinue(); }
  });
  pi.on("turn_end", (event, ctx) => {
    const request = lastRequest;
    lastRequest = undefined;
    candidate = undefined;
    const message = event.message;
    if (request && request.key === modelKey(ctx) &&
        (!message.provider || message.provider === ctx.model?.provider) &&
        (!message.model || message.model === ctx.model?.id) &&
        (!message.api || message.api === ctx.model?.api)) {
      if (request.filtered) {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          totals.recoveryFailures++;
          ctx.ui.notify("清理请求尚未成功；后续由宿主原生重试及兼容性恢复预算决定。", "warning");
          log("recovery-failed");
        } else {
          totals.recoverySuccesses++;
          ctx.ui.notify("上游兼容性错误已恢复；下一次请求仍原样发送。", "info");
          log("recovery-success");
        }
      }
      if (message.stopReason === "error") {
        if (isTerminalLimitError(message.errorMessage)) {
          revokeRecovery();
          log("terminal-error");
        } else {
          // 错误中的索引属于真正发送的副本，而不是清理前的历史输入。
          const rejection = classifyCompatibilityError(message.errorMessage, request.payload, request.status);
          if (rejection) {
            totals.compatibleErrors++;
            log("compatibility-error", { kind: rejection.kind });
            candidate = { request, rejection, entryId: event.messageEntryId };
          }
        }
      }
    } else if (recovery) {
      revokeRecovery();
    }
    if (event.message.role === "assistant") {
      lastAssistant = event.message;
      if (event.message.stopReason !== "error") resetRecovery();
      // 自动继续得到成功响应说明限流已恢复：重置预算，后续新中断从头计数。
      // 若继续后立刻再次限流（无任何成功响应），预算继续累计，仍受二十次上限约束。
      if (afterAutoContinue && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        autoContinues = 0;
        afterAutoContinue = false;
      }
    }
    pendingAutoContinue = false;
  });
  pi.on("agent_before_settle", (event, ctx) => {
    pendingAutoContinue = false;
    const pending = candidate;
    candidate = undefined;
    // 此事件在原生重试之后；重复的未启动边界不消费已安排的恢复。
    if (pending || recovery?.started || event.outcome !== "error" || event.continue ||
        event.context.pendingMessages.length > 0 || ctx.hasPendingMessages() || ctx.signal?.aborted) recovery = undefined;
    if (pending && event.outcome === "error" && !event.continue &&
        event.context.pendingMessages.length === 0 && !ctx.hasPendingMessages() &&
        !ctx.signal?.aborted && pending.request.key === modelKey(ctx) && config[pending.request.target]) {
      if (compatibilityRecoveries >= MAX_COMPATIBILITY_RECOVERIES) {
        totals.recoverySkipped++;
        ctx.ui.notify(`兼容性恢复 ${MAX_COMPATIBILITY_RECOVERIES} 次已耗尽，未安排第 ${MAX_COMPATIBILITY_RECOVERIES + 1} 次恢复。`, "warning");
        log("recovery-exhausted");
        return;
      }
      try {
        const rejections = [...pending.request.rejections];
        const known = rejections.some((rejection) => JSON.stringify(rejection) === JSON.stringify(pending.rejection));
        const increment = clean(pending.request, [pending.rejection]);
        const changed = removedCount(increment) > 0;
        // 相同 input[N] 结构可能在旧 reasoning 删除后指向新项；有增量删除就追加顺序规则。
        if (!known || changed) rejections.push(pending.rejection);
        const result = clean({ ...pending.request, payload: pending.request.rawPayload }, rejections);
        totals.warnings += result.stats.warnings ?? 0;
        if (removedCount(result) === 0 || (!known && !changed)) {
          totals.recoverySkipped++;
          ctx.ui.notify("兼容性错误没有可安全清理的历史状态，未重试。", "warning");
          log("recovery-skipped", { kind: pending.rejection.kind });
          return;
        }
        // 使用宿主的公开边界草稿排除失败响应；不改原始消息、不添加用户输入。
        const entries = event.context.contextEntries;
        const failed = entries?.find((entry) => entry.sourceEntry.id === pending.entryId);
        const remaining = entries?.flatMap((entry) =>
          entry === failed ? [] : entry.messages).filter((message) => message.role !== "system");
        if (!pending.entryId || !failed || !remaining?.length || remaining.at(-1)?.role === "assistant") {
          totals.recoverySkipped++;
          ctx.ui.notify("无法确认原任务的可续跑上下文，未安排清理重试。", "warning");
          log("recovery-skipped-context");
          return;
        }
        recovery = {
          key: pending.request.key, target: pending.request.target, rejections,
          contextKey: contextKey(entries!.filter((entry) => entry !== failed)), started: false,
        };
        compatibilityRecoveries++;
        totals.recoveryAttempts++;
        log("recovery-scheduled", { kind: pending.rejection.kind, attempt: compatibilityRecoveries });
        ctx.ui.notify(`检测到 ${pending.rejection.kind}，将清理历史状态并续跑原任务（兼容性恢复 ${compatibilityRecoveries}/${MAX_COMPATIBILITY_RECOVERIES}）。`, "info");
        return {
          entries: [...(event.entries ?? []), {
            type: "context_edit", targetId: pending.entryId, replacement: null,
          }],
          continue: true,
        };
      } catch {
        recovery = undefined;
        filterError(ctx);
        return;
      }
    }
    const errorMessage = lastAssistant?.errorMessage ?? "";
    // 此边界位于宿主重试、压缩和排队工作之后；不在每次 agent_end 时抢先续跑。
    if (event.outcome !== "error" || event.continue || event.context.pendingMessages.length > 0 ||
        ctx.hasPendingMessages() || ctx.signal?.aborted || lastAssistant?.stopReason !== "error" ||
        !isTokenRateLimitError(errorMessage) || isTerminalLimitError(errorMessage)) return;
    if (autoContinues >= MAX_AUTO_CONTINUES) {
      ctx.ui.notify(`自动继续 ${MAX_AUTO_CONTINUES} 次已耗尽，请手动处理限流。`, "warning");
      return;
    }
    pendingAutoContinue = true;
  });
  pi.on("agent_settled", (event, ctx) => {
    revokeRecovery();
    const shouldContinue = pendingAutoContinue;
    pendingAutoContinue = false;
    if (event.aborted || ctx.signal?.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) {
      if (event.aborted || ctx.signal?.aborted) resetRecovery();
      resetAutoContinue();
      return;
    }
    if (!shouldContinue) {
      // 发送后到下一轮响应前没有最终结果；重复 settled 通知不能清零当前预算。
      if (lastAssistant) resetAutoContinue();
      return;
    }
    autoContinues++;
    afterAutoContinue = true;
    expectingAutoInput = true;
    lastAssistant = undefined;
    try {
      // 宿主会将 settled 期间提交的消息延后启动，避免异步入队与结束边界竞争。
      pi.sendUserMessage("继续", { deliverAs: "followUp" });
      ctx.ui.notify(`原生重试已结束，已自动发送：继续（${autoContinues}/${MAX_AUTO_CONTINUES}）。`, "info");
    } catch {
      resetAutoContinue();
      ctx.ui.notify("自动发送“继续”失败，已停止自动续跑。", "error");
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    const attempt = recovery;
    lastRequest = undefined;
    if (!matchesFilterEndpoint(ctx.model?.baseUrl)) { revokeRecovery(); return undefined; }
    const payload = event.payload;
    const target = looksLikeResponsesPayload(payload) ? "responses"
      : looksLikeAnthropicPayload(payload) ? "anthropic" : undefined;
    if (!target || !config[target]) { revokeRecovery(); return undefined; }
    const request: RequestLike = { key: modelKey(ctx), target, payload, rawPayload: payload, rejections: [], filtered: false };
    lastRequest = request;
    totals.requests++;
    try {
      // 后加载的扩展可能加入新工作或改写既有内容；只清理相同的原任务投影。
      const projection = attempt ? ctx.sessionManager?.buildSessionProjection() : undefined;
      if (!attempt || attempt.key !== request.key || attempt.target !== target || !projection ||
          attempt.contextKey !== contextKey(projection.entries) ||
          ctx.signal?.aborted || ctx.hasPendingMessages()) {
        if (attempt) {
          if (ctx.signal?.aborted || attempt.key !== request.key) resetRecovery();
          else revokeRecovery();
          lastRequest = request;
        }
        totals.passedRequests++;
        log("pass", { target });
        return undefined;
      }
      const result = clean(request, attempt.rejections);
      if (removedCount(result) === 0) {
        recovery = undefined;
        totals.passedRequests++;
        totals.recoverySkipped++;
        ctx.ui.notify("恢复请求已无可清理内容，原样发送，不再追加恢复。", "warning");
        log("recovery-no-change");
        return undefined;
      }
      const s = result.stats;
      attempt.started = true;
      request.filtered = true;
      request.payload = result.payload;
      request.rejections = attempt.rejections;
      totals.cleanedRequests++;
      totals.responsesRequests += s.responsesRequests ?? 0;
      totals.anthropicRequests += s.anthropicRequests ?? 0;
      totals.removedReasoningItems += s.removedReasoningItems ?? 0;
      totals.removedItemIds += s.removedItemIds ?? 0;
      totals.removedThinkingBlocks += s.removedThinkingBlocks ?? 0;
      totals.lastFilteredAt = new Date().toISOString();
      if (s.warnings) ctx.ui.notify("部分纯 thinking 消息无法安全清理，已保留原样。", "warning");
      log("filter", { kinds: attempt.rejections.map((rejection) => rejection.kind), ...s });
      return result.payload;
    } catch {
      recovery = undefined;
      totals.passedRequests++;
      filterError(ctx);
      return undefined;
    }
  });

  pi.registerCommand("filter", {
    description: "查看/设置错误后恢复（ responses | anthropic on|off ）",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const target = parts[0];
        const value = parts[1] === "on" || parts[1] === "true";
        if ((target === "responses" || target === "anthropic") && parts[1] !== "on" && parts[1] !== "off") {
          ctx.ui.notify("用法：/filter responses|anthropic on|off", "warning");
          return;
        }
        if (target !== "responses" && target !== "anthropic") {
          ctx.ui.notify("用法：/filter responses|anthropic on|off", "warning");
          return;
        }
        revokeRecovery();
        config[target] = value;
        try {
          await saveConfig(config);
          ctx.ui.notify(`错误后恢复 ${target} = ${value ? "on" : "off"}（已保存）`, "info");
        } catch (error) {
          ctx.ui.notify(
            `已切换 ${target} = ${value ? "on" : "off"}，但保存配置失败：${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }
      if (parts.length === 1) {
        ctx.ui.notify("用法：/filter 查看；/filter responses|anthropic on|off 切换", "info");
        return;
      }
      const lines = [
        `域名白名单（仅 HTTPS、精确匹配）：${FILTER_HOSTS.join(", ")}`,
        `错误后恢复状态：responses=${config.responses ? "on" : "off"}  anthropic=${config.anthropic ? "on" : "off"}`,
        `本会话白名单启用协议请求：${totals.requests}；原样放行：${totals.passedRequests}`,
        `兼容性错误：${totals.compatibleErrors}；逻辑恢复：${totals.recoveryAttempts}；当前任务预算：${compatibilityRecoveries}/${MAX_COMPATIBILITY_RECOVERIES}`,
        `清理请求（含原生重试继承）：${totals.cleanedRequests}（responses=${totals.responsesRequests}, anthropic=${totals.anthropicRequests}）`,
        `  清理响应成功：${totals.recoverySuccesses}  清理响应失败：${totals.recoveryFailures}  未安排/未清理：${totals.recoverySkipped}`,
        `  删除历史 reasoning 项：${totals.removedReasoningItems}`,
        `  清理历史记录 id：${totals.removedItemIds}`,
        `  删除 thinking 块：${totals.removedThinkingBlocks}`,
        `  警告：${totals.warnings}  过滤错误：${totals.errors}`,
        `  最后过滤时间：${totals.lastFilteredAt ?? "无"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
