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
- [Dev Note](#dev-note)

-----

<a id="host-process-integration"></a>
## Host-process integration

`DirectClaudeSdkSession` drives the official Claude Agent SDK in the Host process. It forwards correlated native-session events to the Harness, delegates approvals, questions, and Harness tools through the Host services, and passes a caller cancellation signal to the SDK abort controller.

SDK diagnostics and errors are redacted before they become Harness events or caller-visible failures.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the Host-owned SDK session has no independently observable package-owned relationship beyond its runtime tests.

The Host resolves the Claude credential immediately before it opens an SDK session. No Claude worker exists and no credential field crosses the native runtime protocol.

</details>

**Runtime invariant:** one Host-owned SDK session forwards correlated events, honors cancellation, and does not expose credentials in diagnostics.
