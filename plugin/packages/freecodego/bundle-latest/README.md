---
description: "The installable single-package FreeCodeGo composition for DeepSeek Harness: install channel, release tagging, and the bundled Agent Teams composition."
kind: "package-bundle"
---

# FreeCodeGo Harness Bundle

English | [中文](README.zh.md)

## Summary

Installable single-package FreeCodeGo composition for DeepSeek Harness `freecodego@0.1.6-alpha.2`, targeting Harness baseline `0.1.6-alpha.2`. The npm artifact contains the compiled Host plugin, browser client, session-event prerequisite, native worker entrypoints, and the bundled Harness Agent Teams composition. A release publishes on npm's `next` dist-tag, and its plugin version intentionally matches the Harness version it targets exactly; for a reproducible install, name the version (`freecodego@0.1.6-alpha.2`) instead of the channel. Official Codex and Claude runtime binaries remain optional platform downloads — the package does not embed every platform's native binary.

## Table of Contents

- [Install](#install)
- [Agent Teams](#agent-teams)
- [Dev Note](#dev-note)

-----

<a id="install"></a>
## Install

Install the current prerelease channel with `@next`; the CLI matches it to the active Harness baseline:

```sh
dsh plugin --profile web add --save-exact freecodego@next
```

The `dsh` command is provided by the Harness CLI, not this bundle. In a normal terminal install it first with `npm install --global @deepseek-ai/dsh` (and ensure `pnpm` is available). Desktop launches the same command through its private shims and passes the active `DSH_HOME`, so Web and Desktop use one Profile data directory when they select the same Harness home.

Maintainers release from a tag. `pnpm run release:freecodego <version>` bumps the bundle and creates the `freecodego-v<version>` tag, and the workflow is dispatched from that tag:

```sh
pnpm run release:freecodego <version>
gh workflow run release-freecodego.yml --ref freecodego-v<version>
```

The workflow verifies the family, builds, packs, and publishes with npm provenance under the `next` dist-tag. The family publishes only from a `freecodego-v*` tag that names the version the workspace carries, so a dispatch from a branch fails before the build rather than after it.

-----

<a id="agent-teams"></a>
## Agent Teams

The bundle enables Harness Agent Teams with same-engine child sessions. A DeepSeek parent creates DeepSeek teammates, a Codex parent creates Codex teammates, and a Claude parent creates Claude teammates; the child route is inherited from the parent session rather than selected from the process default. Team roster, mailbox, task-board, and teammate Session records remain owned by Harness. The Web Chat renders the live delegated-Agent progress tree inside the parent conversation, including each task label, current tool, status, and tool-use count.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the bundle is static composition metadata with no runtime registry relationship of its own.

The plugin version tracking the Harness version exactly is deliberate: a bundle assembled against one baseline composes the rows of that baseline, so an independent version number would only invite installing a pair that no build ever tested.

</details>

**Runtime invariant:** the bundle declares its composition as data (`dsh.bundle.patch`); it owns no runtime state.
