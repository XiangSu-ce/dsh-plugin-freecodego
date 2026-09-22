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
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="session-bridge"></a>
## 会话桥接

桥接为每个原生会话持有一个 Harness Agent，并把 create、resume、prompt 与释放转发给它所持有的 worker。会话归属留在桥接处，因此已释放的句柄不会留下一个 Harness 仍认为存活的 worker 会话。

-----

<a id="model-experience"></a>
## Model Experience

### 原生会话桥接

#### 模型看到什么

Codex 或 Claude worker 以普通 Harness Agent 的身份呈现给组合的其余部分：与路由器委派时相同的 create、resume、prompt 与 dispose 表面。原生会话 id 与拥有它的引擎都留在桥内部，因此引擎选择绝不进入提示词组装。

#### Token 影响

桥自身不贡献请求文本；token 来自 worker 自己的轮次，以及它返回的 Harness 工具结果。

#### KV Cache 影响

桥不向请求增加任何内容，因此它的存在不会让已缓存的 prefix 失效；被 resume 的会话从它自己轮次产生的 prefix 继续。

### 工具、审批与提问委派

#### 模型看到什么

worker 调用的 Harness 工具通过桥暴露的 Host 服务执行，结果以普通工具结果返回。审批与提问委派给 Harness 的 `ctx.approval` 与 `ctx.userQuestions`；畸形或不可用的请求会 fail-closed，而不是被自动批准。

#### Token 影响

工具结果只在返回它的那一轮计费一次，被拒绝的审批产生拒绝结果，而不是伪造成功。

#### KV Cache 影响

结果通过普通工具结果路径追加，因此是延长已缓存的 prefix，而不是重写它。

### 恢复与销毁

#### 模型看到什么

resume 会重新接上 worker 会话并继续同一段对话；dispose 结束它。会话所有权留在桥里，因此已销毁的 handle 不会留下一个 Harness 仍以为存活的 worker 会话。

#### Token 影响

被 resume 的会话保留它自己轮次建立的上下文；dispose 不贡献任何内容。

#### KV Cache 影响

resume 继续既有 prefix，而全新会话会另起一个。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **每个存活的 Agent handle 对应一个 worker 会话** —— 桥在 dispose 时释放它，因此已销毁的 handle 不会留下一个 Harness 仍以为存活的 worker 会话。
- **差异必须是 worker 的差异** —— 引擎特有行为必须在 worker 里被论证，而不是作为对 agent 契约的改动。
- **不发布 invariant 伴随包** —— 会话所有权与生命周期一致性由桥的操作及其聚焦测试保证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为会话归属与生命周期一致性由桥接操作及其聚焦测试保证。

桥接的存在是为了让原生引擎不是「另一种 agent」：任何对 Harness Agent 生效的东西对 Codex 或 Claude agent 同样生效，而原生特有的行为必须被证明是 worker 的差异，而不是 agent 契约的差异。

</details>

**运行时不变式：** 每个存活 Agent 句柄对应一个 worker 会话，并在释放时归还。
