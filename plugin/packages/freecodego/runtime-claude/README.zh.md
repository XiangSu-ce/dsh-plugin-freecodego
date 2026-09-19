---
description: "FreeCodeGo 原生运行时在 Host 进程内的 Claude Agent SDK 集成。"
kind: "package-reference"
---

# dsh-freecodego-runtime-claude

[English](README.md) | 中文

## 概述

FreeCodeGo 原生运行时在 Host 进程内的 Claude Agent SDK 集成。Host 直接驱动官方 SDK，因此 Claude 凭据与权限决策留在 Harness 进程内，不会跨越 worker 协议。

## 目录

- [Host 进程集成](#host-process-integration)
- [开发备注](#dev-note)

-----

<a id="host-process-integration"></a>
## Host 进程集成

`DirectClaudeSdkSession` 在 Host 进程中驱动官方 Claude Agent SDK。它向 Harness 转发有关联的原生会话事件，通过 Host 服务委派审批、提问与 Harness 工具，并将调用方的取消信号传递给 SDK abort controller。

SDK 诊断信息与错误在成为 Harness 事件或调用方可见失败前会被脱敏。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除运行时测试之外，Host 所有的 SDK 会话没有可独立观察的包内自有关系。

Host 在打开 SDK 会话前立即解析 Claude 凭据。不存在 Claude worker，也没有 Claude 凭据字段跨越原生运行时协议。

</details>

**运行时不变式：** 单个 Host 所有的 SDK 会话转发关联事件、遵从取消，并且不在诊断信息中暴露凭据。
