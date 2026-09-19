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
- [Agent Teams](#agent-teams)
- [开发备注](#dev-note)

-----

<a id="install"></a>
## 安装

用 `@next` 安装当前预发布渠道；CLI 会把它匹配到当前 Harness 基线：

```sh
dsh plugin --profile web add --save-exact freecodego@next
```

`dsh` 命令由 Harness CLI 提供，不来自本 bundle。普通终端里请先用 `npm install --global @deepseek-ai/dsh` 安装它（并确保 `pnpm` 可用）。桌面端通过自己的私有 shim 运行同一条命令并传入当前 `DSH_HOME`，因此 Web 与桌面端选择同一个 Harness home 时共用同一份 Profile 数据目录。

维护者从 tag 发布。`pnpm run release:freecodego <version>` 会提升 bundle 版本并创建 `freecodego-v<version>` tag，然后从该 tag 触发工作流：

```sh
pnpm run release:freecodego <version>
gh workflow run release-freecodego.yml --ref freecodego-v<version>
```

工作流先校验家族、构建、打包，再带 npm provenance 发布到 `next` dist-tag。该家族只允许从 `freecodego-v*` tag 发布，且 tag 必须命名工作区实际携带的版本，所以从分支触发的运行会在构建之前失败，而不是之后。

-----

<a id="agent-teams"></a>
## Agent Teams

bundle 以同引擎子会话启用 Harness Agent Teams。DeepSeek 父会话创建 DeepSeek 队友，Codex 父会话创建 Codex 队友，Claude 父会话创建 Claude 队友；子会话路由继承自父会话，而不是从进程默认值中选取。团队名册、邮箱、任务看板与队友 Session 记录仍由 Harness 持有。Web Chat 在父对话内渲染实时的委派 Agent 进度树，包括每个任务标签、当前工具、状态与工具使用次数。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为 bundle 是静态组合元数据，本身没有运行时注册关系。

插件版本与 Harness 版本完全一致是刻意的：针对某个基线组装的 bundle 组合的是该基线的行，因此独立版本号只会诱导用户安装一对从未被任何构建测试过的组合。

</details>

**运行时不变式：** bundle 以数据形式声明其组合（`dsh.bundle.patch`）；它不持有运行时状态。
