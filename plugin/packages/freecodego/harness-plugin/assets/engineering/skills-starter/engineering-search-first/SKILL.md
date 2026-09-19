---
name: engineering-search-first
description: Choose the smallest reliable navigation capability before reading broad source trees or making code claims.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Search First

For current architecture, dependency, call-path, and blast-radius questions, query the engineering code graph first when it is available. For previous decisions, fixes, and handoffs, use project long-term memory search. Use text search for exact strings and error messages. Use LSP for exact definitions, references, implementations, and hover details.

Read the source files that support a conclusion. Graph and memory results are navigation evidence, not a replacement for current source or tests.
