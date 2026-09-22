---
description: "The engine-neutral session bridge between FreeCodeGo native runtimes and the Harness Agent lifecycle."
kind: "package-reference"
---

# dsh-freecodego-root-agent

English | [中文](README.zh.md)

## Summary

Engine-neutral session bridge between FreeCodeGo native runtimes and the Harness Agent lifecycle. It presents a Codex or Claude worker as an ordinary Harness Agent — the same create, resume, prompt, and dispose surface the router delegates to — so the engine choice never reaches the rest of the composition.

## Table of Contents

- [Session bridge](#session-bridge)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="session-bridge"></a>
## Session bridge

The bridge owns one Harness Agent per native session and forwards create, resume, prompt, and disposal to the worker it holds. Session ownership stays with the bridge, so a disposed handle cannot leave a worker session that the Harness still believes is live.

-----

<a id="model-experience"></a>
## Model Experience

### Native session bridging

#### What the model sees

A Codex or Claude worker is presented to the rest of the composition as an ordinary Harness Agent: the same create, resume, prompt, and dispose surface the router delegates to. The native session id and the engine that owns it stay inside the bridge, so the engine choice never reaches prompt assembly.

#### Token effect

The bridge contributes no request text of its own; tokens come from the worker's own turns and from the Harness tool results it returns.

#### KV Cache effect

Nothing the bridge adds enters the request, so its presence cannot invalidate a cached prefix; a resumed session continues from the prefix its own turns produced.

### Tool, approval, and question delegation

#### What the model sees

Harness tools the worker calls are executed through the Host services the bridge exposes, and their results return as ordinary tool results. Approvals and questions are delegated to Harness `ctx.approval` and `ctx.userQuestions`; a malformed or unavailable request fails closed rather than being auto-approved.

#### Token effect

Tool results are charged once, in the turn that returns them, and a refused approval produces a refusal result rather than a fabricated success.

#### KV Cache effect

Results append through the ordinary tool-result path, so they extend the cached prefix instead of rewriting it.

### Resume and disposal

#### What the model sees

Resume re-acquires the worker session and continues the same conversation; disposal ends it. Session ownership stays with the bridge, so a disposed handle cannot leave a worker session the Harness still believes is live.

#### Token effect

A resumed session keeps the context its own turns established; disposal contributes nothing.

#### KV Cache effect

Resuming continues the existing prefix, while a fresh session starts a new one.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **One worker session per live Agent handle** — the bridge releases it on disposal, so a disposed handle cannot leave a worker session the Harness still believes is live.
- **A difference must be a worker difference** — engine-specific behavior has to be justified in the worker rather than as a change to the agent contract.
- **No invariant companion is published** — session ownership and lifecycle consistency are enforced by the bridge operations and their focused tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because session ownership and lifecycle consistency are enforced by the bridge operations and their focused tests.

The bridge exists so native engines are not a second kind of agent: anything that works on a Harness Agent works on a Codex or Claude one, and a native-specific behavior has to be justified as a difference in the worker rather than a difference in the agent contract.

</details>

**Runtime invariant:** one worker session per live Agent handle, released on disposal.
