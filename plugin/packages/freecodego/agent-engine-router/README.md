---
description: "The single AgentFactory for the FreeCodeGo bundle: engine-plan leases, DeepSeek delegation, and native Codex and Claude routing."
kind: "package-reference"
---

# dsh-freecodego-agent-engine-router

English | [中文](README.zh.md)

## Summary

The router is the single `AgentFactory` for a FreeCodeGo composition, so a requested native engine never falls back to DeepSeek: a missing or incompatible runtime fails explicitly instead. It publishes a lease only after the Harness agent is published and releases it during handle disposal, and the bundle disables `agent-loop.registerFactory` so the process has exactly one factory. Codex and Claude are delegated to the plugin-owned native root-agent factory when their verified runtime openers are installed, and their permission and question events run through Harness `ctx.approval` and `ctx.userQuestions` with fail-closed handling for malformed or unavailable requests.

## Table of Contents

- [Routing and the engine plan](#routing-and-the-engine-plan)
- [Native engines](#native-engines)
- [Dev Note](#dev-note)

-----

<a id="routing-and-the-engine-plan"></a>
## Routing and the engine plan

The router reserves a redacted immutable engine plan before delegating DeepSeek create/resume operations to `dsh-agent-loop`. The plan is the authority for what the session runs on, which is why it is reserved before any work is delegated rather than derived from the request.

The lease follows publication, not intent: it is published only after successful Harness agent publication, so a handle that exists always names a live agent, and it is released during handle disposal.

-----

<a id="native-engines"></a>
## Native engines

Codex and Claude are delegated to the plugin-owned native root-agent factory when their verified runtime openers are installed.

Native permission and question events use Harness `ctx.approval` and `ctx.userQuestions`; a malformed or unavailable request fails closed.

Resume re-acquires the exact durable engine generation and the immutable plan. A missing or incompatible runtime fails explicitly instead of falling back to DeepSeek, because a silent fallback would run the conversation on a different engine than the one its durable plan names.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the router has no independently observable package-owned relationship beyond its focused behavior tests.

</details>

**Runtime invariant:** exactly one factory per process, enforced by the bundle disabling `agent-loop.registerFactory`.
