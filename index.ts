/**
 * Pi 上游过滤扩展（pi-upstream-filter）
 *
 * 借鉴 ccswitch-codex-filter（Codex 专用外部代理）的思路，改为 Pi 进程内实现：
 * 通过 before_provider_request 扩展事件在每次模型请求发出前改写请求体，
 * 删除与上游资源绑定的历史推理内容，避免 CC Switch 等中转切换上游后出现
 * "created under a different resource"、密文解密失败、thinking 签名校验失败等问题。
 *
 * - openai-responses（GPT 系）：删历史 reasoning 项、清历史记录顶层 id（保留 call_id）、
 *   清 include 中的 reasoning.encrypted_content、store:false。
 * - anthropic-messages（Claude 系）：删历史 assistant 消息的 thinking/redacted_thinking 块。
 * - 其他 API 的请求体原样放行。
 *
 * 仅对 agentrouter.org、ps.air-outer.com 的 HTTPS 端点启用；其他端点原样放行。
 * 无端口、无后台进程；修改后 /reload 即生效。/filter 查看统计，/filter responses|anthropic on|off 切换。
 * 配置持久化在 ~/.pi/agent/pi-upstream-filter.json。
 *
 * 代价与风险：删除历史推理会丢失模型前轮的内部推理状态，可能影响复杂任务连续性；
 * 严格按规范要求 reasoning 块的上游可能对缺少 reasoning 的 function_call 报错。
 * 请以 /filter 统计随真实请求增长、且会话正常完成为接入依据。
 */

import { createRequire } from "node:module";

interface UiLike {
  notify(message: string, level?: "info" | "warning" | "error"): unknown;
}

interface ExtensionApiLike {
  on(
    event: "before_provider_request",
    handler: (
      event: { type: "before_provider_request"; payload: unknown },
      ctx: { model?: { baseUrl?: string } },
    ) => unknown,
  ): () => void;
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
  responsesRequests: number;
  anthropicRequests: number;
  removedReasoningItems: number;
  removedItemIds: number;
  removedIncludeEntries: number;
  removedThinkingBlocks: number;
  warnings: number;
  errors: number;
  lastFilteredAt: string | null;
}

const DEFAULT_CONFIG: FilterConfig = { responses: true, anthropic: true };

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
    responsesRequests: 0,
    anthropicRequests: 0,
    removedReasoningItems: 0,
    removedItemIds: 0,
    removedIncludeEntries: 0,
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
  } = require(corePath) as typeof import("./filter-core.cjs");
  const fs = await import("node:fs");
  const config = await loadConfig();
  const totals = newTotals();
  const appendDebugLog = makeDebugLogger(fs);

  pi.on("before_provider_request", (event, ctx) => {
    // 无法确认端点时不猜测中转来源，避免改写其他供应商的历史推理。
    if (!matchesFilterEndpoint(ctx.model?.baseUrl)) return undefined;
    const payload = event.payload;
    try {
      let result: { payload: unknown; stats: Record<string, number> } | undefined;
      if (config.responses && looksLikeResponsesPayload(payload)) {
        result = filterResponsesPayload(payload);
      } else if (config.anthropic && looksLikeAnthropicPayload(payload)) {
        result = filterAnthropicPayload(payload);
      }
      if (!result) return undefined;
      const s = result.stats;
      totals.requests++;
      totals.responsesRequests += s.responsesRequests ?? 0;
      totals.anthropicRequests += s.anthropicRequests ?? 0;
      totals.removedReasoningItems += s.removedReasoningItems ?? 0;
      totals.removedItemIds += s.removedItemIds ?? 0;
      totals.removedIncludeEntries += s.removedIncludeEntries ?? 0;
      totals.removedThinkingBlocks += s.removedThinkingBlocks ?? 0;
      totals.warnings += s.warnings ?? 0;
      if ((s.responsesRequests ?? 0) + (s.anthropicRequests ?? 0) > 0) {
        totals.lastFilteredAt = new Date().toISOString();
      }
      appendDebugLog({ ts: new Date().toISOString(), ...s });
      return result.payload;
    } catch {
      // 过滤逻辑本身出错：保留原请求体放行（不阻断会话），
      // runner 会向用户报告该扩展错误，这里再计数供 /filter 检查。
      totals.errors++;
      return undefined;
    }
  });

  pi.registerCommand("filter", {
    description: "查看/设置上游过滤（ responses | anthropic on|off ）",
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
        config[target] = value;
        try {
          await saveConfig(config);
          ctx.ui.notify(`上游过滤 ${target} = ${value ? "on" : "off"}（已保存）`, "info");
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
        `上游过滤状态：responses=${config.responses ? "on" : "off"}  anthropic=${config.anthropic ? "on" : "off"}`,
        `本会话已过滤请求：${totals.requests}（responses=${totals.responsesRequests}, anthropic=${totals.anthropicRequests}）`,
        `  删除历史 reasoning 项：${totals.removedReasoningItems}`,
        `  清理历史记录 id：${totals.removedItemIds}`,
        `  删除 include 密文项：${totals.removedIncludeEntries}`,
        `  删除 thinking 块：${totals.removedThinkingBlocks}`,
        `  警告：${totals.warnings}  过滤错误：${totals.errors}`,
        `  最后过滤时间：${totals.lastFilteredAt ?? "无"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
