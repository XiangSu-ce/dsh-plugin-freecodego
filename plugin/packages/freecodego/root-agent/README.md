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
- [Dev Note](#dev-note)

-----

<a id="session-bridge"></a>
## Session bridge

The bridge owns one Harness Agent per native session and forwards create, resume, prompt, and disposal to the worker it holds. Session ownership stays with the bridge, so a disposed handle cannot leave a worker session that the Harness still believes is live.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because session ownership and lifecycle consistency are enforced by the bridge operations and their focused tests.

The bridge exists so native engines are not a second kind of agent: anything that works on a Harness Agent works on a Codex or Claude one, and a native-specific behavior has to be justified as a difference in the worker rather than a difference in the agent contract.

</details>

**Runtime invariant:** one worker session per live Agent handle, released on disposal.
