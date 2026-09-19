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

`assets/engineering/skills` vendors 21 Skill directories from [mattpocock/skills](https://github.com/mattpocock/skills) at commit `3cca18b368ae95cdbdebbff572ccafa662551015`: `ask-matt`, `code-review`, `codebase-design`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `improve-codebase-architecture`, `prototype`, `resolving-merge-conflicts`, `setup-matt-pocock-skills`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `wizard`, and `writing-for-agents`. Four upstream Skills are deliberately not vendored because they duplicate the bundled `engineering-tdd`, `engineering-debug`, and `research` Skills, or (`teach`) sit outside the engineering scope; `ask-matt` and `implement` carry a local edit repointing those references, and every other vendored file is byte-for-byte upstream.

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
- One sentence describing workspace cleanup was reworded to avoid a recursive-delete command literal, which the bundled asset audit treats as a blocking finding.

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
