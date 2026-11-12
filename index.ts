/**
 * Pi 上游错误恢复扩展（pi-upstream-filter）。
 * 正常请求原样放行；明确的密文/签名/跨资源错误后只清理一次请求副本，
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
  let recovery: { key: string; target: FilterTarget; rejection: Rejection; contextKey: string } | undefined;
  let recoveryUsed = false;

  const modelKey = (ctx: EventContextLike) => JSON.stringify([
    ctx.model?.baseUrl, ctx.model?.provider, ctx.model?.id, ctx.model?.api,
  ]);
  const contextKey = (entries: { sourceEntry: { id: string }; messages: AssistantMessageLike[] }[]) =>
    createHash("sha256").update(JSON.stringify(entries.flatMap((entry) => {
      const messages = entry.messages.filter((message) => message.role !== "system");
      return messages.length ? [{ id: entry.sourceEntry.id, messages }] : [];
    }))).digest("hex");
  const resetRecovery = () => {
    lastRequest = undefined;
    candidate = undefined;
    recovery = undefined;
    recoveryUsed = false;
  };
  const clean = (request: RequestLike, rejection: Rejection): FilterResult =>
    request.target === "responses"
      ? filterResponsesPayload(request.payload, rejection)
      : filterAnthropicPayload(request.payload);
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
  pi.on("session_compact", resetRecovery);
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
    resetRecovery();
    const ownContinue = expectingAutoInput && event.source === "extension" && event.text === "继续";
    if (!ownContinue) resetAutoContinue();
    expectingAutoInput = false;
    lastAssistant = undefined;
    pendingAutoContinue = false;
  });
  pi.on("before_agent_start", (event) => {
    resetRecovery();
    if (event.messageType !== "user") resetAutoContinue();
    lastAssistant = undefined;
    pendingAutoContinue = false;
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
          ctx.ui.notify("清理重试未成功，不再为本次失败安排剥离重试。", "warning");
          log("recovery-failed");
        } else {
          totals.recoverySuccesses++;
          ctx.ui.notify("上游兼容性错误已恢复；下一次请求仍原样发送。", "info");
          log("recovery-success");
        }
      }
      if (message.stopReason === "error") {
        const rejection = classifyCompatibilityError(message.errorMessage, request.payload, request.status);
        if (rejection) {
          totals.compatibleErrors++;
          log("compatibility-error", { kind: rejection.kind });
          if (!recoveryUsed) candidate = { request, rejection, entryId: event.messageEntryId };
        }
      } else if (message.stopReason !== "aborted") {
        recoveryUsed = false;
      }
    }
    if (event.message.role === "assistant") {
      lastAssistant = event.message;
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
    if (pending && !recoveryUsed && event.outcome === "error" && !event.continue &&
        event.context.pendingMessages.length === 0 && !ctx.hasPendingMessages() &&
        !ctx.signal?.aborted && pending.request.key === modelKey(ctx) && config[pending.request.target]) {
      recoveryUsed = true;
      try {
        const result = clean(pending.request, pending.rejection);
        totals.warnings += result.stats.warnings ?? 0;
        if (removedCount(result) === 0) {
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
          key: pending.request.key, target: pending.request.target, rejection: pending.rejection,
          contextKey: contextKey(entries!.filter((entry) => entry !== failed)),
        };
        log("recovery-scheduled", { kind: pending.rejection.kind });
        ctx.ui.notify(`检测到 ${pending.rejection.kind}，将清理历史状态并重试原任务一次。`, "info");
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
    resetRecovery();
    const shouldContinue = pendingAutoContinue;
    pendingAutoContinue = false;
    if (event.aborted || ctx.signal?.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) {
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
    recovery = undefined;
    lastRequest = undefined;
    if (!matchesFilterEndpoint(ctx.model?.baseUrl)) return undefined;
    const payload = event.payload;
    const target = looksLikeResponsesPayload(payload) ? "responses"
      : looksLikeAnthropicPayload(payload) ? "anthropic" : undefined;
    if (!target || !config[target]) return undefined;
    const request: RequestLike = { key: modelKey(ctx), target, payload, filtered: false };
    lastRequest = request;
    totals.requests++;
    try {
      // 后加载的扩展可能加入新工作或改写既有内容；只清理相同的原任务投影。
      const projection = attempt ? ctx.sessionManager?.buildSessionProjection() : undefined;
      if (!attempt || attempt.key !== request.key || attempt.target !== target || !projection ||
          attempt.contextKey !== contextKey(projection.entries) ||
          ctx.signal?.aborted || ctx.hasPendingMessages()) {
        totals.passedRequests++;
        log("pass", { target });
        return undefined;
      }
      const result = clean(request, attempt.rejection);
      if (removedCount(result) === 0) {
        totals.passedRequests++;
        totals.recoverySkipped++;
        ctx.ui.notify("恢复请求已无可清理内容，原样发送，不再追加恢复。", "warning");
        log("recovery-no-change");
        return undefined;
      }
      const s = result.stats;
      request.filtered = true;
      totals.recoveryAttempts++;
      totals.responsesRequests += s.responsesRequests ?? 0;
      totals.anthropicRequests += s.anthropicRequests ?? 0;
      totals.removedReasoningItems += s.removedReasoningItems ?? 0;
      totals.removedItemIds += s.removedItemIds ?? 0;
      totals.removedThinkingBlocks += s.removedThinkingBlocks ?? 0;
      totals.lastFilteredAt = new Date().toISOString();
      if (s.warnings) ctx.ui.notify("部分纯 thinking 消息无法安全清理，已保留原样。", "warning");
      log("filter", { kind: attempt.rejection.kind, ...s });
      return result.payload;
    } catch {
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
        resetRecovery();
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
        `兼容性错误：${totals.compatibleErrors}；清理重试：${totals.recoveryAttempts}（responses=${totals.responsesRequests}, anthropic=${totals.anthropicRequests}）`,
        `  恢复成功：${totals.recoverySuccesses}  失败：${totals.recoveryFailures}  未安排/未清理：${totals.recoverySkipped}`,
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
