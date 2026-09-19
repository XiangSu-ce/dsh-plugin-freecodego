# 免费模型 Provider 接入（Host 侧契约）

把第三方平台变成插件内可选的本地 Provider：用该平台自己的账号凭证，调度它对外免费的那些模型。本文覆盖两个已接入的平台 —— **Cline**（`api.cline.bot`）与 **WorkBuddy 国际版**（`workbuddy.ai`）—— 以及两者共用的一套池语义。与 Agnes / B.AI 那类「平台凭证 + 免费模型」接入同构，区别在于这两个平台都要**多账号轮询**，而额度按模型（Cline）或按账号（WorkBuddy）发放。

## 共同约束：为什么它们各自写适配器，而不是复用 `OpenAiCompatibleAdapter`

`OpenAiCompatibleAdapter` 每条流只解析一次静态连接，而免费额度的路由是**池决策**，必须发生在**一次 turn 内**：

- `401`：凭证真的坏了，先丢弃缓存令牌（或强刷一次），仍失败才停放该账号；
- `402 / 403 / 429`：凭证没坏，是额度或限流 —— 换下一个账号继续同一轮对话，并按上游返回的 `Retry-After` / `Try again in 17h 59m` 这类恢复时间停放；
- 全部账号失败才抛出各自的 `ClineUpstreamError(status, detail, { model, retryAfterMs })` / `WorkBuddyIntlError(status, detail)`。

因此两个适配器 —— `ClineAdapter` 与 `WorkBuddyIntlAdapter` —— 都自己序列化请求（复用 `openai-wire.ts`），而不是套一层静态连接。

**错误映射是硬要求**：把额度问题报成 `AUTH`，对话界面就会显示「API 密钥无效」，与实际原因完全不符。`401` / `WORKBUDDY_LOGIN_REQUIRED` → `AUTH`，`402 / 403 / 429` → `RATE_LIMIT`，`>= 500` → `SERVER`。

停放与凭证的口径一致：**凭证失效的账号不会被自动删除**，只有用户点「移除」才从池里消失；到期的停放（`coolingUntil` 一类时间戳）**在读取时就被丢弃**，卡片不会拿着过期的恢复时间一直显示「已限流，约 0 分钟后恢复」。

## Cline

### 上游契约（已核对 Cline 官方客户端与 Cline-proxy 参考实现）

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 聊天 | `POST https://api.cline.bot/api/v1/chat/completions` | OpenAI 兼容，SSE；带 `X-Task-ID` 与 body 内 `session_id` |
| 免费模型目录 | `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` | 需鉴权；返回 `{ free: [{ id, name, description, tags }] }` |
| 刷新令牌 | `POST https://api.cline.bot/api/v1/auth/refresh` | `{ refreshToken, grantType: 'refresh_token' }` → `{ data: { accessToken, refreshToken, expiresAt, userInfo? } }` |
| 设备登录授权 | `POST https://api.workos.com/user_management/authorize/device` | `client_id=client_01K3A541FN8TA3EPPHTD2325AR`（官方客户端同一公开 id） |
| 设备登录轮询 | `POST https://api.workos.com/user_management/authenticate` | `grant_type=urn:ietf:params:oauth:grant-type:device_code` |
| 注册 Cline 令牌 | `POST https://api.cline.bot/api/v1/auth/register` | `{ accessToken, refreshToken }`（WorkOS 令牌换 Cline 令牌），返回 `userInfo.email` |

鉴权头是 **`Authorization: Bearer workos:<accessToken>`** —— 前缀 `workos:` 是上游要求的一部分，漏掉它会被判为无效凭证。这点与普通 OpenAI 兼容 Provider 不同，是它不复用 `OpenAiCompatibleAdapter` 的第二个理由。

调用默认发送 `reasoning_effort: 'high'` 与 `max_tokens: 128000`（参考实现同值）。

### 额度按模型发放，停放也按模型

免费额度是**按模型**发放的，所以 `deepseek/deepseek-v4-flash` 用完不会把 `zhipu/glm-5.3-flash` 一起停掉：账号在设置卡片里仍是「可用，参与轮询」，只是多出一行 `coolingModels: [{ model, until }]`。只有 `402`（账号自己的付款状态）或请求体里没有 `model` 时才停放整个账号。

### 账号池与凭证

