# FreeCodeGo 插件 ↔ 后端接口契约

本文把插件与 FreeCodeGo 后端之间的接口契约**显性化**：哪些 endpoint 被调用、调用方是谁、请求/响应类型在哪里、字段的必填/缺省/忽略规则、以及哪些字段会影响路由绑定、计费与协议选择。

它不是设计提案，而是现状 + 已决事项的记录。修改任何消费这些字段的代码前，先改本文，再改代码和测试。

---

## 1. 判据（怎么算对齐）

- 凡是**影响模型绑定、计费、协议选择**的字段，规则只有一处实现，且有测试。
- 凡是**影响用户可见信息**的字段，明确“显示 / 不显示”。
- 凡是**面向用户的文案**，一律由插件按当前语言生成：后端返回的 `error.message`、路由名、provider 主机名与解析错误**只进日志，不进界面**。后端的错误串是给运维看的，改它不会改变用户读到的话——要改用户读到的话，改的是插件里对应的分支。
- 未接入的 endpoint 明确标注“不接入”或“待确认”，不留隐式依赖。
- 目录（picker）里能看到的每一个分组，其 `routeKey` 必须能被 Host 的路由选择逻辑命中。

---

## 2. 接口差异表

“调用方” = 生产代码里真正发起请求的位置。“类型” = 是否有显式的请求/响应类型（`freecodego-api/src/index.ts`）。

