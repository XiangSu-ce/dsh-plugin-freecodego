---
description: "FreeCodeGo 原生运行时的 Codex App Server JSONL worker 集成，含平台二进制选择与经校验的按需安装。"
kind: "package-reference"
---

# dsh-freecodego-runtime-codex

[English](README.md) | 中文

## 概述

FreeCodeGo 原生运行时的 Codex App Server JSONL worker 集成。官方运行时二进制按平台选择、按需下载，并在安装到 Harness home 之下以前完成校验，因此已安装且平台与协议仍然匹配的官方构建保持可用。

## 目录

- [Worker 集成](#worker-integration)
- [运行时二进制](#runtime-binaries)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="worker-integration"></a>
## Worker 集成

worker 通过 JSONL 驱动 Codex App Server，并实现原生运行时协议：`initialize`、会话 create/resume/prompt/cancel/dispose、审批与提问响应，以及 `models/refresh`，并发出携带严格递增序列号的关联事件。

审批与提问委派给宿主公开的 Harness 服务，因此畸形或不可用的请求按 fail-closed 处理，而不是被自动批准。

-----

<a id="runtime-binaries"></a>
## 运行时二进制

官方运行时二进制按平台选择、按需下载，并在安装到 Harness home 之下以前完成校验。

不因为 worker 包版本变化就需要重新下载：只要平台与协议兼容，已安装的官方运行时保持可用。

-----

<a id="model-experience"></a>
## Model Experience

### worker 协议

#### 模型看到什么

worker 通过 JSONL 驱动 Codex App Server 并实现原生运行时协议：`initialize`、会话 create/resume/prompt/cancel/dispose、审批与提问应答，以及 `models/refresh`，带关联的事件携带严格递增的序号。

#### Token 影响

worker 完成的轮次像其它任何 agent 轮次一样计费，而分帧本身不产生开销。

#### KV Cache 影响

worker 的对话 prefix 属于它自己；Harness 只能通过 worker 转发的事件看到它。

### 审批与提问

#### 模型看到什么

审批与提问委派给 host 暴露的 Harness 服务，因此畸形或不可用的请求会 fail-closed，而不是被自动批准。

#### Token 影响

每个判定只在承载它的那一轮返回一个结果。

#### KV Cache 影响

判定通过工具结果路径追加，而不是重写此前的内容。

### 运行时二进制

#### 模型看到什么

官方运行时二进制按平台选择、按需下载，并在安装到 Harness home 之下前完成校验；只有平台匹配且已校验的官方二进制才会被执行。已安装的运行时只要平台与协议兼容就继续可用。

#### Token 影响

二进制的选择不改变请求中的任何内容。

#### KV Cache 影响

安装或刷新运行时发生在请求之外，不会移动已缓存的 prefix。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **只执行已校验且平台匹配的官方二进制** —— 否则被篡改或截断的下载就会成为应答 Host 协议请求的进程。
- **worker 版本变化不要求重新下载** —— 已安装的官方运行时只要平台与协议兼容就继续可用。
- **JSONL 分帧是唯一通道** —— 落在带关联、严格递增序号之外的帧都是协议错误。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除运行时协议测试之外，worker 没有可独立观察的包内自有关系。

二进制在安装前完成校验，因为执行它的是 worker：否则被篡改或被截断的下载就会成为回答宿主协议请求的那个进程。

</details>

**运行时不变式：** 只执行平台匹配且经校验的官方二进制。
