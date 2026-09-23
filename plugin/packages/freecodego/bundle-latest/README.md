---
description: "The installable single-package FreeCodeGo composition for DeepSeek Harness: install channel, release tagging, and the bundled Agent Teams composition."
kind: "package-bundle"
---

# FreeCodeGo Harness Bundle

English | [中文](README.zh.md)

## Summary

Installable single-package FreeCodeGo composition for DeepSeek Harness `freecodego@0.1.7-alpha.2`, targeting Harness baseline `0.1.7-alpha.2`. The npm artifact contains the compiled Host plugin, browser client, session-event prerequisite, native worker entrypoints, and the bundled Harness Agent Teams composition. A release publishes on npm's `next` dist-tag, and its plugin version intentionally matches the Harness version it targets exactly; for a reproducible install, name the version (`freecodego@0.1.7-alpha.2`) instead of the channel. Official Codex and Claude runtime binaries remain optional platform downloads — the package does not embed every platform's native binary.

## Table of Contents

- [Install](#install)
- [Free Models](#free-models)
- [Code Review](#code-review)
- [Project Memory](#project-memory)
- [Agent Teams](#agent-teams)
- [Image and Video Generation](#image-and-video-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="install"></a>
## Install

Install the release for the Harness baseline you run; each release carries one tarball, named after the baseline it mounts on:

```sh
dsh plugin --profile web add --save-exact \
  https://github.com/XiangSu-ce/dsh-plugin-freecodego/releases/download/freecodego-v0.1.7-alpha.2/freecodego-0.1.7-alpha.2.tgz
```

`freecodego-0.1.7-alpha.2.tgz` is the bundle for Harness `0.1.7-alpha.2`: substitute the version you run, which the settings page shows beside the installed plugin version. The asset name is the naming contract in `packages/freecodego/AGENTS.md`.

The `dsh` command is provided by the Harness CLI, not this bundle. In a normal terminal install it first with `npm install --global @deepseek-ai/dsh` (and ensure `pnpm` is available). Desktop launches the same command through its private shims and passes the active `DSH_HOME`, so Web and Desktop use one Profile data directory when they select the same Harness home.

Maintainers release from a tag. `pnpm run release:freecodego <version>` bumps the bundle and creates the `freecodego-v<version>` tag, and the workflow is dispatched from that tag:

```sh
pnpm run release:freecodego <version>
gh workflow run release-freecodego.yml --ref freecodego-v<version>
```

The workflow verifies the family, builds, packs, and creates the GitHub release for that tag. It refuses to publish unless the packed file already carries the asset name an update check looks for, and it re-reads the published release the way the plugin does before the run is allowed to pass. The family publishes only from a `freecodego-v*` tag that names the version the workspace carries, so a dispatch from a branch fails before the build rather than after it.

-----

<a id="free-models"></a>
## Free Models

<!-- generated:free-models:begin by scripts/generate-free-model-tables.ts -->
Every free row below comes from the provider's own directory, read when you open the picker, so this is what those directories returned on 2026-09-23 (sorted, where the picker keeps directory order) — and the picker is the count that is true when you look.

| Provider | Free models | Directory |
|---|---|---|
| **OpenCode** | `big-pickle`, `deepseek-v4-flash-free`, `jev-1.13-free`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free`, `mimo-v2.6-flash-free`, `muse-spark-1.2`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3`, `muse-spark-1.3-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `space-bunny-free` | 13 of 80 rows; public, no sign-in |
| **Kilo** | `cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`, `inclusionai/ling-3.0-flash-fin:free`, `inclusionai/ling-3.0-flash-sante:free`, `inclusionai/ling-3.0-flash-vl:free`, `kilo-auto/free`, `liquid/lfm-2.5-2.6b:free`, `nex-agi/nex-n2.5-mini:free`, `nex-agi/nex-n2.5-pro:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-content-safety:free`, `nvidia/nemotron-3.5-lightning:free`, `openrouter/free`, `poolside/laguna-s-2.1:free`, `poolside/laguna-xs-2.1:free`, `qwen/qwen3.8-27b:free`, `stepfun/step-3.7-flash:free`, `thinkingmachines/inkling-small:free`, `z-ai/glm-5.2:free` | 21 of 394 rows; public, 200 requests/hour per egress IP |
| **Logfare** | chat `claude-opus-4.6`, `deepseek-v3.2`, `deepseek-v4-pro-0813`, `gemma-4-26b`, `glm-5`, `glm-5.3`, `glm-5.3-flash`, `grok-4.6`, `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `logfare/auto`, `moondream3.1`, `qwen-3.8-27b`, `step-3.7-flash`; images `flux-1-schnell`, `flux-2-dev`, `flux-2-klein-4b`, `flux-2-klein-9b`, `sdxl-lightning`; audio `melotts`, `whisper-large-v3-turbo`; other routes `aura-2-en`, `lucid-origin`, `nova-3`, `phoenix-1.0` | 27 rows; 20 need a training-data opt-in, the other 7 do not |
| **Qoder** | `Qwen 3.8 Flash` (route `qmodel_38flash`) | the free flash route, plus daily check-in campaigns |
| **NVIDIA** | `google/gemma-4-31b-it`, `moonshotai/kimi-k3`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash` — the roster also names `deepseek-ai/deepseek-v4-flash-0731` and `deepseek-ai/deepseek-v4-pro-0813`, which are gone from NVIDIA's live catalogue of 82 rows | an API key is required to call them; cross-checked 2026-09-23 |
| **SenseNova** | `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`, `kimi-k3`, `sensenova-6.8-flash-lite` — 1M context and 128K output each | roster ships in the bundle; an API key is required |
| **TRAE** | the rows its directory lists | free credits reset daily, per account |
| **Cline** | the rows the directory marks `×0 · 官方免费模型` | an account pool |
| **WorkBuddy International** | the rows a credit package marks `x0` | device login, several accounts |
| **Agnes** | chat and image/video rows | a control-plane account |
| **VyceAI** | no free roster | the daily check-in credit pays its metered rows |
| **Groq** | `whisper-large-v3-turbo` | transcription, not a chat route |

These lists follow their directories: a route upstream retires leaves the table on the next read, which is why it is generated by `scripts/generate-free-model-tables.ts` rather than remembered.

TRAE, Cline, WorkBuddy International, Agnes publish no stable roster, so their rows are counted when they arrive rather than listed here.

20 Logfare rows sit behind a training-data opt-in, which the picker labels rather than hides.

<!-- generated:free-models:end -->

<a id="code-review"></a>
## Code Review

The bundle mounts a four-tool change reviewer. `engineering_code_review` reviews the workspace (staged, unstaged, *and* untracked changes), a ref range measured from its merge base, or one commit against its first parent, and renders the report as `text`, `json`, or `sarif`; `engineering_review_rules` returns what would be reviewed and under which rule with no model call at all; `engineering_review_status` and `engineering_review_report` show what is running and re-render the last result for another reader. Rules resolve in four layers — a rule file passed for the run, the project's own (`.opencodereview/rule.json`, `.dsh/review.json`, or `.freecodego/review.json`), the user's `~/.opencodereview/rule.json`, then the baseline shipped with the plugin — and the first matching layer wins, so a project override replaces the shipped rule rather than merging into it. Coverage is accounted per file: a run cannot finish while a changed file is still unreviewed, and every skip records why it was skipped.

The reviewer spends model calls, so it is opt-in. `reviewMode` is `off`, `record` (findings become durable session events, so a review is answerable later without re-running it), or `gate` (findings at or above `reviewThreshold` are injected back into the turn once `reviewCooldownTurns` has passed, so the Agent has to answer them before it can finish). `reviewDeep` gives each changed file its own read-only child agent, and `reviewEscalation` re-checks high-severity findings with an independent adjudicator that is asked to *refute* them. Reviews run on the plugin's second-model route (`advisorProvider` / `advisorModel`), so a fresh install reviews without extra configuration.

<a id="project-memory"></a>
## Project Memory

Durable per-project memory ships with the bundle: recall is reviewed-only, injected recall is fenced and budgeted, and credential screening refuses a labelled credential or redacts a shape-only match on the write path. Consolidation is a staged rollout rather than a switch — `memoryRollout` is `off`, `record_only`, `shadow` (which runs the whole pass, including the model call, and commits nothing, so an operator can read what the model *would* have written), or `active` — and a pass takes a fenced lease plus a frozen snapshot, so a crashed pass is recoverable while a live one is reported instead of retried. `MEMORY.md` is a bounded index of absolute pointers, and forgetting requires the caller to hand over the bytes it means to remove together with their hash, because "forget what you know about X" must not become a relevance decision that deletes records with no undo.

<a id="agent-teams"></a>
## Agent Teams

The bundle enables Harness Agent Teams with same-engine child sessions. A DeepSeek parent creates DeepSeek teammates, a Codex parent creates Codex teammates, and a Claude parent creates Claude teammates; the child route is inherited from the parent session rather than selected from the process default. Team roster, mailbox, task-board, and teammate Session records remain owned by Harness. The Web Chat renders the live delegated-Agent progress tree inside the parent conversation, including each task label, current tool, status, and tool-use count.

<a id="image-and-video-generation"></a>
## Image and Video Generation

The bundle registers image and video generation tools for DeepSeek, Codex, and Claude, and they read the model each category is configured to use at execution time rather than a pinned one. `mediaGenerationEnabled` (on by default) is the switch: with it off, `freecodego_generate_image`, `freecodego_generate_video`, and the legacy `agnes_generate_image` / `agnes_generate_video` names are **unregistered** — they leave the model's tool list instead of failing at call time — while `freecodego_generate_audio` and `freecodego_transcribe_audio` stay, since one writes a file into the active workspace and the other reads one out of it.

The route is chosen from the **provider**, never from a keyword in a model id. Image generation speaks the OpenAI Images contract (`/images/generations`, and `/images/edits` when source images are attached), Seedream's `image: [...]` fusion body, Gemini's `:generateContent`, Imagen's `:predict`, and DashScope's `multimodal-generation`. Video generation speaks nine: Kling's `text2video` / `image2video` / `multi-image2video`, Ark's `/contents/generations/tasks`, DashScope's asynchronous `video-synthesis`, MiniMax Hailuo's `/v2/video_generation`, Vidu's four `ent/v2` routes, Gemini's Veo `:predictLongRunning`, xAI's `/videos/generations` (with edits and extensions when a source video is given), OpenAI's `/videos`, and the gateway's portable shape for everything unrecognized.

The model roster is **live, not pinned**: candidates are collected per request from the Harness model directory, the managed catalog, Logfare, and Agnes, and a route's category is inferred from its id and can be overridden by hand in the settings page's model categories. Every call carries a per-route circuit breaker, and only a route's own problem falls through to the next one — a wrong credential or a refused prompt fails outright rather than paying for another attempt. The package README in `harness-plugin` carries the full table, including which providers accept a last frame and which durations each route can render.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the packages the bundle mounts; each inserted row's package owns its own model-facing behavior.

#### KV Cache effect

The bundle adds no request text of its own, so the cached prefix is whatever the composed rows produce.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **The artifact is assembled, not authored** — `prepack` rebuilds the Host plugin, browser client, native worker entrypoints, and the Agent Teams composition; nothing in the tarball is edited by hand.
- **The version matches the Harness baseline exactly** — a hotfix keeps the tag precise while the release asset keeps the baseline in its name.
- **Official runtime binaries stay optional platform downloads** — the package does not embed every platform's native binary.
- **Install is pinned by version** — a reproducible install names the baseline rather than a channel.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the bundle is static composition metadata with no runtime registry relationship of its own.

The plugin version tracking the Harness version exactly is deliberate: a bundle assembled against one baseline composes the rows of that baseline, so an independent version number would only invite installing a pair that no build ever tested.

</details>

**Runtime invariant:** the bundle declares its composition as data (`dsh.bundle.patch`); it owns no runtime state.
