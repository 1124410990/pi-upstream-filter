# pi-upstream-filter

用于 Pi 的进程内请求过滤扩展，借鉴 `ccswitch-codex-filter` 的历史推理与记录 ID 清理思路。无需监听端口、后台进程或额外运行时依赖。

> 这是兼容性规避方案，不是密文解密工具，也不保证解决全部 Azure OpenAI 400 错误。删除历史内部推理状态可能影响复杂任务的连续表现。

## v0.2.1

调整预算规则：自动“继续”获得成功响应后，五次预算立即重置；若“继续”后立刻再次限流（无任何成功响应），预算继续累计，仍受五次上限约束。

## v0.2.0

新增 Token 限流自动继续：Pi 原生重试耗尽后，每项任务最多自动发送 5 次“继续”；支持取消、人工消息优先及次数耗尽提示。原请求体过滤行为保持不变。

## 支持范围

目前离线验证环境：Windows、Node.js 22.22.3、`@earendil-works/pi-coding-agent` 1.4.0（最低 Node.js 版本按宿主要求为 22.19.0）。其他 Pi 发行版、版本和操作系统尚未验证；当前路径处理按 Windows 实现。

仅在 Pi 当前模型的 `baseUrl` 精确匹配以下 HTTPS 域名时过滤：

- `agentrouter.org`
- `ps.air-outer.com`

支持 `/v1` 等 URL 路径，不匹配其他子域名、伪装域名或 HTTP 端点。若 `baseUrl` 指向 localhost 的 CCSwitch 代理，无法自动识别其后端供应商，因此原样放行。模型路由、动态认证端点覆盖及嵌套模型调用尚未验证。

## 过滤内容

| 请求类型 | 处理 |
| --- | --- |
| Responses（顶层 `input` 数组） | 删除历史 `reasoning` 项；清理普通消息和函数/自定义工具记录的顶层 `id`；从 `include` 删除 `reasoning.encrypted_content`；设置 `store:false` |
| Anthropic Messages（顶层 `messages` 和 `system`） | 删除历史 assistant 消息的 `thinking` / `redacted_thinking` 块；若删除后消息为空，保留原消息并记录警告 |
| 其他请求类型或非白名单端点 | 原样放行 |

保留本轮推理配置、消息内容、工具参数和结果、`call_id` / 工具结果关联及嵌套文件资源 ID。只修改请求副本，不重写 Pi 历史文件或响应流。

以下情况仍可能失败：

- 上游强制要求工具调用携带对应历史 reasoning。
- `previous_response_id`、`conversation`、`item_reference`、加密 compaction 等服务器状态引用。本扩展不会把它们展开，也不会像原 Codex HTTP 代理那样主动拒绝转发。
- WebSocket 缓存续传可能在请求钩子之后追加状态；该场景未验证。
- Token 速率限流：原生重试耗尽后最多自动发送 5 次“继续”，仍可能无法恢复；其他 429、配额不足、鉴权错误和服务商不可用不触发此功能。
- 过滤器异常时保留原请求、增加错误计数，并不提供严格阻断保证。

## Token 限流自动继续

当最后一次模型响应报 `token rate limit`（也匹配 `token_rate_limit` / `token-rate-limit`）时，先等待 Pi 原生重试、压缩和已有排队工作结束，再自动提交真实用户消息“继续”。不模拟键盘，不覆盖输入框草稿，不修改 Pi 的重试配置或额外增加等待。

- 每项任务累计最多自动发送 **5 次**；原始任务不计入这 5 次。每次“继续”仍由 Pi 执行自己的重试策略。
- 默认三次原生重试下，持续失败最多为 **24 次模型请求**：原任务及 5 次“继续”，每轮首次请求加三次重试。达到上限后明确提示耗尽，不再发送第六次。
- 自动“继续”后的成功响应会立即重置五次预算，进度中的任务通遇新中断从头计数；若“继续”后立刻再次限流（没有任何成功响应），预算继续累计，仍受五次上限约束。任务最终完成、主动取消、用户手动提交新消息（含手动“继续”）、切换会话或 `/reload` 会结束旧计数链。
- 正常完成、非 Token 速率错误、鉴权失败和已识别的余额/配额不足不触发。已排队的人工消息和其他续跑优先。
- 每次发送会显示 `继续（1/5）` 等通知；关闭或重载扩展不会安排后台续跑。