| 后端 endpoint | 插件是否调用 | 调用方 | 类型 | 用途 | 本轮决定 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/freecodego/models/options` | 是 | `engine-remotes`、`account-remotes`、`payment-remotes` | `FreeCodeGoModelRouteOption` | 模型分组的**唯一权威来源**：分组路由键、倍率、锁定、协议 | 保持（本文第 4 节定义字段语义） |
| `POST /api/v1/freecodego/agent/bootstrap` | 是 | `FreeCodeGoApiClient.getBootstrap` / `getCatalog` | `Record<string, unknown>` → `FreeCodeGoCatalog` | 目录级信息与模型可用性 | 保持；**不可**当作分组/价格来源（见第 6 节） |
| `GET /api/v1/freecodego/agent/channel-health` | 是 | `managed-catalogs` | `FreeCodeGoGatewayProviderHealth[]` | 渠道健康卡片 | 保持 |
| `GET /api/v1/freecodego/agent/runtime/health` | 是 | `account-remotes` | `Record<string, unknown>` | 运行时健康 | 保持 |
| `GET /api/v1/freecodego/agent/quota` | 是 | `account-remotes` | `Record<string, unknown>` | 配额 | 保持 |
| `GET /api/v1/freecodego/agent/usage?days=` | 是 | `account-remotes`、`payment-remotes` | `Record<string, unknown>` | 账号用量 | 保持 |
| `GET /api/v1/freecodego/inference/status` | 是 | `managed-catalogs` | `FreeCodeGoPremStatus` | Prem 机密中继状态 | 保持 |
| `GET /api/v1/freecodego/inference/charges` | 是 | `payment-remotes`（分页） | `FreeCodeGoInferenceCharge[]` | 实际结算账单 | 保持（按页回退，上限 10 页） |
| `GET /api/v1/freecodego/usage/dashboard/stats\|trend\|models\|insights` | 是 | `payment-remotes.tokenUsageGateway` | 未收敛（`Record<string, unknown>`） | 网关账单看板 | **保持**：此前误记为“待确认”，实际已在用 |
| `GET /api/v1/freecodego/payment/plans` | **否** | — | `FreeCodeGoPaymentPlan`（仅展示用） | 兼容投影 | **不接入**：`checkout-info` 已覆盖且含费率/限额 |
| `GET /api/v1/freecodego/payment/channels` | **否** | — | `FreeCodeGoPaymentChannel`（仅展示用） | 兼容投影 | **不接入**（同上），客户端方法已删除 |
| `GET /api/v1/payment/checkout-info` | 是 | `payment-remotes` | `FreeCodeGoPaymentCheckoutInfo` | 套餐 + 支付渠道（含费率、单笔限额） | 保持 |
| `POST /api/v1/payment/orders` | 是 | `payment-remotes.paymentCheckout` | `FreeCodeGoCheckoutRequest` → `FreeCodeGoCheckoutOrder` | 创建订单（非幂等，关闭 401 重放） | 保持 |
| `GET /api/v1/freecodego/payment/orders/my` | 是 | `payment-remotes.paymentOrders` | `JsonValue` | 我的订单 | 保持 |
| `GET /api/v1/freecodego/payment/orders/:id` | 是 | `payment-remotes.paymentOrder` | `FreeCodeGoCheckoutOrder` | 轮询订单 | 保持 |
| `POST /api/v1/freecodego/payment/orders/verify` | 是 | `payment-remotes.paymentVerify` | `FreeCodeGoCheckoutOrder` | 校验支付 | 保持（非幂等） |
| `POST /api/v1/freecodego/payment/orders/:id/cancel` | 是 | `payment-remotes.paymentCancel` | — | 取消订单 | 保持（非幂等） |
| `POST /api/v1/freecodego/payment/orders/:id/receipt/email` | 是 | `payment-remotes.paymentReceiptEmail` | `FreeCodeGoReceiptEmailResult` | 邮件回执 | 保持（非幂等） |
| `GET /api/v1/freecodego/payment/orders/:id/receipt` | 是 | `payment-remotes.paymentReceiptDocument` | `FreeCodeGoReceiptDocument`（文本 HTML） | 商业收据（后端自绘） | 接入；`receipt_available` 决定是否提供（`GET /orders/:id`、`POST /orders/verify`、订单列表三处都带，**创建响应没有**），**状态不以本地名单推导** |
| `GET /api/v1/freecodego/payment/orders/:id/stripe-receipt` | 是 | `payment-remotes.paymentStripeReceiptDocument` | `FreeCodeGoReceiptDocument`（`encoding: 'base64'`） | Stripe 自己开具的 PDF 收据 | 接入；只在 Stripe 支付且 `stripe_receipt_available` 为真时提供——收据列表与“当前订单”卡片共用同一条判据（`stripeReceiptOffered`），且**标志缺失不等于可用**（创建响应不带它）；**必须按字节读**（`text()` 会改写非 UTF-8 字节） |
| `GET /api/v1/public/model-pricing/landing` | 是 | `payment-remotes.localGatewayModelPrices` 路径（公开定价） | `FreeCodeGoGatewayModelPrice[]` | 公开定价 | 保持 |
| `POST /api/v1/public/model-pricing/lookup` | 是 | `payment-remotes.accountGatewayModelPrices` | 匿名价格行 | 补齐目录缺失价格 | 保持 |
| `POST /api/v1/freecodego/mobile/auth/*` | 是 | `FreeCodeGoMobileAuthClient` | 各自类型 | 登录/刷新/登出/2FA | 保持 |
| `GET /api/v1/freecodego/auth/me` | 是 | `account-remotes` | `FreeCodeGoCurrentUser` | 账号身份 | 保持 |
| `GET /api/v1/freecodego/auth/device-sessions` | **是（本轮新增）** | `account-remotes.deviceSessions` | `FreeCodeGoDeviceSessionList` | 设备会话列表 | 接入；返回 `currentDeviceId` |
| `POST /api/v1/freecodego/auth/device-sessions/revoke` | **是（本轮新增）** | `account-remotes.revokeDeviceSession` | `{ device_id }` → message | 撤销单台设备 | 接入 |
| `POST /api/v1/freecodego/auth/revoke-all-sessions` | **是（本轮新增）** | `account-remotes.revokeAllSessions` | `{ revoked_count }` | 撤销全部会话 | 接入（会连带撤销本机） |
| `GET /api/v1/freecodego/models/catalog` | **否** | — | — | 模型广场目录 | 不接入：`models/options` 是账号视角的权威来源 |
| `POST /api/v1/freecodego/redeem`、`GET /redeem/history` | **否** | — | — | 兑换码 | 待确认：需要产品决策，本轮不接入 |
| `GET /api/v1/freecodego/subscriptions*` | **否** | — | — | 订阅进度 | 待确认（同上） |
| `GET /api/v1/freecodego/payment/config`、`GET /payment/limits` | **否** | — | — | 支付开关/限额 | 待确认：当前由前端固定额度阶梯，未读后端限额 |
| `POST /api/v1/freecodego/usage/dashboard/api-keys-usage` | **否** | — | — | 按 Key 用量 | 不接入：账号视角不使用 API Key 维度 |
| `POST /api/v1/freecodego/inference/relay/*` | 间接 | `managed-catalogs`（Prem 中继连接） | — | 机密中继 | 保持现状：只提供中继 URL/令牌，不直连 |
| `POST /attestation/*`、`POST /rvenc/*` | **否** | — | — | 机密推理落地 | 不接入：由 Prem 适配器/上游处理 |
| `POST /api/v1/freecodego/mailbox/inbound` | **否** | — | — | 接收邮件 | 不接入：与 Harness 无消费方 |

### 本轮结论（可直接作为后续动作的边界）

1. **退款族状态不请求**（产品不销售退款）：`refund-request`（用户侧）、`admin/orders/:id/refund`（运营侧）都不接入，`ORDER_LIST_STATES` 只列**可能带单据**的四个状态（`pending`/`paid`/`recharging`/`completed`）。后端状态机确实有 `REFUND_REQUESTED`/`REFUNDING`/`PARTIALLY_REFUNDED`/`REFUNDED`/`REFUND_FAILED`，且运营侧退款路由仍在；但本产品禁止退款，所以订单到不了这些状态，把它们加进请求只会变成每状态一次 HTTP 调用。页面仍保留 `已退款` 这类文案映射——它映的是**后端词表**，不是本产品的售卖项，运营侧退款出来的历史订单不至于显示成原始 `REFUNDED`。
2. **不新增**的接口已经在上表标注“不接入/待确认”，不要再为了“覆盖度”加 Remote：`models/catalog`、`redeem`、`subscriptions`、`payment/config`、`payment/limits`、`api-keys-usage`、`attestation/*`、`rvenc/*`、`mailbox/inbound`。两处 `receipt` 下载**已接入**（上表），此前写在这里的“回执文件不进入 Harness”已不成立：收据是用户要的东西，且订单行本来就带 `receipt_available`/`stripe_receipt_available` 两个开关。
3. 删除死接口：`FreeCodeGoApiClient.getPaymentPlans()`、`getPaymentChannels()` 已删除（只有测试在用）。
4. 分组 pin 归**选择器**所有（不是 Host 的自动挑）：模型列表为后端每一个 `(模型, 分组)` 出一行，选择值携带 `id@group:<n>`；路由读到 pin 就只服务该分组，只有未带 pin 的旧值/默认值才走自动挑。**不要**再删这条链路——设置页那个独立的“模型分组路由”面板（`modelRouteSelections`）是另一条路线，与选择器里的分组行无关。
5. 新增：`getDeviceSessions()`、`revokeDeviceSession()`、`revokeAllSessions()` + Host Remote `accountDeviceSessions`/`accountRevokeDeviceSession`/`accountRevokeAllSessions` + 设置页“设备会话”面板。
6. **用户可见文案的边界（本轮收紧）**：支付相关的每一句错误都由插件按 `language` 单语生成，旧的「中文 / English」拼接写法已全部移除（`describePaymentError` 现在收 `language`）；后端的 `error.message`、渠道厂商名、以及支付 SDK 的内部报错都不再出现在界面上，只写进控制台（`[freecodego] …`）。区分只剩一处：卡被拒时展示支付服务**写给人看**的那句（`type` 为 `card_error`/`validation_error`），其余请求级失败一律用插件自己的文案。因此后端**不需要**为了让文案好看而改错误串——它只影响插件的分类匹配。

---

## 3. `/models/options` 字段契约

类型定义：`freecodego-api/src/index.ts` → `FreeCodeGoModelOptionsSnapshot`（`{ groups, models }`），其中模型是 `FreeCodeGoModelRouteOption`、分组是 `FreeCodeGoModelOptionGroup`。读取方式：`getModelOptionsSnapshot()` 一次请求拿到两半；`getModelOptions()` 是只取 `models` 的薄封装。

### 3.1 模型级

| 字段 | 后端 | 插件 | 影响 |
| --- | --- | --- | --- |
| `id` | 必有 | **必需**，缺失/空 → 抛错 | 模型绑定、选择集 key |
| `label` | 必有 | 缺省 → 用 `id` | 展示 |
| `provider` | 必有 | 缺省 → 省略（UI 回退 `FreeCodeGo`） | 展示 |
| `protocol` | 必有 | 可缺省 | 展示 + 兜底协议 |
| `type` | 必有 | **忽略** | — |
| `billing_mode` | 必有 | **忽略**（计费模式取 `activity_pricing.billing_mode`） | — |
| `description` | `omitempty` | 可缺省 | 展示 |
| `official_pricing` / `options` | 必有 | `options` 必须是数组，否则抛错 | 分组来源 |
| `sort_order` | 必有 | 忽略（沿用后端顺序） | — |

### 3.2 分组 choice 级

| 字段 | 后端 | 插件 | 影响 |
| --- | --- | --- | --- |
| `group_id` | 必有 | **必需**，非有限数 → 抛错 | 同倍率时的稳定排序键 |
| `route_key` | 必有 | **必需**，空 → 抛错 | 推断请求头 `X-FreeCodeGo-Route-Key` |
| `group_name` | 必有 | 缺省 → 省略（UI 回退 provider） | 展示：分组行的可见名（`<模型名> · <分组名>`）与描述车道（`<分组名> · ×<倍率>`） |
| `platform` | 必有 | **忽略**（`platform` 用 `protocol` 兜底） | — |
| `protocol` | 必有 | 可缺省 → 影响 wire 选择 | **协议分流** |
| `plan_code` | `omitempty` | 可缺省 | 展示 |
| `enabled` | 必有 | 缺省视为 `true` | **路由候选过滤** |
| `access` | `omitempty`，`available`/`locked` | 可缺省；缺省不等于可用 | **锁定判定** |
| `unlock_required` | `omitempty` | 可缺省 | **锁定判定** |
| `unlock_reason` | `omitempty` | 可缺省 | 展示（后端标识串） |
| `unlock_expires_at` | `omitempty` | 可缺省 | 展示；**`access: available` + 有时间 = 限时解锁** |
| `rate_multiplier` | 必有（`float64`，无 omitempty） | 可缺省（旧部署） | **零价判定、排序** |
| `activity_discount_percent` | `omitempty` | **忽略** | — |
| `activity_label` | `omitempty` | **忽略** | — |
| `official_pricing` | 必有（可能为空对象） | 缺省 → 省略价格字段 | 展示（原价） |
| `activity_pricing` | 必有（可能为空对象） | 缺省 → 省略价格字段；`billing_mode`/`currency` 取自此块 | 展示 + 计费模式 |

价格块字段（`billing_mode`、`currency` 必有；`input/output/cache_read/cache_write_price_per_million`、`per_request_price`、`image_output_price_per_million` 均为 `omitempty`）→ 插件全部按“缺了就省略”处理，不做 0 兜底（0 与缺失含义不同：0 是免费，缺失是未知）。

**`billing_mode` 是三值枚举，不是布尔**：后端取值为 `token` / `per_request` / `image`（`backend/internal/service/channel.go` 的 `BillingMode`），`gatewayBillingMode()` 是唯一的翻译点。把 `image` 读成 `token` 会让生图模型落到输入/输出那四列上（见第 4.3 节）。choice 级只认 `per_request` 与 `image` 这两个非默认值：`token` 是后端目录自身的默认值，一个不在模型广场里的模型也会报 `token`，那时 `/public/model-pricing/lookup` 才是权威来源。

### 3.3 分组级（`groups[]`）

`groups[]` 是账号视角的分组清单：与 `models[].options` 出自同一次请求，**不是**模型级的补充字段。

| 字段 | 后端 | 插件 | 影响 |
| --- | --- | --- | --- |
| `id` | 必有 | **必需**，非有限数 → 丢弃该行 | 把 choice 的 `group_id` 映射回分组 |
| `name` | 必有 | **必需**，空 → 丢弃该行 | optgroup 标题（**唯一的展示来源**） |
| `sort_order` | 必有 | 可缺省 | 分组展示顺序（缺省排最后） |
| `rate_multiplier` | 必有（`float64`） | 可缺省 | **模型行显示的倍率**；后端已折入账号覆盖倍率 |
| `enabled` | 必有 | 缺省视为 `true` | 与 `access`/`unlock_*` 合成 `enabled: false` |
| `description` / `platform` / `protocol` / `plan_code` | `omitempty` | 可缺省 | 展示 |
| `model_count` | 必有 | 可缺省 | 展示 |
| `access` / `unlock_required` / `unlock_reason` / `unlock_expires_at` | `omitempty` | 可缺省 | 复用 `isLockedRoute()`，**不新增第二条锁定规则** |
| `activity_discount_percent` / `activity_label` | `omitempty` | `activity_label` 透传，其余忽略 | 展示 |
| `default` | 必有（布尔） | 只有 `true` 才透传 | 展示（账号默认分组） |
| `allow_image_generation` | `omitempty` | 可缺省 | 展示；缺省是“后端没说”，不是“不允许生图” |
| `image_rate_independent` | `omitempty` | 可缺省 | **生图倍率选择**：`true` 才用 `image_rate_multiplier`，否则用 `rate_multiplier` |
| `image_rate_multiplier` | `omitempty` | 可缺省（声明了独立倍率却没有值 → 按 `0` 结算） | 生图倍率 |
| `image_price_1k` / `image_price_2k` / `image_price_4k` | `omitempty` | 可缺省；**`0` 是有效价格（免费档），只有缺失/负数才是未配置** | 生图按张单价（USD / 张） |

> 这六个字段是后端为桌面端新增的（`groups.image_price_*` / `image_rate_*` / `allow_image_generation`），取值与网关结算同源：`BillingService.getImageUnitPrice` 优先用分组这三列，未命中才回落 LiteLLM 的 `output_cost_per_image`（并自带 2K ×1.5、4K ×2）。因此**任何本地常量都只是巧合**，不是这个分组真实会扣的价。

- 投影链路：`getModelOptionsSnapshot()` → `managedCatalogGroups()` → `FreeCodeGoManagedCatalog.groups` → 缓存往返 → 前端 `ManagedCatalog.groups` → `modelGroupRows()`。
- 缓存往返：`readManagedCatalogCache()` 必须透传分组字段，否则重启后 picker 退回“按 provider 归桶、无倍率”。
- 展示语义：optgroup 用 `name`、按 `sortOrder` 排序；模型行显示该分组的 `rateMultiplier`（`0` 显示为“免费”）。
- 对话框内的模型列表同样按 `(模型, 分组)` 出多行：`expandGroupPinnedModels()` 给每行挂 `__groupPin` / `__groupLabel` / `__groupRate`，选择值 = `id@group:<n>`。同一个模型挂在多个分组时，**每个分组各出一行、各自显示该分组的倍率**，这是用户唯一能指定线路的地方。
- 账户不可用的分组**保留该行**并标 `__groupUnavailable`（锁定/需解锁 → `FREECODEGO_GROUP_LOCKED`；停用或无可用 wire → `FREECODEGO_GROUP_UNAVAILABLE`），由 `modelRowGroupBlock()` 决定是否上报。静默消失的分组和“后端根本没卖”的分组长得一模一样——这正是要修的那个坑。
- 模型级不可用（如未登录 `FREECODEGO_LOGIN_REQUIRED`）优先于分组自身原因：先把账号修好，分组才谈得上。
- 分组名一律来自后端：`groups[].name` 优先，其次 `options[].group_name`。两者都没有时才退回 provider（`providerName`/`provider`）这个真实字段；**不得**用 route key、营销语或本地拼的名称填进去（价格表的 `groupName` 曾回退成 `'FreeCodeGo'`，那正是“本地编了个分组名”的例子，已改为先从 `groups[]` 按 id 取真名）。
- `groups[].default` 同样要透传：`managedCatalogGroups()` → `FreeCodeGoManagedCatalog.groups` → `readManagedCatalogCache()` 往返 → `ManagedCatalog.groups` → 设置页读出行 `backendDefaultGroupName()`。少了它，“没选分组时走哪条”就成了用户看不见的规则。

---

## 4. 零价与锁定：各自只有一条规则

### 4.1 零价

- 唯一实现：`freecodego-api/src/index.ts` → `isFreeRouteRow()`（原始行）/ `isZeroPriceRoute()`（已归一化行）。
- 规则：`rate_multiplier === 0` 为免费；兼容旧部署的 `access === 'free'`、`billing_mode === 'free'`。
- `access` 现在的取值是 `available`/`locked`，**不是**价格信号；把它当零价来源会把付费路由判成免费（坑 1）。
- 归一化结果：`zeroPrice: boolean` 恒存在；免费时 `rateMultiplier` 归零。
- 消费方不再自行比较字段：`selectModelOptionChoice`、`enrichCatalogChoices`、`accountGatewayModelPrices` 均复用上面的函数。

### 4.2 锁定

- 唯一实现：`isLockedRoute()`；`access === 'locked'` 与 `unlock_required === true` 是**同一条**锁定信号，任一成立即为锁定。
- 后端事实：`liteAgentAccessForBinding` 在 `access: 'locked'` 时必定同时给 `unlock_required: true`；限时解锁则反过来给 `access: 'available'` + `unlock_expires_at`。
- 归一化结果：`locked: boolean` 恒存在（catalog choice 与 options choice 都有）。
- 路由语义：
  - 带 pin 的选择（`id@group:<n>`）：先排除 `enabled === false` / `locked`，再取该分组；分组内只按协议可用性过滤 wire。pin 指向的分组被删/停用/锁定时**不回落**——回落到别的分组等于按用户没选的倍率计费，所以直接报 `MODEL_ROUTE_UNAVAILABLE`，选择器重新列出可用分组。
  - 未带 pin 的选择值**不按价格挑**：先取后端声明的账号默认分组（`groups[].default === true`），该模型不在默认分组里则按后端给出的 choice 顺序取第一个可用项。历史实现里的“免费优先 → 最低倍率 → 最小 `group_id`”已删除：分组是账号计费的载体，本地比较器替用户决定分组，会让选择器里一行一个分组的列表变成谎话（用户读到的是免费行，请求却走了兄弟分组）。候选集皆空 → `MODEL_ROUTE_UNAVAILABLE`。
  - 默认分组靠 `getModelOptionsSnapshot()` 拿到：`groups[]` 只存在于 `/models/options` 的响应里，只读 `models` 的 `getModelOptions()` 永远看不到它；旧 Host 没有 snapshot 方法时退化为“按后端顺序”，不报错。
  - wire 上必须打掉 pin：请求体里的模型名是裸 `id`（`parseGroupPin()` 拆）；pin 只是本地的路由指令，网关不认识 `@group:` 后缀。
- 展示语义：模型选择列表按后端分组分桶（optgroup 标题取 `groups[].name`，顺序取 `groups[].sortOrder`），每个模型行显示 `groups[].rateMultiplier`（已是账号实际倍率，`0` 显示为“免费”）。同一模型挂在多个分组时，**每个分组各出一行、各自显示该分组的倍率**；后端未分组的行（Logfare / Agnes / 本地 Groq / 原生媒体模型）按 provider 归桶。
- 对话框内的列表同样一行一个分组，且**不可用的分组照样列出、只是禁用并给出原因**（`FREECODEGO_GROUP_LOCKED` / `FREECODEGO_GROUP_UNAVAILABLE`，文案在 `native-model-menu-badges.ts` 的 `unavailableLabel`/`unavailableMessage`）。锁定的分组不是“缺凭证”，所以不能复用“需配置”标签——那会把用户送到一个没有东西可配的设置页。
- 价格表语义：`GatewayPricingTable` 的每一行也是后端的一个 `(model, group)` 定价行——分组名取 `options[].group_name`（`accountGatewayModelPrices` 原样透传 `groups`/`options` 的 `group_name`），倍率取该分组已折算的 `rate_multiplier`（`0` 显示为“免费”）。除完全相同的行外不合并，同一模型的多个分组按倍率从低到高相邻排列，因此同一模型在价格表里会出现多行，各自显示自己的分组名与倍率。把同一模型折叠成“最低价一行”会删掉除最便宜分组以外的全部分组名与倍率。

### 4.3 生图（按张）

- 触发：行的 `billingMode === 'image'`（后端前缀规则 `gpt-image-*` / `grok-imagine-*`，或“只有图片输出价”的模型）。
- 结算事实：`result.ImageCount > 0` 时后端一律走 `CalculateImageCost`，**每张图一个价**，单价 = 分组的 `image_price_1k/2k/4k`（按图片实际分辨率档位）× 生图倍率；token 计费在那条路径上根本不会被调用。所以这四列 token 价对生图行既不是近似也不是上界。
- 倍率：`imageRateIndependent ? imageRateMultiplier : rate_multiplier`，与后端 `resolveImageRateMultiplier()`、网页端 `openAIImageStudioMultiplier()` 同一条规则。
- 投影：`harness-plugin/src/payment-remotes.ts` → `imagePriceTiers()` 把分组三档乘以生图倍率，产出 `imagePrices: { label, price, originalPrice? }`；**分组没配这一档就不产出这一档**，而不是补 0（0 会读成“这张免费”）。
- 展示：`GatewayPricingTable` 对生图行只出一个「按张」单元格（跨 token 四列），里面一档一个小格；`isFreePricingRow()` 把档位价也算作报价（全 0 才叫免费），`pricingSortValue()` 用**最低档**排序（未报价 → `Infinity`，排最后）。拿空 token 列求和会让每张生图都排成全场最低价，这是修之前的实际行为。
- **不允许回退到本地常量**：网页端曾用 `OPENAI_IMAGE_STUDIO_PRICE_* = 0.05/0.10/0.20` 兜底未配置的档位，那会显示一个永远不会被扣的数；现在两端都是“未配置 → 不显示（`—`）”。

---

## 5. 目录投影：bootstrap 不携带分组信息

后端的 `/agent/bootstrap`（FreeCodeGo 投影）与 `/models/options` 不是同一份数据：

| | bootstrap | models/options |
| --- | --- | --- |
| 路由键 | 被重写成遗留语法 `model:<protocol>:<model>` | `group:<id>:<model>` |
| 分组 id / 名称 | 清空 | 有 |
| `rate_multiplier` | **清空** | 有 |
| 去重 | 按 `protocol:modelID` 去重（每模型最多 2 行） | 每个分组一行 |
| `access` / `unlock_*` | 保留 | 保留 |

因此“用 bootstrap 的 route key 去 options 里配 enrichment”永远匹配不上。插件现在的做法：

- `enrichCatalogChoices()`：模型有 options 分组时，**用分组重建 choice 列表**（route key 取 `group:<id>:<model>`，携带 `groupId`/`groupName`/`protocol`/`access`/`unlock_*`/`zeroPrice`/`locked`/`rateMultiplier`，`availability` 由 `enabled && !locked` 决定）；没有分组时保持 bootstrap 原样。
- 这一改动同时修复了两件事：picker 的分组名/倍率/免费标记、锁定分组在 UI 中可见且不可选。（用户 pin 分组的链路见 3.3 / 4.2：pin 由选择器的 `(模型, 分组)` 行写入，不是 Host 的自动挑。）
- 缓存往返：`readManagedCatalogCache` 必须透传上述所有分组字段，否则重启后 picker 退回“无分组、无倍率”。
- Bootstrap 的免费模型行（`liteagent.free_model_id`，默认 `deepseek-v4-flash`）没有分组，因此其免费状态只能靠遗留拼写识别；这是遗留路径，不要把新逻辑建在它上面。

---

## 6. 媒体生成的认证与重试

- 事实：媒体请求的 transport 由 `mediaTransport()` 构造，凭证来自 `managedRuntime()`（走 `withAccessToken`），并注入 `X-FreeCodeGo-Route-Key` / `X-LiteAgent-Route-Key`。
- 事实：直接/自配置 provider（logfare/opencode/agnes 等）使用自己的凭证，`accountBacked === false`。
- 本轮统一：新增 `gatewayResponse()`，网关请求（`gatewayMediaFetch`/`gatewayMediaGet`/视频轮询）统一走 `host.recoverGatewayAuth()`（实现为 `account.withAccessToken`，即 401 时刷新一次并重放）。
  - 仅 `accountBacked` 的请求进入该恢复路径；直接 provider 的 401 立即失败，不会被账号令牌重放。
  - 401 说明网关在执行业务前就拒绝了令牌，因此重放不会重复计费；其它状态码（含 5xx）原样返回给调用方。
  - 重放时通过 `reloadTransport()` 丢弃旧 transport，避免用同一个过期令牌重试。
- 已移除：视频轮询里那段自写的“401 就自己重新解析 transport”逻辑。

---

## 7. 本轮改动与验证

改动：

- `freecodego-api/src/index.ts`：导出 `isFreeRouteRow`/`isZeroPriceRoute`/`isLockedRoute`；`locked` 成为恒存在字段；bootstrap 投影保留 `access`/`unlock_*`/`group_*`；删除 `getPaymentPlans`/`getPaymentChannels`；新增设备会话方法。
- `harness-plugin/src/model-catalog.ts`：分组重建 choice（见第 5 节）。
- `harness-plugin/src/engine-remotes.ts`：`selectModelOptionChoice` 支持 `preferredGroupId`（pin 优先，且 pin 不可满足时报错而不回落）与 `defaultGroupId`（后端默认分组）；删除按价格自动挑（`isFree`/最低倍率/最小 group id 排序）；`routeForModelDetail` 用 `parseGroupPin()` 拆出 pin，并用 `getModelOptionsSnapshot()` 读 `groups[].default`。
- `harness-plugin/src/payment-remotes.ts`：价格表的 `groupName` 优先取 `groups[]` 里该 `group_id` 的真实名称。
- `freecodego-api/src/index.ts`：`gatewayBillingMode()` 三值翻译；`image` 输入输出价（`original/currentImageOutputPricePerMillion`）与分组生图字段（`allowImageGeneration` / `imageRateIndependent` / `imageRateMultiplier` / `imagePrice1K|2K|4K`）接入 `models/options`；公共查询的 `billing_mode: 'image'` 与 `image_output_price_per_million` 不再被丢弃。
- `harness-plugin/src/payment-remotes.ts` + `types.ts`：`imagePriceTiers()` 与 `FreeCodeGoImagePriceTier`。
- `harness-ui`：价格表新增「按张」行（`ImagePriceTiers`）与 `.imageTiers` 样式。
- `harness-ui`：设置页在默认模型选择器上方显示「未指定分组时使用后端默认分组「X」」；未设置文案从“使用默认路由”改为“分组由后端决定”。
- `harness-plugin/src/model-catalog.ts`：`withGroupPin`/`parseGroupPin`（选择值编解码）、`expandGroupPinnedModels`（一行一个分组）、`groupRowBlockReason`/`modelRowGroupBlock`（不可用原因）。
- `harness-plugin/src/managed-catalogs.ts`：`listFreeCodeGoModels` 产出分组行（可见名 `<模型名> · <分组名>`），wire 请求前用 `parseGroupPin()` 打掉 pin。
- `harness-plugin/src/account-remotes.ts` + `index.ts`：设备会话 Remotes。
- `harness-plugin/src/media-generation.ts`：统一 401 恢复路径。
- `harness-ui`：分组标签显示锁定原因/有效期；锁定分组在 picker 中 `disabled`；新增设备会话面板。
- `harness-plugin/src/managed-catalog-utils.ts`：缓存透传分组字段。

验证：

```bash
cd plugin && npx tsc -b packages/freecodego/freecodego-api packages/freecodego/harness-plugin packages/freecodego/harness-ui
cd plugin && npx vitest run packages/freecodego/
# 改了 freecodego-api 后，harness-plugin 的测试读到的是打包产物，先重建：
cd plugin && pnpm exec tsdown --config packages/freecodego/freecodego-api/tsdown.config.ts
```

已知不稳定用例：`harness-ui/tests/settings-tab.client.spec.tsx > clears a stale restart banner after the Host reconnects` 在并行负载下偶发失败（单独运行通过）。

---

## 8. 遗留项（未决，不在本轮）

- `redeem` / `subscriptions` / `payment/config` / `payment/limits`：需要产品决策后才接入，不要静默加 Remote。
- `/models/catalog`（模型广场）与 `models/options` 的差异没有产品需求，保持不接入。
- 媒体生成的 5xx 重试策略仍未统一（当前只统一了 401）。
- 目录缓存格式新增字段后未做版本迁移：旧缓存在重新拉取前不会带分组字段（首次刷新即修复）。

### 夹具里的分组名

测试里出现的分组名（`group-a` / `后端分组甲` / `后端分组·免费` 等）是**后端 payload 的占位串**，不是产品常量——产品代码从不生成分组名，UI 只渲染 `groups[].name`。夹具刻意不用“开发者线路”“免费池”这类像产品文案的名字，否则容易被误读成本地编造的分组（这个误解已经发生过一次）。另外：按名字排序的用例（`getPublicModelPricing`）必须用拉丁占位名，CJK 名字会让期望顺序依赖运行时的 collation。
