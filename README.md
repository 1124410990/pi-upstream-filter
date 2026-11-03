# pi-upstream-filter

用于 Pi 的进程内兼容性错误恢复扩展，借鉴 CC Switch 的“报错后整流重试”思路。无需监听端口、后台进程或额外运行时依赖。

> 这是兼容性规避方案，不是密文解密工具，也不保证解决全部 Azure OpenAI 400 错误。删除历史内部推理状态可能影响复杂任务的连续表现。

## v0.3.0（源码版本，尚未创建发布标签）

从“每次请求主动剥离”改为“正常请求原样发送，明确兼容性错误后清理重试一次”。

- 不再删除 `include` 中的 `reasoning.encrypted_content`，不再改写 `store`。
- 密文错误只移除历史 reasoning；Azure 跨资源错误才额外清理已知 item ID；ID 格式错误只清理点名项。
- 利用 Pi 的公开结束边界续跑原任务，不额外发送用户“继续”，不改历史推理内容。
- `/filter` 区分原样放行、兼容性错误、清理尝试及恢复结果。
- Token 限流自动继续的五次预算规则保持不变。

`package.json` 已设为 0.3.0，当前分支源码包含新行为，尚未创建对应 Git 发布标签。下面的 v0.2.1 标签安装仍是旧行为，试用新行为请获取当前分支源码后本地加载。

## v0.2.1

调整预算规则：自动“继续”获得成功响应后，五次预算立即重置；若“继续”后立刻再次限流（无任何成功响应），预算继续累计，仍受五次上限约束。

## v0.2.0

新增 Token 限流自动继续：Pi 原生重试耗尽后，每项任务最多自动发送 5 次“继续”；支持取消、人工消息优先及次数耗尽提示。原请求体过滤行为保持不变。

## 支持范围

目前离线验证环境：Windows、Node.js 22.22.3、`@earendil-works/pi-coding-agent` 1.4.0（最低 Node.js 版本按宿主要求为 22.19.0）。其他 Pi 发行版、版本和操作系统尚未验证；当前路径处理按 Windows 实现。

仅在 Pi 当前模型的 `baseUrl` 精确匹配以下 HTTPS 域名时允许错误后恢复：

- `agentrouter.org`
- `ps.air-outer.com`

支持 `/v1` 等 URL 路径，不匹配其他子域名、伪装域名或 HTTP 端点。若 `baseUrl` 指向 localhost 的 CCSwitch 代理，无法自动识别其后端供应商，因此原样放行。模型路由、动态认证端点覆盖及嵌套模型调用尚未验证。

## 错误后一次性恢复

1. 每次新请求先原样发送，保留历史密文、签名和记录 ID。
2. `turn_end` 记录明确的兼容性错误，等待宿主原生重试、压缩和排队工作结束。
3. 在 `agent_before_settle` 确认仍是原任务且有安全可清理内容，通过 `context_edit` 排除**失败响应**，再请求一次上下文续跑。原始失败响应仍保留在原始会话记录、UI 和计费统计中。
4. 仅对这一次恢复请求清理历史状态；同一失败链不再追加第二次剥离重试。成功后下一请求再次原样发送。

| 错误 / 请求 | 恢复请求处理 |
| --- | --- |
| Responses 密文错误：`invalid_encrypted_content`、明确的密文无法验证/解密、密文非当前身份签发、`rs_` 项在 `store:false` 下未保存 | 移除历史 `reasoning` 项，保留其他有效记录 ID |
| Responses 跨资源错误：`created under a different … resource` | 移除历史 `reasoning`，清理普通消息及函数/自定义工具记录的顶层 `id` |
| Responses ID 格式错误：明确点名 `input[N].id` 和所需前缀 | 只清理点名的已知记录项 ID，不移除 reasoning |
| Anthropic Messages 签名无效、thinking 块不可修改、工具链缺少 thinking 前缀等明确错误 | 删除历史 assistant 的 `thinking` / `redacted_thinking`；若会产生空消息，保留该消息并告警 |
| 正常请求、普通参数错误、网络/超时、401/403、429、5xx、其他协议或非白名单端点 | 不剥离；宿主自己的重试规则不变 |

支持普通 HTTP 错误和 HTTP 200 内由宿主规范化的 SSE 错误。不以泛化的 `invalid request` 或单独状态码作为剥离依据；未知措辞会保留错误，不猜测。缺失 HTTP 状态时使用宿主错误文本里的固定前缀和明确措辞。

