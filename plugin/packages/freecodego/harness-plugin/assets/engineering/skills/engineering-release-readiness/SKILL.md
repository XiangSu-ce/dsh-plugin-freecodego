---
name: engineering-release-readiness
description: Verify package artifacts, versioning, compatibility, rollback, permissions, and platform coverage before releasing a plugin or runtime.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Release Readiness

Verify the packaged artifact rather than only source output. Check version metadata, checksums, licenses, upgrades, rollback, desktop and web loading, platform compatibility, permissions, and offline behavior.

Do not release an artifact that has not passed its target operating-system and architecture smoke tests. Report unsupported platform combinations directly.
