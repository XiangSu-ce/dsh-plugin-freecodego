---
description: "FreeCodeGo 原生运行时与 Harness Agent 生命周期之间的引擎中立会话桥接。"
kind: "package-reference"
---

# dsh-freecodego-root-agent

[English](README.md) | 中文

## 概述

FreeCodeGo 原生运行时与 Harness Agent 生命周期之间的引擎中立会话桥接。它把 Codex 或 Claude worker 呈现为一个普通的 Harness Agent——即路由器所委派的同一套 create、resume、prompt 与 dispose 表面——因此引擎选择不会渗透到组合的其他部分。

## 目录

- [会话桥接](#session-bridge)
- [开发备注](#dev-note)

-----

<a id="session-bridge"></a>
## 会话桥接

桥接为每个原生会话持有一个 Harness Agent，并把 create、resume、prompt 与释放转发给它所持有的 worker。会话归属留在桥接处，因此已释放的句柄不会留下一个 Harness 仍认为存活的 worker 会话。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为会话归属与生命周期一致性由桥接操作及其聚焦测试保证。

桥接的存在是为了让原生引擎不是「另一种 agent」：任何对 Harness Agent 生效的东西对 Codex 或 Claude agent 同样生效，而原生特有的行为必须被证明是 worker 的差异，而不是 agent 契约的差异。

</details>

**运行时不变式：** 每个存活 Agent 句柄对应一个 worker 会话，并在释放时归还。
