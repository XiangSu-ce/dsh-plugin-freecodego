---
name: engineering-spec-mining
description: Extract an existing system contract from callers, tests, events, data formats, and observed behavior before changing legacy code.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Specification Mining

When behavior is undocumented, inspect callers, tests, persisted events, schemas, UI states, and failure handling. Distinguish observed facts from assumptions. Record the smallest contract that explains the evidence and identify unverified edges before implementation.

Do not replace legacy behavior based only on a name, comment, or isolated code fragment.
