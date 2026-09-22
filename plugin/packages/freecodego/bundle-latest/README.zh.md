---
description: "面向 DeepSeek Harness 的可安装单包 FreeCodeGo 组合：安装渠道、发布打标，以及随包交付的 Agent Teams 组合。"
kind: "package-bundle"
---

# FreeCodeGo Harness Bundle

[English](README.md) | 中文

## 概述

面向 DeepSeek Harness `freecodego@0.1.6-alpha.2` 的可安装单包 FreeCodeGo 组合，目标 Harness 基线为 `0.1.6-alpha.2`。npm 产物包含编译后的 Host 插件、浏览器端 client、会话事件前置包、原生 worker 入口，以及随包交付的 Harness Agent Teams 组合。发布产物使用 npm 的 `next` dist-tag，且其插件版本刻意与所面向的 Harness 版本完全一致；需要可复现安装时请指定版本（`freecodego@0.1.6-alpha.2`），而不是渠道名。官方 Codex 与 Claude 运行时二进制仍按平台可选下载——本包不内嵌每个平台的原生二进制。

## 目录

- [安装](#install)
- [免费模型](#free-models)
- [代码审查](#code-review)
- [项目记忆](#project-memory)
- [Agent Teams](#agent-teams)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="install"></a>
## 安装

安装你实际运行的那条 Harness 基线对应的 release；每个 release 只带一个 tarball，名字即它所挂载的基线：

```sh
dsh plugin --profile web add --save-exact \
  https://github.com/XiangSu-ce/dsh-plugin-freecodego/releases/download/freecodego-v0.1.6-alpha.2/freecodego-0.1.6-alpha.2.tgz
```

`freecodego-0.1.6-alpha.2.tgz` 就是面向 Harness `0.1.6-alpha.2` 的 bundle：请替换为你实际运行的版本，设置页会把它显示在已装插件版本旁边。资产名即 `packages/freecodego/AGENTS.md` 里的命名约定。

`dsh` 命令由 Harness CLI 提供，不来自本 bundle。普通终端里请先用 `npm install --global @deepseek-ai/dsh` 安装它（并确保 `pnpm` 可用）。桌面端通过自己的私有 shim 运行同一条命令并传入当前 `DSH_HOME`，因此 Web 与桌面端选择同一个 Harness home 时共用同一份 Profile 数据目录。

维护者从 tag 发布。`pnpm run release:freecodego <version>` 会提升 bundle 版本并创建 `freecodego-v<version>` tag，然后从该 tag 触发工作流：

```sh
pnpm run release:freecodego <version>
gh workflow run release-freecodego.yml --ref freecodego-v<version>
```

工作流先校验家族、构建、打包，再为这个 tag 创建 GitHub release。若打包出来的文件没有带着更新检查所寻找的资产名，它会拒绝发布；发布之后还会按插件读取 release 的方式复验一遍，才会让本次运行通过。该家族只允许从 `freecodego-v*` tag 发布，且 tag 必须命名工作区实际携带的版本，所以从分支触发的运行会在构建之前失败，而不是之后。

-----

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

<a id="code-review"></a>
## 代码审查

这个包挂载一个四工具的改动审查器。`engineering_code_review` 会审查工作区（已暂存、未暂存**以及**未跟踪的改动）、从 merge base 起算的一段引用范围、或某个提交对其第一父提交的差异，并按 `text`、`json` 或 `sarif` 渲染报告；`engineering_review_rules` 完全不花模型调用，直接返回会审查什么、按哪条规则；`engineering_review_status` 与 `engineering_review_report` 分别显示正在跑什么、以及把上一次结果按另一位读者重新渲染。规则分四层解析 —— 本次运行传入的规则文件、项目自己的（`.opencodereview/rule.json`、`.dsh/review.json` 或 `.freecodego/review.json`）、用户级 `~/.opencodereview/rule.json`、以及随插件发布的基线 —— 命中的第一层胜出，所以项目覆盖是替换而不是并入。覆盖面按文件核算：只要还有改动过的文件没被审到，这次运行就不能结束，而每次跳过都会记录原因。

审查要花模型调用，所以是可选的。`reviewMode` 取 `off`、`record`（结论成为持久会话事件，所以事后不必重跑就能回答"那次审查说了什么"）或 `gate`（达到 `reviewThreshold` 的结论会在 `reviewCooldownTurns` 过去后注入回这一回合，Agent 必须回应它才能结束）。`reviewDeep` 为每个改动文件各开一个只读子 Agent，`reviewEscalation` 会用独立裁定者复核高危结论，并要求它去**反驳**。审查跑在本插件的第二模型路由（`advisorProvider` / `advisorModel`）上，所以全新安装无需额外配置即可使用。

<a id="project-memory"></a>
## 项目记忆

这个包同时带上按项目持久化的记忆：召回只针对已审核记录，注入有围栏与预算，而凭据筛查会在写入路径上拒绝带标签的凭据、或就地脱敏仅形状匹配的内容。整合是分阶段放量而不是开关 —— `memoryRollout` 取 `off`、`record_only`、`shadow`（完整跑完包括模型调用的整合但什么都不提交，所以操作者能先读到模型**本来会**写什么）、或 `active` —— 并且一次整合会取一把带租约的锁加一份冻结快照，因此崩掉的整合可恢复，而运行中的整合会被如实报告而不是被重试。`MEMORY.md` 是一份有界的绝对路径索引，而遗忘需要调用方把打算删除的字节连同哈希一起交出来，因为"忘掉你知道的关于 X 的一切"绝不能变成一次会以没有撤销的方式删掉记录的相关性判断。

<a id="agent-teams"></a>
## Agent Teams

bundle 以同引擎子会话启用 Harness Agent Teams。DeepSeek 父会话创建 DeepSeek 队友，Codex 父会话创建 Codex 队友，Claude 父会话创建 Claude 队友；子会话路由继承自父会话，而不是从进程默认值中选取。团队名册、邮箱、任务看板与队友 Session 记录仍由 Harness 持有。Web Chat 在父对话内渲染实时的委派 Agent 进度树，包括每个任务标签、当前工具、状态与工具使用次数。

-----

<a id="model-experience"></a>
## Model Experience

间接地，经由 bundle 挂载的各个包；每个被插入的行由它自己的包决定模型可见行为。

#### KV Cache 影响

bundle 自身不改动请求文本，已缓存的 prefix 完全由被组合的行产生。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **产物是组装出来的，不是手写的** —— `prepack` 会重建 Host 插件、浏览器客户端、原生 worker 入口与 Agent Teams 组合；tarball 里没有任何内容是手工编辑的。
- **版本与 Harness 基线完全一致** —— hotfix 让 tag 保持精确，而发布资产在名字里保留基线。
- **官方运行时二进制仍是可选的平台下载** —— 本包不内嵌每个平台的原生二进制。
- **安装按版本钉住** —— 可复现的安装点名基线，而不是通道。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为 bundle 是静态组合元数据，本身没有运行时注册关系。

插件版本与 Harness 版本完全一致是刻意的：针对某个基线组装的 bundle 组合的是该基线的行，因此独立版本号只会诱导用户安装一对从未被任何构建测试过的组合。

</details>

**运行时不变式：** bundle 以数据形式声明其组合（`dsh.bundle.patch`）；它不持有运行时状态。
