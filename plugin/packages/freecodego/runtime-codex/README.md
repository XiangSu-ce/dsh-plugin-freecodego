---
description: "The Codex App Server JSONL worker integration for the FreeCodeGo native runtime, including platform binary selection and verified on-demand installation."
kind: "package-reference"
---

# dsh-freecodego-runtime-codex

English | [中文](README.zh.md)

## Summary

Codex App Server JSONL worker integration for the FreeCodeGo native runtime. Official runtime binaries are selected by platform, downloaded on demand, and verified before installation below the Harness home, so an official build that was already installed stays usable when its platform and protocol still match.

## Table of Contents

- [Worker integration](#worker-integration)
- [Runtime binaries](#runtime-binaries)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="worker-integration"></a>
## Worker integration

The worker drives the Codex App Server over JSONL and implements the native runtime protocol: `initialize`, session create/resume/prompt/cancel/dispose, approval and question responses, and `models/refresh`, with correlated events carrying a strictly increasing sequence number.

Approvals and questions are delegated to the Harness services the host exposes, so a malformed or unavailable request fails closed rather than being auto-approved.

-----

<a id="runtime-binaries"></a>
## Runtime binaries

Official runtime binaries are selected by platform, downloaded on demand, and verified before installation below the Harness home.

A new download is not required solely because the worker package version changed: an installed official runtime remains available while its platform and protocol are compatible.

-----

<a id="model-experience"></a>
## Model Experience

### Worker protocol

#### What the model sees

The worker drives the Codex App Server over JSONL and implements the native runtime protocol: `initialize`, session create/resume/prompt/cancel/dispose, approval and question responses, and `models/refresh`, with correlated events carrying a strictly increasing sequence number.

#### Token effect

Turns the worker completes are charged like any other agent turn, and the framing itself costs nothing.

#### KV Cache effect

The worker's conversation prefix is its own; the Harness sees it only through the events the worker forwards.

### Approvals and questions

#### What the model sees

Approvals and questions are delegated to the Harness services the host exposes, so a malformed or unavailable request fails closed rather than being auto-approved.

#### Token effect

Each decision returns one result in the turn that carries it.

#### KV Cache effect

Decisions append through the tool-result path rather than rewriting earlier content.

### Runtime binaries

#### What the model sees

Official runtime binaries are selected by platform, downloaded on demand, and verified before installation below the Harness home, and only a platform-matched, verified official binary is executed. An already installed runtime stays usable while its platform and protocol are compatible.

#### Token effect

Binary selection changes nothing in the request.

#### KV Cache effect

Installing or refreshing a runtime happens outside the request and cannot shift the cached prefix.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Only a verified, platform-matched official binary is executed** — a tampered or truncated download would otherwise become the process answering the Host's protocol requests.
- **A worker version change does not require a new download** — an installed official runtime stays available while its platform and protocol are compatible.
- **JSONL framing is the only channel** — a frame outside the correlated, strictly increasing sequence is a protocol error.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the worker has no independently observable package-owned relationship beyond its runtime protocol tests.

The binary is verified before installation because the worker executes it: a tampered or truncated download would otherwise become the process that answers the Host's protocol requests.

</details>

**Runtime invariant:** only a platform-matched, verified official binary is executed.
