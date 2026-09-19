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

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the worker has no independently observable package-owned relationship beyond its runtime protocol tests.

The binary is verified before installation because the worker executes it: a tampered or truncated download would otherwise become the process that answers the Host's protocol requests.

</details>

**Runtime invariant:** only a platform-matched, verified official binary is executed.
