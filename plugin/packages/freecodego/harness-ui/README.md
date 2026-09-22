---
description: "The FreeCodeGo browser surface: the settings section, provider and account cards, MCP and Skills switches, plugin conflict protection, the agent companion in the rail, above the composer, and in the running turn's status row, and the embedded community page."
kind: "package-reference"
---

# FreeCodeGo Harness UI

English | [中文](README.zh.md)

## Summary

The FreeCodeGo settings section reports engine generations, persisted default engine state, backend availability, and local third-party provider routes, reading the provider summary from the standard `llm.providers` Host API. Route creation and editing stay in the shared Models settings surface rather than a second editor, and the browser never receives stored key values: FreeCodeGo adds no parallel credential protocol. The page also exposes the WorkBuddy device-login flow and an Agnes AI card, and — when Engineering is enabled — a multi-engine team panel that keeps the selected root Agent unchanged while running isolated DeepSeek, Codex, and Claude child reviews.

## Table of Contents

- [Settings surface](#settings-surface)
- [Model menu and provider cards](#model-menu-and-provider-cards)
- [Code review panel](#code-review-panel)
- [Usage, media, and session overlays](#usage-media-and-session-overlays)
- [MCP And Skills](#mcp-and-skills)
- [Plugin Conflict Protection](#plugin-conflict-protection)
- [Embedded Community Plugins](#embedded-community-plugins)
- [Companion in the rail, above the composer, and in the transcript](#companion-in-the-sidebar-rail)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="settings-surface"></a>
## Settings surface

The FreeCodeGo settings section reports engine generations, persisted default engine state, backend availability, and local third-party provider routes. The provider summary is read from the standard `llm.providers` Host API and is refreshed after every connection generation reset.

Route creation and editing intentionally remain in the shared Models settings surface (`@deepseek-ai/dsh-client-ui-settings-models`). That editor writes `llm-pi-ai` profiles through `settings.mutate` and API keys through `credentials.set`; the browser never receives stored key values. FreeCodeGo does not add a parallel credential protocol.

FreeCodeGo Cloud controls are shown as `BACKEND_NOT_CONFIGURED` until a public backend contract is available.

The settings page also exposes the independent WorkBuddy device-login flow. It opens WorkBuddy's browser authorization URL, polls after the user confirms, and shows only UID, nickname, login state, and dynamic CLI model ids. Multiple accounts can be added and removed independently; tokens remain in the Host credential service and are never sent to the browser.

The same settings surface includes an Agnes AI card for verification-code registration, login, and automatic default API-key creation. Agnes credentials are stored by the Host credentials service; the browser never receives the session token or API key.

When Engineering is enabled, the page also exposes a multi-engine team panel. It keeps the selected root Agent unchanged while starting isolated DeepSeek, Codex, and Claude child reviews, and shows quorum, failures, consensus, and dissent for each bounded council task. A completed report presents explicit Approve implementation and Reject plan actions. Only approval reveals the post-implementation verification action and its persisted stage result.

-----

<a id="model-menu-and-provider-cards"></a>
## Model menu and provider cards

The chat model list is the stock Harness menu, and the Host registers every adapter it can serve. Four client pieces shape it without replacing it:

- **What the picker shows** is decided on the Accounts-and-providers page, per provider or per model. Storage is negative (visible unless recorded hidden) with two declared exceptions — a metered provider's priced rows and a curated provider's unnamed rows default to hidden — so nothing changes for a user who never opens the controls, while a newly added priced model does not arrive switched on. The decorator reads the store before rendering a provider section or a row, so a decision reaches a menu that is already open beside it.
- **Rows are labelled, not rebuilt.** `native-model-menu-badges` appends non-interactive source, price-class, and health labels to rows that expose the stable ARIA menu contract; the official selector keeps ownership of selection, focus, scrolling, and reasoning effort.
- **The picker label echoes the Session selection.** `model-selection-echo` checks the *result* the directory publishes rather than only watching for a throw, because a refused `selectModel` resolves with the Remote failure — a wrapper that treated it as applied would clear the reason it had just written.
- **A reconnect does not empty the menu.** `model-catalog-retry` recognises transport failures and reloads on a 1 minute / 10 minute / 30 minute backoff without clearing the last good directory.

Each provider gets one card (`provider-card.tsx`) rather than a hand-built section: identity and status, a cloud of the models the provider offers right now, then whatever controls the caller supplies. The four providers used to drift into four layouts and, in two cases, a hand-typed roster that contradicted the live directory.

-----

<a id="code-review-panel"></a>
## Code review panel

The `设置` page carries the code review panel (`ReviewPanel`): the mode (`off` / `record` / `gate`), the severity threshold, the cooldown in turns, deep review, and escalation, plus a start button for an on-demand run. The remote is fire-and-forget — a run spends model calls per file and can take minutes — so the panel starts the run and then polls the same remote for status, showing queued runs and the report with its coverage arithmetic. Every review remote takes the session id and resolves the working directory from it, so the panel cannot ask about a checkout the session never opened.

-----

<a id="usage-media-and-session-overlays"></a>
## Usage, media, and session overlays

- **Token usage dashboard** — the local ledger and its redacted usage view, rendered with the shared stacked-bar visuals.
- **Generated media** — image, video, and audio tool calls get a dedicated tool view, and the media defaults the tools read live in this settings surface.
- **Voice input** — a composer control that transcribes through the Groq Whisper route (`voiceInputEnabled`).
- **Plan review** — the current plan is read back with line numbers, line-level remarks are collected, and they are composed into one rework message (the line numbers match the Host's own print, so a remark cannot land on another line).
- **Session deletion** — clears a stale sidebar row idempotently when the log is already gone, while a live session must be closed first.
- **Guard, sandbox, and trust** — the guard switches the Host mirrors for the UI (the credential-path and environment-read guard, the native-engine doom-loop guard, LSP auto-mount, post-compaction rehydration), the session's sandbox mode with the mode actually in force read back, and the folder-trust grant/revoke controls beside the project-config report they gate.
- **Automation** — the declarative failure-recovery chains with their depth guard and cooldown, and the calendar planner's master switch.
- **Context switches** — Headroom compression and deferred tool schemas each own a panel with their live counters, so a switch that changes what the model sees is visible next to what it saves.
- **Community plugins and capability marketplace** — bounded, paginated metadata with one-click install only when the published detail is representable with no unresolved environment or header values; anything needing credentials stays in manual configuration. The shared README reader tries the conventional Chinese README names before the English one and reports which file it read, so an English fallback is labelled rather than passed off as localized.

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

The fixed `已安装插件` entry beside the Community filters opens a list of installed community plugins. Cards show their activation state and replace the install action with `卸载`. The Host receives that request, so it can deactivate the running Loader entry and hand the package operation to `dsh plugin`, which owns the profile manifest; browser code does not run `pnpm` or mutate profile files.

-----

<a id="companion-in-the-sidebar-rail"></a>
## Companion in the rail, above the composer, and in the transcript

The selected session's own activity is shown as a character, in three seats that always agree. The rail mark registers into the upstream `sidebar.brand.mark` slot one rank below the default occupant, so the official mark and every surrounding control — the collapse button, the brand row's New Session target — stay upstream's. The strip above the composer docks into `conversation.input.dock` as a fourth entry after upstream's todo, goal, and queue strips, and rides the conversation's own content axis the way those two do: centred on it, cut to the input card's width from the shared composer tokens, and padded back in by the side clearance so the mark lines up with the message text. It measures its own content box from there, so a wider conversation draws a larger character rather than the same small one. The dock a strip is registered in is full width, and a strip left at that width — as this one was — starts at the conversation column's outer edge, a hundred-odd pixels left of the card it describes, and sizes its character for a column the reader is not looking at. It draws nothing at all on the blank-session Hero — the new-conversation page has no turn to describe, and a status line about work nobody has asked for is the wrong first thing to show above an empty composer — and is seated by the first prompt, from the framework's own `session.blank` bit. The third seat is an injection rather than a registration: the running turn's own status row in the transcript is upstream's, with no slot on it, so the character takes the shipped row over — keeping the row's box, its place in the column, its role, its words for a screen reader, and its elapsed clock, and replacing only the shimmering loading animation with the pose the other two seats decided. The character is drawn in one place at a time: the mounted row claims it for as long as it exists, and the strip above the composer yields the drawing — keeping its lane and its words, so the handover moves nothing — for exactly that long. Two more seats are injections of the same kind, at the shell's other two loading animations. Inside a turn, upstream sweeps every row that is still working — one idiom it spells five times (the command, reasoning, and tool rows on a row element, the skill row's hand-rolled one, and the bash row on its own box) — so rather than list the spellings the seat asks which element in a running row paints an animated `::after`, switches that band off, and stands the character at the row's leading edge, 18px in a 24px row so it cannot grow the row it was inserted into. And where the shell's in-flight mark is its *ongoing dot* — an eight-cell pixel chase, 8px in the plugin manager's rows and 10px everywhere else — the character takes that dot's place instead: same slot, the dot's own classes carried over so the callsite's layout is untouched, the dot itself switched off rather than removed, because React still owns that node and removing it is what releases the character. That seat speaks only for the conversation: it takes the dot in the transcript, in the composer area, and in the session header's action row, and it leaves the dot a settings page draws for a package that is loading — the character is the agent's mark, and a fiber installing is not the agent working. One character per row and per mark, never two in the same place. All of them read the same facts from the same stores and run the same arbiter, so they cannot disagree about what the agent is doing.

The character shows what the session is doing — resting, starting, thinking, writing, running a tool, waiting for an answer, failed, done, a message from outside, stirring, asleep — and every pose carries its own label from the `freecodego.companion` locale namespace, so a shape is never the only thing saying what is happening. From that first prompt the strip holds one lane height for the rest of the session and stays mounted, so nothing it shows can move the composer or the transcript above it; the two quiet poses draw the resting circle on the same row rather than leaving, and every pose — the resting ones included — draws at full ink, so the character is as legible at rest as it is mid-turn. Each pose serves the dwell its own animation measured, so a burst of tool calls cannot strobe the picture, and `prefers-reduced-motion` freezes to a single frame rather than animating faster.

The *phases inside a turn* are read from the session's own event log, in [`src/client/companion/activity.ts`](src/client/companion/activity.ts): one live feed, created once per plugin and read by every seat, because the session list reports only that a turn is running and cannot separate a model thinking, a reply being written, and a tool executing — which is what the poses are for. A tool call in flight, a reply arriving, a turn starting, a turn that ended in failure, and a message injected from outside the turn (a cron notice, a file-change notice, a subagent result) each become a pose; the three that concern an instant are published as the durable identity of the event that carried them and turned into a bounded signal by the news window in [`src/client/companion/signals.ts`](src/client/companion/signals.ts), so a failure stays in the log without the pose outliving the news. Every one of them ranks above `thinking` — `thinking` is true beside every phase of a turn, so a rung below it is a rung a reader can never observe for the length of a turn. Work outranks the model's own phases, and a waiting human outranks everything.

A resting session is not a still one. Between the two quiet poses the character stirs through the rest of the engine's catalogue (`egg`, `wink`, `wide`, `hexagon`), one pose per quiet period and then back to rest, and powers down to `sleep` only once the session has been quiet long enough for that. A mark that never moved in the time a session waits for its next prompt reads as broken rather than as calm; the powered-down pose is the end of that stirring rather than a pose it competes with, which is why a session left alone stirs a few times and then sleeps. The period is short enough that the whole catalogue plays inside one stretch of quiet, so no pose in it is unreachable — and which pose is drawn is read from the shared clock rather than from a count kept in each seat, so the several seats stir at the same instant and draw the same pose, rather than each walking the catalogue from whenever it happened to mount. A seat's own quiet time only decides whether it has rested long enough to stir at all.

The character is a vendored MIT engine sampled as a pure function of time; its origin, hashes, and license are recorded in [`src/client/companion/engine/PROVENANCE.md`](src/client/companion/engine/PROVENANCE.md).

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser settings surface registers no tool, prompt section, or session event; the routes and credentials it displays are owned by Host services.

#### KV Cache effect

Browser-side rendering never enters a request, so it cannot change the cached prefix.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **The settings section reports, it does not own** — engine generations, persisted default state, and provider routes are read from the standard `llm.providers` Host API.
- **Route editing stays in the shared Models surface** — FreeCodeGo adds no second editor.
- **The browser never receives stored key values** — there is no parallel credential protocol.
- **The Engineering panel depends on the plugin's settings** — with Engineering off, the multi-engine team panel is absent rather than inert.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the browser surface has no independently observable Host relationship beyond its client integration tests.

Every capability above reaches the Host through a FreeCodeGo remote rather than a private channel; a page that needs a new operation adds a remote instead of a second transport.

</details>

**Runtime invariant:** the browser holds no credential value and mutates no profile file.
