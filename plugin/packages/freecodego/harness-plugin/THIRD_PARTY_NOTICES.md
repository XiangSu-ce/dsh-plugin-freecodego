# Third-Party Notices

## Graphify

The optional code-graph runtime downloads the official `graphifyy` Python Wheel from Graphify-Labs at runtime. FreeCodeGo does not modify or redistribute Graphify source code. The pinned runtime is `graphifyy==0.9.52`, Wheel SHA-256 `5588ea9af433a8cf74ada89dfc0b981abf596a1327a1375fdaf661905562bf44`.

Graphify is licensed under Apache-2.0 and retains an MIT notice for historical portions. Runtime installation preserves the Wheel's included `LICENSE`, `LICENSE-MIT`, and `NOTICE` material. Source: <https://github.com/Graphify-Labs/graphify>.

## uv

The optional Graphify installer downloads a platform-specific official `uv` 0.12.7 release archive from Astral after SHA-256 verification. The executable is used only from the FreeCodeGo private runtime directory and is never added to the system `PATH`.

uv is distributed by Astral under Apache-2.0 OR MIT. Source: <https://github.com/astral-sh/uv>.

## CodeGraph

The optional CodeGraph code-graph runtime downloads the official self-contained platform bundle for this OS/CPU at runtime. The bundle carries its own Node.js runtime, so this engine needs no Python and no `uv`; FreeCodeGo does not modify or redistribute CodeGraph source code. The pinned runtime is `codegraph` 1.6.0, and each platform archive is verified against the SHA-256 published with its GitHub Release before it is unpacked. The bundled Node.js runtime is distributed under the Node.js license (MIT).

CodeGraph is licensed under MIT. Runtime installation preserves the license and package metadata included in the bundle. Source: <https://github.com/colbymchenry/codegraph>.

## Matt Pocock's Skills

