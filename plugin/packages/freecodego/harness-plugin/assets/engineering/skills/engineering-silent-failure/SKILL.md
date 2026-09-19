---
name: engineering-silent-failure
description: Inspect asynchronous work, caches, retries, empty states, and error routing for failures that are hidden from users or agents.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Silent Failure Audit

Inspect timeout, cancellation, background refresh, cache expiry, retry, parsing, and error-display paths. A module must show its own failure without blocking unrelated UI or pretending stale or empty data is successful.

Check that asynchronous results cannot overwrite newer state and that unsupported features report unavailable rather than silently choosing a different provider or capability.
