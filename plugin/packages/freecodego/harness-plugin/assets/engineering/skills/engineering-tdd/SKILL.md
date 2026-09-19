---
name: engineering-tdd
description: Use test-first development when a behavior can be specified and verified deterministically.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Test Driven Development

For a behavior change or defect with a deterministic contract, first identify the smallest failing test or verification case. Make the minimal implementation pass, then refactor only after the focused validation remains green.

Do not impose a global coverage target when the project has no such policy. Record missing testability, unavailable tools, or non-deterministic behavior honestly.