This package vendors 21 Skill directories from [mattpocock/skills](https://github.com/mattpocock/skills) at commit `3cca18b368ae95cdbdebbff572ccafa662551015`: `ask-matt`, `code-review`, `codebase-design`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `improve-codebase-architecture`, `prototype`, `resolving-merge-conflicts`, `setup-matt-pocock-skills`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `wizard`, and `writing-for-agents`. Four upstream Skills are deliberately not vendored because they duplicate the bundled `engineering-tdd`, `engineering-debug`, and `research` Skills, or (`teach`) sit outside the engineering scope.

Sixteen of those directories ship under `assets/engineering/skills`; the five the default-on starter pack mounts (`grill-me`, `grilling`, `handoff`, `to-questionnaire`, `wait-what`) ship under `assets/engineering/skills-starter`. The pack therefore spans two asset roots — re-vendoring has to touch both, and neither root on its own holds the whole pack.

Local adaptations, all listed here so a future upstream sync can be diffed:

- `ask-matt` and `implement` repoint the Skill references named above.
- `grilling`'s round template prefixed each question with `❓` and each recommended answer with `➡️`. Bundled Skill text is rendered in the Skills page, copied into user workspaces, and read as prompt text, so emoji presentation is not something this product controls: on the terminals it runs in, `❓` arrives at double width or as a box. The question glyph is **dropped** — `**Q1** -` already labels the question — and the answer marker becomes `→`, a text-presentation arrow. `tests/engineering.spec.ts` sweeps every bundled asset for `\p{Emoji_Presentation}` so a future sync cannot quietly put them back.

Every other vendored file is byte-for-byte upstream.

Copyright (c) 2026 Matt Pocock. Licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Source: <https://github.com/mattpocock/skills>.

## Superpowers

`assets/engineering/skills-superpowers` vendors 8 Skill directories from [obra/superpowers](https://github.com/obra/superpowers) at commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`: `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `subagent-driven-development`, `using-git-worktrees`, and `writing-plans`. Six upstream Skills are deliberately not vendored: `test-driven-development`, `systematic-debugging`, `requesting-code-review`, and `verification-before-completion` duplicate Skills this package already ships, `writing-skills` duplicates the bundled `skill-creator`, and `using-superpowers` is the upstream bootstrap rule that FreeCodeGo replaces with its own session-start capability map.

Local adaptations, all listed here so a future upstream sync can be diffed:

- Skill-name references were repointed from upstream's `superpowers:<name>` form to the bare `/name` form the rest of this pack uses.
- `brainstorming`'s optional browser-based visual companion (`scripts/`, `visual-companion.md`) is **not** vendored: it starts a local Node server and its page loads a logo with telemetry from the upstream author's site. What remains is the classification discipline, applied text-only.
- `subagent-driven-development` keeps upstream's three git-only helper scripts (`scripts/sdd-workspace`, `scripts/task-brief`, `scripts/review-package`), normalized from CRLF to LF so they run as scripts. They write to git-ignored scratch inside the user's repository and touch nothing else.
- `subagent-driven-development`'s final-review reference points at the verbatim `final-reviewer-prompt.md` (copied from upstream's `requesting-code-review/code-reviewer.md`) instead of a Skill this package does not ship.
- `subagent-driven-development`'s body was split: its two process digraphs, the workspace/ledger mechanics and pre-flight scan, the model-selection detail, the dispatch/review-prompt rules, and the worked example moved into `process-diagrams.md`, `setup-and-ledger.md`, `model-selection.md`, `dispatch-and-review-rules.md`, and `example-workflow.md`, each linked from the body where it is used. The reason is the rule this package enforces on every published Skill: a body is loaded into the model's context whenever the Skill is selected, and this one was 1.6× the publish budget (`tests/skills-body-budget.spec.ts` carried it as a recorded exemption until now). The edit is a move, not a rewrite of the procedure — the loop, the rulings discipline, the breaker, and the rationalization table stay in the body, and no rule exists only in the diff. Prose was condensed where the companion now carries the elaboration, and the body dropped from 32.2 KB to 18.9 KB (4,666 priced tokens against a 5,000 limit), which is what let the exemption be deleted.
- One sentence describing workspace cleanup was reworded to avoid a recursive-delete command literal, which the bundled asset audit treats as a blocking finding.
- Verdict markers were spelled out: `✅`/`❌`/`⚠️` became `PASS`/`FAIL`/`UNVERIFIABLE` (and `❌ WRONG:`/`✅ RIGHT:` became `WRONG:`/`RIGHT:`) in `receiving-code-review`, `dispatching-parallel-agents`, `subagent-driven-development`, and that Skill's `task-reviewer-prompt.md`. The summary verdict is the one line a reader acts on, and an emoji-presentation glyph is exactly the character a terminal may draw as a box or at double width; the reviewer template now defines the vocabulary in the same edit, so the Skill and its template still agree. `tests/engineering.spec.ts` fails if any bundled asset ships one again.

Copyright (c) 2025-2026 Jesse Vincent and the Superpowers contributors. Licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Source: <https://github.com/obra/superpowers>.

## Prompt Engineering Guide

The Chinese technique reference in `assets/engineering/skills-starter/prompt-techniques` is derived from the Chinese edition of [dair-ai/Prompt-Engineering-Guide](https://github.com/dair-ai/Prompt-Engineering-Guide). It is a restatement and condensation — the technique list, each technique's trade-off, and the warnings about over-claiming come from that guide, while the wording, the tables, and the agent-specific closing section are written for this plugin. No page is copied verbatim.

Copyright (c) 2022 DAIR.AI. Licensed under the MIT License (same terms as reproduced above).

Source: <https://github.com/dair-ai/Prompt-Engineering-Guide>.

## UI/UX Pro Max catalogue

`assets/uiux/data` vendors 34 CSV data tables (12 core tables: 11 routed domains plus auxiliary reasoning profiles, and 22 stack-guideline tables) from [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill). The package carries the data's own MIT `LICENSE` at `assets/uiux/LICENSE`; see `assets/uiux/PROVENANCE.md` for snapshot commits, exact-byte hashes, the reviewed exclusions, and the mixed-source Three.js correction. The TypeScript search, CSV reader, and generation resolver are local ports, not upstream code. The Google Fonts and full upstream Phosphor dictionaries, platform wrappers, Python scripts, and file-writing design-system generator are not included.

Copyright (c) 2024 Next Level Builder. Licensed under the MIT License (same terms as reproduced above).

Source: <https://github.com/nextlevelbuilder/ui-ux-pro-max-skill>.

## HyperFrames Design Skills

`assets/design/skills` vendors 17 Skill directories from [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes). Copyright (c) 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0.

### Which upstream state this came from

Upstream publishes no `version` field for the monorepo, and this pack was vendored from a source archive rather than a checkout, so **there is no commit to cite**. The citable fact is a digest of the upstream `skills/` tree:

```
sha256:09651c031cbcb886e5927f39acbc617921095abfbbc1537240abb97d6775b80c
913 files, 16385760 bytes
```

`scripts/vendor-design-skills.mjs` recomputes and prints this on every run, so a future sync knows immediately whether anything upstream moved. The digest covers **every** upstream file including the four Skills this package does not ship: it identifies the source state, not this package's selection from it.

### What is not vendored, and why

Four of the 21 upstream Skills are excluded, each for its own reason:

- `hyperframes-registry` — a client for a hosted registry (`hyperframes add <block>`, `hyperframes catalog`). This plugin is offline and deterministic, so the Skill would point the model at a service it cannot reach.
- `hyperframes-cli` — documents the command line this pack replaces with in-process tools; there is nothing left for it to describe.
- `media-use` — needs third-party credentials (TTS, transcription, background removal).
- `figma` — needs a Figma MCP server.

Two further classes of file are dropped wholesale across the Skills that **are** vendored:

- **Binary assets** (142 files): 57 `woff2` fonts, 66 `png` textures, 19 `mp3` effects. Fonts and audio carry **their own licences** and cannot be folded into this file the way Apache-2.0 text can. `embedded-captions/modes/standard/fonts/fonts.css` is the sharpest case — 1.1 MB of `@font-face` rules with 45 base64 payloads inlined, which is a font binary wearing a `.css` extension.
- **Executable scripts** (157 files). They are what this package's own `dangerousCommandFindings` audit exists to catch, and the pack no longer shells out at all, so nothing would invoke them.

### Prose around the removed capabilities

Stripping an invocation leaves the sentence around it unusable, so the **sentence** is replaced, not the fragment: 53 sentences became one of ten verb-level sentences (`add` 17, `catalog` 16, `auth` 5, `init` 4, `timeline` 4, `capture` 3, and `upgrade` / `publish` / `remove-background` / `feedback` one each). Each replacement is written to be true and useful on its own — it names the local substitute that exists, or states plainly that nothing does — because it takes the place of a step the reader was about to follow. `needs-review` reports **0**.

One residual is recorded rather than fixed: prose that names a verb as a **word** (`Do not rerun `lint`, `check`, or `snapshot` after rendering`) still uses those names. The rules match invocations, not vocabulary, and a pass that rewrote every mention of "lint" in these documents would be over-reach. A reader following that sentence now looks for a step that no longer exists under that name.

### Nested third-party licence retained in tree

`talking-head-recut` is **adapted from** [notedit/vtake-skills](https://github.com/notedit/vtake-skills) (`vtake-cut`), MIT licensed, Copyright (c) 2026 leeoxiang. Upstream's own `NOTICE.md` for that Skill carries the required MIT text and **is vendored verbatim** at `assets/design/skills/talking-head-recut/NOTICE.md`. That file, not this section, is the notice that satisfies the licence; it is listed here so an auditor reading only this file knows it exists.

### Local adaptations, all listed so a future upstream sync can be diffed

**The vendored text is not byte-for-byte upstream.** These edits are applied by `scripts/vendor-design-skills.mjs` as rules, so they can be replayed rather than remembered. The same convention is used for the Matt Pocock and Superpowers packs above.

- **Emoji are removed.** `tests/engineering.spec.ts` refuses `\p{Emoji_Presentation}` in any bundled asset, because a terminal may draw such a glyph at double width or as a box. Verdict glyphs keep their meaning as words (`PASS` / `FAIL` / `UNVERIFIABLE`), matching the substitution already recorded for Superpowers; every other glyph is dropped, and where one sat between two words a single space takes its place. **Only the whitespace immediately around a removed glyph is collapsed** — an earlier revision of the script reflowed whitespace globally, which silently rewrote indented examples and ASCII diagrams and made the 64 KiB body audit pass for a reason nobody had chosen.
- **Command invocations are replaced with tool names.** Upstream Skills instruct the model to shell out. This plugin provides in-process tools instead, and the Skills now name those: `render` / `preview` / `lint` / `validate` / `check` → the corresponding `freecodego_design_*` tool; `doctor` → the Design settings page self-check; `snapshot` and `keyframes` → their own tools (both are capabilities this plugin implements); `play` and `present` → the preview tool, which is what they already were; `skills update` → a statement that the pack is bundled offline. Trailing command-line flags **and quoted arguments** are consumed with the verb, because an in-process tool takes named arguments and a leftover `--quality high` — or the quoted project path upstream writes first, `"$PROJECT_DIR"` — would name a tool and then hand it an argument its schema rejects. A **bare positional word is deliberately left alone** (`render public`, `snapshot public --at 5`), because the rule that would consume those also consumes ordinary prose; those sites are the hand-rewrite track tallied in `DESIGN-ENGINE-PLAN.md`, and they stay visible in a diff rather than half-fixed. The replacement text carries no backticks of its own: upstream writes these calls inside code spans, and a replacement that supplied its own would nest inside the existing one.
- **Two sentences that describe what the replaced command does are corrected.** An invocation rewrite is mechanical and the prose around it is not: these sentences do not merely name a command, they explain its mechanism, and the mechanism is upstream's rather than ours. Upstream's `preview` occupies the shell — it prints a URL and stays attached — while this plugin's `preview` tool returns as soon as its listener is up. So `pr-to-video/SKILL.md`'s stop step (which also carried the now-defunct `--stop` flag and a background server) reads "stop only this preview by calling `freecodego_design_preview` again with `stop: true`", and `hyperframes-creative/references/design-picker.md`'s warning no longer says the preview blocks — the prohibition stays, with the reason this step actually has (it wants a plain static server it can verify with curl and kill by pid) and the correction stated ("It never blocks"). Each correction is a rule in `scripts/vendor-design-skills.mjs` (`CLAIM_REPAIRS`), keyed by the sentence rather than by the file, and a sentence that has moved upstream is reported as an unmatched claim instead of being silently skipped.
- **Invocations of capabilities this plugin does not provide are removed.** `add`, `catalog`, `init`, `auth`, `capture`, `timeline`, `publish`, `feedback`, `transcribe`, `normalize-audio`, `remove-background`, `upgrade`, `skills check` and `--help` have no counterpart here. A line that was only such an invocation is deleted; an invocation inside a sentence is replaced by `a capability this plugin does not provide` and flagged for review, since the surrounding paragraph usually explains a workflow that no longer exists.
- **One body was split.** `talking-head-recut/SKILL.md` exceeded the 64 KiB limit `inspectSkillRoot()` enforces (65,847 bytes). Its `Confirm Visual Direction with User` section moved to `references/confirm-visual-direction-with-user-do-this-first.md` (12,556 bytes) and is linked from the body where it was used, dropping the body to 53,370 bytes. The rule is general rather than a file list: any body over budget gives up its widest `####` section, repeatedly, until it fits.

Every other vendored file is otherwise upstream, aside from the invocation, claim and glyph substitutions above.

## Impeccable design detector

The `freecodego_design_detect` tool reads the rule catalogue published by [pbakaus/impeccable](https://github.com/pbakaus/impeccable), and delegates a scan to the user's own installed Impeccable engine when this machine already has one. Impeccable is licensed under Apache-2.0.

**No upstream file is vendored into this package.** The rule ids, names and categories in `src/impeccable/rules.ts` are the catalogue metadata read from upstream's `crates/live/assets/antipatterns.json` — the subset a source file can decide without a rendered page, listed there as `IMPECCABLE_BUILTIN_RULES` so the count in the design page's own card is derived rather than typed. Every matcher, message, report and refusal in this package is local code, written here, and is not a port of upstream's Rust implementation. Findings carry upstream's rule ids so that the same wording applies in this package's output as in upstream's documentation.

The tool never downloads or installs anything: it looks for an engine on `IMPECCABLE_ENGINE`, `$PATH`, or `~/.impeccable/bin`, and answers from the built-in subset when there is none.

Upstream's guidance Skill (24 command playbooks and roughly forty reference documents, version 4.4.0) is **not** vendored. `scripts/vendor-impeccable.mjs` is the pass that would bring it in — dropped launcher tree, rewritten invocations, emoji stripped, bodies split to the 64 KiB audit limit — and it writes nothing until it is run with `--write` against a checkout of upstream. When it runs, the files it writes and `assets/design/impeccable/PROVENANCE.md` become the notice that section is about; until then there is nothing here to attribute beyond the catalogue metadata above.

Source: <https://github.com/pbakaus/impeccable>.

## React Bits components

The `freecodego_reactbits` tool reads the component registry published by [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) — its index at `https://reactbits.dev/r/registry.json` and one component's `registry-item.json` — and returns a variant's source, or writes it into the user's own project, at the user's explicit direction. React Bits is licensed under MIT **with the Commons Clause**, which permits using the components — including in commercial work — and forbids selling, sublicensing or redistributing the components themselves, whether alone, in a bundle, or as a ported version.

**No upstream file is vendored into this package, and none is ever written inside it.** The tool fetches on demand, holds the index in memory for at most one session, and returns source rather than storing it: a copy inside this package's assets would be the redistribution the licence forbids, and a cache file would be that same copy under a different name. Its `apply` action writes only into a directory inside the user's session working directory, only on an explicit `confirm: true`, and only the files upstream publishes — altered in exactly two mechanical ways, each recorded per file in the result: a leading `'use client'` where the target framework needs one, and a `prefers-reduced-motion` block appended to a stylesheet that animates without honouring the system setting (written as a duration rather than as a removal, so an entrance animation still reaches its end state). `src/reactbits/` is local code written here — the registry reader, the import scanner, the integration review, the write planner and the tool definition — and no component is ported, renamed or otherwise re-spelled anywhere in this repository.

The guidance Skill in `assets/design/react-bits/SKILL.md` is written here as well. It states the licence boundary, the identifier and variant grammar, the integration contract and the motion quality bar, and quotes none of upstream's text.

Source: <https://github.com/DavidHDev/react-bits>. Licence: <https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md>.

## Taste-Skill design direction Skills

The Skills under `assets/design/taste/` are vendored third-party prose from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill): thirteen `SKILL.md` bodies plus one companion document, nineteen files and about 308 KB, covering brief inference and design direction, four style languages, redesign of an existing project, `DESIGN.md` generation for Google Stitch, image-reference generation, image-to-code, and one output-discipline skill. Taste-Skill is licensed under MIT, Copyright (c) 2026 Leonxlnx. The vendored text is **not** covered by this package's AGPL-3.0-only licence; `assets/design/taste/LICENSE` carries the upstream MIT terms, and `assets/design/taste/PROVENANCE.md` records the snapshot commit (`ce26fc25c0e5e8cab638f883de62d9a86ee5e45b`, 2026-09-26), the per-file SHA-256 of the bytes shipped, and every adaptation below.

**These are the only third-party Skill bodies this package ships without trimming.** Every other vendored pack was held to the 64 KiB body audit and, where a body exceeded it, split. The taste pack is the one place where the bodies deliberately keep their upstream length, because a body here is paid for only when its Skill is selected: the pack's 72,540 tokens cost nothing to a session that never reaches for one, and a session that does pays for a single body rather than for the pack. The 5,000-token budget this package enforces on Skills it *publishes* is therefore not applied, and the sizes are stated on the design page's own card and per file in `PROVENANCE.md` so the trade is visible rather than assumed.

### Local adaptations, applied by `scripts/vendor-taste-skills.mjs`

- **One body was split, not shortened.** `taste-skill/SKILL.md` is 87,253 bytes upstream, over the 64 KiB limit `inspectSkillRoot()` reports. Five sections moved into that Skill's own `references/` directory and are linked from the body where they stood: `9.F Production-Test Tells (banned outright)` (8,107 bytes), `4.7 Layout Discipline (Hard Rules. Failing any of these is shipping broken work)` (6,124 bytes), `4.8 Image & Visual Asset Strategy` (3,862 bytes), `4.9 Content Density` (3,507 bytes) and `4.2 Color Calibration` (3,060 bytes), dropping the body to 62.1 KB. The rule is general rather than a file list — the widest section is moved, repeatedly, until the body fits — which is the same rule recorded for the HyperFrames pack above. No sentence was cut, and each move is listed in `PROVENANCE.md` with the file it went to.
- **The emoji rule applied and found nothing.** The pass strips `\p{Emoji_Presentation}` glyphs with the substitution vocabulary the other packs use, and reported zero substitutions for this pack, so these bodies are byte-for-byte upstream apart from the one split.
- **No invocation was rewritten, and the reason is not an omission.** Upstream's commands here are ordinary project tooling — `npx shadcn@latest add …`, `npm i gsap`, a package manager chosen by the project — which the model runs through the harness's own shell rather than through a vendored CLI. The pass still scans for invocations of programs this plugin does not provide (`skill.sh`, the Claude plugin and marketplace commands, `~/.claude/` paths) and found none; a future upstream revision that reaches for one is reported as a finding instead of shipping.

Source: <https://github.com/Leonxlnx/taste-skill>.

## OpenDesign craft references

The Markdown under `assets/design/craft/` is vendored third-party prose from [nexu-io/open-design](https://github.com/nexu-io/open-design): eleven craft sections plus that layer's own `README.md` and its forward-reference register, thirteen files and about 108 KB. It is the layer upstream writes *on top of* a design system — typography and hierarchy, colour discipline, animation discipline, accessibility baseline, form validation, the laws of UX, RTL and bidirectional text, state coverage, anti-AI-slop — which is why it is referenced by 22 of upstream's 163 Skills and 151 of its 152 design-system manifests while being one thousandth the size of the brand catalog it ships beside. The vendored text is **not** covered by this package's AGPL-3.0-only licence; `assets/design/craft/LICENSE` carries the upstream Apache-2.0 terms, and `assets/design/craft/PROVENANCE.md` records the upstream version (0.23.1), the per-file SHA-256 of the bytes shipped, and every adaptation below.

Upstream ships **no `NOTICE` file**, so Apache-2.0 §4(d) has nothing to propagate; the attribution this package owes is the licence text, the change record below, and this section. Two sections carry a second, nested attribution in their own prose and keep it here: `color.md` and `anti-ai-slop.md` are adapted by upstream from [`refero_skill`](https://github.com/referodesign/refero_skill) (MIT), which the vendored files continue to state at the point they rely on it.

### Local adaptations, applied by `scripts/vendor-craft.mjs`

- **Six glyphs are named rather than drawn — the only change to any file.** `anti-ai-slop.md` forbids emoji as feature icons and therefore has to write six of them down; those ship as their code point and Unicode name (`U+2728 SPARKLES`, `U+1F680 ROCKET`, `U+1F3AF DIRECT HIT`, `U+26A1 HIGH VOLTAGE`, `U+1F525 FIRE`, `U+1F4A1 LIGHT BULB`), which keeps the rule able to say which glyphs it means while no emoji-presentation glyph ships. Any *other* such glyph is a blocking finding in the pass rather than a silent deletion: this package has no word table for it, and inventing one is how a vendored body starts drifting from what this notice attributes. The pass reported exactly these six, so the other twelve files are byte-for-byte upstream.
- **The forward-reference register is honoured, not copied.** `FUTURE_SECTIONS.md` is upstream's list of slugs it references before they ship (`motion-discipline`, `pixel-discipline`, `typographic-rhythm` at this snapshot). The tool reads that file rather than a transcription of it, which is what lets it tell a *planned* slug from a typo; the pass refuses to write when a registered slug has a file, so the register and the tree cannot drift apart in either direction.

### What was deliberately not vendored

The rest of upstream is a product, not a library: 152 design-system packages (40 MB), 114 artifact templates (39 MB), a 71 MB plugin ecosystem, an Electron desktop app and a daemon. None of it is copied here. The craft layer was taken because it is the one part whose size is negligible and whose content is brand-agnostic — and because the catalog's own manifests declare they need it.

Source: <https://github.com/nexu-io/open-design>.
