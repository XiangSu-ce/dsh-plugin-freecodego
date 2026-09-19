---
name: engineering-code-review
description: Review changed code for concrete behavioral failures, regressions, security risks, and missing tests.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Code Review

Start with concrete findings ordered by severity. Each finding needs an exact location, a realistic failure mode, and enough surrounding context to prove it is actionable. Focus on correctness, behavioral regressions, security boundaries, race conditions, error handling, and missing verification.

Returning no findings is valid when the reviewed evidence supports it. Do not manufacture style concerns to appear rigorous.
