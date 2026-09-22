---
description: "Node JSONL framing, cancellation, and timeout primitives for isolated FreeCodeGo-derived native agent workers."
kind: "package-reference"
---

# dsh-freecodego-native-runtime-protocol

English | [中文](README.zh.md)

## Summary

Node JSONL framing, cancellation, and timeout primitives for isolated FreeCodeGo-derived native agent workers. Stable requests include `initialize`, account and catalog operations, session create/resume/prompt/cancel/dispose, approval and question responses, and `models/refresh`; unsolicited events carry runtime/session correlation ids and a strictly increasing sequence number, and the host rejects malformed or secret-bearing frames. Worker implementations must use this protocol with Harness-owned tools, approvals, credentials, and resource limits.

## Table of Contents

- [Request and event vocabulary](#request-and-event-vocabulary)
- [Provenance](#provenance)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="request-and-event-vocabulary"></a>
## Request and event vocabulary

Stable requests include `initialize`, account and catalog operations, session create/resume/prompt/cancel/dispose, approval and question responses, and `models/refresh`.

Unsolicited events carry runtime/session correlation ids and a strictly increasing sequence number; the host rejects malformed or secret-bearing frames.

-----

<a id="provenance"></a>
## Provenance

The package intentionally excludes the Bun/Effect desktop runtime. Its `NOTICE` records the provenance of the small timeout/abort helpers derived from FreeCodeGo (taken from the MIT-licensed era, before the 0.1.4 AGPL relicensing).

Worker implementations must use this protocol with Harness-owned tools, approvals, credentials, and resource limits.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host and worker that speak it; the protocol renders nothing itself.

#### KV Cache effect

Framing, correlation ids, and sequence checks stay off the request path, so the cached prefix is unaffected.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **A worker must use Harness-owned tools, approvals, credentials, and resource limits** — the protocol carries requests, not policy.
- **Frames are strict** — a malformed or secret-bearing frame is rejected rather than partially interpreted.
- **Events carry correlation ids and a strictly increasing sequence number** — a gap is a protocol error, not a reorder.
- **The protocol owns no transport** — the host owns the process, framing, and lifetime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the protocol package contains no independently observable registry relationship.

The sequence number is the only ordering authority on the wire; a frame that arrives out of order is rejected rather than reordered, because a reordered approval response would answer a different request than the one the Host is waiting on.

</details>

**Runtime invariant:** monotonic event sequence per correlation id, with no secret-bearing frame accepted.
