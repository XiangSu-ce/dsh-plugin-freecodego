---
description: "可安装的 Cordis bundle：为 DeepSeek Harness 挂载 FreeCodeGo 引擎清单、Host 配置表面、engineering 工具与设置 Remote。"
kind: "package-reference"
---

# dsh-freecodego-harness-plugin

[English](README.md) | 中文

## 概述

面向 FreeCodeGo root-engine 清单与 Host 配置表面的可安装 Cordis bundle。

它挂载 `dsh-agent-engine`，发布 DeepSeek、Codex 与 Claude 描述符，并且只有当原生引擎已校验的清单、摘要、协议 ABI、worker 路径与状态目录同时提供时才予以接纳。它的路由器是唯一的 Harness `AgentFactory`，因此请求的原生引擎绝不会回退到 DeepSeek。

`setDefaultEngine` 与 `setDefaultModel` 决定新会话以什么开始，通过 `ctx.settings` 持久化在 `freecodego-harness` 命名空间中，并让已有会话仍钉在其持久计划上。

本 README 只要点名一个决策，该决策就是契约。

## 目录

- [文档](#documentation)
- [Subagent 模型路由](#subagent-model-routing)
- [免费模型](#free-models)
- [Advisor 评审回路](#advisor-review-loop)
- [Engineering 增强](#engineering-enhancement)
- [代码审查](#code-review)
- [上下文压缩（Headroom）](#context-compression-headroom)
- [提示词构成](#prompt-composition)
- [压缩后补灌](#post-compaction-rehydration)
- [项目记忆](#project-memory)
- [上下文纪律、命令策略与 Plan Mode](#context-discipline-command-policy-and-plan-mode)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [插件冲突保护](#plugin-conflict-protection)
- [发布更新](#release-updates)
- [Zcode GLM-5.3 Flash 推广](#zcode-glm-53-flash-promotion)
- [MCP 与 Skills](#mcp-and-skills)
- [可选的本体能力](#optional-harness-capabilities)
- [第三方插件工具](#third-party-plugin-tools)
- [媒体默认值](#media-defaults)
- [模型选择器与供应商账号](#model-picker-and-provider-accounts)
- [设置迁移：孤儿 Engineering 键](#settings-migration-orphan-engineering-keys)
- [社区插件](#community-plugins)
- [开发备注](#dev-note)

-----

<a id="documentation"></a>
## 文档

本 README 是顶层文档：它描述插件挂载的每一项功能、它做出什么决策，以及为什么。有两个主题大到需要单独成文，且都以中文撰写：

- [`docs/free-providers.zh.md`](docs/free-providers.zh.md) — 免费模型提供方集成（Cline、WorkBuddy International）：上游契约、账号池，以及两个适配器共同实现的轮换语义。
- [`freecodego-api/docs/backend-contract.zh.md`](../freecodego-api/docs/backend-contract.zh.md) — 本插件与 FreeCodeGo 后端之间逐 endpoint 的契约，包括哪个字段决定路由结果。

其余内容都在 `packages/freecodego/` 下的包 README 里：设置表面见 `harness-ui`，后端客户端见 `freecodego-api`，路由选择见 `agent-engine-router`，原生引擎见 `root-agent` 以及 `runtime-codex` / `runtime-claude` / `native-runtime-host` / `native-runtime-protocol`，发布组装见 `bundle-latest`。

<a id="subagent-model-routing"></a>
## Subagent 模型路由

启用 `autoSubagentModelSelection`（默认开启）时，Host 会把每条实时 text-model 路由同步进 Harness 的 `subagent-model-selection` 设置。因此新的顶层会话会获得标准的 `subagent` 字段 `provider`、`model` 与 `reasoning_effort`，以及按需的 `list_subagent_models` 发现工具，而不需要用户维护一份复选框清单。暂时失败的提供方会保留它最后获批的路由，直到其 catalog 恢复。

被拉起的子会话继承父会话的 FreeCodeGo 执行引擎，并可以按单次委派覆盖确切的 LLM 路由。DeepSeek 在官方 AgentLoop 中执行子会话；Codex 与 Claude 保留其原生运行时，但把所选模型经 Host 桥接取路由。已有会话保留其持久 Subagent 策略；获批 catalog 变化后请新建对话。

<a id="free-models"></a>
## 免费模型

<!-- generated:free-models:begin by scripts/generate-free-model-tables.ts -->
下面每一行都来自各提供商自己的目录，在你打开选择器时读取；也就是说，这是那些目录在 2026-09-23 返回的结果（按名称排序，选择器里保持目录顺序），而选择器里的数量才是你查看时真正成立的数量。

| 提供商 | 免费模型 | 目录 |
|---|---|---|
| **OpenCode** | `big-pickle`、`deepseek-v4-flash-free`、`jev-1.13-free`、`ling-3.0-flash-fin-free`、`mimo-v2.5-free`、`mimo-v2.6-flash-free`、`muse-spark-1.2`、`muse-spark-1.2-contributor-free`、`muse-spark-1.3`、`muse-spark-1.3-contributor-free`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free` | 76 行中的 12 行；公开，无需登录 |
| **Kilo** | `cohere/north-mini-code:free`、`dots-studio/dots-3-note-preview:free`、`inclusionai/ling-3.0-flash-fin:free`、`inclusionai/ling-3.0-flash-sante:free`、`inclusionai/ling-3.0-flash-vl:free`、`kilo-auto/free`、`liquid/lfm-2.5-2.6b:free`、`nex-agi/nex-n2.5-mini:free`、`nex-agi/nex-n2.5-pro:free`、`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`、`nvidia/nemotron-3-super-120b-a12b:free`、`nvidia/nemotron-3-ultra-550b-a55b:free`、`nvidia/nemotron-3.5-content-safety:free`、`nvidia/nemotron-3.5-lightning:free`、`openrouter/free`、`poolside/laguna-s-2.1:free`、`poolside/laguna-xs-2.1:free`、`qwen/qwen3.8-27b:free`、`stepfun/step-3.7-flash:free`、`thinkingmachines/inkling-small:free`、`z-ai/glm-5.2:free` | 385 行中的 21 行；公开，每个出口 IP 每小时 200 次 |
| **Logfare** | 对话 `deepseek-v3.2`、`deepseek-v4-pro-0813`、`gemma-4-26b`、`gemma-4-31b-it`、`glm-5`、`glm-5.3`、`glm-5.3-flash`、`grok-4.6`、`kimi-k2.5`、`kimi-k2.6`、`kimi-k2.7-code`、`logfare/auto`、`moondream3.1`、`qwen-3.8-27b`、`step-3.7-flash`；图片 `flux-1-schnell`、`flux-2-dev`、`flux-2-klein-4b`、`flux-2-klein-9b`、`sdxl-lightning`；音频 `melotts`、`whisper-large-v3-turbo`；其他路由 `aura-2-en`、`lucid-origin`、`nova-3`、`phoenix-1.0` | 26 行；18 行需要训练数据授权，其余 8 行不需要 |
| **Qoder** | `Qwen 3.8 Flash`（路由 `qmodel_38flash`） | 免费 flash 路由，另有每日签到活动 |
| **NVIDIA** | `google/gemma-4-31b-it`、`moonshotai/kimi-k3`、`z-ai/glm-5.3`、`z-ai/glm-5.3-flash` —— 名单里另有 `deepseek-ai/deepseek-v4-flash-0731` 与 `deepseek-ai/deepseek-v4-pro-0813`，这两个名字已不在 NVIDIA 实时目录（82 行）中 | 调用需要 API key；核对于 2026-09-23 |
| **SenseNova** | `deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.2`、`kimi-k3`、`sensenova-6.8-flash-lite` —— 均为 1M 上下文 / 128K 输出 | 名单随 bundle 内置；需要 API key |
| **TRAE** | 其目录列出的那些行 | 免费额度每日重置，按账号 |
| **Cline** | 目录标记 `×0 · 官方免费模型` 的那些行 | 账号池 |
| **WorkBuddy 国际版** | 积分包标记 `x0` 的那些行 | 设备登录，可放多个账号 |
| **Agnes** | 对话与图片/视频行 | 控制面账号 |
| **VyceAI** | 没有免费名单 | 每日签到额度支付其计量行 |
| **Groq** | `whisper-large-v3-turbo` | 仅转写，不是对话路由 |

这些清单跟随各自的目录：上游下架的路由会在下次读取时从表中消失 —— 这正是本表由 `scripts/generate-free-model-tables.ts` 生成、而不是凭记忆维护的原因。

TRAE、Cline、WorkBuddy 国际版、Agnes 不公布固定名单，因此它们的行在到达时计数，而不在此列名。

Logfare 有 18 行位于训练数据授权之后，选择器会标注而不是隐藏它们。

<!-- generated:free-models:end -->

<a id="advisor-review-loop"></a>
## Advisor 评审回路

独立的 Advisor 在公开的 `freecodego/hy3` 路由上默认启用。它以独立的模型上下文评审持久轮次事件，并且只拥有有界、只读的工作区工具（`read`、`glob` 与 `grep`）。它的结论与 token 用量被追加到 Harness 会话；凭据、隐藏推理与不受限的主 Agent 工具绝不复制进评审上下文。

每个 DeepSeek、Codex 与 Claude Agent 都会收到 `advisor_status`、`advisor_review` 与 `advisor_notes`。这让活动 Agent 能查看评审者、在有用的检查点请求第二意见，并消费既有结论，而不需要单独的 UI 操作。具体的顾虑或阻塞会引导 Agent，而低严重度或处于冷却期的结论会在下一个安全步骤注入。原生 Codex 与 Claude 把引导作为后续原生轮次消费，并在下一个用户轮次之前暂存注入。关闭 Agent 控制则只把结论保留为 `record` 事件。更改 Advisor 路由或投递设置即时生效；原生会话在每轮之前刷新其投影出的 Harness 工具。

会话删除对陈旧的侧栏行是幂等的：当会话日志已被移除但缓存的投影仍列出该 id 时，Host 清除其工作区关联并返回成功，而不是留下一个无法删除的 Ungrouped 行。活动或正在运行的会话仍必须在删除前关闭。

<a id="engineering-enhancement"></a>
## Engineering 增强

### 多引擎 Engineering 团队

Engineering 团队让当前 root Agent 留在它选定的引擎上，同时为一次有界、只读的评审启动隔离的 DeepSeek、Codex 与 Claude 子 Agent。`engineering_team_start` 接受一个目标与草稿计划，运行一轮独立评审，可选地运行一轮交叉质询，并在父 Session 中记录共识、异议、参与者状态与最终建议。子 Agent 不能编辑文件、执行 shell 命令、创建另一个团队或更改权限。运行时缺失与失败的参与者会被分别报告；只有配置的最少参与者数量完成时，团队才达到法定人数。

团队可以在前台运行，也可以返回 `council_*` id 供 `engineering_team_status` 轮询；`engineering_team_cancel` 取消所有子 Agent。父 Session 恢复之后，完成的报告仍可通过 `engineering_team_report` 与 `engineeringTeamReports` Host Remote 获取。把 `engineeringCouncilAutoRun` 设为在获批的 `exit_plan_mode` 计划之后自动运行一次评审；它默认关闭，以便用户保留显式控制权。

完成的报告是证据，不是编辑许可。实施之前，用户必须通过 engineering 团队批准命令或 `engineeringTeamDecision` Remote 明确批准或拒绝它。只有获批的报告才能运行 engineering 团队验证；默认运行会在父 Session 中记录 `scope`、`build`、`types`、`lint` 与 `tests` 结果。

#### 验证证据与对抗式探针

通过的阶段是证据，不是主张。每个阶段结果都携带实际运行的命令与它返回的退出状态，而无法运行的阶段会报告 `skipped`、`unavailable` 或 `refused`——绝不是通过。当写代码的东西同时也是 LLM 时，正是这条规则要紧：被宣告为绿色的门禁只说明项目自己的检查仍然通过，与这次改动本身引入的失效模式毫无关系。

因此，只有当至少一个**对抗式探针**运行过并守住了它的预期时，验证才是 `verified`。探针是校验者在运行它*之前*就声明的独立检查——一个边界、一个并发场景、一次幂等重跑、一个孤儿操作——带明确预期（`pass`，或对于应当拒绝新输入的守卫用 `fail`）与一份点名它会捕获何种破损的理由。声明式的失败才是更有意思的那一半：一个不再触发的守卫会让这次运行变红，而不是静默通过。

判定是计算出来的、不是推断出来的，并且报告每一条未满足的理由：

| 判定 | 何时 |
|---|---|
| `verified` | 每个声明阶段都带记录证据通过，且每个探针都守住 |
| `failed` | 某阶段失败或被拒绝、某个探针没守住，或某阶段在没有记录命令的情况下通过 |
| `unverified` | 阶段被跳过／不可用，或根本没有提供任何探针 |

探针由模型撰写，因此这些控制按 fail-closed 处理：空或畸形的探针、理由为空的探针，或触碰网络、发布、删除的探针，都会以 `refused` 加 `held: false` 记录，从而把这次运行强制为 `failed`，而不是悄悄丢掉这项检查。命令不经 shell 派生，环境禁用网络抓取，每个探针与阶段受同一个五分钟超时约束，并且工作区在每个探针周围都会被取指纹，因此一个会改动树的检查不可能同时充当「树没问题」的证据。空的 argv 项会被保留——`git commit -m ""` 与 `git commit -m` 是不同的命令，而重写 argv 的归一化器正是探针测到别的东西的原因。议会子 Agent 使用 Harness 只读沙箱与永不批准策略。Codex 还会收到 App Server 只读沙箱加不批准设置，而 Claude 使用 plan 权限模式与显式的原生工具允许清单。

议会任务公开明确的生命周期（`queued`、`running`、`awaiting_approval`、`implementing`、`verifying`，以及若干终态）。请求与状态迁移都作为会话事件持久化，因此被中断的活动任务会恢复为 `stale`，而不是被静默丢失。批准记录包含计划摘要、工作区指纹、策略摘要与过期时间；其中任何一项变化都按 fail-closed 处理，并要求重新评审。报告还包含结构化的 `info`／`warning`／`blocker` 结论，并可从设置面板导出。DeepSeek、Codex 与 Claude 的参与可以独立开关；在允许启用某个参与者之前，设置表面会报告 Codex／Claude 运行时是否已安装。批准之后，主 Agent 必须先调用 `engineering_team_mark_implemented`（或 `engineeringTeamImplementation` Remote）并附上有界摘要，`engineering_team_verify` 才会被接受。

可选的 Engineering 增强总开关会挂载经审计的随包 engineering Skills、静态资产 Doctor 检查、有界的声明式脚本验证，以及由 Host 持有、被 DeepSeek、Claude 与 Codex 共享的工具。设置页只放那个总开关；细粒度控制位于动态的 Engineering 侧栏入口中。

Engineering Memory 是 `DSH_HOME/freecodego/engineering/memory` 下的本地 SQLite 状态。Agent 可以保存草稿，并使用只针对已评审内容的 `Search -> Timeline -> Get` 流程。只有面向用户的 Remote 可以批准、拒绝、导出、清除或删除记录。草稿绝不进入自动召回，记忆操作通过一个以工作区为后端的打开会话来限定作用域。

插件私有状态——记忆、检查点、Code Graph 与 Graphify 运行时、任务与 plan mode——通过一个 helper 而不是各模块各自解析其根：`FREECODEGO_HOME` 被设为非空值时用它，否则用 `DSH_HOME`，否则用 `~/.dsh`。下文每个 `DSH_HOME/...` 路径都按这条规则理解，因此设置 `FREECODEGO_HOME` 会一次性移动它们全部。Host 自有的文件（`.credentials.yaml`、`settings.yaml`、`profiles/`、`runtimes/`、`state/`、`.agent-presets/`、`skills/`）绝不跟随该覆盖：这些由 Host 读写，第二个根会让设置表面与凭据服务对「哪个文件才是真源」产生分歧。

Code Graph 提供两个可互换的引擎，并且只挂载一个 Agent 工具族，由 `engineeringGraphEngine` 设置选择（`auto` 偏好无 Python 的引擎，`graphify`／`codegraph` 表示就是该引擎或什么都不挂）。

Graphify 引擎在 SHA-256 校验之后下载官方 `graphifyy==0.9.52` Wheel，并在 `DSH_HOME/freecodego/engineering/graphify` 下引导一个以 SHA-256 钉住的官方 uv 发布包与私有 Python 3.12。它的首次构建使用 Graphify 原始的仅代码提取器，并且只把图、缓存与报告写入插件自有的项目目录。它不会创建工作区 `graphify-out`、不安装 hook、不改 `PATH`，也不用 Lite Graph。用户构建出图之后，Agent 会获得有界的官方 Graphify search、explain、path、impact 与 overview 工具。

CodeGraph 引擎在 SHA-256 校验之后下载针对当前 OS/CPU 的官方自包含平台 bundle（48-62 MB），并解包到 `DSH_HOME/freecodego/engineering/codegraph` 下。该 bundle 自带 Node 运行时，因此这个引擎不需要 Python、不需要 `uv`、也不需要 wheel；musl Linux 会被拒绝而不是被近似处理，因为官方 Linux bundle 是 glibc 链接的。CodeGraph 把它的索引目录解析为项目根之下的一个路径段，因此这个引擎把索引留在工作区的 `.codegraph-freecodego` 而不是 `DSH_HOME` 下；该目录带一个自我忽略的 `.gitignore`，插件只在用户显式操作时才删除它。每个插件自有的进程都在匿名遥测、后台守护进程与 CLI 自身的下载回退被禁用的情况下运行，且插件绝不运行 `codegraph install`——那会重写用户其他的 agent 配置。用户构建出索引之后，Agent 会获得有界的 `engineering_codegraph_explore`、`_search`、`_explain`、`_path` 与 `_affected` 工具。

两个引擎都通过同一条共享下载路径安装与校验：产物边流式落盘边哈希，暂时性的传输失败重试一次，而摘要不匹配是终局的、绝不重试。

### 确定性扫描选择

一次扫描覆盖哪些改动文件，由一个纯函数决定，而不是由提示词决定——因为提示词回答不了用户终究会问的三个问题：**哪些**文件、**为什么不是**其余那些、以及**有没有东西被跳过**。`src/scan-selection.ts` 接收改动路径和每条路径的一个已测量事实，为每个文件返回一条决定（选中，或带理由排除），并**封存覆盖率分母**：运行时必须交代的那一份确切集合。它不做 IO、不读 git、不调模型，因此预览和真实运行消费的是**同一个答案**，而不是各自推导出两个、然后漂移。

各道闸门按**声明的顺序**运行，因为顺序本身就是这个函数的实质。删除的文件没有内容可扫，最先离开分母。凭证路径在任何模式规则**之前**被拒，所以位于 vendor 源码里的凭证文件报告的是 `credential`——那才是解释“为什么没人看它”的理由。随后模式规则命名出“发现了也无法行动”的路径：已安装依赖、vendored 源码、构建产物、生成元数据、lockfile。测试文件**有意不排除**，这是相对本项目所参照的上游默认表（阿里 Apache-2.0 的 `open-code-review`）的一处偏离：本插件盯得最紧的缺陷类，正是“断言为空却报绿”的测试，而一个从不打开测试文件的扫描看不见它。

大小是最后一道闸门，而且它是对**字节**设的上限，不是对估算值：估算值只为展示而经插件唯一的 token 估算器定价，这样本模块就不会变成第二处给文本定价的地方。**大小无法判定**的文件会**保持选中**并被具名标记为未检查。“没量过”与“很小”是两个不同的答案，而只有一个才是把目光移开的理由；把未知读成其中任何一个，都是“靠不看而通过的预算”。

`engineering_inspect` 把这次选择作为 `scan` 段报告：分母、每一条带理由的排除、运行会读到的字节与 token 合计，以及所有大小未检查的文件名。该段**有意不受**文件夹信任门禁约束，差别在于它读什么——大小与路径名，从不读内容。字节数不是指令，而把它门禁掉，会让一份在“没人信任过的检出”上**仍然可用**的诊断也消失。账本的**对账**那一半——运行时究竟交代了哪些被选中的文件——尚未实现，因为本插件还没有任何地方记录**逐文件的扫描结果**：council 与 advisor 报告携带的是发现，而不是它们覆盖过的文件集合。

<a id="code-review"></a>
## 代码审查

一个引擎上的四个工具：把 OCR 风格（open-code-review）的改动审查重建为 Host 自有机制，外加一个可选的收尾门禁。流水线在 `src/review/`，组装根是 `review/install.ts` —— 宿主文件只增加一个 import、一次调用与一次注册，而不必自己拥有八个协作者。

| 工具 | 回答的问题 |
|---|---|
| `engineering_code_review` | 审查这次改动（`mode: workspace \| range \| commit`，输出 `text \| json \| sarif`） |
| `engineering_review_rules` | 会审查什么、按哪条规则 —— 不花模型调用 |
| `engineering_review_status` | 现在在跑什么 |
| `engineering_review_report` | 把上一次结果按另一位读者重新渲染 |

`engineering_review_rules` 之所以是工具而不是开关，是因为它是整条流水线里不含模型调用的确定性那一半：调用方要自己去做审查时需要它，而"我的 exclude 模式生效了吗"也不必花掉一次审查的预算才知道。每个工具返回文本而不是对象，是因为三种格式的区别在于**谁来读** —— 人、另一个 Agent、或扫描集成 —— 所以格式是参数，答案到达时已经渲染好。

**审查什么是决定，不是 `git diff | head`。** 在第一次模型调用之前有三项决定，每一项都是审查可能悄悄小于它声称覆盖的那份改动的地方：

- **对比哪些引用。** 工作区审查意味着已暂存**加**未暂存**加**未跟踪；未跟踪那一半是朴素 diff 永远看不到的，而新文件最严重的缺陷正好住在里面。范围审查从 **merge base** 开始 diff，而不是从 `from`，否则基线分支上的每个提交都会变成审查者的问题。提交审查对比它自己的第一父提交。
- **跳过了什么，以及为什么。** 二进制内容没有行可审；过大的文件会把整份预算花在一个 diff 上；被排除的模式是项目已经做过的决定。每条跳过都连同原因与**类型**一起记录（`ReviewSkipReason` 是封闭并集），因此报告可以给跳过分组而不是打印自由文本，而一个没有原因就消失的文件也无法与一次被遗忘的文件区分。
- **覆盖面。** 进入一次运行的文件都会留下交代（`pending` / `reviewed` / `skipped` / `failed`），只要还有东西停在 `pending`，这次运行就不能结束 —— 检查会点名缺失的文件，而不是让分母悄悄缩小。覆盖面是结果集上的纯函数，所以测试不必跑一次审查就能断言这套算术。

**一份报告，三种渲染。** `text` 给人，`json` 给 Agent，`sarif` 给扫描集成，三者渲染同一份组装好的报告，所以同一次运行不会在文本里说出 SARIF 里没有的结论，也不会两种格式给出不同的覆盖率。被事实核查否掉、或被裁定驳回的结论会从 `text` 与 `sarif` 中扣下 —— 注释格式承载不了丢掉它的理由 —— 并留在 `json` 里带上原因；因此 `text` 会声明它扣下了多少条，因为一份静默省略结论的报告会教会读者把那个数字当成全部真相。所有严重级都会渲染，包括 `low`：上游 CLI 也是这样，它把那套 skill 交给**展示方 Agent** 去丢弃琐碎项 —— 而这个渲染器就是展示方，替读者丢掉一条结论不是一份报告可以悄悄做的决定。

**规则分四层解析，命中的第一层胜出。** `custom`（本次运行传入的规则文件）→ `project` → `global`（`~/.opencodereview/rule.json`，仓库无法自己撰写的那一层）→ `system`（随本插件发布）。是命中的**层**胜出，而不是跨层命中第一个模式，这正是项目覆盖能成为覆盖的原因：用户级规则不能被静默合并进一个已经决定了自己标准的仓库的每个 TypeScript 文件。项目的标准放在 `.opencodereview/rule.json`、`.dsh/review.json` 或 `.freecodego/review.json`，按此顺序尝试，存在的第一个就是**那个**项目层 —— 合并两份会让生效标准变成一份没人写过、也没人能预测的文档。用户规则默认替换该文件随插件发布的规则，除非条目设置 `mergeSystemRule`（那会同时纳入基线）；没有这个显式选择，一个只新增一条检查的项目会丢掉所有基线检查且不会被通知。出处随答案传递（`source` + 命中的 `pattern`），分组按这三者取键，因此一个分组报告的出处对组内每个文件都为真。格式错误或不可读的规则文件会产生一条点名它的警告，绝不静默回退：一个以为标准正在生效、而文件里多了一个尾逗号的项目，比从没写过规则文件的项目处境更差。

**高危结论会被对抗性复核**（`reviewEscalation`，默认关）。上游有一个审查者和一个刻意很弱的事实核查者，后者只能移除 diff **证明**为错的东西；这对一般评论是合适的取舍，而对审查者最没能力判断自己的那两类结论是错的。因此达到严重级的结论会被独立裁定者复核，且被要求**反驳**而不是同意 —— 这是一个不对称的问题，因为"确认"是偷懒答案的默认，"反驳"不是。被驳回（有针对该结论的 diff 证据，且确认票未达法定数）会保留结论、置为 `filtered` 状态并附上驳回理由，这是唯一会移除结论的路径，也是这一级**朝保留方向失败**的地方；被确认则连同裁定记录一起发布；未定则原样发布，因为一次没有结论的检查不构成对结论的反证。这个端口刻意只有一个方法：最强实现是本插件自己的多引擎 council，而随插件发布的是单路由对抗复核。

**深度审查**（`reviewDeep`，默认关）会用每个被审查文件各自的只读子 Agent 去读它，可以搜索调用方、打开某个测试覆盖的实现，而不是只凭 diff 判断。默认关，因为它对每个文件开一个子 Agent —— 这是一个有代价的决定，而不是更好的默认值。

**收尾审查是可选的，而且只有一遍。** `reviewMode` 取 `off`（零成本）、`record`（跑这一遍，结论成为持久会话事件，所以"那次审查说了什么"以后不必重跑就能回答）、或 `gate`（同一遍在 `reviewCooldownTurns` 冷却已过后，把达到 `reviewThreshold` 的结论注入回会话）。逐回合审查与收尾门禁听起来是两个功能，其实是同一个审查：分开跑会各自读同一份改动集的同一份 diff，付两次钱，并可能对同一棵工作树给出互相矛盾的结论。三条规则约束成本，每条都有测试：

1. 没有任何改动的回合绝不审查，所以一次纯对话回合不产生任何 git 调用。
2. 同一个改动集只审一次，闩锁在改动路径的指纹**与**工作区修订上 —— 已被修改的文件再改一次不改变任何路径，只看路径会把两个不同状态当成同一个。
3. 一次运行只限于这一回合碰过的东西（`include` 携带这一回合自己的改动路径），因此本来就已经是脏的文件不会被重审，它们的结论也不会被报成这一回合的。这一回合的路径优先取自 Host 自己的逐回合记录，没有时回退到工作区未提交的改动集（`review/turn-scope.ts`，它同时拥有"拒绝收窄"的那些理由）。

投递方式是一条注入消息，这是 Harness 在收尾时刻提供的机制：它会继续这一回合，所以 Agent 必须回应这个结论才能结束。这就是它成为门禁而不是通知的原因，也是 `verify-on-stop` 用的同一种形状。

**路由用的是本插件的第二模型路由**（`advisorProvider` / `advisorModel`，默认落到 OpenCode 的虚拟 `auto`），而不是新增一对设置：两者都是"本插件替自己调用的那个模型"，那一对已经由用户配置、由界面编辑，再加一对只会让同一个意图有两个地方可以设置并互相矛盾。路由按请求解析，所以改设置无需重载即可生效；全新安装开箱就能审查，而不是第一次调用就失败。

**界面侧**的审查 Remote 是发起即返回：一次运行按文件花模型调用、可能跑上几分钟，所以调用只启动运行并回传当下的运行状态，调用方用同一个 Remote 轮询。同一工作区的第二次并发运行会被拒绝，并用一句话点名占着名额的那次运行，而不是排进一个看起来像卡死的队列。每个 Remote 都接收会话 id 并据此解析工作目录 —— 用路径参数就会让浏览器问起一个会话从未打开过的目录。设置页显示模式、阈值、冷却、深度审查与对抗复核，并连同覆盖面算术一起渲染报告。

## Hunk 级变更追踪

检查点回答的是「那次调用之前工作区长什么样」，粒度是文件；它回答不了*哪次*调用引入了某一行，也没法只撤销一次调用的改动而保留其他调用的改动。Hunk 追踪为每一次会写文件的工具调用记录它改动的连续行区间，并把这些区间归属到本体自己的 `callId` 上，再依据文件**当前**内容回退某个 hunk。

两半都挂在工具接缝上：pre-execute 钩子读该调用所命名的文件的**前像**，post-execute 钩子做 diff 并记录 hunk。**失败的调用同样记录**——写了文件却报了错的那次改动，恰恰是只读对话记录永远找不到的那一处。两个值得知道的设计决定：

- **后来的编辑会取代它所覆盖的那些行。** 偏移随编辑到达而维护，因此早先的 hunk 仍保有可用位置；当后来的编辑覆盖了早先 hunk 的行时，那个 hunk 会拒绝独自回退，并指名覆盖它的那个 hunk。回退覆盖方那一次调用就能恢复该状态，所以拒绝信息指向那里。
- **回退先验证再落子。** 记录的后像必须仍在它记录的偏移处，或在别处**唯一**出现（上方编辑把它挪走了）。其余情况一律报 `drifted` 而绝不去猜——包括邻居已不匹配的纯删除：空后像在全文件到处都匹配，这个模块不会从一堆长得一样的空行里挑一个。文件行尾会被保留。

Agent 用 `engineering_hunks` 读这份日志（有界的元数据加五行预览，绝不回整段区域），用 `engineering_hunk_revert` 撤销其中一个——它接受一个 hunk id，或者一个 call id 加上一个文件。这两个工具是**无条件注册**的，不同于代码图谱那几个家族：日志由工具接缝写入、与是否安装引擎无关，所以读它的工具不能依赖引擎存在。

参数来自模型，所以一次调用所命名的文件如果解析到工作区之外就会被拒绝：读 `../../id_rsa` 的前像等于把凭据内容放进一个模型之后可以查询的日志里。

<a id="context-compression-headroom"></a>
## 上下文压缩（Headroom）

Headroom 在模型看到之前压缩过大的工具输出。持久会话日志保留完整原文，压缩后的文本携带 `hash=<24 hex>` 标记，模型获得 `headroom_retrieve` 以取回任何被省略的文本——线上有损，端到端无损。每种策略都按*形态*路由（log、JSON、diff、search、table、config、prose），且每条策略只在确实缩小了自己的输入时才运行。

### 代码骨架化

源代码没有形态签名，因此这次移植最初没有动它——而度量显示，那正是它本可以处理的最大单项成本。在 17 个会话 / 133 步的样本中，`read` 产生了被摄取工具输出 1,025,038 token 中的 875,706（85%），而由于 Harness 在每一步重发整份记录（`deriveMessages` 不做裁剪），这些字节在样本中总共被传输了 21,365,476 token。

`headroomCodeSkeletonEnabled`（默认开启）会为 `read`、`read_file` 与 `view` 的结果指定一个骨架。安全契约是一条子序列：**保留的每一行都是逐字节原文，包括它的 `N: ` 前缀**；只有整段连续的正文行会被替换，每段由一个标记点名它所覆盖的行号范围。imports、声明、类型／接口成员、签名（包括多行参数表）、装饰器、attributes、文档注释、箭头函数的类字段，以及顶层闭合分隔符全部保留。被丢掉的是实现——因此锚定在保留行上的 Edit 仍然匹配，而标记会准确说明读者再也看不到哪些行号。短于三行的连续段会保留而不是标记，因为一个标记的成本高于它本会替换掉的那些行。

在读取小于 2 KB、不是带行号的 envelope、行号不连续、已被另一个压缩器（JSON、config、logs、search、diffs、tables、HTML）占用、按扩展名与检测器都属散文、是错误结果，或缩小幅度低于 25% 时，这次读取会被拒绝而不是靠猜。支持从某个 offset 开始读取窗口，因为 agent 正是这样读大文件的。

在 1,983 个真实仓库源码上度量，骨架让已应用文件的总量减少 61.5%（中位数 58.3%，p25 49.5%）。把样本会话以骨架化的 read 重放，总重传从 21,365,476 降到 17,820,922 token：**占全部发送量的 16.6%**，无需改配置，也没有丢掉模型仍能匹配的任何一行。

关掉开关即恢复逐字节读取。read-fold 旋钮与此无关：它把无损折叠应用到那些恰好看起来像 search 或 log 输出的 read 上。

### 按需工具 schema

工具块是另一项固定成本：同一样本中，每个请求有 45.7-47.4 KB（11,700-12,130 token）是工具 JSONSchema，而 61-74 个工具里有 37 个是本插件的——14,380 字符，占该块的 27%，在每个轮次的每一步都被重发。一个只改设置的轮次永远不会碰图查询、记忆 CRUD、检查点恢复、议会编排或媒体生成。

`deferredToolSchemasEnabled`（默认开启）让这些工具保持注册但扣住它们的 schema。在 `agent/session-start` 上，插件在一次绝不会阻塞会话的尝试中用 `deny: [...deferred]` 限定 agent 的工具作用域；Harness 从可见集合推导线上 schema，而被拒绝的名称会让一次直接调用以 `UNKNOWN_TOOL` 失败——可见性与可调用性读自同一个真源，因此模型既不能调用没被展示给它的东西，也看不到自己不能调用的工具。`tool_search` 随后为它返回的工具解除该拒绝，因此在一次发现调用之后，一个延迟工具与一个立即工具一样可用。查询语法刻意跟随 Claude Code 的 `ToolSearch`：`select:A,B` 用于精确名称，`+term rest` 要求名称中含某个词，裸关键词用于排序。

`tool_search`、`engineering_status`、`engineering_repo_map`、`advisor_review` 与 `headroom_retrieve` 从不延迟。延迟一个入口点等同于把门锁上，前两个是用户在别的东西都不灵时会去用的，而后两个回答的是模型已经被展示过的东西——一个去咨询 advisor 的提示，或压缩标记里的一个 hash——在那里走一轮发现往返纯粹是延迟。

关键词查询按名称与描述的 BM25F 排序（`tool-search-rank.ts`），而不是数子串命中：稀有度就地从这份延迟目录本身计算，词频会饱和，描述长度被归一化，而一个三字符以上、前缀命中某个词的查询词按半次命中计。旧的计数法在几百个工具的目录上会暴露三件事：每个描述都有的词压过真正要紧的那个、最长的描述获胜、重复的词压过一个工具自己的名字。`max_results` 的公开上限在生成答案的地方被强制执行，而不只是写在描述里。

索引本身也像任何其他输出一样被计价（`tool-catalog-budget.ts`，1,000 token）：能装下时渲染 `name — summary`，装不下时退化为只有名称，再装不下时退化为每个名称前缀一行加计数与几个样本。每一档都会说明自己丢掉了什么、以及怎么把它要回来，并且任何一档都不能藏起一个名称——`list:<prefix>`（以及 `list:all`）返回不带 schema 的名称，这就是一个被分组摘要掉的名称仍然可达的方式。今天 37 个工具的目录约 930 token，略低于预算，因此在目录真正长过它之前这次改动是不生效的。

该工具的描述是**静态的**，并且刻意不点名任何延迟工具。那里的动态索引会在每次设置变化时改动工具块，并使它之后所有内容的 prompt-cache 前缀作废，这正是 Claude Code 自己的源码记录下的失效模式（约占其机群 cache-creation token 的 10.2%）：损失远大于省下的定义。索引改为由一次无参数的 `tool_search` 调用返回。

<a id="context-discipline-command-policy-and-plan-mode"></a>
## 上下文纪律、命令策略与 Plan Mode

这些机制共享同一个想法：只以散文形式存在的规则无法被执行、测试或评审——而模型看不到的成本，就是它无法规避的成本。

**差分上下文注入**（`context-fragments.ts`）。被注入的常驻上下文被拆成具名分区，每个分区带一份快照。没有变化的分区**什么都不发**；发生了变化的分区先发一条**替换通知**；消失的分区发一条明确的**移除通知**，而不是被静默省略，因为一条模型只是不再看到的指令，仍是它继续遵守的指令。`unknown`（在恢复、压缩或重启之后）被视为*可能仍然持有*，会带通知重发而不是跳过通知。当预算缩短了分区时，分区报告 `incomplete`，因此「我们看过、里面没有」与「我们不再看了」始终可区分。该引擎是纯的：`plan()` 计算，`commit()` 记录实际追加了什么，因此被取消的轮次无法让日志与模型上下文失同步。

**缓存未命中归因**（`cache-attribution.ts`）。台账已经记录了每个轮次花了多少；这里补上它*浪费*了多少。它按轮次计算上一轮提示词中未从缓存读取的字节，按付费费率减去缓存读取费率计价，并标注原因：模型变了、请求在提供方 TTL 之后才回来，或前缀本身移动了。1024 token 及以下的移动作为断点粒度被忽略，而从不报告缓存的提供方会被报告为不可归因，而不是每一轮都报 100% 未命中。

它运行在本地台账（`token-usage.ts`）*内部*而不是旁边：每个被报告的轮次都成为一条观测，而会话遍历已在飞行中，因此面板会把被重新计费的 token 显示在促使它们产生的输入总量旁边。当该范围没有可比内容时，这个块会被省略——绝不清零——因为「这个提供方不报告缓存」与「这个范围什么都没浪费」是同一片沉默得出的相反结论。价格也不会被凭空发明：作用域内没有费率时，面板只陈述 token。

**模型可见的上下文预算**（`context-budget.ts`）。我们的开销探针发现，压缩在实践中从不运行，而模型也从不知道自己的上下文有多满——于是那个本可以规避成本的一方（通过读一个范围而不是整个文件，或提前压缩）恰恰是没被告知那个数字的一方。Codex 用一段 `<rollout_budget>` 风格的片段加一个 `get_context_remaining` 工具闭合了这个缺口，而难的那一半不是数字，而是在不摧毁这个数字所描述的那份缓存的前提下把它注入：一段每轮都变化的片段会每轮重写前缀，这正是 Claude Code 自己的源码为动态 agent 列表记录下的失效模式（约占其机群 cache-creation token 的 10.2%）。因此被注入的文本被**量化成五个档位**——只要会话停留在同一档内就完全一致，只有跨档时才发替换通知，并且它是被*追加*的，因此最后一个缓存断点之前的一切仍保持命中。精确数字存在于 `engineering_context_budget` 中，其 schema 被延迟，因此在被问到之前不产生任何成本。

三条规则使这个信号可信到足以据此行动。**估算不是度量**：token meter 的基线要么是提供方用量，要么是启发式，而启发式会被标注为启发式，因为一个被猜测出来的「还剩 4,000 token」告知的模型，会基于一个假数字做出真实决策。**未知窗口就陈述为未知**：不公布上下文窗口的模型会得到它的已用量，而不会得到被凭空发明的分母。**不规定阈值**：档位点名一种状况以及适用于该状况的补救方式，而不是在某个 token 数上命令一个动作；并且预留只从确实存在的空间里扣除——一个 150k 的请求对着 100k 窗口是超出 50k，而不是 50k 加上本来计划要写多少回复。

**声明式命令策略**（`command-policy.ts`）。规则是数据：`pattern`（有序 token，允许备选）、`decision ∈ allow | prompt | forbidden`、`justification`，以及——真正要紧的那部分——`match` 与 `notMatch` 示例。**自己的示例不成立的规则在加载时就被拒绝**并给出诊断，因此规则集在它被书写的地方自测。最长模式胜出，同长时归较早的规则，这正是让一条窄的 `forbidden` 坐在宽泛的 `prompt` 前面的做法。`hostExecutable(name, paths)` 钉住哪些绝对路径可以经由 basename 规则解析，因此一个被植入的 `./git` 无法满足为 `/usr/bin/git` 写的那条规则。守卫只把 `forbidden` 变成拒绝：单调守卫无法把拒绝反过来变成批准询问，因此 `prompt` 留在真正可以询问的审批层。

**Plan Mode**（`plan-mode.ts`）。一种在结构上拒绝工作区变更的对话模式：改动文件的工具被拒绝，shell 命令由上面那套策略判定（任何它未放行的命令都以该规则自己的理由被拒绝），而读取、搜索与运行检查仍然可用。该模式按对话持久，并且**不会因为一句话要求执行而结束**——只有带 `action: "exit"` 的 `engineering_plan_mode` 才会离开它。模式规则通过片段日志注入，因此离开 Plan Mode 会发送移除通知，而不是让陈旧的限制继续生效。

**动作评审**（`action-review.ts`）。Guardian 风格评审器的策略那一半：一个按历史代取键的增量记录游标（被压缩或回滚过的历史会强制全量重读）、按分区计入截断标记自身预算的 token 上限、每会话的评审预算，以及一个从会话而非动作推导出的稳定评审缓存键。缺席永远不是放行：没有配置评审器、预算耗尽，以及评审器抛异常，全都返回 `ask-user`。

**注入表面锁**（`surface-lock.ts`）。`engineering_surface_report` 度量本插件注入了多少字节的工具 schema 与指导文本，并把该值与一份经评审的锁做 diff（`added` / `removed` / `changed` 分别报告），因此改提示词是一个可见的 diff 而不是不可见的。token 数字在它出现的每一处都被标注为估算——`approximateTokens` *不是*分词器计数，也不是一个任务的成本。

**缓存冷清除**（`cache-cold.ts`）。第二条更窄的压缩路径，只有一条规则：当距上一条主循环 assistant 消息超过一小时时，提供方的 prompt cache 肯定已过期，整个前缀无论如何都会被重写——因此在下一个请求*之前*清除较旧的工具结果，恰好缩小那部分已经确定会被重新计费的内容。理由不是这些内容旧了。一小时阈值位于所有已公布的 TTL 之外，因此该机制无法制造一次本不会发生的未命中；而清除标记是按会话的，因此同一段内容绝不会被处理两次：清除按构造幂等，而不是靠调用方记得。

**请求形态指纹**（`request-shape.ts`）。上面的缓存未命中归因是对台账做算术；这里的是因果的那一半。每个请求之前都会对线上形态取哈希——system 文本、工具集、**每个工具各自的 schema**、模型、betas、预算档位——下一个响应的 cache-read 下降会被归因到一个具名变化。逐工具哈希之所以存在，是因为现实中占主导的情形是工具*集合*未变而某个工具的描述移了位，而任何增／减计数都看不到这种情况；那种情形会被点名到具体移位的那个工具。那些曾在对话中途翻转并使前缀作废的 flag 改为粘性开启：不再要紧的 flag 会被保持开启，而不允许它翻回去，因为第二次翻转才是昂贵的那次。

**按比例验证**（`verification-tier.ts`）。验证曾经对一行守卫与对一次调度器重写花费相同，这既对小改动过度收费，又——更糟——给大改动提供了不足的证据。现在档位从改动本身选取（用 `git status --porcelain` 判断*什么*动了，因此未跟踪的新文件也被计入，加上 `diff --numstat` 与每个未跟踪文件自身的长度），安全片段、架构片段（清单、lockfile、CI、迁移）与广度都会强制升到 `thorough`。每个档位都保持两条不变式：**档位可以减少跑哪些阶段，绝不可以减少什么算作证据**——被跳过的阶段仍报告 `skipped`，没有探针的运行仍是 `unverified`——以及**档位要与它省略了什么一起报告**，因为「没有失败」与「在我们跑过的检查里没有失败」是不同的主张，而只有其中一个是真的。覆盖情况仅由路径推断，因此一个未伴随任何测试文件的改动无论多小都永远到不了轻量档。

**记忆的凭据筛查**（`secret-scan.ts`）。项目记忆是从 agent 读到的东西写成的，因此一个 `.npmrc` 或一条粘贴进来的 curl 命令可以把真实令牌写进一条会活过该会话、并在后续对话中被重新注入的条目。这份精心挑选的规则集在有用的方向上做子集：只取带独特厂商前缀、误报率极低的规则，刻意不要那些让人干脆关掉扫描器的通用关键词上下文规则。扫描器从不返回密钥本身——一条命中只携带四个字符的前缀与一个长度——而置信度也是匹配的一部分。在写入路径上，*被标注*的凭据（既有那条关键词规则）与*厂商前缀*凭据都会拒绝该条目，而仅形态匹配（一个 JWT、一个裸 `sk-`、一段 PEM）会在原地脱敏并保留该条目，因为丢掉一个不透明标识符的代价低于留住一份凭据。

**旁路通道预算不变式**（`side-channel-budget.ts`）。Claude Code 把这条作为其分类器的硬性运行规则：旁路提示词必须严格小于主循环，以便压缩发生在*旁路通道*溢出之前。我们的 Advisor 以及每个议会视角正是这样的通道，因此每次调用在发送之前——而不是在失败之后——就对照 Harness 的压缩阈值（窗口乘以 `compaction-basic` 的默认比例）度量；比较对象是阈值而不是当前对话大小，因为一个尚未长大的会话里的大通道恰恰是会出问题的那种情况。记录按通道保留**最差**的一次占用而不是最近一次——一个曾经越线的通道还会再次越线，而「最后一次调用很小」什么都证明不了。这只会被报告，绝不强制执行：插件无法调整另一个组件的提示词大小，而拒绝评审等于用一项可度量的成本换来监督的静默丢失。未知阈值不产生警告，因为拿一个占用去比一条未命名的线，等于默认把它判为安全。

**隔离报告**（`isolation-report.ts`）。成员的受限被报告为*请求*了什么、实际把它缩窄的是哪个机制（`tool-scope`、`harness-policy`、`both` 或 `none`），以及一个供调用方分支的 `restricted` 标志——它从**解析后的工具集**与沙箱模式回读计算得出，绝不从角色的意图得出。「我们要了只读」与「只读正在生效」是两个不同的事实，而把两者混为一谈的 brief 正是把一个可写成员误认为受限成员的途径。唯一绝不静默的结果是只读请求上的 `enforcedBy: none`：它携带 `fallbackReason`，而处于自己 worktree 中的 `workspace-write` 成员被报告为*已被围隔*而不是受限，因为私有 worktree 实际买到的就是围隔。

<a id="prompt-composition"></a>
## 提示词构成

`context-budget.ts` 说窗口有多**满**；`cache-attribution.ts` 说一次未命中**花了多少**。两者都不说这些 token **由什么构成** —— 而这正是平台大多数真实决策背后的疑问：延迟 schema 这项工作之所以存在，是因为工具定义占了一个 13,454 token 固定块中的 45.7–47.4 KB，而那个数字来自一次离线测量，而不是模型或用户在运行时可问的任何东西。没有这份拆解，"提示词很大"就没有下一步 —— 模型分不清是工具块臃肿（延迟、或关掉某个包）、是对话太长（压缩）、还是累积的规则与 Skills（改设置）。

`engineering_context_prompt` 以树的形式回答它，一次一个节点：系统文本、工具块、常驻指引、Skills、注入片段与对话，每个都带自己的体积。快照按会话保留并在拆卸时清理，而该工具在 `tool-manifest.ts` 里被分类为只读，所以"问一下提示词花了多少"不是一个改动过工作区的回合。与 `engineering_context_budget` 一样，它被延迟：不问就不花成本。

<a id="post-compaction-rehydration"></a>
## 压缩后补灌

只有摘要会丢掉那些从来不属于对话语义内容的常驻上下文。当 Harness 的压缩器遮蔽一段范围后，`rehydrationEnabled`（默认开）会把它原本承载的东西重新注入：持久项目记忆、最新待办列表、最新工程检查点 —— 工作是继续下去，而不是模型"忘掉"了一个从未进入摘要的计划。

一切都从会话已经记录的数据回放（待办与写入事件、记忆召回、检查点事件），因此回放不可能与它恢复的历史互相矛盾。补灌内容刻意既不携带凭据也不携带推理内容，因为它们既不是待办也不是检查点。`rehydrationArcEnabled`（默认关）提供可选的对话弧变体，以同样方式折叠目标与决策。这对应 Claude Code 的补灌经验；机制是片段日志，所以一个区段消失时发出的是移除通知，而不是让过期的限制继续生效。

<a id="project-memory"></a>
## 项目记忆

按项目持久化的记忆是 `DSH_HOME/freecodego/engineering/memory` 下的本地 SQLite 状态。召回是仅限已审核记录的 `Search → Timeline → Get` 流程 —— 草稿永远不进入自动召回 —— 而召回注入有围栏与预算（`engineeringMemoryContextTokenBudget`，默认 1,200 token），标签被中和，所以仓库文本无法伪装成记忆。凭据筛查发生在写入路径上：带标签或带厂商前缀的凭据会直接拒绝该条目，只匹配形状的会被就地脱敏，而发现结论永远不返回密钥本身 —— 只有四字符前缀与长度。

其中有五件事容易被忽略，所以在这里写明。

**整合（"dream"）是分阶段放量，因为它会写入。** 一次整合拿的是**带租约的锁**而不是互斥锁 —— 一个带过期时间的锁文件，因此崩掉的整合天然可恢复，而**活着的**租约会被报成 `lease-held` 而不是被重试，因为两次整合同一批观察会各自写入一个对方不知道的主题。接着它读取开始时已存在的**冻结快照**，忽略之后的到达：那些是下一轮的输入，而让运行中的整合看见新到达会让它的产出取决于它跑了多久，从而使一次糟糕的整合无法复现。随后在快照上跑一次不含工具调用的模型调用，并原子地写入主题。因此 `memoryRollout` 是四个阶段而不是一个开关 —— `off`、`record_only`、`shadow`、`active` —— 而 `shadow` 正是让这个功能可以安全打开的那个阶段：它完整跑完包括模型调用的整合但什么都不提交，操作者可以先读到模型**本来会**写什么，再决定是否让它写。关闭该流水线是 fail closed 的。

**`MEMORY.md` 是一份有界的绝对路径索引。** 路径是绝对的，因为相对指针要针对某个作用域根解析，而那个根取决于索引是在哪里被找到的；一个把这个推理重构错的模型不会报告路径坏了，而会报告什么都没找到。溢出时整行丢弃并说明丢了多少，因为截断描述会让索引声称在描述一条它已经不再描述的记录 —— 读者分不清"摘要很短"和"被截断了" —— 而丢掉一行是可见的，数量是可行动的。

**遗忘要凭证据，绝不凭模式。** "忘掉你知道的关于 X 的一切"是这个子系统唯一不能靠把 X 变成一组文件来回答的请求：那是一次相关性判断，判宽一点就以没有撤销的方式删掉了用户想保留的记录，而这个存储的全部价值就在于它记得。所以调用方要做只有调用方能做的事 —— 读出打算删除的字节并连同哈希交出来 —— 而这个模块只做机械工作：用磁盘上的文件核对证据，然后精确删除那个文件。目录或通配符会被拒绝，因为"这底下的一切"又是一次判断，而它的证据不是调用方读得到的东西；哈希不匹配以及另外四种形状同样是拒绝而不是警告，每次拒绝都会说明是哪一种。

**记忆有管理面。** 设置面板可以按需整合、重建索引、导出已审核记忆、创建备份、清理过期内容，全部限定在一个打开且绑定工作区的会话内。只有面向用户的 Remotes 可以批准、拒绝、导出、清空或删除记录，而记忆也可以毕业为 `.freecodego/skill-drafts/` 下的 Skill 草稿。

**遥测是 schema，不是约定。** 遥测是一个功能里最容易泄漏它知道什么的地方：记忆流水线看得到用户陈述、主题、关键词、文件路径与模型输出，所以一个看似无害的 `{ topic: slug }` 字段会把私人笔记的精炼版本永久送进任何收集指标的容器，无法撤回。因此每个事件都由同一个构造器**构造**，它拒绝未知字段，也拒绝不是该字段声明取值之一的字符串 —— 自由文本字段不可能被误加，因为没有形状会接受它 —— 并且这种拒绝是抛错而不是丢弃，所以一个以为自己在收集指标的开发者会在测试里失败，而不是静悄悄地失败。

<a id="plugin-conflict-protection"></a>
## 插件冲突保护

`freecodego-harness` 设置命名空间默认启用插件冲突保护。`dsh` profile launcher 在 Loader 启动 profile 树之前安装该守卫，随后 FreeCodeGo 静态扫描每个后续条目的模块与本地 import，查找字面重复的 Tool 名称、命令名称、设置命名空间、HTTP 路由、模型 Provider id 与 UI Slot id。当它发现某个独占资源已被一个活动条目持有时，它保留较早的条目，在较晚的条目运行之前将其禁用，并为设置页保存一条修复记录。浏览器通知会点名两个条目与该重复资源。

扫描器绝不执行第三方代码，并刻意忽略动态或计算出的注册。它防止的是可靠的重复注册，而不是仅仅提供相似面向用户功能的无关插件。

<a id="release-updates"></a>
## 发布更新

更新服务读取 `XiangSu-ce/dsh-plugin-freecodego` 的 release，而不是孤立地更新某一个 Host 组件。一个 release 以 `freecodego-v<version>` 打 tag（家族前缀让同一个仓库里多个 release 家族的 tag 互不混淆，裸 `v<version>` 形式同样可读），并把它 bundle 的 tarball 命名为 `<包名>-<Harness 版本>.tgz` —— 本包即为 Harness `0.1.6-alpha.2` 构建的 `freecodego-0.1.6-alpha.2.tgz` —— 因此一次请求就回答了检查要问的两件事：哪个版本最新，以及它为哪条 Harness 而构建。资产名对应的是 Harness 线而不是 bundle 版本，因此 hotfix 仍可辨识：它的 tag 是深一个点段的精确版本，资产名则依旧写着它属于哪条线。资产名带 bundle 版本的 release 同样会被安装 —— 查找同时接受两种拼法，并在该 release 只带一个 tarball 时兜底 —— 因为名字与 tag 不一致并不是让更新不可达的理由。只会提供适用于当前运行 Harness 的 release —— 完全匹配，或深一个点段的 hotfix —— 其中版本最高者胜出。检查在启动后不久执行一次，此后每天一次；安装执行 `dsh plugin add --save-exact <tarball url>`，也就是用户当初安装所用的同一入口，并把结果暂存在一个同级 Profile 中，然后再原子地提升它。更新前的 Profile 会一直可用，直到重启后的 Host 保持健康，设置页可以在确认之前恢复它。编辑 release 即可撤回某个版本，而一个已发布的 npm 版本做不到这一点；更新绝不隐式重启进程，因此需要重启 Host 才会加载新的 bundle。

<a id="zcode-glm-53-flash-promotion"></a>
## Zcode GLM-5.3 Flash 推广

只有当 Host 为当前 Z.AI 账号持有 Coding Plan 凭据时，Zcode 模型目录才会标注 `glm-5.3-flash`。限免窗口按 `Asia/Shanghai` 计算：每月 20 日之前，从 23:00 到次日 09:00，请求显示为不消耗 token。该模型在窗口之外仍然可用，但 UI 会明确报告限免期未生效；任何客户端时钟或账号声明都无法授予该权益。

<a id="mcp-and-skills"></a>
## MCP 与 Skills

`freecodego-harness` 设置命名空间存储开关、第三方 MCP 服务器与额外的 Skill 根。两个开关默认关闭。被启用的 MCP 服务器由 Host 连接一次，并注册为 DeepSeek 引擎的 Harness 工具。Claude 通过其进程内 `freecodego-host` MCP 服务器收到已发现的 schema 并调用 Host 桥接，而 Codex 在其插件自有的 app-server 配置中收到同一套已启用服务器定义。

被启用的 Skill 根由 Harness 的文件系统 Skill provider 发现。一次 skills.sh 安装会原子地把由 Host 持有的社区目录注册为一个已启用的自定义根，因此导入的单层 `SKILL.md` bundle 会立即对 DeepSeek 以及下一个原生会话可见。Claude 通过 Host 桥接加载已启用的 Skills，Codex 通过 `skills/extraRoots/set` 收到它们。禁用一个能力会卸载它的受管 provider 并阻止未来的原生会话收到它；已有会话必须重启才能替换其原生 app-server 清单。

内嵌社区页通过 Host Remote 读取有界、分页的 MCP.so 与 skills.sh 元数据。只有当 MCP 条目的已发布详情包含一个可由共享 registry 表示的 HTTP endpoint 或 stdio 命令，且没有未解析的环境变量或 header 值时，它才可以一键安装；需要凭据的条目留在手动配置中，而不是报告一次不可用的安装。Skill 条目只从经过校验的 GitHub 源仓库把匹配的 `SKILL.md` 导入由 Host 持有的社区 Skill 根。

Skill 的安装是一条可核对的记录，而不是一次复制：来源按 `owner/repo#ref&path:…` 这样的写法解析，载荷先暂存再原子晋升，`skill-lock.json` **最后**写入并钉住内容真正来自的那个 commit；卡片会显示这个 pin，而当目录已落地、记录却没写成时，界面会如实那样说。同名冲突在任何字节落盘前被拒绝并点名双方来源；移除走同一条记录，先删目录再删条目，因此记录永远不会描述已经不存在的文件。

安装还可以选择落在哪里。投放矩阵是 `--agent` × `--scope`（`harness`/`agents` × `project`/`user`），按本 Host 所运行的那个文件夹解析，其中项目一层要求文件夹已授信：这道门在**路径算出来之前**先跑，因为一个未授信检出里的 `.agents/skills` 正是那个仓库能控制的目录。页面会把整张矩阵摊开显示，包括不可用那一行携带的原因，因此“未授信”不会看起来像“这个组合不存在”；用户选中的两个轴会传到 Host，由它在自己这一侧重新解析一次——两次读取之间，文件夹可能已经失去授信。每一种投放挂载各自独立的受管根 id，因为复用社区根的 id 会把页面读取自身列表的那个根卸下来；而移除会搜索每一个受管根，所以被投放出去的 Skill 仍能在当初添加它的那张卡片上移除。

这个投放位置会被记住，而“记在哪里”是刻意选择的：选择写入 `freecodego-harness` 设置文档（`preferredSkillPlacement`，两个轴 —— 绝不存它解析出的根目录，因为那个路径由工作区、`$DSH_HOME` 与 home 三者共同决定，存档下来会比三者都活得久）。因此它能跨重启保留、与其他开关一起在设置文件里可读可改，并且由本 Host 的每一个客户端共享，而不是躺在某个浏览器的 localStorage 里。如果记住的那一行在当前文件夹不可用，它依然会被如实上报并原样发出去：安装会带着矩阵自己的原因被拒绝，而不是悄悄落到社区目录——一个会静默改道的偏好，比一个说清楚自己为什么无法被满足的偏好更糟。

<a id="optional-harness-capabilities"></a>
## 可选的本体能力

浏览器控制、桌面控制与会话历史检索是 Harness 自己的能力，而没有任何 bundle 挂载它们：本 bundle 在 `bundle-latest/cordis.patch.yml` 里携带它们的行并置为 `disabled: true`，因此需要其中某一项的部署，是在管理其他 Loader 条目的地方把它打开，而不是去改 `node_modules` 里的文件。三行全部关闭，出于两条对每一项都成立的理由。

那些包没有一个在本 bundle 的 `peerDependencies`（也就是安装契约）里，因此一条 enabled 的行会点名一个 Harness 并不必须提供的包。而一条解析不到的行，失败粒度取决于它被挂在哪一层：携带这种行的 preset 会被报告为损坏并变为不可选，而 Host 平面的一行只死那一个条目，因为 Loader 会捕获 import 错误、记录它，并让树里其余部分继续运行。所以 Host 平面是唯一能承载“可选能力”的平面。

能力本身是 Harness 的；它背后的引擎不一定。下面这张表是部署实际在同意的东西，连同每个依赖携带的许可证：

| 能力 | 挂载的行 | 实际驱动 | 许可证 |
|---|---|---|---|
| 浏览器控制 | `browser-use`、`browser-use-playwright-mcp` | [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Apache-2.0 |
| 桌面控制 | `computer-use`、`computer-use-cua-driver-native` | [Cua Driver](https://github.com/trycua/cua) | MIT |
| 会话历史检索 | `tool-session-query` | Harness 之外没有任何东西 | MIT |

### 浏览器控制

两行都要开。`mode` 必填且没有默认值：行里带的是 `mode: launch` 与 `headless: true`；`mode: attach` 配合 `endpoint` 则驱动一个你已经打开的浏览器，并保留它的标签页与登录态。服务只有一个 provider 槽位并拒绝第二次注册，因此 Chrome DevTools MCP 与 Stagehand 是替换而不是追加。

先决条件是上游运行时能启动的浏览器；已有的 Chromium 用 `executablePath` 指定。启动出来的浏览器属于那个活着的 Agent 与 Session、在同一个会话的多个轮次间复用、并随会话运行时一起销毁——重新加载或 fork 会从全新状态开始，日志里不会恢复任何 cookie 或页面。挂接式（attach）的浏览器仍属外部所有，且被保留给一个会话。初始化在创建或恢复完成之前完成，因此一个起不来的 provider 会拒绝那次创建，而不是在没有浏览器的情况下继续；而一次被取消的调用也无法撤销已经送达浏览器的动作。

有一个配置陷阱值得从上游带过来：当系统提示词配置了 `toolOrder` 时，浏览器工具必须留在 `<unlisted-tools>` 之下——把它们显式列出来，会让那些没有浏览器连接的会话在组装提示词时失败。本 bundle 不设置 `toolOrder`。

### 桌面控制

启用 `computer-use` 与 `computer-use-cua-driver-native`。原生 provider 没有任何配置项，并加载紧挨着它声明的那一个精确的 Cua Driver npm 版本。替代方案是 `computer-use-cua-driver-mcp`：它通过 MCP 驱动一个已经装好的 `cua-driver` 可执行文件——当应该由一个独立应用持有桌面权限与执行权时选它，代价是要装那一个。

先决条件属于机器而不属于部署：平台二进制通过 npm optional dependencies 到达，因此那些必须保持启用；启动 Host 的那个应用需要获得桌面权限授权。原生运行时与 Host 共享同一进程，它自己的文档把话说得很直白——原生崩溃可能终止 Host。截图还需要附件存储与一条声明了图像输入的模型路由。

一个已注册的 provider 并不会为某个会话保留桌面，因此调用方要自行协调完整的“观察—操作—验证”流程；而一次被取消的调用也无法撤销桌面已经收到的输入。

### 会话历史检索

这一项只有一行，且不需要装任何依赖：`tool-session-query` 注入的服务由基础组合已经挂载，因此把它打开就是这五个工具本身的全部 opt-in。

内容搜索是第二个开关，而这部分容易漏。基础组合刻意以 `openAt: never` 挂载 `session-query-sqlite`：查询服务保持可用（精确读取、标题、血缘），而 SQLite 从不打开。因此在没有下面这段覆盖的情况下打开工具，会得到五个工具里三个能用、两个永远回答 `SESSION_QUERY_SEARCH_DISABLED`，而 Web 侧栏依旧只匹配标题与工作区名。本 bundle 的 patch 文件正是基础组合点名的“后来的 patch 层”，所以这一对应该放在一起：

```yaml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-index.db')
    openAt: first-search
```

这五个工具是只读的，跨会话访问按调用逐次授权，判据是与调用方自己会话的 `cwd` 精确相等。代价是提示词表面：启用该包会给每个模型请求加上一段固定引导与五个工具 schema，`engineering_surface_report` 会把它作为注入字节对照已审阅的锁报告出来。

<a id="third-party-plugin-tools"></a>
## 第三方插件工具

原生 Codex 与 Claude 会话会投影出 Harness 向 DeepSeek 暴露的同一套 Agent 作用域 Tool schema。这包括由后续第三方插件注册的工具，例如 canvas 或领域特定的工作流工具；FreeCodeGo 不维护名称允许清单。调用经 Host ToolRuntime 返回，因此原插件仍然拥有校验、权限、审计事件、取消与执行。MCP 与 Skill 能力也可以保留其专门的原生集成，但这个通用投影绝不会仅仅因为名字就隐藏一个第三方工具。

Codex 在每次提示词之前刷新这份清单，Claude 为每次查询重建其进程内 MCP 服务器。因此安装、禁用或限制一个插件会在下一个原生轮次生效，而无须重建对话。只有 `ctx.tools.schemas(agent)` 中可见的 schema 会被投影；被 Host 或作用域隐藏的工具绝不跨过原生桥接。

<a id="media-defaults"></a>
## 媒体默认值

Host 为 DeepSeek、Codex 与 Claude 注册 `freecodego_generate_image`、`freecodego_generate_video` 与 `freecodego_generate_audio`。每次执行都从 `freecodego-harness.mediaDefaults` 读取实时的图像／视频／音频默认值；面向模型的 schema 刻意没有模型覆盖项。网关请求复用 Host vault 账号令牌与所选模型的路由键。Agnes 默认值复用既有的 Agnes Host 客户端。Base64 图像响应被接纳进 Harness 附件存储并作为 image 内容块返回；音频字节保存到活动工作区的 `.freecodego/generated-media` 目录下。

<a id="model-picker-and-provider-accounts"></a>
## 模型选择器与供应商账号

用户真正读到的模型列表是 Harness 原生菜单，而 Host 会把所有可服务的适配器都注册进去。有六个机制塑造这份菜单显示什么、以及怎么表现。

**浏览器代理的 OAuth 登录。** 本插件既没有窗口接收浏览器 fragment，也没有 `freecodego://` 协议处理器，因此它直接走既有的 `/auth/oauth/{provider}/start` 流程，带 `redirect=/oauth/desktop?state=<ours>&plugin=1`。后端回调把它签发的凭据对存在该 state 下（并给用户一个普通确认页而不是深链），而这一侧轮询 `GET /auth/oauth/desktop/poll` 直到凭据对到达，再把它收进 Host 凭据保险库。同一张卡片还能完成 MFA、绑定或创建账号，并经由 Host Remotes 发送验证码。

**选择器显示什么，是用户的决定。** 账号与供应商页面是用户唯一能说"我不想要模型列表里有 WorkBuddy"的地方，因为 Host 会把所有可服务的适配器都注册进去。存储是**反向**的 —— 除非明确记录为隐藏，否则可见 —— 并带两条声明的例外：按量计费供应商的有价行默认隐藏，精选供应商的未命名行默认隐藏。只有与默认不一致的决定才会被存储，这带来三条值得写下的结果：从没打开过这些开关的用户不会看到变化；供应商之后新增的模型到达时是可见的；而新增的**有价**模型不会自己打开。价格是按行而不是按供应商询问的，因为按量计费供应商的名单通常两者都有。这份决定由选择器装饰层读取，所以答案会立刻作用于旁边已经打开的那份菜单；面板持有自己的存储订阅，因为这个设置属于供应商，而不属于恰好渲染它的那个页面。

**原生菜单只做标注，不做替换。** 官方选择器仍然是选择、焦点、滚动与推理档位的所有者；这一层只对符合稳定 ARIA 菜单契约的模型行追加非交互标签（来源、价格类别、供应商健康）。于是用户能知道哪些行免费、按量还是降级，而不必存在第二个会漂移失同步的选择器。

**被拒绝的选择不会读成已应用的选择。** 只监听异常的包装层会把一次拒绝当成已应用的选择，并清掉它刚写下的原因，所以回显检查的是目录发布出来的**结果**（`status: 'error'` 加消息），抛异常分支只保留给会话完全无法选择的情况。

**短暂重连不会清空菜单。** 另有一层重试观察该目录，识别传输性失败（`failed to fetch`、`carrier offline`、`remote event generation ended`、被中止的 remote 调用），按 1 分钟 / 10 分钟 / 30 分钟退避重新加载，且不清空上一次可用的目录。断连时已经打开的菜单会恢复而不是变空，而重复安装只保留一个订阅，而不是每次渲染再加一个。

**冷启动的目录从秒级降到毫秒级。** Host 构建模型目录时会同时向每个已注册路由要模型列表、等最慢的那个、再为拿到的每个模型解析元数据。这个部署 13 个路由里有 12 个属于本插件，而它们是唯一必须读网络目录的 —— 每个连接器都通过自己的端点轮换账号，预算以秒计。以重启后的 Host 实测：首次目录 5,528 ms，热态 12 ms；那 5.5 秒里菜单没有任何供应商分组可画，这正是"打开选择器像没打开"的来源。因此 FreeCodeGo 那一半改由这个部署已经知道的目录（`known-provider-catalog.ts`）直接回答，而不是再跑一轮供应商读取。

**一张失败表，三种决策。** 同一个失败从每个路由来时的形状都不一样 —— `fetch` 拒绝、自定义错误对象上的状态码、abort 引发的 DOMException、适配器自带的机器码、供应商自己的措辞 —— 而在每个调用点按消息文本分支，正是"限流被无限重试、上下文溢出被重试到额度耗尽"的来源。`provider-error-classify.ts` 把所有失败汇入一张表，每种对应一个决策：重试、让账号冷却、或让这一回合失败。

<a id="settings-migration-orphan-engineering-keys"></a>
## 设置迁移：孤儿 Engineering 键

一个 DSH home 可能被本插件的多个构建写过。已发布的 alpha 包会写入四个本仓库从不读取的键——`engineeringProfile`、`engineeringTelemetryEnabled`、`engineeringLearningDraftsEnabled` 与 `engineeringTelemetryRetentionDays`——因此被两个构建都用过的 home 最终会携带死设置：没有任何代码路径读它们，设置页从不显示它们，也不会有任何东西失败，而这恰恰是它们值得被点名的原因。

它们已从本地 home 中移除，文件其余部分逐字节保留（备份留在旁边，名为 `settings.yaml.bak-orphan-keys-*`）。它们*点名*的能力在这里并非一致地缺失：

| 被移除的键 | 在本仓库中的状态 |
| --- | --- |
| `engineeringLearningDraftsEnabled` | 该行为存在，但不是工具：设置里的 Skills 区块通过 `engineeringSkillDraft` Host Remote 推导草稿，把它们从用户已经评审过的记忆写入 `.freecodego/skill-drafts/`。目前不可开关。 |
| `engineeringProfile` | 不存在 profile 分级；各个独立开关就是契约。 |
| `engineeringTelemetryEnabled` / `engineeringTelemetryRetentionDays` | 这个构建中不存在任何遥测采集或保留。 |

如果某个 alpha profile 仍在 `profiles/freecodego-alpha` 下使用，它自己的设置文档是独立的；从共享 home 中移除这些键不会碰它，而 alpha 构建会在下次运行时重新加回它需要的任何东西。

<a id="community-plugins"></a>
## 社区插件

社区插件页读取活动 profile 的依赖与 bundle 列表以显示已安装插件。FreeCodeGo 记录每次安装返回的源 URL 与直接包名，因此 GitHub 安装与多包安装仍然可识别。卸载会先禁用匹配的 Loader 条目，再从 profile 中移除直接依赖与 bundle 激活；下一次 Harness 启动无法加载被移除的插件。

配置了 `gateway` 时，bundle 为移动端认证、bootstrap／模型状态、quota、运行时健康与模型价格复用现有的 FreeCodeGo v1 路由。浏览器 Remote 只收到脱敏状态。UI 中不暴露任何提供方特定的凭据。

`gateway.baseUrl` 默认为 `https://freecodego.com`，并且必须是 HTTPS 部署地址。本插件不使用 HTTP loopback 网关。

WorkBuddy 是一个独立的 `workbuddy` 提供方。它使用 WorkBuddy CN 设备授权流程（`POST /v2/plugin/auth/state?platform=CLI`、浏览器 `authUrl`，然后 `GET /v2/plugin/auth/token?state=...` 与 `GET /v2/plugin/login/account?state=...`）。访问令牌与刷新令牌通过 Host 凭据服务存储在 `WORKBUDDY_AUTH` 下；浏览器 Remote 只收到脱敏状态。`GET /console/enterprises/personal/models` 会被过滤为真实的 `cli` agent 模型，聊天使用 `POST /v2/chat/completions`，并在 HTTP 401 之后自动刷新并重试一次。登录流程需要用户完成被打开的浏览器授权；本插件不绕过验证码、设备确认或其他手动步骤。多个 WorkBuddy 账号存储在 Host 凭据引用下，并显示为脱敏的账号行。聊天与模型请求会在账号之间轮换；HTTP 401 重新认证失败与 402／429 配额响应会先让受影响账号进入冷却，再尝试下一个账号。

Agnes AI 是一个独立的 `agnes` 提供方。它仅限 Host 的账号流程使用已文档化的控制面 endpoint 完成验证、注册、登录与 API key 创建，然后把返回的会话与生成的 API key 存储在 `AGNES_AUTH` 与 `AGNES_API_KEY` 下。API 路由是 `https://apihub.agnes-ai.com/v1`；浏览器只收到脱敏状态。

本地 OpenAI 兼容与 Anthropic 兼容提供方使用既有的 `@deepseek-ai/dsh-llm-pi-ai` 插件与共享的 Models 设置编辑器。在其 `providers` 配置下添加路由，并通过 Harness 凭据服务存储 `apiKeyEnv` 值。例如：

```yaml
- id: freecodego-local-openai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      freecodego-local-openai:
        displayName: FreeCodeGo local OpenAI
        api: openai-completions
        baseURL: https://gateway.example/v1
        apiKeyEnv: FREECODEGO_LOCAL_OPENAI_KEY
        models:
          - id: coding-model
            name: Coding Model
            contextWindow: 128000
            maxTokens: 16384
```

设置页覆盖账号相关内容：配额、用量与实时的模型价格表。

-----

<a id="model-experience"></a>
## Model Experience

### 提示词分区

#### 模型看到什么

本插件写入带序号的 `ctx.systemPrompt.section` 分区，而不是改动 Harness 拥有的文本：Plan Mode 规则、上下文纪律规则，以及它挂载的每个复合工具附带的说明各占一行。分区只在对应开关打开时存在，因此关闭 Plan Mode 或未挂载 token meter 的组合不会为此贡献任何分区。

##### 复合编辑工具说明

```markdown
Use edit_and_run when a change and the check that proves it are one step: give the edit and the verification command together. The command runs only if the edit landed, and both results come back in one call.
```

#### Token 影响

每个已挂载的分区在该会话的每一次请求中都要计费。Plan Mode 规则与上下文纪律规则是最长的两段；每个工具附带的说明只有一句，而未挂载的分区不产生任何开销。

#### KV Cache 影响

固定文本位于固定的 `order` 值上，因此会跨轮次留在已缓存的 prefix 内。挂载或卸载某个分区的设置变更会移动其后所有分区，从该点起使 prefix 失效。

### Advisor 与 Engineering 工具

#### 模型看到什么

`advisor_status`、`advisor_review` 与 `advisor_notes` 暴露独立的 Advisor：它的路由、一次有界评审，以及它已记录的持久结论。Engineering 套件（`engineering_status`、`engineering_inspect`、`engineering_context_budget`、`engineering_context_compact`、`engineering_context_snip`、`engineering_context_prompt`、`engineering_surface_report`、`engineering_plan_mode`、`engineering_team_*` 系列动词，以及 `engineering_memory_*`、`engineering_graph_*`、`engineering_codegraph_*` 与 `engineering_checkpoint_*` 家族）暴露持久看板、记忆、仓库图与检查点。媒体生成只有在媒体提供方获授权时才会以 `agnes_generate_image` 与 `agnes_generate_video` 出现。以上每一个名字都只在 `tool-manifest.ts` 声明一次，并同时声明持有它需要什么能力、以及 Plan Mode 是否可以调用它。这张表就是 Plan Mode 围栏与验证门禁所读的东西，且有测试按注册字面量双向核对——因此本页写了而插件并未注册的工具会让测试失败，而不是让这段文字继续错下去。

#### Token 影响

每个已注册工具都要在请求中付出其描述与参数 schema 的代价，这正是这份清单保持封闭、且最大条目按需获取的原因：`tool_search` 取回延迟的工具描述，`headroom_retrieve` 只在模型主动索取时取回已溢出的结果。

#### KV Cache 影响

注册顺序稳定，因此工具块位于已缓存的 prefix 内。挂载或卸载某个工具家族会重写该块，并从该工具起使 prefix 失效。

### 注入的引导

#### 模型看到什么

Advisor 引导以后续轮次抵达，绝不重写此前的消息：已结束的评审以 `record`、注入轮次或 steer 投递，Agent 在承载它的那一轮读到它。Plan Mode 规则以独立分区陈述，而不是塞进工具描述里。

#### Token 影响

已投递的结论只在承载它的那一轮计费一次。持久的 `advisor/note`、`advisor/delivery` 与 `advisor/state` 记录是 log-only 的，绝不进入请求。

#### KV Cache 影响

注入追加在已缓存的 prefix 之后，因此已投递的结论不会破坏此前的缓存 —— 这正是存在这条通道、而不是改写提示词的原因。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本插件在何时需要特别的运维照料。它们是当前的约束，而不是待办清单。

- **验证历史是进程本地的** —— 持久化任务与取消尚未公开。
- **上下文预算需要挂载 token meter** —— 没有它时压力读作“不可测量”而不是零，该片段因此缺席。
- **缓存浪费只按本地账本归因** —— 网关报告的是计费总额，而不是逐轮请求前缀，且只有区间带费率时才归因金额，因为未定价的数字比没有更糟。
- **动作评审器是完整策略但没有评审者挂载** —— `action-review.ts` 在逐工具热路径上保持未绑定，因为模型评审会为每次工具调用增加一次请求，而这正是本插件存在的意义所要削减的成本。
- **等级选择从变更路径推断覆盖** —— 它只能说“这次变更伴随了测试文件改动”，绝不能说“这些测试覆盖了本次变更”；知道真实覆盖率的调用方应直接传入。
- **旁路阈值派生自 `compaction-basic` 的默认比例** —— 覆写该比例的组合会让数值变成近似值，因此该检查只警告、绝不拒绝。
- **冷缓存清理只改动请求本身** —— 它无法删除服务器上的已缓存前缀。
- **凭据扫描器是精选子集** —— 它不是通用密钥探测器，且只筛查记忆写入；引擎审计摘要与导出 bundle 仍依赖各自的字段键脱敏。
- **Code Graph 通过官方 CLI 调用** —— 仅支持纯代码构建、增量更新与有界只读查询。
- **Graphify 的各个 sidecar 仍是发布门禁** —— 内部 MCP sidecar、持久化构建队列、用户取消、依赖哈希锁、运行时更新通道与 Canvas 适配器均未随包提供。
- **CodeGraph 没有 Canvas 适配器，也没有 `overview` 工具** —— 它的 CLI 未提供 hub 排名或全图导出命令，因此有界 Canvas 投影仍然只属于 Graphify。
- **新鲜度来自钩子，而不是后台监听** —— 两个引擎都通过轮次后自动更新钩子与用户显式操作更新，且 `codegraph` 不启动其 daemon，因此查询永不与第二个写入者争用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为 Host 插件的生命周期与其公开的服务由它的组合测试覆盖。

上文的排序按读者带着什么问题而来，而不是按挂载顺序：先路由与评审，然后 engineering 表面，接着是上下文纪律（一组为了让长会话负担得起而存在的功能），再是部署方要配置的那些表面（设置、媒体、提供方），最后是已安装 home 的运维备注。

当某个 Harness 包已经拥有某项能力时，本插件挂接到它，而不是注册第二套实现；它仍然保留的增强会写在它所属的那一节旁边。这条规则在 [`../../../COMPATIBILITY.md`](../../../COMPATIBILITY.md) 里逐冲突记录。

</details>

**运行时不变式：** 上述每项能力都由其所在节点名的设置开关把关，且没有任何一节注册 Harness 自有契约的第二套实现。
