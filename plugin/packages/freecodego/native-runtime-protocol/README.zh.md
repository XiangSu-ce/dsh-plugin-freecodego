---
description: "面向隔离的 FreeCodeGo 派生原生 agent worker 的 Node JSONL 分帧、取消与超时原语。"
kind: "package-reference"
---

# dsh-freecodego-native-runtime-protocol

[English](README.md) | 中文

## 概述

面向隔离的 FreeCodeGo 派生原生 agent worker 的 Node JSONL 分帧、取消与超时原语。稳定请求包括 `initialize`、账号与 catalog 操作、会话 create/resume/prompt/cancel/dispose、审批与提问响应，以及 `models/refresh`；非请求事件携带运行时／会话关联 id 与严格递增的序列号，宿主拒绝畸形或携带密钥的帧。worker 实现必须把本协议与 Harness 自有的工具、审批、凭据与资源限制一起使用。

## 目录

- [请求与事件词表](#request-and-event-vocabulary)
- [来源](#provenance)
- [开发备注](#dev-note)

-----

<a id="request-and-event-vocabulary"></a>
## 请求与事件词表

稳定请求包括 `initialize`、账号与 catalog 操作、会话 create/resume/prompt/cancel/dispose、审批与提问响应，以及 `models/refresh`。

非请求事件携带运行时／会话关联 id 与严格递增的序列号；宿主拒绝畸形或携带密钥的帧。

-----

<a id="provenance"></a>
## 来源

本包刻意排除 Bun/Effect 桌面运行时。其 `NOTICE` 记录了派生自 FreeCodeGo 的小型超时／中止辅助函数的来源（取自 MIT 许可时期，即 0.1.4 改用 AGPL 之前）。

worker 实现必须把本协议与 Harness 自有的工具、审批、凭据与资源限制一起使用。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为协议包不包含任何可独立观察的注册关系。

序列号是链路上唯一的排序权威；乱序到达的帧会被拒绝而不是重排，因为被重排的审批响应会回答一个与宿主正在等待的请求不同的请求。

</details>

**运行时不变式：** 每个关联 id 一个单调事件序列，且不接受任何携带密钥的帧。
