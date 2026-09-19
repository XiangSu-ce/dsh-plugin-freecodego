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

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除运行时协议测试之外，worker 没有可独立观察的包内自有关系。

二进制在安装前完成校验，因为执行它的是 worker：否则被篡改或被截断的下载就会成为回答宿主协议请求的那个进程。

</details>

**运行时不变式：** 只执行平台匹配且经校验的官方二进制。
