---
description: "FreeCodeGo 原生 agent worker 的隔离子进程宿主：JSONL 分帧、请求关联、事件序列校验，以及 Harness home 之下的受管运行时文件。"
kind: "package-reference"
---

# Native Runtime Host

[English](README.md) | 中文

## 概述

`NativeRuntimeHost` 为每个 FreeCodeGo agent worker 持有一个隔离的 Node 子进程。它使用有界 JSONL 分帧、请求关联、单调事件序列校验、显式环境白名单、超时／中止处理与升级式进程清理。宿主刻意不接受协议消息中的凭据或类密钥字段。受管的 Codex 与 Claude 运行时文件位于 Harness home 之下，因此已安装的官方运行时在其平台与协议仍兼容时，可以跨 Host worker 更新继续可用。

## 目录

- [子进程契约](#child-process-contract)
- [受管运行时文件](#managed-runtime-files)
- [开发备注](#dev-note)

-----

<a id="child-process-contract"></a>
## 子进程契约

`NativeRuntimeHost` 为每个 FreeCodeGo agent worker 持有一个隔离的 Node 子进程。它使用有界 JSONL 分帧、请求关联、单调事件序列校验、显式环境白名单、超时／中止处理与升级式进程清理。

宿主刻意不接受协议消息中的凭据或类密钥字段。

-----

<a id="managed-runtime-files"></a>
## 受管运行时文件

受管的 Codex 与 Claude 运行时文件位于 Harness home 之下。已安装的官方运行时在其平台与协议兼容时，可以跨 Host worker 更新继续可用；不会仅仅因为 worker 包版本变化就需要重新下载。

移除会删除整个受管运行时目录，包括产物与缓存的下载内容，并且在该目录仍然存在时报错。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为宿主在拥有该关系的操作内部校验每种协议与进程关系。

让子进程隔离而不是在进程内运行，正是原生 worker 崩溃不会连带拖垮 Host 的原因，也是协议不能携带凭据的原因：跨越该边界的一切都不会经过 Host 自己的凭据处理。

</details>

**运行时不变式：** 每个 worker 一个子进程，带环境白名单且没有任何凭据形态的协议字段。