**即使在恢复请求中，也保留 `include`、`store`、本轮 `reasoning` / `thinking` 配置、消息正文、工具参数和结果、`call_id` / 工具结果关联及嵌套文件资源 ID。** 只清理请求副本，不编辑已有历史推理条目或响应流；会话仅追加失败响应的上下文排除记录。

用户取消、人工消息排队、已有扩展续跑、模型/会话切换、压缩或关闭协议开关时撤销旧恢复状态。恢复请求前再次核对端点、模型、协议和原任务上下文摘要，避免后加载扩展的新工作继承清理。

### 代价与限制

- 旧的不兼容密文仍在历史里；严格“每次先原样发送”可能让后续轮次重复经历一次失败、一次清理恢复，增加延迟和请求开销。不会永久开启整个会话的剥离模式。
- 这里只保证本扩展最多安排一次清理续跑；Pi 和供应商 SDK 对无关瞬态错误的原生重试预算不变，不能把全部 HTTP 请求数理解成最多两次。
- 上游强制要求工具调用携带对应历史 reasoning/thinking 时，清理可能仍失败；不会偷偷关闭本轮 thinking 来换取成功。
- `previous_response_id`、`conversation`、`item_reference`、加密 compaction 等服务器状态引用不会被展开或删除；无法安全清理时明确提示，不做无意义重试。
- WebSocket 缓存续传可能在请求钩子之后追加状态；该场景未验证。
- 同一配置端点/模型并不保证中转内部实际后端不变；不支持推断内部账号路由。
- 过滤器异常时保留原请求、增加错误计数并明确告警，不报告恢复成功，也不提供严格阻断保证。

实现参考：[CC Switch thinking 签名整流器](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src-tauri/src/proxy/thinking_rectifier.rs)、[Responses 密文整流器](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src-tauri/src/proxy/opaque_state_rectifier.rs)。本扩展只移植与 Pi 请求相关的恢复思想，不照搬泛化错误兜底、关闭顶层 thinking 或 Codex 压缩状态处理。

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

GitHub 已发布标签版本安装（`v0.2.1`，仍是始终过滤行为，不含当前源码的 0.3.0 改动）：

```text
pi install git:github.com/1124410990/pi-upstream-filter@v0.2.1
```

在当前 Pi 窗口执行：

```text
/reload
/filter
```

当前源码首次无配置时默认开启 Responses 和 Anthropic **错误后恢复**，`on` 不再表示每次剥离；已有配置中的开关保持不变。若已有手工安装副本，请先通过 `pi config` 禁用它，再安装包，避免重复命令和重复过滤。

Git 标签安装是固定版本，`/reload` 不会升级旧标签。下面仅是旧发布版本之间的升级示例，**不会获得当前源码的 0.3.0 行为**：

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

开关保存在 `%USERPROFILE%\.pi\agent\pi-upstream-filter.json`；设置 `PI_CODING_AGENT_DIR` 时使用该目录。`/filter` 显示白名单、错误后恢复开关、启用协议请求/原样放行数、兼容性错误数、清理尝试与成功/失败/未清理数、实际删除数量。域名外及已关闭协议请求不计入请求统计。重载或重启后计数重置；开关持久化。

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

普通测试共 39 项（包含子测试），覆盖核心分类/清理、热重载、错误恢复状态机及原有自动继续预算。`test:host` 共 22 项（包含子测试）：新恢复套件运行真实 Pi 会话、provider、SDK 序列化与钩子链，只替换 `fetch` 返回离线 HTTP/SSE；验证正常请求保留密文、400/SSE 后一次恢复、工具配对、原历史不变、失败上限、无关原生重试及竞争取消。原自动继续套件替换模型输出且阻止联网，验证 24 次上限和恢复取消。该命令必须设置 `PI_TEST_PACKAGE_DIR`，缺失直接报错，不静默跳过。

已验证的测试不调用实际供应商、不读取真实凭据。实际收费供应商多轮会话、真实压缩链路、WebSocket 和完整 Pi UI 尚未验证。

## GitHub 发布前检查

1. 不要上传 `.pi/agent`、密钥、日志或回滚备份。
2. 运行测试，检查实际暂存内容及 Git 提交作者信息，再提交、推送并创建版本标签。
3. 使用 GitHub noreply 邮箱，避免在新提交中公开私人邮箱。

## 许可证

采用 [MIT](LICENSE) 许可证。仓库：https://github.com/1124410990/pi-upstream-filter 。

`package.json` 的 `private:true` 只防止误发布到 npm，不影响从 GitHub 安装，也不决定 GitHub 仓库的可见性。
