---
description: "The isolated child-process host for FreeCodeGo native agent workers: JSONL framing, request correlation, event sequence checks, and managed runtime files below the Harness home."
kind: "package-reference"
---

# Native Runtime Host

English | [中文](README.zh.md)

## Summary

`NativeRuntimeHost` owns one isolated Node child process for a FreeCodeGo agent worker. It uses bounded JSONL framing, request correlation, monotonic event sequence checks, an explicit environment allowlist, timeout/abort handling, and escalated process cleanup. The host intentionally does not accept credentials or secret-like fields in protocol messages. Managed Codex and Claude runtime files live below the Harness home, so an installed official runtime stays available across Host worker updates when its platform and protocol are compatible.

## Table of Contents

- [Child process contract](#child-process-contract)
- [Managed runtime files](#managed-runtime-files)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="child-process-contract"></a>
## Child process contract

`NativeRuntimeHost` owns one isolated Node child process for a FreeCodeGo agent worker. It uses bounded JSONL framing, request correlation, monotonic event sequence checks, an explicit environment allowlist, timeout/abort handling, and escalated process cleanup.

The host intentionally does not accept credentials or secret-like fields in protocol messages.

-----

<a id="managed-runtime-files"></a>
## Managed runtime files

Managed Codex and Claude runtime files live below the Harness home. An installed official runtime remains available across Host worker updates when its platform and protocol are compatible; a new download is not required solely because the worker package version changed.

Removal deletes the complete managed runtime directory, including artifacts and cached downloads, and fails if the directory remains present.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the worker whose events the host relays into the Harness session.

#### KV Cache effect

The host adds no request text of its own; the cached prefix follows the session's own event projections.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **One isolated child process per worker** — bounded JSONL framing, request correlation, and monotonic event sequence checks are the contract.
- **No credentials in protocol messages** — the host refuses secret-like fields rather than forwarding them.
- **Managed runtime files live below the Harness home** — an installed official runtime stays available across Host worker updates while its platform and protocol match.
- **Cleanup is escalated, not best-effort** — timeout and abort handling end in escalated process cleanup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the host validates each protocol and process relationship inside the operation that owns it.

Keeping the child process isolated rather than in-process is what lets a native worker crash without taking the Host with it, and it is why the protocol must not carry credentials: nothing crossing that boundary is inspected by the Host's own credential handling.

</details>

**Runtime invariant:** one child process per worker, with an environment allowlist and no credential-shaped protocol field.
