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
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="host-process-integration"></a>
## Host 进程集成

`DirectClaudeSdkSession` 在 Host 进程中驱动官方 Claude Agent SDK。它向 Harness 转发有关联的原生会话事件，通过 Host 服务委派审批、提问与 Harness 工具，并将调用方的取消信号传递给 SDK abort controller。

SDK 诊断信息与错误在成为 Harness 事件或调用方可见失败前会被脱敏。

-----

<a id="model-experience"></a>
## Model Experience

### Host 拥有的 SDK 会话

#### 模型看到什么

`DirectClaudeSdkSession` 在 Host 进程中驱动官方 Claude Agent SDK。带关联的原生会话事件被转发给 Harness，因此一次 Claude 轮次表现为普通的 agent 活动，而 SDK 会话本身并不是 Harness Agent。

#### Token 影响

SDK 自身的轮次发生时即计费；会话调用的 Harness 工具通过普通路径追加它们的结果。

#### KV Cache 影响

SDK 拥有自己的对话 prefix；Harness 的 prefix 只由该会话产生的事件与工具结果延长。

### 审批、提问与工具

#### 模型看到什么

审批与提问通过 Host 服务委派，而不是在 SDK 内部作答；Harness 工具也经由同样的接缝调用。调用方的取消信号会传给 SDK 的 abort controller。

#### Token 影响

被委派的判定只在承载它的那一轮产生一个结果。

#### KV Cache 影响

判定与工具结果追加到对话中，而不是重写此前的内容。

### 凭据与脱敏

#### 模型看到什么

Host 在 SDK 会话打开前一刻解析 Claude 凭据，且没有任何凭据字段经过原生运行时协议。SDK 的诊断与错误在成为 Harness 事件或调用方可见失败之前先被脱敏。

#### Token 影响

脱敏是移除文本而不是增加文本，被脱敏的诊断只按其报告的失败计费。

#### KV Cache 影响

凭据解析发生在请求之外，因此 token 刷新不会让已缓存的 prefix 失效。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **每个 agent 一个 Host 拥有的 SDK 会话** —— 不存在 Claude worker 进程，因此崩溃会连同 Host 的会话一起带走。
- **凭据绝不经过协议** —— Host 在会话打开前一刻解析 Claude 凭据。
- **诊断是脱敏的，而不只是被缩短** —— SDK 错误在成为 Harness 事件前会经过一步脱敏。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除运行时测试之外，Host 所有的 SDK 会话没有可独立观察的包内自有关系。

Host 在打开 SDK 会话前立即解析 Claude 凭据。不存在 Claude worker，也没有 Claude 凭据字段跨越原生运行时协议。

</details>

**运行时不变式：** 单个 Host 所有的 SDK 会话转发关联事件、遵从取消，并且不在诊断信息中暴露凭据。
