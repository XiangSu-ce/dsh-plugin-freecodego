---
description: "可安装的 Cordis bundle：为 DeepSeek Harness 挂载 FreeCodeGo 引擎清单、Host 配置表面、engineering 工具与设置 Remote。"
kind: "package-reference"
---

# dsh-freecodego-harness-plugin

[English](README.md) | 中文

## 概述

面向 FreeCodeGo root-engine 清单与 Host 配置表面的可安装 Cordis bundle。

本 bundle 挂载 `dsh-agent-engine`，并发布一个标准 DeepSeek 引擎描述符以及 Codex 与 Claude 描述符。只有当原生引擎已校验的产物清单、摘要、协议 ABI、worker 路径与状态目录同时提供时，它才会被接纳。配套路由器是唯一的 Harness `AgentFactory`；请求的原生引擎绝不会回退到 DeepSeek。

`setDefaultEngine` 改变未来会话使用的引擎。挂载了 `ctx.settings` 时，该选择持久化在 `freecodego-harness` 命名空间中；已有会话仍钉在其持久引擎计划上。Claude 凭据在拉起私有 worker 之前立即从 `ctx.credentials` 解析，绝不经过 Remote 或原生 JSONL 协议。

`setDefaultModel` 与引擎一起持久化一个兼容的受管模型 id；新会话默认值同时包含两者，而已有会话仍保持钉住。

本 README 只要点名一个决策，该决策就是契约：某个功能由它点名的设置开关把关，与 Harness 的归属冲突一律以 Harness 为准，本插件不实现的能力会写明为延期，而不是以沉默暗示。

## 目录

