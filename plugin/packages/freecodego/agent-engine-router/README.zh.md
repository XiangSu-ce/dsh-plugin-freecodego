---
description: "FreeCodeGo bundle 唯一的 AgentFactory：引擎计划租约、DeepSeek 委派，以及原生 Codex 与 Claude 路由。"
kind: "package-reference"
---

# dsh-freecodego-agent-engine-router

[English](README.md) | 中文

## 概述

路由器是 FreeCodeGo 组合中唯一的 `AgentFactory`，因此请求的原生引擎绝不会回退到 DeepSeek：运行时缺失或不兼容会显式失败。它只在 Harness agent 发布成功之后才发布租约，并在句柄释放时归还；bundle 关闭 `agent-loop.registerFactory`，使进程中恰好只有一个 factory。当已校验的运行时 opener 就位时，Codex 与 Claude 会委派给插件自有的原生 root-agent factory，其权限与提问事件经由 Harness `ctx.approval` 与 `ctx.userQuestions`，对畸形或不可用的请求按 fail-closed 处理。

## 目录

- [路由与引擎计划](#routing-and-the-engine-plan)
- [原生引擎](#native-engines)
- [开发备注](#dev-note)

-----

<a id="routing-and-the-engine-plan"></a>
## 路由与引擎计划

路由器在把 DeepSeek 的 create/resume 委派给 `dsh-agent-loop` 之前，先预留一份脱敏的不可变引擎计划。计划是「该会话运行在什么之上」的权威，因此它在任何工作被委派之前就被预留，而不是从请求推导出来。

租约跟随发布而不是意图：它只在 Harness agent 发布成功之后发布，因此存在的句柄总是指向一个存活 agent；它在该句柄释放时归还。

-----

<a id="native-engines"></a>
## 原生引擎

当已校验的运行时 opener 就位时，Codex 与 Claude 会委派给插件自有的原生 root-agent factory。

原生权限与提问事件使用 Harness `ctx.approval` 与 `ctx.userQuestions`；畸形或不可用的请求按 fail-closed 处理。

恢复会重新取得完全一致的持久引擎代与不可变计划。运行时缺失或不兼容会显式失败，而不是回退到 DeepSeek，因为静默回退会让这段对话运行在与其持久计划所指不同的引擎上。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除聚焦的行为测试之外，路由器没有可独立观察的包内自有关系。

</details>

**运行时不变式：** 每进程恰好一个 factory，由 bundle 关闭 `agent-loop.registerFactory` 强制。