- 仅存 Harness Host 保险库，引用为 `CLINE_AUTH`：`{ accounts: [{ id, email?, refreshToken, accessToken?, expiresAt?, cooldownUntil?, note? }], activeAccountId? }`。
- 浏览器只拿到 `ClineStatus`（账号状态 + 免费模型列表），令牌与刷新令牌不出 Host。
- 账号状态语义：`active` 参与轮询、`cooling` 账号级停放（带恢复时间）、`reauth-required` 凭证失效（**保留可见**，让用户知道是哪个账号要重新授权，而不是静默移除）。

### 免费模型目录

- 目录**实时读取**推荐列表，不硬编码；升到免费的模型无需插件更新即可选择。
- **仅实时**：上游不可达或未登录时返回**空列表**，不再回落到任何种子 id。伪造的模型 id 会在每次调用时 4xx，展示空比展示假更诚实；原生选择器里 Cline 分组随之消失，登录提示走 `CLINE_LOGIN_REQUIRED` 文案。
- 只有**所有账号都停放的那条**路由才标记为不可用，原因是 `CLINE_MODEL_RATE_LIMITED`（选择器里灰掉并提示「该模型免费额度已限流，可改用其他模型」，而不是把整个 Cline 分组判死）。
- 缓存 5 分钟；登录 / 退出 / 刷新凭证会立即失效缓存。

### 用量与额度

- `clineStatus` 附带 `usage`：读取 `GET /users/me/plan/usage-limits`（5 小时 / 每周 / 每月窗口）与 `GET /users/{id}/balance`（以百万分之一美元计的整数）。
- 上游无公开 schema，解析器保持宽容：识别已知字段拼写，识别不了整行丢弃，绝不猜数。
- 用量是**尽力而为**的附加面板：读取失败降级为空快照，绝不拖垮账号列表。
- 卡片展示窗口进度条（≥90% 转警示色）、套餐名与余额。

### 暴露面

Remote（`account-remotes.ts` → `index.ts`）：`clineStatus` / `clineStartLogin` / `clinePollLogin` / `clineAddAccount` / `clineRemoveAccount` / `clineRefresh` / `clineLogout`。

- 设备登录拆成两段：`clineStartLogin` 拿票（含 `userCode` 与授权 URL），页面按 `intervalSeconds` 轮询 `clinePollLogin`。Host 不会挂一个 5 分钟的请求。
- 设置页「账号与提供商」的 Cline 卡片：状态、实时免费模型云、账号管理（刷新 / 移除）、设备登录面板，以及手动粘贴 Refresh Token 的兜底入口。

## WorkBuddy 国际版

参考实现：`dsh-workbuddy-connect`（读桌面 App 的 `workbuddy-desktop-ai.info`）。本插件保留那条桌面导入路径作为兜底，主路径改成插件自己发起浏览器授权，因此不依赖用户是否装了桌面 App。

### 上游契约（已核对 live 主机与参考实现）

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 浏览器授权入口 | `GET https://www.workbuddy.ai/console/auth/login?platform=plugin&state=<ours>` | `302` 进 Keycloak（`/auth/realms/copilot/...`，OneID / 微信 / Google / GitHub） |
| 授权轮询 | `GET https://www.workbuddy.ai/v2/plugin/auth/token?state=<ours>` | 未完成时 `{code:11217,msg:"11217:login ing..."}`；完成时返回同一 `data` 形状的令牌对 |
| 模型目录 | `GET https://www.workbuddy.ai/v3/config` | 产品文档（App 主进程读的那份），网关按 User-Agent 分流 |
| 聊天 | `POST https://www.workbuddy.ai/v2/chat/completions` | OpenAI 兼容 SSE，Bearer；body 首条必须是 `system` |
| 刷新令牌 | `POST https://www.workbuddy.ai/v2/plugin/auth/token/refresh` | 刷新令牌走 **`X-Refresh-Token` 头**，body 形式不被接受 |
| 积分汇总 | `POST https://www.workbuddy.ai/billing/meter/get-user-resource-summary` | 套餐总览（`data.Packages`） |
| 付费积分包 | `POST .../billing/meter/get-user-resource-paid-packages` | `data.Accounts`，带精确余量与到期时间 |
| 免费/活动积分包 | `POST .../billing/meter/get-user-resource-free-packages` | 同上，按当天切片查询 |
| 积分（旧） | `POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource` | 仅当上面三个都读不出形状时回退 |

