---
description: "The FreeCodeGo browser surface: the settings section, provider and account cards, MCP and Skills switches, plugin conflict protection, the agent companion in the rail and above the composer, and the embedded community page."
kind: "package-reference"
---

# FreeCodeGo Harness UI

English | [中文](README.zh.md)

## Summary

The FreeCodeGo settings section reports engine generations, persisted default engine state, backend availability, and local third-party provider routes, reading the provider summary from the standard `llm.providers` Host API. Route creation and editing stay in the shared Models settings surface rather than a second editor, and the browser never receives stored key values: FreeCodeGo adds no parallel credential protocol. The page also exposes the WorkBuddy device-login flow and an Agnes AI card, and — when Engineering is enabled — a multi-engine team panel that keeps the selected root Agent unchanged while running isolated DeepSeek, Codex, and Claude child reviews.

## Table of Contents

- [Settings surface](#settings-surface)
- [MCP And Skills](#mcp-and-skills)
- [Plugin Conflict Protection](#plugin-conflict-protection)
- [Embedded Community Plugins](#embedded-community-plugins)
- [Companion in the rail and above the composer](#companion-in-the-sidebar-rail)
- [Dev Note](#dev-note)

-----

<a id="settings-surface"></a>
## Settings surface

The FreeCodeGo settings section reports engine generations, persisted default engine state, backend availability, and local third-party provider routes. The provider summary is read from the standard `llm.providers` Host API and is refreshed after every connection generation reset.

Route creation and editing intentionally remain in the shared Models settings surface (`@deepseek-ai/dsh-client-ui-settings-models`). That editor writes `llm-pi-ai` profiles through `settings.mutate` and API keys through `credentials.set`; the browser never receives stored key values. FreeCodeGo does not add a parallel credential protocol.

FreeCodeGo Cloud, billing, and payment controls are shown as `BACKEND_NOT_CONFIGURED` until a public backend contract is available.

The settings page also exposes the independent WorkBuddy device-login flow. It opens WorkBuddy's browser authorization URL, polls after the user confirms, and shows only UID, nickname, login state, and dynamic CLI model ids. Multiple accounts can be added and removed independently; tokens remain in the Host credential service and are never sent to the browser.

The same settings surface includes an Agnes AI card for verification-code registration, login, and automatic default API-key creation. Agnes credentials are stored by the Host credentials service; the browser never receives the session token or API key.

When Engineering is enabled, the page also exposes a multi-engine team panel. It keeps the selected root Agent unchanged while starting isolated DeepSeek, Codex, and Claude child reviews, and shows quorum, failures, consensus, and dissent for each bounded council task. A completed report presents explicit Approve implementation and Reject plan actions. Only approval reveals the post-implementation verification action and its persisted stage result.

-----

<a id="mcp-and-skills"></a>
## MCP And Skills

The `设置` page owns the MCP and Skill switches. A switch registers the matching `MCP` or `Skills` settings-sidebar entry, so inactive capabilities do not add dormant navigation. The MCP page shows connection state, discovered tools, enablement, editing, and quick templates; the Skills page separates configured roots from the discovered catalog. Configuration is sent only through FreeCodeGo Host remotes and is applied to new DeepSeek, Claude, and Codex sessions from one shared inventory.

-----

<a id="plugin-conflict-protection"></a>
## Plugin Conflict Protection

The `设置` page exposes the default-on Plugin Conflict Protection switch and the five newest automatic repairs. It explains that a repair retains the earlier active plugin and disables the later conflicting entry before it starts. A frame-wide modal names the retained plugin, disabled plugin, and duplicate resource when a new repair is observed.

-----

<a id="embedded-community-plugins"></a>
## Embedded Community Plugins

The FreeCodeGo settings page includes a curated community-plugin page. It consumes the local `dsh-market` Host routes (`/dsh-market/registry`, `/dsh-market/install`, `/dsh-market/status`, and `/dsh-market/restart`) instead of implementing a second package installer. Deployments should compose a recent `dshmarket` bundle with the `embedded` client behavior; the market's full navigation is suppressed and its verified install engine remains available to the FreeCodeGo page.

Community includes `插件` / `MCP` / `Skills` filters. MCP pages read the paginated MCP.so directory and live category counts; Skills pages read the paginated skills.sh directory. Both retain Host-owned search and installation, so browser code receives directory metadata but never runs marketplace installation commands.

The fixed `已安装插件` entry beside the Community filters opens a list of installed community plugins. Cards show their activation state and replace the install action with `卸载`. The Host receives that request, so it can deactivate the running Loader entry and update the profile package manifest; browser code does not run `pnpm` or mutate profile files.

-----

<a id="companion-in-the-sidebar-rail"></a>
## Companion in the rail and above the composer

The selected session's own activity is shown as a character, in two seats that always agree. The rail mark registers into the upstream `sidebar.brand.mark` slot one rank below the default occupant, so the official mark and every surrounding control — the collapse button, the brand row's New Session target — stay upstream's. The strip above the composer docks into `conversation.input.dock` as a fourth entry after upstream's todo, goal, and queue strips, and takes its width from there: it measures its own full-width element, so a wider panel draws a larger character rather than the same small one. Both seats share one clock, one ladder, and one engine per mount, so they cannot disagree about what the agent is doing.

The character shows what the session is doing — resting, thinking, working, waiting for an answer, failed, done, streaming, asleep — and every pose carries its own label from the `freecodego.companion` locale namespace, so a shape is never the only thing saying what is happening. The strip holds one lane height for the whole session and stays mounted, so nothing it shows can move the composer or the transcript above it; the two quiet poses draw dimmed rather than leaving. Each pose serves the dwell its own animation measured, so a burst of tool calls cannot strobe the picture, and `prefers-reduced-motion` freezes to a single frame rather than animating faster.

The character is a vendored MIT engine sampled as a pure function of time; its origin, hashes, and license are recorded in [`src/client/companion/engine/PROVENANCE.md`](src/client/companion/engine/PROVENANCE.md).

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the browser surface has no independently observable Host relationship beyond its client integration tests.

Every capability above reaches the Host through a FreeCodeGo remote rather than a private channel; a page that needs a new operation adds a remote instead of a second transport.

</details>

**Runtime invariant:** the browser holds no credential value and mutates no profile file.