- [文档](#documentation)
- [Subagent 模型路由](#subagent-model-routing)
- [Advisor 评审回路](#advisor-review-loop)
- [Engineering 增强](#engineering-enhancement)
- [上下文压缩（Headroom）](#context-compression-headroom)
- [上下文纪律、命令策略与 Plan Mode](#context-discipline-command-policy-and-plan-mode)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [插件冲突保护](#plugin-conflict-protection)
- [NPM 更新](#npm-updates)
- [Zcode GLM-5.3 Flash 推广](#zcode-glm-53-flash-promotion)
- [MCP 与 Skills](#mcp-and-skills)
- [第三方插件工具](#third-party-plugin-tools)
- [媒体默认值](#media-defaults)
- [设置迁移：孤儿 Engineering 键](#settings-migration-orphan-engineering-keys)
- [社区插件](#community-plugins)
- [开发备注](#dev-note)

-----

## 文档

本 README 是顶层文档：它描述插件挂载的每一项功能、它做出什么决策，以及为什么。有两个主题大到需要单独成文，且都以中文撰写：

- [`docs/free-providers.zh.md`](docs/free-providers.zh.md) — 免费模型提供方集成（Cline、WorkBuddy International）：上游契约、账号池，以及两个适配器共同实现的轮换语义。
- [`freecodego-api/docs/backend-contract.zh.md`](../freecodego-api/docs/backend-contract.zh.md) — 本插件与 FreeCodeGo 后端之间逐 endpoint 的契约，包括哪个字段决定路由结果与计费。

其余内容都在 `packages/freecodego/` 下的包 README 里：设置表面见 `harness-ui`，后端客户端见 `freecodego-api`，路由选择见 `agent-engine-router`，原生引擎见 `root-agent` 以及 `runtime-codex` / `runtime-claude` / `native-runtime-host` / `native-runtime-protocol`，发布组装见 `bundle-latest`。

## Subagent 模型路由

启用 `autoSubagentModelSelection`（默认开启）时，Host 会把每条实时 text-model 路由同步进 Harness 的 `subagent-model-selection` 设置。因此新的顶层会话会获得标准的 `subagent` 字段 `provider`、`model` 与 `reasoning_effort`，以及按需的 `list_subagent_models` 发现工具，而不需要用户维护一份复选框清单。暂时失败的提供方会保留它最后获批的路由，直到其 catalog 恢复。

被拉起的子会话继承父会话的 FreeCodeGo 执行引擎，并可以按单次委派覆盖确切的 LLM 路由。DeepSeek 在官方 AgentLoop 中执行子会话；Codex 与 Claude 保留其原生运行时，但把所选模型经 Host 桥接取路由。已有会话保留其持久 Subagent 策略；获批 catalog 变化后请新建对话。

## Advisor 评审回路

独立的 Advisor 在公开的 `freecodego/hy3` 路由上默认启用。它以独立的模型上下文评审持久轮次事件，并且只拥有有界、只读的工作区工具（`read`、`glob` 与 `grep`）。它的结论与 token 用量被追加到 Harness 会话；凭据、隐藏推理与不受限的主 Agent 工具绝不复制进评审上下文。

每个 DeepSeek、Codex 与 Claude Agent 都会收到 `advisor_status`、`advisor_review` 与 `advisor_notes`。这让活动 Agent 能查看评审者、在有用的检查点请求第二意见，并消费既有结论，而不需要单独的 UI 操作。具体的顾虑或阻塞会引导 Agent，而低严重度或处于冷却期的结论会在下一个安全步骤注入。原生 Codex 与 Claude 把引导作为后续原生轮次消费，并在下一个用户轮次之前暂存注入。关闭 Agent 控制则只把结论保留为 `record` 事件。更改 Advisor 路由或投递设置即时生效；原生会话在每轮之前刷新其投影出的 Harness 工具。

会话删除对陈旧的侧栏行是幂等的：当会话日志已被移除但缓存的投影仍列出该 id 时，Host 清除其工作区关联并返回成功，而不是留下一个无法删除的 Ungrouped 行。活动或正在运行的会话仍必须在删除前关闭。

## Engineering 增强

### 多引擎 Engineering 团队

Engineering 团队让当前 root Agent 留在它选定的引擎上，同时为一次有界、只读的评审启动隔离的 DeepSeek、Codex 与 Claude 子 Agent。`engineering_team_start` 接受一个目标与草稿计划，运行一轮独立评审，可选地运行一轮交叉质询，并在父 Session 中记录共识、异议、参与者状态与最终建议。子 Agent 不能编辑文件、执行 shell 命令、创建另一个团队或更改权限。运行时缺失与失败的参与者会被分别报告；只有配置的最少参与者数量完成时，团队才达到法定人数。

团队可以在前台运行，也可以返回 `council_*` id 供 `engineering_team_status` 轮询；`engineering_team_cancel` 取消所有子 Agent。父 Session 恢复之后，完成的报告仍可通过 `engineering_team_report` 与 `engineeringTeamReports` Host Remote 获取。把 `engineeringCouncilAutoRun` 设为在获批的 `exit_plan_mode` 计划之后自动运行一次评审；它默认关闭，以便用户保留显式控制权。

完成的报告是证据，不是编辑许可。实施之前，用户必须通过 engineering 团队批准命令或 `engineeringTeamDecision` Remote 明确批准或拒绝它。只有获批的报告才能运行 engineering 团队验证；默认运行会在父 Session 中记录 `scope`、`build`、`types`、`lint` 与 `tests` 结果。

#### 多成员团队

`engineeringTeamEnabled`（默认开启）补上团队要「不止是同一目录里的几个 agent」所需的运行时：

| 表面 | 工具 | 它保证什么 |
|---|---|---|
| 任务看板 | `engineering_team_board`、`engineering_team_plan`、`engineering_team_claim`、`engineering_team_task_update` | 每个任务一个所有者，依赖关系把可用性把关，可用性按 id 顺序，只有所有者能关闭任务 |
| 成员 | `engineering_team_member_start`、`engineering_team_member_stop`、`engineering_team_recover` | 每个成员都是真实的子 Agent，带按角色限定的工具允许清单；成员关系持久在磁盘上，存活状态实时读取且从不镜像 |
| 合并 | `engineering_team_merge` | 有冲突的合并在被报告之前就已中止，且冲突路径会在报告中点名 |
| 上下文 | `engineering_context_compact`、`engineering_context_snip`、`engineering_context_budget` | 压缩可以按需进行，而不只在压力下进行；模型可以先问自己的窗口有多满，再决定怎么做 |

**等人是一个状态，不是一个结论。** 需要人类决定的成员此前只有两条路，而两条都是谎言：`failed` 声称工作是坏的（并把每一个下游任务变成阻塞），而停在 `claimed` 则什么都没说。`needs-review` 把它记下来——在等谁、从何时起、属于哪一次认领——看板把它单独算作一个桶并点名这些被挂起的任务，答案到了之后由它的所有者用 `resume` 收回，`rerun` 则在同一个 id 下重开一个失败或取消的任务，而不是让 `create` 造一个新 id 并丢掉尝试次数。每一次状态变化都由唯一的写入者追加进该任务的账本，因为最新的 `note` 回答不了后来真正重要的问题：上一步为什么发生。

**看板是主干**。任务按 id 顺序分发，依赖未完成的任务绝不会被提供，认领也不能被抢走：一次拒绝会点名是谁持有该任务，或它在等什么，因为这两种情况需要不同的修法。只有当前所有者可以完成或标记任务失败，这才使看板成为「谁做了什么」的审计记录，而不是一张愿望清单。被失败依赖阻塞的任务是*推导*出来的、不存储，因此重试该依赖就能解除阻塞，无须状态迁移。

**每个写入方都有自己的 git worktree**，位于自己的分支上，由 `git worktree add` 创建在 `.freecodego/worktrees/<member>` 之下（并加进 `.git/info/exclude`，因此这份隔离不会变成未跟踪的噪音）。共享树只在 `engineering_team_merge` 时变化，而有冲突的合并会在冲突被报告*之前*就执行 git merge abort——隔离只有在失败留在本地时才有价值。分支会跨发布存活；只有在它被合并之后才会删除。

**只有在能够授予时才授予隔离，只有在安全时才收回。** 这对动词上有三条规则。仍持有未提交改动的 worktree 会被*保留*——`release` 会报告它找到的路径，并在丢弃任何东西之前要求 `acknowledgeLostWorktree: true`，因为一次静默销毁成员唯一副本的清理，是本模块里唯一可能丢工作的步骤。删除失败时登记会保持 `active` 并如实说明，而不是在目录仍在磁盘上时把条目标为 abandoned——那正是一个 worktree 对之后所有清理都变得不可见的方式。而 `allocate` 会拒绝**脏工作区**：写入方从 `HEAD` 切分支，所以没有任何未提交编辑进入副本，但那棵脏树*正是*之后合并要落上的状态，而「合并进一棵带着改动的树」没有确定的基线——`allowDirtyWorkspace` 是明确表示这一点已被理解的方式。已经存在、干净、且在该成员自己分支上的副本会被直接交回而不是报错（`git worktree add` 会拒绝一个已被检出的路径），而路径或分支与约定不符的登记会被点名拒绝，而不是被复用。

**隔离事实是被存储的，不是被重建的。** `engineering_team_recover` 通过一组锁定字段报告每个存活 worktree——`workspaceMode`、`worktreeMode`、`teamStateRoot`、`workingDir`、`worktreeRepoRoot`、`worktreePath`、`worktreeBranch`、`worktreeDetached`、`worktreeCreated`、`worktreeState`——它们读自持久记录，而不是从目录名反推，因为一旦出现第二种命名约定，被反推出来的东西正是会静默不一致的那个。报告选取的就是同一份列表（`LOCKED_ISOLATION_FIELDS`），测试也钉住这份列表，因此加进记录却忘了加进报告的字段会是一个失败的测试。该记录是从条目派生的，而不是在旁边另存一份：`path`、`branch`、`strategy`、`createdAt` 本来就持久在那里，而同一个事实的第二份存储拷贝就是一个有两个主人的不变式。

**角色是数据**（`team/roles.ts`，可按项目在 `.freecodego/team-roles.json` 中覆盖）。每个角色携带目的、能力、工具允许／拒绝清单、模型、轮次上限、沙箱模式、报告契约，以及——维持职责分离的那一行——明确的*不负责什么*。允许清单会与能力集合取交集，因此不能写入的角色不会因为点名某个工具就拿到写工具，`explorer` 与 `verifier` 按构造即只读。成员的 brief 由其角色记录生成，因此新增角色就是新增一条记录，而不是加一个提示词分支。

**成员关系持久；存活状态不镜像。** 看板按成员 id 记录所有者，写入方的 worktree 也登记在某个成员名下，因此两者都能在创建它们的进程之后存活。由于看板与成员注册表都在磁盘上，`engineering_team_recover` 可以在重启之后回答当时在飞的是什么：哪个成员停了、它握着哪个任务，以及哪个 worktree 的工作仍在磁盘上。关于成员的其他一切——它是否还在运行、它说过什么——都从活动子 Agent 读取，而不是复制进文件，因为对另一个进程状态的镜像只可能是错的。

**上下文控制既可手动也可自动。** Harness 在压力下压缩，而它的自动 pruner 与 compactor 随包投放时是关闭的。这里的两个工具让模型能对最先注意到的一件事采取行动——某个区域已经用完——并且当引擎找不到可安全替换的内容时，它们报告 `changed: false` 并给出原因，而不是宣称一次并未发生的压缩。Snipping 会校验工具调用配对；不平衡的边界会被拒绝，而不是被静默加宽。

每个 `engineering_team_*` 与 `engineering_context_*` 名称都符合延迟工具前缀规则，因此这些都不消耗一个从未用到它们的请求。

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

插件私有状态——记忆、检查点、Code Graph 与 Graphify 运行时、任务、plan mode 与团队——通过一个 helper 而不是各模块各自解析其根：`FREECODEGO_HOME` 被设为非空值时用它，否则用 `DSH_HOME`，否则用 `~/.dsh`。下文每个 `DSH_HOME/...` 路径都按这条规则理解，因此设置 `FREECODEGO_HOME` 会一次性移动它们全部。Host 自有的文件（`.credentials.yaml`、`settings.yaml`、`profiles/`、`runtimes/`、`state/`、`.agent-presets/`、`skills/`）绝不跟随该覆盖：这些由 Host 读写，第二个根会让设置表面与凭据服务对「哪个文件才是真源」产生分歧。

Code Graph 提供两个可互换的引擎，并且只挂载一个 Agent 工具族，由 `engineeringGraphEngine` 设置选择（`auto` 偏好无 Python 的引擎，`graphify`／`codegraph` 表示就是该引擎或什么都不挂）。

Graphify 引擎在 SHA-256 校验之后下载官方 `graphifyy==0.9.52` Wheel，并在 `DSH_HOME/freecodego/engineering/graphify` 下引导一个以 SHA-256 钉住的官方 uv 发布包与私有 Python 3.12。它的首次构建使用 Graphify 原始的仅代码提取器，并且只把图、缓存与报告写入插件自有的项目目录。它不会创建工作区 `graphify-out`、不安装 hook、不改 `PATH`，也不用 Lite Graph。用户构建出图之后，Agent 会获得有界的官方 Graphify search、explain、path、impact 与 overview 工具。

CodeGraph 引擎在 SHA-256 校验之后下载针对当前 OS/CPU 的官方自包含平台 bundle（48-62 MB），并解包到 `DSH_HOME/freecodego/engineering/codegraph` 下。该 bundle 自带 Node 运行时，因此这个引擎不需要 Python、不需要 `uv`、也不需要 wheel；musl Linux 会被拒绝而不是被近似处理，因为官方 Linux bundle 是 glibc 链接的。CodeGraph 把它的索引目录解析为项目根之下的一个路径段，因此这个引擎把索引留在工作区的 `.codegraph-freecodego` 而不是 `DSH_HOME` 下；该目录带一个自我忽略的 `.gitignore`，插件只在用户显式操作时才删除它。每个插件自有的进程都在匿名遥测、后台守护进程与 CLI 自身的下载回退被禁用的情况下运行，且插件绝不运行 `codegraph install`——那会重写用户其他的 agent 配置。用户构建出索引之后，Agent 会获得有界的 `engineering_codegraph_explore`、`_search`、`_explain`、`_path` 与 `_affected` 工具。

两个引擎都通过同一条共享下载路径安装与校验：产物边流式落盘边哈希，暂时性的传输失败重试一次，而摘要不匹配是终局的、绝不重试。

### 确定性扫描选择

一次扫描覆盖哪些改动文件，由一个纯函数决定，而不是由提示词决定——因为提示词回答不了用户终究会问的三个问题：**哪些**文件、**为什么不是**其余那些、以及**有没有东西被跳过**。`src/scan-selection.ts` 接收改动路径和每条路径的一个已测量事实，为每个文件返回一条决定（选中，或带理由排除），并**封存覆盖率分母**：运行时必须交代的那一份确切集合。它不做 IO、不读 git、不调模型，因此预览和真实运行消费的是**同一个答案**，而不是各自推导出两个、然后漂移。

各道闸门按**声明的顺序**运行，因为顺序本身就是这个函数的实质。删除的文件没有内容可扫，最先离开分母。凭证路径在任何模式规则**之前**被拒，所以位于 vendor 源码里的凭证文件报告的是 `credential`——那才是解释“为什么没人看它”的理由。随后模式规则命名出“发现了也无法行动”的路径：已安装依赖、vendored 源码、构建产物、生成元数据、lockfile。测试文件**有意不排除**，这是相对本项目所参照的上游默认表（阿里 Apache-2.0 的 `open-code-review`）的一处偏离：本插件盯得最紧的缺陷类，正是“断言为空却报绿”的测试，而一个从不打开测试文件的扫描看不见它。

大小是最后一道闸门，而且它是对**字节**设的上限，不是对估算值：估算值只为展示而经插件唯一的 token 估算器定价，这样本模块就不会变成第二处给文本定价的地方。**大小无法判定**的文件会**保持选中**并被具名标记为未检查。“没量过”与“很小”是两个不同的答案，而只有一个才是把目光移开的理由；把未知读成其中任何一个，都是“靠不看而通过的预算”。

`engineering_inspect` 把这次选择作为 `scan` 段报告：分母、每一条带理由的排除、运行会读到的字节与 token 合计，以及所有大小未检查的文件名。该段**有意不受**文件夹信任门禁约束，差别在于它读什么——大小与路径名，从不读内容。字节数不是指令，而把它门禁掉，会让一份在“没人信任过的检出”上**仍然可用**的诊断也消失。账本的**对账**那一半——运行时究竟交代了哪些被选中的文件——尚未实现，因为本插件还没有任何地方记录**逐文件的扫描结果**：council 与 advisor 报告携带的是发现，而不是它们覆盖过的文件集合。

## Hunk 级变更追踪

检查点回答的是「那次调用之前工作区长什么样」，粒度是文件；它回答不了*哪次*调用引入了某一行，也没法只撤销一次调用的改动而保留其他调用的改动。Hunk 追踪为每一次会写文件的工具调用记录它改动的连续行区间，并把这些区间归属到本体自己的 `callId` 上，再依据文件**当前**内容回退某个 hunk。

两半都挂在工具接缝上：pre-execute 钩子读该调用所命名的文件的**前像**，post-execute 钩子做 diff 并记录 hunk。**失败的调用同样记录**——写了文件却报了错的那次改动，恰恰是只读对话记录永远找不到的那一处。两个值得知道的设计决定：

- **后来的编辑会取代它所覆盖的那些行。** 偏移随编辑到达而维护，因此早先的 hunk 仍保有可用位置；当后来的编辑覆盖了早先 hunk 的行时，那个 hunk 会拒绝独自回退，并指名覆盖它的那个 hunk。回退覆盖方那一次调用就能恢复该状态，所以拒绝信息指向那里。
- **回退先验证再落子。** 记录的后像必须仍在它记录的偏移处，或在别处**唯一**出现（上方编辑把它挪走了）。其余情况一律报 `drifted` 而绝不去猜——包括邻居已不匹配的纯删除：空后像在全文件到处都匹配，这个模块不会从一堆长得一样的空行里挑一个。文件行尾会被保留。

Agent 用 `engineering_hunks` 读这份日志（有界的元数据加五行预览，绝不回整段区域），用 `engineering_hunk_revert` 撤销其中一个——它接受一个 hunk id，或者一个 call id 加上一个文件。这两个工具是**无条件注册**的，不同于代码图谱那几个家族：日志由工具接缝写入、与是否安装引擎无关，所以读它的工具不能依赖引擎存在。

参数来自模型，所以一次调用所命名的文件如果解析到工作区之外就会被拒绝：读 `../../id_rsa` 的前像等于把凭据内容放进一个模型之后可以查询的日志里。

## 上下文压缩（Headroom）

Headroom 在模型看到之前压缩过大的工具输出。持久会话日志保留完整原文，压缩后的文本携带 `hash=<24 hex>` 标记，模型获得 `headroom_retrieve` 以取回任何被省略的文本——线上有损，端到端无损。每种策略都按*形态*路由（log、JSON、diff、search、table、config、prose），且每条策略只在确实缩小了自己的输入时才运行。

### 代码骨架化

源代码没有形态签名，因此这次移植最初没有动它——而度量显示，那正是它本可以处理的最大单项成本。在 17 个会话 / 133 步的样本中，`read` 产生了被摄取工具输出 1,025,038 token 中的 875,706（85%），而由于 Harness 在每一步重发整份记录（`deriveMessages` 不做裁剪），这些字节在样本中总共被传输了 21,365,476 token。

`headroomCodeSkeletonEnabled`（默认开启）会为 `read`、`read_file` 与 `view` 的结果指定一个骨架。安全契约是一条子序列：**保留的每一行都是逐字节原文，包括它的 `N: ` 前缀**；只有整段连续的正文行会被替换，每段由一个标记点名它所覆盖的行号范围。imports、声明、类型／接口成员、签名（包括多行参数表）、装饰器、attributes、文档注释、箭头函数的类字段，以及顶层闭合分隔符全部保留。被丢掉的是实现——因此锚定在保留行上的 Edit 仍然匹配，而标记会准确说明读者再也看不到哪些行号。短于三行的连续段会保留而不是标记，因为一个标记的成本高于它本会替换掉的那些行。

在读取小于 2 KB、不是带行号的 envelope、行号不连续、已被另一个压缩器（JSON、config、logs、search、diffs、tables、HTML）占用、按扩展名与检测器都属散文、是错误结果，或缩小幅度低于 25% 时，这次读取会被拒绝而不是靠猜。支持从某个 offset 开始读取窗口，因为 agent 正是这样读大文件的。

在 1,983 个真实仓库源码上度量，骨架让已应用文件的总量减少 61.5%（中位数 58.3%，p25 49.5%）。把样本会话以骨架化的 read 重放，总重传从 21,365,476 降到 17,820,922 token：**占全部发送量的 16.6%**，无需改配置，也没有丢掉模型仍能匹配的任何一行。

关掉开关即恢复逐字节读取。read-fold 旋钮与此无关：它把无损折叠应用到那些恰好看起来像 search 或 log 输出的 read 上。

### 延迟工具 schema

工具块是另一项固定成本：同一样本中，每个请求有 45.7-47.4 KB（11,700-12,130 token）是工具 JSONSchema，而 61-74 个工具里有 37 个是本插件的——14,380 字符，占该块的 27%，在每个轮次的每一步都被重发。一个只改设置的轮次永远不会碰图查询、记忆 CRUD、检查点恢复、团队编排或媒体生成。

`deferredToolSchemasEnabled`（默认开启）让这些工具保持注册但扣住它们的 schema。在 `agent/session-start` 上，插件在一次绝不会阻塞会话的尝试中用 `deny: [...deferred]` 限定 agent 的工具作用域；Harness 从可见集合推导线上 schema，而被拒绝的名称会让一次直接调用以 `UNKNOWN_TOOL` 失败——可见性与可调用性读自同一个真源，因此模型既不能调用没被展示给它的东西，也看不到自己不能调用的工具。`tool_search` 随后为它返回的工具解除该拒绝，因此在一次发现调用之后，一个延迟工具与一个立即工具一样可用。查询语法刻意跟随 Claude Code 的 `ToolSearch`：`select:A,B` 用于精确名称，`+term rest` 要求名称中含某个词，裸关键词用于排序。

`tool_search`、`engineering_status`、`engineering_repo_map`、`advisor_review` 与 `headroom_retrieve` 从不延迟。延迟一个入口点等同于把门锁上，前两个是用户在别的东西都不灵时会去用的，而后两个回答的是模型已经被展示过的东西——一个去咨询 advisor 的提示，或压缩标记里的一个 hash——在那里走一轮发现往返纯粹是延迟。

关键词查询按名称与描述的 BM25F 排序（`tool-search-rank.ts`），而不是数子串命中：稀有度就地从这份延迟目录本身计算，词频会饱和，描述长度被归一化，而一个三字符以上、前缀命中某个词的查询词按半次命中计。旧的计数法在几百个工具的目录上会暴露三件事：每个描述都有的词压过真正要紧的那个、最长的描述获胜、重复的词压过一个工具自己的名字。`max_results` 的公开上限在生成答案的地方被强制执行，而不只是写在描述里。

索引本身也像任何其他输出一样被计价（`tool-catalog-budget.ts`，1,000 token）：能装下时渲染 `name — summary`，装不下时退化为只有名称，再装不下时退化为每个名称前缀一行加计数与几个样本。每一档都会说明自己丢掉了什么、以及怎么把它要回来，并且任何一档都不能藏起一个名称——`list:<prefix>`（以及 `list:all`）返回不带 schema 的名称，这就是一个被分组摘要掉的名称仍然可达的方式。今天 37 个工具的目录约 930 token，略低于预算，因此在目录真正长过它之前这次改动是不生效的。

该工具的描述是**静态的**，并且刻意不点名任何延迟工具。那里的动态索引会在每次设置变化时改动工具块，并使它之后所有内容的 prompt-cache 前缀作废，这正是 Claude Code 自己的源码记录下的失效模式（约占其机群 cache-creation token 的 10.2%）：损失远大于省下的定义。索引改为由一次无参数的 `tool_search` 调用返回。

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

**任务看板修订号**（`team/board.ts`）。每个任务都携带一个在每次变更时前进的修订号，因此 `claim` 可以要求调用方最后读到的那个修订号，竞争的失败方会干净地失败，而不是覆盖一个决策。一次认领还会铸出一个**认领令牌**，而严格闸门（`transition`）要求出示它：一个在重启后仍存在的所有者名字，不是同一个成员仍然持有这份工作的证据。`complete`／`fail` 仍是单进程团队的仅所有权路径，并被文档标注为较弱的那一条。`approve` 在任务上记录决策，因此看板就是审计记录。

由于严格闸门是默认值，令牌必须能到达：为某任务启动的成员会在其 brief 中收到该任务的认领令牌，并被告知在关闭任务时出示它。扣下它等同于把一份成员在结构上无法完成的工作交给它——它只能停滍或请父级代它关闭——因此 `member_start` 会把它传递下去，并且有一个测试钉住这次交接。

**缓存冷清除**（`cache-cold.ts`）。第二条更窄的压缩路径，只有一条规则：当距上一条主循环 assistant 消息超过一小时时，提供方的 prompt cache 肯定已过期，整个前缀无论如何都会被重写——因此在下一个请求*之前*清除较旧的工具结果，恰好缩小那部分已经确定会被重新计费的内容。理由不是这些内容旧了。一小时阈值位于所有已公布的 TTL 之外，因此该机制无法制造一次本不会发生的未命中；而清除标记是按会话的，因此同一段内容绝不会被处理两次：清除按构造幂等，而不是靠调用方记得。

**请求形态指纹**（`request-shape.ts`）。上面的缓存未命中归因是对台账做算术；这里的是因果的那一半。每个请求之前都会对线上形态取哈希——system 文本、工具集、**每个工具各自的 schema**、模型、betas、预算档位——下一个响应的 cache-read 下降会被归因到一个具名变化。逐工具哈希之所以存在，是因为现实中占主导的情形是工具*集合*未变而某个工具的描述移了位，而任何增／减计数都看不到这种情况；那种情形会被点名到具体移位的那个工具。那些曾在对话中途翻转并使前缀作废的 flag 改为粘性开启：不再要紧的 flag 会被保持开启，而不允许它翻回去，因为第二次翻转才是昂贵的那次。

**按比例验证**（`verification-tier.ts`）。验证曾经对一行守卫与对一次调度器重写花费相同，这既对小改动过度收费，又——更糟——给大改动提供了不足的证据。现在档位从改动本身选取（用 `git status --porcelain` 判断*什么*动了，因此未跟踪的新文件也被计入，加上 `diff --numstat` 与每个未跟踪文件自身的长度），安全片段、架构片段（清单、lockfile、CI、迁移）与广度都会强制升到 `thorough`。每个档位都保持两条不变式：**档位可以减少跑哪些阶段，绝不可以减少什么算作证据**——被跳过的阶段仍报告 `skipped`，没有探针的运行仍是 `unverified`——以及**档位要与它省略了什么一起报告**，因为「没有失败」与「在我们跑过的检查里没有失败」是不同的主张，而只有其中一个是真的。覆盖情况仅由路径推断，因此一个未伴随任何测试文件的改动无论多小都永远到不了轻量档。

**记忆的凭据筛查**（`secret-scan.ts`）。项目记忆是从 agent 读到的东西写成的，因此一个 `.npmrc` 或一条粘贴进来的 curl 命令可以把真实令牌写进一条会活过该会话、并在后续对话中被重新注入的条目。这份精心挑选的规则集在有用的方向上做子集：只取带独特厂商前缀、误报率极低的规则，刻意不要那些让人干脆关掉扫描器的通用关键词上下文规则。扫描器从不返回密钥本身——一条命中只携带四个字符的前缀与一个长度——而置信度也是匹配的一部分。在写入路径上，*被标注*的凭据（既有那条关键词规则）与*厂商前缀*凭据都会拒绝该条目，而仅形态匹配（一个 JWT、一个裸 `sk-`、一段 PEM）会在原地脱敏并保留该条目，因为丢掉一个不透明标识符的代价低于留住一份凭据。

**旁路通道预算不变式**（`side-channel-budget.ts`）。Claude Code 把这条作为其分类器的硬性运行规则：旁路提示词必须严格小于主循环，以便压缩发生在*旁路通道*溢出之前。我们的 Advisor 以及每个议会视角正是这样的通道，因此每次调用在发送之前——而不是在失败之后——就对照 Harness 的压缩阈值（窗口乘以 `compaction-basic` 的默认比例）度量；比较对象是阈值而不是当前对话大小，因为一个尚未长大的会话里的大通道恰恰是会出问题的那种情况。记录按通道保留**最差**的一次占用而不是最近一次——一个曾经越线的通道还会再次越线，而「最后一次调用很小」什么都证明不了。这只会被报告，绝不强制执行：插件无法调整另一个组件的提示词大小，而拒绝评审等于用一项可度量的成本换来监督的静默丢失。未知阈值不产生警告，因为拿一个占用去比一条未命名的线，等于默认把它判为安全。

**隔离报告**（`isolation-report.ts`）。成员的受限被报告为*请求*了什么、实际把它缩窄的是哪个机制（`tool-scope`、`harness-policy`、`both` 或 `none`），以及一个供调用方分支的 `restricted` 标志——它从**解析后的工具集**与沙箱模式回读计算得出，绝不从角色的意图得出。「我们要了只读」与「只读正在生效」是两个不同的事实，而把两者混为一谈的 brief 正是把一个可写成员误认为受限成员的途径。唯一绝不静默的结果是只读请求上的 `enforcedBy: none`：它携带 `fallbackReason`，而处于自己 worktree 中的 `workspace-write` 成员被报告为*已被围隔*而不是受限，因为私有 worktree 实际买到的就是围隔。

## 已知限制与延期工作

验证历史是进程本地的，尚未公开持久化任务或取消。团队成员尚未支持进程内恢复：重启后的 Host 会从持久看板与成员注册表报告当时在飞的是什么，但成员本身必须重新启动（它的 worktree 与分支会存活，因此它的工作不会丢）。角色库随包投放五个角色；角色记录的形状就是扩展点。上下文预算依赖已挂载的 token meter；没有它时，组合会把压力报告为不可度量而不是零，因此那里根本没有那段片段。缓存浪费只从本地台账归因——网关 endpoint 报告的是计费总额，不是逐请求前缀——而只有在范围内携带费率时才归因到金额，因为一个无价格可依的数字比没有更差。动作评审器（`action-review.ts`）是一套完整策略但没有接上评审器：在逐工具热路径上跑模型评审会为每次工具调用增加一个请求，而那正是本插件存在以减少的成本，因此在评审值得这笔开销之前它保持未绑定。档位选择从*变更路径*而非覆盖率插桩推断覆盖，因此它说的是「这次改动伴随了一个测试文件改动」，而绝不是「这些测试覆盖了这次改动」；知道真实覆盖率的调用方应当直接传入它。旁路通道阈值推导自 `compaction-basic` 的默认比例，因此覆盖该比例的组合会使这个数字变成近似值——这就是该检查只警告、绝不拒绝的原因。缓存冷清除只从请求中删除旧工具结果；它无法编辑服务器上已被缓存的前缀，而那会是同一想法的更强版本。凭据扫描器是经过挑选的子集，不是通用密钥探测器，而且它只筛查记忆写入——引擎审计摘要与导出的 bundle 仍依赖它们自己的按字段脱敏。Code Graph 目前调用官方 CLI 完成仅代码构建、增量更新与有界只读查询；内部 Graphify MCP sidecar、持久化构建队列、用户取消、依赖哈希锁、运行时更新渠道与 Canvas 适配器仍是发布门槛。CodeGraph 引擎没有 Canvas 适配器（有界的 Canvas 投影仍仅限 Graphify），也没有 `overview` 工具，因为它的 CLI 不提供 hub 排序或全图导出命令；两个引擎的新鲜度都来自轮次后的自动更新 hook 与用户的显式操作，而不是后台 watcher，并且 `codegraph` 在不带守护进程的情况下运行，因此查询绝不会与第二个写入方争抢。

## 插件冲突保护

`freecodego-harness` 设置命名空间默认启用插件冲突保护。`dsh` profile launcher 在 Loader 启动 profile 树之前安装该守卫，随后 FreeCodeGo 静态扫描每个后续条目的模块与本地 import，查找字面重复的 Tool 名称、命令名称、设置命名空间、HTTP 路由、模型 Provider id 与 UI Slot id。当它发现某个独占资源已被一个活动条目持有时，它保留较早的条目，在较晚的条目运行之前将其禁用，并为设置页保存一条修复记录。浏览器通知会点名两个条目与该重复资源。

扫描器绝不执行第三方代码，并刻意忽略动态或计算出的注册。它防止的是可靠的重复注册，而不是仅仅提供相似面向用户功能的无关插件。

## NPM 更新

更新服务跟踪已发布的 `freecodego` 入口包，而不是孤立地更新某一个 Host 组件。它在启动后以及每天检查 npm，支持 `latest`、`next` 与 `canary` dist-tag，并把所选版本暂存在一个同级 Profile 中，然后再原子地提升它。更新前的 Profile 会一直可用，直到重启后的 Host 保持健康；设置页可以在确认之前恢复它。更新绝不隐式重启进程，因此需要重启 Host 才会加载新的 bundle。

## Zcode GLM-5.3 Flash 推广

只有当 Host 为当前 Z.AI 账号持有 Coding Plan 凭据时，Zcode 模型目录才会标注 `glm-5.3-flash`。限免窗口按 `Asia/Shanghai` 计算：每月 20 日之前，从 23:00 到次日 09:00，请求显示为不消耗 token。该模型在窗口之外仍然可用，但 UI 会明确报告限免期未生效；任何客户端时钟或账号声明都无法授予该权益。

## MCP 与 Skills

`freecodego-harness` 设置命名空间存储开关、第三方 MCP 服务器与额外的 Skill 根。两个开关默认关闭。被启用的 MCP 服务器由 Host 连接一次，并注册为 DeepSeek 引擎的 Harness 工具。Claude 通过其进程内 `freecodego-host` MCP 服务器收到已发现的 schema 并调用 Host 桥接，而 Codex 在其插件自有的 app-server 配置中收到同一套已启用服务器定义。

被启用的 Skill 根由 Harness 的文件系统 Skill provider 发现。一次 skills.sh 安装会原子地把由 Host 持有的社区目录注册为一个已启用的自定义根，因此导入的单层 `SKILL.md` bundle 会立即对 DeepSeek 以及下一个原生会话可见。Claude 通过 Host 桥接加载已启用的 Skills，Codex 通过 `skills/extraRoots/set` 收到它们。禁用一个能力会卸载它的受管 provider 并阻止未来的原生会话收到它；已有会话必须重启才能替换其原生 app-server 清单。

内嵌社区页通过 Host Remote 读取有界、分页的 MCP.so 与 skills.sh 元数据。只有当 MCP 条目的已发布详情包含一个可由共享 registry 表示的 HTTP endpoint 或 stdio 命令，且没有未解析的环境变量或 header 值时，它才可以一键安装；需要凭据的条目留在手动配置中，而不是报告一次不可用的安装。Skill 条目只从经过校验的 GitHub 源仓库把匹配的 `SKILL.md` 导入由 Host 持有的社区 Skill 根。

## 第三方插件工具

原生 Codex 与 Claude 会话会投影出 Harness 向 DeepSeek 暴露的同一套 Agent 作用域 Tool schema。这包括由后续第三方插件注册的工具，例如 canvas 或领域特定的工作流工具；FreeCodeGo 不维护名称允许清单。调用经 Host ToolRuntime 返回，因此原插件仍然拥有校验、权限、审计事件、取消与执行。MCP 与 Skill 能力也可以保留其专门的原生集成，但这个通用投影绝不会仅仅因为名字就隐藏一个第三方工具。

Codex 在每次提示词之前刷新这份清单，Claude 为每次查询重建其进程内 MCP 服务器。因此安装、禁用或限制一个插件会在下一个原生轮次生效，而无须重建对话。只有 `ctx.tools.schemas(agent)` 中可见的 schema 会被投影；被 Host 或作用域隐藏的工具绝不跨过原生桥接。

## 媒体默认值

Host 为 DeepSeek、Codex 与 Claude 注册 `freecodego_generate_image`、`freecodego_generate_video` 与 `freecodego_generate_audio`。每次执行都从 `freecodego-harness.mediaDefaults` 读取实时的图像／视频／音频默认值；面向模型的 schema 刻意没有模型覆盖项。网关请求复用 Host vault 账号令牌与所选模型的路由键。Agnes 默认值复用既有的 Agnes Host 客户端。Base64 图像响应被接纳进 Harness 附件存储并作为 image 内容块返回；音频字节保存到活动工作区的 `.freecodego/generated-media` 目录下。

## 设置迁移：孤儿 Engineering 键

一个 DSH home 可能被本插件的多个构建写过。已发布的 alpha 包会写入四个本仓库从不读取的键——`engineeringProfile`、`engineeringTelemetryEnabled`、`engineeringLearningDraftsEnabled` 与 `engineeringTelemetryRetentionDays`——因此被两个构建都用过的 home 最终会携带死设置：没有任何代码路径读它们，设置页从不显示它们，也不会有任何东西失败，而这恰恰是它们值得被点名的原因。

它们已从本地 home 中移除，文件其余部分逐字节保留（备份留在旁边，名为 `settings.yaml.bak-orphan-keys-*`）。它们*点名*的能力在这里并非一致地缺失：

| 被移除的键 | 在本仓库中的状态 |
| --- | --- |
| `engineeringLearningDraftsEnabled` | 该行为作为 `engineering_skill_draft` 工具存在，它只从用户已经评审过的记忆中推导草稿。目前不可开关。 |
| `engineeringProfile` | 不存在 profile 分级；各个独立开关就是契约。 |
| `engineeringTelemetryEnabled` / `engineeringTelemetryRetentionDays` | 这个构建中不存在任何遥测采集或保留。 |

如果某个 alpha profile 仍在 `profiles/freecodego-alpha` 下使用，它自己的设置文档是独立的；从共享 home 中移除这些键不会碰它，而 alpha 构建会在下次运行时重新加回它需要的任何东西。

## 社区插件

社区插件页读取活动 profile 的依赖与 bundle 列表以显示已安装插件。FreeCodeGo 记录每次安装返回的源 URL 与直接包名，因此 GitHub 安装与多包安装仍然可识别。卸载会先禁用匹配的 Loader 条目，再从 profile 中移除直接依赖与 bundle 激活；下一次 Harness 启动无法加载被移除的插件。

配置了 `gateway` 时，bundle 为移动端认证、bootstrap／模型状态、quota、运行时健康、模型价格、套餐、结账与订单轮询复用现有的 FreeCodeGo v1 路由。浏览器 Remote 只收到脱敏状态。UI 中不暴露任何提供方特定的凭据。

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

设置页显示账号／配额／用量详情、选择支付方式与套餐、打开结账链接、轮询订单，并显示实时的模型价格表。支付校验／取消与收据邮件投递已经接通。提供方特定的支付确认、二进制收据下载、完整的运行时产物覆盖、干净 profile 安装与组装后的 Web E2E 仍是发布门槛。

-----

## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为 Host 插件的生命周期与其公开的服务由它的组合测试覆盖。

上文的排序按读者带着什么问题而来，而不是按挂载顺序：先路由与评审，然后 engineering 表面，接着是上下文纪律（一组为了让长会话负担得起而存在的功能），再是部署方要配置的那些表面（设置、媒体、提供方），最后是已安装 home 的运维备注。

当某个 Harness 包已经拥有某项能力时，本插件挂接到它，而不是注册第二套实现；它仍然保留的增强会写在它所属的那一节旁边。这条规则在 [`../../../COMPATIBILITY.md`](../../../COMPATIBILITY.md) 里逐冲突记录。

</details>

**运行时不变式：** 上述每项能力都由其所在节点名的设置开关把关，且没有任何一节注册 Harness 自有契约的第二套实现。