以上路径已在国际版主机上核对存在（未带凭证时统一 `401 Authorization Required`，不是 `404`）。积分请求额外带 **`X-Client-Platform: web`** 与 `Accept: application/json, text/plain, */*`，这是产品自己的套餐页始终携带的头；缺失时网关会把请求当成未知客户端。

`code 11217` 的语义就是「用户还没登录完」，轮询按它继续等，其余非 0 code 直接当失败抛出，不把一个明确的拒绝伪装成「还在等待」。

### 身份头（不是可选装饰）

聊天与目录请求都带上（缺哪个就用上游自己的 `X-No-*` 声明缺哪个）：

- `X-User-Id: <uid>` —— **必须是 uid，不能是邮箱**。此前用邮箱填这个头，等于把账号报成一个它不拥有的身份。
- `X-Domain: workbuddy.ai` —— 登录域；没有它时改用 `X-No-Department-Info: 1`。
- `X-Enterprise-Id` / `X-No-Enterprise-Id: 1`。
- `X-Product: SaaS`、`X-Requested-With: XMLHttpRequest`、`Origin`/`Referer`、CLI UA。

`/v3/config` 是**唯一**换 UA 的请求（`WorkBuddyAI/2.63.2`，无空格）：网关按 UA 分流，App 形状才拿到产品文档；chat 与 refresh 继续用 CLI 身份。

### 授权登录流程（卡片上的「使用 WorkBuddy 账号登录」）

1. `workbuddyStartBrowserLogin`：本地生成随机 `state`（`fcg_<ts36>_<rand>`），拼出 `/console/auth/login?platform=plugin&state=<state>`，交给系统浏览器打开；返回 `{ state, loginUrl, expiresAt }`。**打开浏览器失败不影响授权**：票据照常有效，只是多一个 `note: 'BROWSER_OPEN_FAILED'`，卡片据此改文案并让用户点链接。
2. 用户在浏览器里登录国际版账号（Keycloak 侧）。
3. 页面每 3 秒 `workbuddyPollBrowserLogin(state)`：`pending` 继续等，拿到令牌对就把账号写进保险库并刷新适配器。`expiresAt`（10 分钟）到点由页面自行取消，Host 不挂长请求。
4. 新账号与桌面导入**共用同一条存储与轮询路径**，所以刷新、轮换、多账号都自动成立。

