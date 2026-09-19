---
description: "FreeCodeGo 的浏览器端界面：设置分区、提供方与账号卡片、MCP 与 Skills 开关、插件冲突保护、侧边栏与输入框上方的 Agent 形象，以及内嵌的社区页面。"
kind: "package-reference"
---

# FreeCodeGo Harness UI

[English](README.md) | 中文

## 概述

FreeCodeGo 设置分区报告引擎代、已持久化的默认引擎状态、后端可用性与本地第三方提供方路由，其提供方摘要读取自标准的 `llm.providers` Host API。路由的创建与编辑仍留在共享的 Models 设置表面，而不是另建编辑器；浏览器也永远拿不到已存储的密钥值：FreeCodeGo 不新增并行凭据协议。该页面还公开 WorkBuddy 设备登录流程与 Agnes AI 卡片，并且在启用 Engineering 时提供一个多引擎团队面板——它在运行隔离的 DeepSeek、Codex 与 Claude 子评审时保持所选 root Agent 不变。

## 目录

- [设置表面](#settings-surface)
- [MCP 与 Skills](#mcp-and-skills)
- [插件冲突保护](#plugin-conflict-protection)
- [内嵌社区插件](#embedded-community-plugins)
- [侧边栏与输入框上方的形象](#companion-in-the-sidebar-rail)
- [开发备注](#dev-note)

-----

<a id="settings-surface"></a>
## 设置表面

FreeCodeGo 设置分区报告引擎代、已持久化的默认引擎状态、后端可用性与本地第三方提供方路由。提供方摘要读取自标准的 `llm.providers` Host API，并在每次连接代重置后刷新。

路由的创建与编辑刻意留在共享的 Models 设置表面（`@deepseek-ai/dsh-client-ui-settings-models`）。该编辑器通过 `settings.mutate` 写入 `llm-pi-ai` profile，通过 `credentials.set` 写入 API key；浏览器永远拿不到已存储的密钥值。FreeCodeGo 不新增并行凭据协议。

在公开后端契约可用之前，FreeCodeGo Cloud、计费与支付控件显示为 `BACKEND_NOT_CONFIGURED`。

设置页还公开独立的 WorkBuddy 设备登录流程。它打开 WorkBuddy 的浏览器授权 URL，在用户确认后轮询，并且只显示 UID、昵称、登录状态与动态 CLI 模型 id。可以独立添加和移除多个账号；令牌留在 Host 凭据服务中，绝不发送给浏览器。

同一设置表面还包含一张 Agnes AI 卡片，用于验证码注册、登录与自动创建默认 API key。Agnes 凭据由 Host 凭据服务存储；浏览器永远拿不到会话令牌或 API key。

启用 Engineering 时，该页面还公开一个多引擎团队面板。它在启动隔离的 DeepSeek、Codex 与 Claude 子评审时保持所选 root Agent 不变，并为每个有界议会议题显示法定人数、失败项、共识与异议。完成的报告提供明确的 Approve implementation 与 Reject plan 操作。只有批准之后才会显示实施后验证操作及其已持久化的阶段结果。

-----

<a id="mcp-and-skills"></a>
## MCP 与 Skills

`设置` 页面持有 MCP 与 Skill 开关。开关会注册对应的 `MCP` 或 `Skills` 设置侧栏入口，因此未启用的能力不会带来休眠的导航项。MCP 页面显示连接状态、已发现的工具、启用状态、编辑与快捷模板；Skills 页面把已配置的根与已发现的 catalog 分开呈现。配置只通过 FreeCodeGo Host remote 发送，并从一份共享清单应用到新的 DeepSeek、Claude 与 Codex 会话。

-----

<a id="plugin-conflict-protection"></a>
## 插件冲突保护

`设置` 页面公开默认开启的「插件冲突保护」开关与最近五次自动修复。它说明修复会保留较早加载的活动插件，并在较晚的冲突条目启动之前将其禁用。当观察到新的修复时，一个覆盖整个 frame 的模态框会点名被保留的插件、被禁用的插件与重复的资源。

-----

<a id="embedded-community-plugins"></a>
## 内嵌社区插件

FreeCodeGo 设置页包含一个精选的社区插件页面。它消费本地 `dsh-market` Host 路由（`/dsh-market/registry`、`/dsh-market/install`、`/dsh-market/status` 与 `/dsh-market/restart`），而不是实现第二套包安装器。部署方应当把较新的 `dshmarket` bundle 与 `embedded` client 行为组合在一起；该市场的完整导航被抑制，其经校验的安装引擎仍可供 FreeCodeGo 页面使用。

社区包含 `插件` / `MCP` / `Skills` 过滤器。MCP 页面读取分页的 MCP.so 目录与实时分类计数；Skills 页面读取分页的 skills.sh 目录。两者都保留由 Host 持有的搜索与安装，因此浏览器代码拿到目录元数据，但绝不执行市场安装命令。

社区过滤器旁边固定的 `已安装插件` 入口会打开已安装社区插件列表。卡片显示其激活状态，并把安装操作替换为 `卸载`。该请求由 Host 接收，因此它可以停用正在运行的 Loader 条目并更新 profile 包清单；浏览器代码不运行 `pnpm`，也不改动 profile 文件。

-----

<a id="companion-in-the-sidebar-rail"></a>
## 侧边栏与输入框上方的形象

选中会话自身的活动会以一个形象呈现，分坐两处且始终一致。侧边栏标记注册进上游的 `sidebar.brand.mark` 槽位，优先级比默认占用者低一级，因此官方标记与其周围的所有控件——收起按钮、品牌行的新建会话入口——仍属于上游。输入框上方的条带则挂进 `conversation.input.dock`，排在上游的 todo、goal、queue 三条之后，并从那里取得宽度：它测量自己这个全宽元素，因此面板变宽时画出的形象会跟着变大，而不是维持同一个小点。两处共用同一个时钟、同一套阶梯与每挂载一份的引擎，因此不可能对「Agent 正在做什么」给出不同答案。

形象显示当前会话在做什么——待机、思考、执行、等待你的回答、出错、完成、输出中、已休眠——并且每个形态都带有来自 `freecodego.companion` locale 命名空间的自有文案，因此「发生了什么」从不只靠一个形状来说。条带在整个会话期间保持同一条高度并始终挂载，因此它显示的任何内容都不会推动输入框及其上方的对话区；两种静息形态改为以低饱和度绘制，而不是离开。每个形态都会走完它自己动画量出的最短停留时长，因此一串连续的工具调用不会让画面闪烁；`prefers-reduced-motion` 下则冻结为单帧，而不是加快播放。

该形象来自一份以 MIT 许可内嵌的引擎，按时间纯函数采样；内嵌副本的来源、哈希与许可记录在 [`src/client/companion/engine/PROVENANCE.md`](src/client/companion/engine/PROVENANCE.md)。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除 client 集成测试之外，浏览器端表面没有可独立观察的 Host 关系。

上述每项能力都通过 FreeCodeGo remote 而非私有通道抵达 Host；需要新操作的页面应当新增 remote，而不是第二套传输层。

</details>

**运行时不变式：** 浏览器不持有任何凭据值，也不改动任何 profile 文件。