此功能与请求体过滤分开，**不受上述过滤域名白名单和 Responses/Anthropic 开关限制**。自动发送“继续”不能解除服务商限流，仍可能全部失败并增加请求和费用；需要停止时按 Escape 取消当前任务。只安装一个扩展副本，避免重复续跑。

使用 Pi 1.4.0 的 `agent_before_settle` / `agent_settled` 事件及 `sendUserMessage` API；其他版本尚未验证。

## 安装

本地试用：

```powershell
pi --no-extensions --extension ./index.ts
```

`--no-extensions` 用于避免本机已安装副本与试用副本重复注册 `/filter`，仅对本次运行有效。

GitHub 安装（使用本次发布的 `v0.2.1` 标签）：

```text
pi install git:github.com/1124410990/pi-upstream-filter@v0.2.1
```

在当前 Pi 窗口执行：

```text
/reload
/filter
```

首次无配置时默认开启 Responses 和 Anthropic 过滤；已有配置中的开关保持不变。若已有手工安装副本，请先通过 `pi config` 禁用它，再安装包，避免重复命令和重复过滤。

Git 标签安装是固定版本，`/reload` 不会升级旧标签。从旧版本升级请在终端执行：

```text
pi remove git:github.com/1124410990/pi-upstream-filter@v0.2.0
pi install git:github.com/1124410990/pi-upstream-filter@v0.2.1
```

然后回到 Pi 窗口执行 `/reload`。本地路径安装只需更新对应源码后 `/reload`。

## 配置与统计

```text
/filter
/filter responses on
/filter responses off
/filter anthropic on
/filter anthropic off
```

开关保存在 `%USERPROFILE%\.pi\agent\pi-upstream-filter.json`；设置 `PI_CODING_AGENT_DIR` 时使用该目录。`/filter` 显示白名单、开关及本次扩展运行的计数。重载或重启后计数重置；开关持久化。

白名单目前固定在 `filter-core.cjs` 的 `FILTER_HOSTS` 中。修改后同步调整域名测试，再 `/reload`。

`PI_FILTER_DEBUG=1` 是本扩展自定义环境变量，可在启动 Pi 前设置，启用数量日志。日志不包含请求正文、密文或鉴权头，写入上述配置目录的 `pi-upstream-filter.log`。

卸载 GitHub 包时使用与安装相同的 source：

```text
pi remove git:github.com/1124410990/pi-upstream-filter@v0.2.1
```

然后 `/reload`。个人开关和诊断日志不属于包源码，可自行保留。

## 开发与测试

只测试过滤、加载和自动续跑，不调用收费模型。测试会清理自己创建的临时目录，不修改用户配置。

普通开发环境安装测试依赖（不安装宿主 peer、不执行依赖生命周期脚本）：

```powershell
npm install --ignore-scripts --legacy-peer-deps
npm test
npm run check
```

已安装 Pi 的环境也可直接使用其实际 jiti 加载器，无需安装依赖：

```powershell
$env:PI_TEST_PACKAGE_DIR = "<本机 pi-coding-agent 的安装目录>"
npm test
npm run test:host
npm run check
```

普通测试包含 4 项核心测试、2 项热重载回归测试和 7 项自动继续回归测试（含成功响应重置预算与重复结束通知不重置）。`test:host` 另有 2 项真实 Pi 会话离线测试，替换模型输出且阻止联网，验证三次重试后发送、五次上限、恢复成功及取消。该命令必须设置 `PI_TEST_PACKAGE_DIR`，缺失直接报错，不静默跳过。实际供应商多轮会话、长会话压缩和完整 Pi UI 尚需自行验证。

## GitHub 发布前检查

1. 不要上传 `.pi/agent`、密钥、日志或回滚备份。
2. 运行测试，检查实际暂存内容及 Git 提交作者信息，再提交、推送并创建版本标签。
3. 使用 GitHub noreply 邮箱，避免在新提交中公开私人邮箱。

## 许可证

采用 [MIT](LICENSE) 许可证。仓库：https://github.com/1124410990/pi-upstream-filter 。

`package.json` 的 `private:true` 只防止误发布到 npm，不影响从 GitHub 安装，也不决定 GitHub 仓库的可见性。