桌面端兜底：`workbuddyImportDesktopLogin` 读各平台的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info`（Windows 探 Local 与 Roaming；WSL 先读挂载的 Windows 用户目录），解析 `{auth,account}` 与扁平两种形状。**只读不写**，刷新后的令牌一律回插件自己的保险库。

### 额度按账号发放，一次 turn 内轮换

免费额度是**按账号**发放的，所以停放的单位是账号而不是模型：`401` 强刷一次令牌、仍失败则停放该账号；`402 / 403 / 429` 直接停放（上游给了 `Retry-After` 就按它等），换下一个账号继续同一轮。

适配器还必须满足国际端点的硬约束：**body 首条消息必须是 `system`**，否则 `HTTP 400 / code 11128` —— `prepareWorkBuddyChatBody` 保证这一点，把调用方的 `developer` 角色改写成 `system`，不改任何消息顺序与内容。

### 免费模型目录

- **实时读取** `/v3/config`，不硬编码；升到免费的模型无需插件更新即可选择。
- 只保留文档 `agents[name=cli].models` 允许的路由；文档没有 `cli` 段时不过滤（未知形状不该把目录清空）。
- 免费判定：`credits` 为 `x0.00`（或 `rateMultiplier: 0`）。
- `modelPromotions` 里 `enabled` 且 `discount.displayMode === 'replace'` 的促销也参与判定：**在有效窗口内且 factor 为 0** 才算免费。判定在每次读取时重算，不冻结在解析时 —— 文档会把折扣期内的值直接写进 `credits`，冻结的话促销结束后仍会宣称「现在免费」。
- 一条路由都没有免费时回落到文档化的 `auto` 路由；未登录时返回**空列表**，绝不向没登录的人广告 WorkBuddy。

### 积分

- 三个资源接口**并发**问，因为它们各描述一部分套餐，并行请求必须**共用同一个凭证**：三次独立刷新会互相覆盖轮换后的令牌。任一分支被判未授权时，只刷新一次，且**只重放被拒的分支**。
- 解析器宽容且不猜数：字段名有 `Precise`/非 `Precise`、`Cycle*`/`Capacity*`/`SlicePeriod*` 多种拼写，到期时间有 epoch 秒、epoch 毫秒、ISO、`YYYY-MM-DD` 四种写法；缺失的一半由 `总量 = 剩余 + 已用` 反推。
- 合并规则：明细接口的同一 `PackageCode` 覆盖汇总行，汇总行只补明细没有的包（汇总里的重复包不是额外的包）。
- **空数组是合法答案**：说明该账号确实没有这类资源，不会因此触发旧接口回退；只有三个接口都读不出形状时才回退 `get-user-resource`。
- 7 天内到期的包标记 `expiringSoon`；已过期的包标记 `expired`，但**只有仍有剩余额度的包**参与「最近到期」与高亮计算（空的过期包不该把到期时间拉近）。
- 快照写回保险库（`creditTotal/creditRemaining/creditUsed/creditExpiresAt/creditCheckedAt/creditError`），所以卡片渲染不需要每次都打上游。**查询失败只记录原因、保留上一次的好数字**：一次超时不该让卡片宣布账号余额清零。

### 维护轮次（sweep）

- 启动后约 15 秒跑首轮，之后每 **30 分钟**一轮，**逐账号串行**：这些是同一个网关后面的免费额度账号，并发 sweep 就是把整个池一起打进限流。
- 每轮只做一件事：刷新积分快照并写回保险库。
- 同一时刻只允许一轮 sweep：定时器与用户点「刷新额度」撞上时，第二个调用**共享**第一个的结果，不会并发跑第二轮。单个账号抛错不会中断其余账号。
- 签到曾经同属这套轮次（因此历史上存在过 `autoCheckin` / `checkinDate` 等字段），已在 2026-09 按产品决定整体移除；识别到旧文档里的这些键会直接忽略，不做迁移。

### 凭证存储与暴露面

- 仅存 Harness Host 保险库，引用 `WORKBUDDY_INTL_STORE`：`{ accounts: [{ id, uid?, domain?, enterpriseId?, email?, accessToken, refreshToken?, expiresAt, creditTotal, creditRemaining?, creditUsed?, creditExpiresAt?, creditCheckedAt?, creditError?, lastChecked }], activeAccountId? }`。
- `uid` / `domain` / `enterpriseId` 与令牌同等重要：它们是聊天请求的身份头，桌面导入与浏览器授权都会一并落库。
- 浏览器只拿到 `WorkBuddyInternationalStatus`（账号行 + 免费模型列表），令牌不出 Host。

Remote（`account-remotes.ts` → `index.ts`）：`workbuddyStatus` / `workbuddyStartBrowserLogin` / `workbuddyPollBrowserLogin` / `workbuddyOpenSignIn` / `workbuddyBrowserLoginUrl` / `workbuddyImportDesktopLogin` / `workbuddyRemoveAccount` / `workbuddySetActiveAccount` / `workbuddyRefreshToken` / `workbuddyRefreshCredits` / `workbuddyLogout`。

设置页「账号与提供商」的 WorkBuddy 卡片：状态、汇总积分、免费模型云、「刷新额度」与账号管理面板（每账号一张卡：身份、到期状态、积分进度条、移除），「使用 WorkBuddy 账号登录」的浏览器授权面板，以及「导入桌面端登录」兜底入口。

## 两个池共用的一套展示

Cline 与 WorkBuddy 都是「多账号 + 免费模型」池，因此账号展示收敛到同一组样式与结构（`settings-tab.module.css` 的 `.pool*` 块 + `PoolAccountCard`）：单色字母徽标、账号名、状态胶囊（参与轮询 / 已限流 / 需重新授权 / 积分即将到期）、右侧操作，以及可选的进度条。数字一律 `tabular-nums`，因为这个面板是靠**比较数字**读的。没有任何该账号数据的池不会画空进度条，而是省略它。

## 与其他 Provider 的边界

- `model-catalog.ts` 的 `DIRECT_PROVIDERS` 与 `native-model-menu-badges.ts` 的 `BUILTIN_PROVIDER_IDS` 已包含 `cline` 与 `workbuddy`，这两个平台的行不会被并入 FreeCodeGo 网关分组，也不会被当成用户自建第三方路由。
- 两者都只在**文本**模型列表出现（无媒体能力），不进媒体默认值候选。
