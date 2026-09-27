---
description: "The single AgentFactory for the FreeCodeGo bundle: engine-plan leases, DeepSeek delegation, and native Codex and Claude routing."
kind: "package-reference"
---

# dsh-freecodego-agent-engine-router

English | [中文](README.zh.md)

## Summary

The router is the single `AgentFactory` for a FreeCodeGo composition, so a requested native engine never falls back to DeepSeek: a missing or incompatible runtime fails explicitly instead. It publishes a lease only after the Harness agent is published and releases it during handle disposal, and the bundle disables `agent-loop.registerFactory` so the process has exactly one factory. Codex and Claude are delegated to the plugin-owned native root-agent factory when their verified runtime openers are installed, and their permission and question events run through Harness `ctx.approval` and `ctx.userQuestions` with fail-closed handling for malformed or unavailable requests.

## Table of Contents

- [Why this is an extension, not a duplicate](#why-this-is-an-extension-not-a-duplicate)
- [Routing and the engine plan](#routing-and-the-engine-plan)
- [Native engines](#native-engines)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="why-this-is-an-extension-not-a-duplicate"></a>
## Why this is an extension, not a duplicate

No Harness release declares a root-engine seam, so root engine selection is this plugin's own capability rather than a second copy of an upstream one. Three facts make that concrete:

- **The engine vocabulary is plugin-owned.** `AgentEngineId`, the engine plan, the durable `agent-engine/selected` binding, and the `defaultEngine` setting appear nowhere in the Harness.
- **The official cross-engine packages cannot open a root Session.** `@deepseek-ai/dsh-subagent-codex` and `-claude-code` are one-shot `SubagentProvider`s on `ctx.subagents` (`NO_START_CAPABILITIES`, `inheritsParentContext: false`) whose approvals are answered unattended: no interactive approval, no multi-turn Session, and no MCP or Harness-tool bridging. Those are exactly the parts `runtime-codex` and `runtime-claude` exist to provide.
- **The extension point is the private factory slot.** The router replaces the `target` of the Harness `AgentRegistry`'s private `FactorySlot` in place, which is the only way one process can serve root Sessions on an engine other than the Harness's own loop without standing up a second registry. Because the slot is private, its shape is pinned as text rather than by type.

Two tripwires keep that honest — one ships with this package, one stays in the repository's own web e2e lane — and both are worth reading before this package is ever proposed for deletion as a duplicate:

| Tripwire | What it fails on |
|---|---|
| `harness-plugin/tests/upstream-seam-contracts.spec.ts` (published with this package) | The `FactorySlot` / `target` / `setFactory` text the router swaps, and the "still absent upstream" case: the day the Harness ships a root-engine seam it goes red, which turns this package from a permanent extension into a migration candidate. |
| `apps/web/tests/freecodego-root-engines.e2e.ts` (repository-only; the web e2e lane is not published) | The four paths on a booted Host: `deepseek` opens on the official loop, `codex` and `claude` open natively or refuse with their own runtime code, and enabling the official Team bundle live leaves the root-engine path intact. |

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

<a id="model-experience"></a>
## Model Experience

Indirectly, through the durable engine plan the router reserves for the session; the Harness AgentLoop assembles the request from the engine the plan names.

#### KV Cache effect

The router contributes no request text, so it cannot shift the cached prefix. A different engine reaches the model only at the next prompt-assembly boundary, where the plan is already fixed.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **A native engine never falls back** — a missing or incompatible runtime fails explicitly, because a silent fallback would run the conversation on a different engine than its durable plan names.
- **Exactly one factory per process** — the bundle disables `agent-loop.registerFactory`, so a composition that mounts a second factory breaks the invariant instead of being tolerated.
- **Native engines need verified openers** — Codex and Claude are delegated only when the plugin-owned runtime openers are installed with a matching generation.
- **Resume re-acquires the exact durable generation** — a runtime that no longer matches cannot continue that session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the router has no independently observable package-owned relationship beyond its focused behavior tests.

</details>

**Runtime invariant:** exactly one factory per process, enforced by the bundle disabling `agent-loop.registerFactory`.
