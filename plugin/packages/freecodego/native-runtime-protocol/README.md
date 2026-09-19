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

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the protocol package contains no independently observable registry relationship.

The sequence number is the only ordering authority on the wire; a frame that arrives out of order is rejected rather than reordered, because a reordered approval response would answer a different request than the one the Host is waiting on.

</details>

**Runtime invariant:** monotonic event sequence per correlation id, with no secret-bearing frame accepted.
