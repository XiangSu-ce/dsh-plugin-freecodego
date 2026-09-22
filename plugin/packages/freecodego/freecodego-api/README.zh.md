---
description: "FreeCodeGo v1 API 的脱敏原生宿主客户端：逐请求凭据、仅 HTTPS 的部署地址，以及 bootstrap、quota、health 与 pricing 路由。"
kind: "package-reference"
---

# dsh-freecodego-api

[English](README.md) | 中文

## 概述

面向现有 FreeCodeGo v1 API 的脱敏原生宿主客户端。它适配现有的 `/api/v1/freecodego/*` bootstrap、quota、health 与 model-pricing 路由，而不新建第二套后端命名空间；它要求 HTTPS 部署地址，并拒绝包含已知凭据字段的 catalog 响应。

## 目录

- [凭据处理](#credential-handling)
- [路由与命名空间](#routes-and-namespace)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="credential-handling"></a>
## 凭据处理

调用方为每个请求提供来自宿主凭据提供方的短期访问令牌。本客户端从不存储该值。

凭据形态的响应在边界上即被拒绝：包含已知凭据字段的 catalog 响应会被拒绝而不是透传，因此后端变更无法把本客户端变成一条凭据传输通道。

-----

<a id="routes-and-namespace"></a>
## 路由与命名空间

本客户端要求 HTTPS 部署地址，并适配现有的 `/api/v1/freecodego/*` bootstrap、quota、health 与 model-pricing 路由，而不新建第二套后端命名空间。

-----

<a id="model-experience"></a>
## Model Experience

无，因为该客户端只交换已脱敏凭据的后端载荷，不注册任何工具、提示词分区或会话事件。

#### KV Cache 影响

它不贡献请求文本，因此在模型轮次之外发起的调用不会改变已缓存的 prefix。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **要求 HTTPS** —— 部署地址必须是 HTTPS 源。
- **响应是被筛查的，而不是被信任的** —— 携带已知凭据字段的 catalog 载荷会被拒绝。
- **只有一个命名空间** —— 客户端适配既有的 `/api/v1/freecodego/*` 路由，而不是另建一个后端命名空间。
- **配额与定价表面属于后端** —— 客户端只报告服务返回的内容，总额不由逐轮请求前缀重建。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

不发布运行时不变式伴生入口，因为除请求测试之外，本 API 客户端不公开任何可独立观察的包内自有关系。

本客户端实现的逐 endpoint 契约——哪个字段决定路由结果、计费与协议选择——记录在 [`docs/backend-contract.zh.md`](docs/backend-contract.zh.md)。

</details>

**运行时不变式：** 不存储凭据；每个请求都携带调用方提供的短期令牌。
