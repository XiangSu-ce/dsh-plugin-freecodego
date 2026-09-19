---
name: engineering-debug
description: Diagnose build, runtime, integration, and state failures from a minimal reproducible symptom to a verified root cause.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Engineering Debugging

Reproduce the failure, collect the smallest relevant evidence, identify the failing boundary, and test the proposed root cause before changing code. Prefer a narrow experiment over broad rewrites.

After a fix, rerun the original reproduction and the closest regression test. Separate unknown, unavailable, and fixed states in the final report.
