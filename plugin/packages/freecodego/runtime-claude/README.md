---
description: "The Host-process Claude Agent SDK integration for the FreeCodeGo native runtime."
kind: "package-reference"
---

# dsh-freecodego-runtime-claude

English | [中文](README.zh.md)

## Summary

Host-process Claude Agent SDK integration for the FreeCodeGo native runtime. The Host drives the official SDK directly, so Claude credentials and permission decisions remain in the Harness process and never cross a worker protocol.

## Table of Contents

- [Host-process integration](#host-process-integration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="host-process-integration"></a>
## Host-process integration

`DirectClaudeSdkSession` drives the official Claude Agent SDK in the Host process. It forwards correlated native-session events to the Harness, delegates approvals, questions, and Harness tools through the Host services, and passes a caller cancellation signal to the SDK abort controller.

SDK diagnostics and errors are redacted before they become Harness events or caller-visible failures.

-----

<a id="model-experience"></a>
## Model Experience

### Host-owned SDK session

#### What the model sees

`DirectClaudeSdkSession` drives the official Claude Agent SDK in the Host process. Correlated native-session events are forwarded to the Harness, so a Claude turn appears as ordinary agent activity while the SDK session itself is not a Harness Agent.

#### Token effect

The SDK's own turns are charged as they happen, and Harness tools the session calls add their results through the normal path.

#### KV Cache effect

The SDK owns its own conversation prefix; the Harness prefix is extended only by the events and tool results the session produces.

### Approvals, questions, and tools

#### What the model sees

Approvals and questions are delegated through the Host services rather than answered inside the SDK, and Harness tools are invoked through the same seams. A caller cancellation signal is passed to the SDK abort controller.

#### Token effect

A delegated decision produces one result in the turn that carries it.

#### KV Cache effect

Decisions and tool results append to the conversation rather than rewriting earlier content.

### Credentials and redaction

#### What the model sees

The Host resolves the Claude credential immediately before an SDK session opens, and no credential field crosses the native runtime protocol. SDK diagnostics and errors are redacted before they become Harness events or caller-visible failures.

#### Token effect

Redaction removes text instead of adding it, and a redacted diagnostic is charged only as the failure it reports.

#### KV Cache effect

Credential resolution happens outside the request, so a token refresh cannot invalidate the cached prefix.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **One Host-owned SDK session per agent** — there is no Claude worker process, so a crash takes the Host's session with it.
- **Credentials never cross the protocol** — the Host resolves the Claude credential immediately before the session opens.
- **Diagnostics are redacted, not merely shortened** — an SDK error passes a redaction step before it becomes a Harness event.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the Host-owned SDK session has no independently observable package-owned relationship beyond its runtime tests.

The Host resolves the Claude credential immediately before it opens an SDK session. No Claude worker exists and no credential field crosses the native runtime protocol.

</details>

**Runtime invariant:** one Host-owned SDK session forwards correlated events, honors cancellation, and does not expose credentials in diagnostics.
