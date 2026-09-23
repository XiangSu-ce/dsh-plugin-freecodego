---
description: "The installable Cordis bundle that mounts the FreeCodeGo engine inventory, Host configuration surface, engineering tools, and settings Remotes for DeepSeek Harness."
kind: "package-reference"
---

# dsh-freecodego-harness-plugin

English | [中文](README.zh.md)

## Summary

Installable Cordis bundle for the FreeCodeGo root-engine inventory and Host configuration surface.

It mounts `dsh-agent-engine`, publishes DeepSeek, Codex, and Claude descriptors, and admits a native engine only when its verified manifest, digest, protocol ABI, worker path, and state directory arrive together. Its router is the only Harness `AgentFactory`, so a requested native engine never falls back to DeepSeek.

`setDefaultEngine` and `setDefaultModel` set what new sessions start on, persist in the settings document of this plugin's own composition entry (`freecodego-harness-plugin`), and leave existing sessions pinned to their durable plan.

Where this README names a decision, that decision is the contract.

## Table of Contents

- [Documentation](#documentation)
- [Subagent Model Routing](#subagent-model-routing)
- [Free Models](#free-models)
- [Advisor Review Loop](#advisor-review-loop)
- [Engineering Enhancement](#engineering-enhancement)
- [Code Review](#code-review)
- [Context Compression (Headroom)](#context-compression-headroom)
- [Prompt Composition](#prompt-composition)
- [Post-Compaction Rehydration](#post-compaction-rehydration)
- [Project Memory](#project-memory)
- [Context Discipline, Command Policy, and Plan Mode](#context-discipline-command-policy-and-plan-mode)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Plugin Conflict Protection](#plugin-conflict-protection)
- [Release Updates](#release-updates)
- [Zcode GLM-5.3 Flash Promotion](#zcode-glm-53-flash-promotion)
- [MCP And Skills](#mcp-and-skills)
- [Optional Harness Capabilities](#optional-harness-capabilities)
- [Third-Party Plugin Tools](#third-party-plugin-tools)
- [Media Defaults](#media-defaults)
- [Model Picker and Provider Accounts](#model-picker-and-provider-accounts)
- [Settings Migration: Orphan Engineering Keys](#settings-migration-orphan-engineering-keys)
- [Community Plugins](#community-plugins)
- [Dev Note](#dev-note)

-----

<a id="documentation"></a>
## Documentation

This README is the top-level document: it describes every feature the plugin mounts, what it decides, and why. Two topics are large enough to live beside it, and both are written in Chinese:

- [`docs/free-providers.zh.md`](docs/free-providers.zh.md) — the free-model Provider integrations (Cline, WorkBuddy International): upstream contracts, the account pool, and the rotation semantics both adapters implement.
- [`freecodego-api/docs/backend-contract.zh.md`](../freecodego-api/docs/backend-contract.zh.md) — the endpoint-by-endpoint contract between this plugin and the FreeCodeGo backend, including which field owns routing outcomes.

Everything else lives in the package READMEs under `packages/freecodego/`: `harness-ui` for the settings surface, `freecodego-api` for the backend client, `agent-engine-router` for route selection, `root-agent` plus `runtime-codex` / `runtime-claude` / `native-runtime-host` / `native-runtime-protocol` for the native engines, and `bundle-latest` for release assembly.

<a id="subagent-model-routing"></a>
## Subagent Model Routing

With `autoSubagentModelSelection` enabled (the default), the Host synchronizes every live text-model route into Harness' `subagent-model-selection` setting. New top-level sessions therefore receive the standard `subagent` fields `provider`, `model`, and `reasoning_effort`, plus the on-demand `list_subagent_models` discovery tool, without requiring a user-maintained checkbox list. A temporarily failing provider retains its last authorized routes until its catalog recovers.

Spawned children inherit the parent's FreeCodeGo execution engine and may override the exact LLM route per delegation. DeepSeek executes the child in the official AgentLoop; Codex and Claude keep their native runtime while routing the selected model through the Host bridge. Existing sessions retain their durable Subagent policy; create a new conversation after the authorized catalog changes.

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

<a id="advisor-review-loop"></a>
## Advisor Review Loop

The independent Advisor is enabled by default on the public `freecodego/hy3` route. It reviews durable turn events with a separate model context and has only bounded, read-only workspace tools (`read`, `glob`, and `grep`). Its findings and token usage are appended to the Harness session; credentials, hidden reasoning, and unrestricted primary-Agent tools are never copied into the review context.

Every DeepSeek, Codex, and Claude Agent receives `advisor_status`, `advisor_review`, and `advisor_notes`. This lets the active Agent inspect the reviewer, request a second opinion at a useful checkpoint, and consume prior findings without a separate UI action. A concrete concern or blocker steers the Agent, while low-severity or cooldown findings are injected at the next safe step. Native Codex and Claude consume steering as a subsequent native turn and stage injections until the next user turn. Disabling Agent control keeps findings as `record` events only. Changing the Advisor route or delivery settings applies live; native sessions refresh their projected Harness tools before each turn.

Session deletion is idempotent for stale sidebar rows: when a session log was already removed but a cached projection still lists the id, the Host clears its workspace association and returns success instead of leaving an undeletable Ungrouped row. Live or running sessions still must be closed before deletion.

<a id="engineering-enhancement"></a>
## Engineering Enhancement

### Multi-engine Engineering Team

The Engineering Team keeps the current root Agent on its selected engine while starting isolated DeepSeek, Codex, and Claude child Agents for a bounded, read-only review. `engineering_team_start` accepts an objective and draft plan, runs an independent round, optionally runs one cross-examination round, and records consensus, dissent, participant states, and a final recommendation in the parent Session. A child cannot edit files, execute shell commands, create another team, or change permissions. Missing runtimes and failed participants are reported independently; the team reaches quorum only when the configured minimum number of participants completes.

The team can run in the foreground or return a `council_*` id for polling with `engineering_team_status`; `engineering_team_cancel` cancels all child Agents. Completed reports remain available through `engineering_team_report` and the `engineeringTeamReports` Host Remote after the parent Session is restored. Set `engineeringCouncilAutoRun` to run a review automatically after an approved `exit_plan_mode` plan; it is off by default so users retain explicit control.

A completed report is evidence, not edit permission. The user must explicitly approve or reject it through the engineering team approval command or the `engineeringTeamDecision` Remote before implementation. Only an approved report can run engineering team verification; the default run records `scope`, `build`, `types`, `lint`, and `tests` results in the parent Session.

#### Verification evidence and adversarial probes

A passing stage is evidence, not a claim. Every stage result carries the command that ran and the exit status it returned, and a stage that could not run reports `skipped`, `unavailable`, or `refused` — never a pass. This is the rule that matters when the thing that wrote the code is also an LLM: green declared gates say the project's own checks still pass, and nothing about the failure mode the change itself introduced.

So verification is only `verified` when at least one **adversarial probe** ran and held its expectation. A probe is an independent check the verifier declares *before* running it — a boundary, a concurrency case, an idempotency re-run, an orphaned operation — with an explicit expectation (`pass`, or `fail` for a guard that should refuse the new input) and a rationale naming the breakage it would catch. Declared failures are the interesting half: a guard that stops firing turns the run red instead of passing silently.

The verdict is computed, not inferred, and reports every unmet reason:

| verdict | when |
|---|---|
| `verified` | every declared stage passed with recorded evidence, and every probe held |
| `failed` | a stage failed or was refused, a probe did not hold, or a stage passed with no recorded command |
| `unverified` | stages were skipped/unavailable, or no probe was offered at all |

Probes are model-authored, so the controls fail closed: an empty or malformed probe, one whose rationale is blank, or one that reaches the network, publishes, or deletes is recorded as `refused` with `held: false`, which forces the run to `failed` rather than quietly dropping the check. Commands spawn without a shell, the environment disables network fetches, each probe is bounded by the same five-minute timeout as a stage, and the workspace is fingerprinted around every probe so a check that mutates the tree cannot also be the evidence that the tree is fine. Empty argv entries are preserved — `git commit -m ""` and `git commit -m` are different commands, and a normalizer that rewrites argv is how a probe ends up testing something else. Council children use Harness read-only sandbox and never-approval policy. Codex also receives App Server read-only sandbox plus no-approval settings, while Claude uses plan permission mode and an explicit native-tool allowlist.

Council jobs expose an explicit lifecycle (`queued`, `running`, `awaiting_approval`, `implementing`, `verifying`, terminal states). Requests and state transitions are persisted as session events, so an interrupted active job is restored as `stale` instead of being silently lost. Approval records include a plan digest, workspace fingerprint, policy digest, and expiry; changes to any of these fail closed and require a fresh review. Reports also contain structured `info`/`warning`/`blocker` findings and can be exported from the settings panel. DeepSeek, Codex, and Claude participation can be toggled independently; the settings surface reports whether the Codex/Claude runtime is installed before allowing that participant to be enabled. After approval, the primary Agent must call `engineering_team_mark_implemented` (or the `engineeringTeamImplementation` Remote) with a bounded summary before `engineering_team_verify` is accepted.

The Engineering Enhancement master switch (on by default, and the way to stand the pack down) mounts audited bundled engineering Skills, static asset Doctor checks, bounded declared-script verification, and Host-owned tools shared by DeepSeek, Claude, and Codex. The settings page contains only the master switch; detailed controls live in the dynamic Engineering sidebar entry.

Engineering Memory is local SQLite state under `DSH_HOME/freecodego/engineering/memory`. Agents can save drafts and use the reviewed-only `Search -> Timeline -> Get` flow. Only the user-facing Remote can approve, reject, export, purge, or delete records. Drafts never enter automatic recall, and memory actions are scoped through an open workspace-backed session.

Plugin-private state — memory, checkpoints, the Code Graph and Graphify runtimes, jobs, and plan mode — resolves its root through one helper rather than per module: `FREECODEGO_HOME` when it is set to a non-empty value, otherwise `DSH_HOME`, otherwise `~/.dsh`. Every `DSH_HOME/...` path below is written against that rule, so setting `FREECODEGO_HOME` moves all of them at once. Host-owned files (`.credentials.yaml`, `settings.yaml`, `profiles/`, `runtimes/`, `state/`, `.agent-presets/`, `skills/`) never follow the override: the Host writes and reads those, and a second root would leave the settings surface and the credentials service disagreeing about which file is the truth.

Code Graph offers two interchangeable engines and mounts exactly one Agent tool family, selected by the `engineeringGraphEngine` setting (`auto` prefers the Python-free engine, `graphify`/`codegraph` mean that engine or nothing).

The Graphify engine downloads the official `graphifyy==0.9.52` Wheel after SHA-256 verification and bootstraps a SHA-256-pinned official uv release plus private Python 3.12 under `DSH_HOME/freecodego/engineering/graphify`. Its initial build uses Graphify's original code-only extractor and writes the graph, caches, and reports only to the plugin-owned project directory. It does not create a workspace `graphify-out`, install hooks, change `PATH`, or use a Lite Graph. Once a user builds a graph, the Agent receives the bounded official Graphify search, explain, path, impact, and overview tools.

The CodeGraph engine downloads the official self-contained platform bundle (48-62 MB) for the running OS/CPU after SHA-256 verification and unpacks it under `DSH_HOME/freecodego/engineering/codegraph`. The bundle carries its own Node runtime, so this engine needs no Python, no `uv`, and no wheel; musl Linux is refused rather than approximated, because the official Linux bundles are glibc-linked. CodeGraph resolves its index directory as a single path segment under the project root, so this engine keeps its index in the workspace at `.codegraph-freecodego` instead of under `DSH_HOME`; the directory carries a self-ignoring `.gitignore`, and the plugin removes it only on an explicit user action. Every plugin-owned process runs with anonymous telemetry, the background daemon, and the CLI's own download fallback disabled, and the plugin never runs `codegraph install`, which would rewrite the user's other agent configurations. Once a user builds an index, the Agent receives the bounded `engineering_codegraph_explore`, `_search`, `_explain`, `_path`, and `_affected` tools.

Both engines install and verify through one shared download path: an artifact streams to disk while hashing, a transient transfer failure is retried once, and a digest mismatch is final and never retried.

### Deterministic scan selection

Which changed files a scan covers is decided by a pure function rather than by a prompt, because a prompt cannot answer the three questions a user eventually asks: which files, why not the others, and whether anything was skipped. `src/scan-selection.ts` takes the changed paths plus one measured fact per path and returns one decision per file — selected, or excluded with the reason — and seals the coverage denominator: the exact set a run must account for. It performs no IO, no git read and no model call, so a preview and a run consume the same answer instead of deriving two that drift apart.

The gates run in a stated order, because the order is the substance. A deletion has no content left and leaves the denominator first. A credential path is refused before any pattern rule, so a credential file inside vendored source reports `credential` — the reason that explains why nobody looked at it. A pattern then names a path where a finding could not be acted on: installed dependencies, vendored source, build output, generated metadata, lockfiles. Test files are deliberately **not** excluded, which is a departure from the upstream default table this was modelled on (Alibaba's Apache-2.0 `open-code-review`): the defect class this plugin watches hardest is a test that asserts nothing while reporting green, and a scan that never opens a test file cannot see one.

Size is the last gate, and it is a ceiling on bytes rather than on the estimate: the estimate is priced for display through the plugin's single token estimator so this module cannot become a second place that prices text. A file whose size could not be judged stays **selected** and is named as unchecked. "Not measured" and "small" are different answers, and only one of them is a reason to look away; reading the unknown as either one would be a budget that passes by not looking.

`engineering_inspect` reports the selection as its `scan` section: the denominator, every exclusion with its reason, the byte and token totals a run would read, and the names of any files whose size was unchecked. That section is deliberately **not** folder-trust-gated, and the difference is what it reads — sizes and path names, never content. A byte count is not an instruction, and gating it would remove the one diagnostic that still works on a checkout nobody has trusted. The reconciliation half of the ledger — which selected files a run actually accounted for — is not implemented, because nothing in this plugin records a per-file scan outcome yet: the council and advisor reports carry findings rather than the set of files they covered.

<a id="code-review"></a>
## Code Review

Four tools over one engine: an OCR-style (open-code-review) change review rebuilt as Host-owned machinery, plus an optional stop-time gate. The pipeline lives in `src/review/`, and the composition root is `review/install.ts` — the host file adds an import, a call, and a registration instead of owning eight collaborators.

| Tool | Question |
|---|---|
| `engineering_code_review` | review this change (`mode: workspace \| range \| commit`, output `text \| json \| sarif`) |
| `engineering_review_rules` | what *would* be reviewed, and under which rule — no model call |
| `engineering_review_status` | what is running now |
| `engineering_review_report` | re-render the last result for another reader |

`engineering_review_rules` is a tool rather than a flag because it is the whole deterministic half of the pipeline with no model call: it is what a caller needs to do the reviewing itself, and it answers "did my exclude pattern work?" without spending a review's budget to find out. Every tool returns text rather than an object because the three formats differ in *who reads them* — a person, another agent, or a scanning integration — so the format is an argument and the answer arrives already rendered.

**What is reviewed is a decision, not a `git diff | head`.** Three decisions are made before a single model call, and each is a place a review can silently become smaller than the change it claims to cover:

- **Which refs.** A workspace review means staged *and* unstaged *and* untracked changes; the untracked half is what a naive diff never shows, and it is exactly where a new file's worst bug lives. A range review diffs from the **merge base**, not from `from`, or every commit on the base branch arrives as the reviewer's problem. A commit review diffs against its own first parent.
- **What is skipped, and why.** Binary content has no lines to review, an oversized file would spend the whole budget on one diff, and an excluded pattern is a decision the project already made. Each skip is recorded with its reason and its *type* (`ReviewSkipReason` is a closed union), so a report can group skips rather than print free text, and a file that vanishes without a reason cannot be told apart from a file the review forgot.
- **Coverage.** A file that entered a run leaves it accounted for (`pending` / `reviewed` / `skipped` / `failed`), and a run cannot finish while anything is still `pending` — the check names the missing files instead of letting the denominator shrink quietly. Coverage is a pure function of the outcomes, so a test asserts the arithmetic without running a review.

**One report, three renderings.** `text` is for a person, `json` for an agent, `sarif` for a scanning integration, and all three render one assembled report so the same run cannot state a finding in text that its SARIF omits or count coverage differently per format. A finding the fact-checker disproved, or that adjudication refuted, is withheld from `text` and `sarif` — annotation formats cannot carry the argument for dropping it — and stays in `json` with the reason; `text` therefore states the count it withheld, because a report that silently omits findings teaches its reader that the count is the whole truth. Every severity is rendered, including `low`: upstream's CLI does the same and its skill asks the *presenting agent* to discard nitpicks — this renderer is the presentation, and dropping a finding on the reader's behalf is not a decision a report gets to make quietly.

**Rules resolve in four layers, and the first matching layer wins.** `custom` (a rule file passed for this run) → `project` → `global` (`~/.opencodereview/rule.json`, the one layer a repository cannot author) → `system` (shipped with this plugin). The first matching layer wins rather than the first matching pattern across layers, which is what makes a project's override an override: a user-level rule must not be silently merged into every TypeScript file of a repository that has already decided what it wants. A project's standard lives in `.opencodereview/rule.json`, `.dsh/review.json`, or `.freecodego/review.json`, tried in that order, and the first that exists becomes *the* project layer — merging two would make the effective standard a document nobody wrote and nobody can predict. A user rule replaces the shipped rule for that file unless the entry sets `mergeSystemRule`, which includes the shipped baseline as well; without the opt-in a project that adds one check would lose every baseline check and never be told. Provenance travels on the answer (`source` + matched `pattern`), and grouping keys on all three, so a group's reported provenance is true for every file in it. A malformed or unreadable rule file produces a warning that names it, never a silent fallback: a project that believes its standard is enforced while the file has a trailing comma is worse off than one that never wrote a rule file.

**High-severity findings are re-checked adversarially** (`reviewEscalation`, off). Upstream has one reviewer and one deliberately weak fact-checker that may only remove what the diff *proves* wrong; that is the right trade for a general comment and the wrong one for the two findings a reviewer is least able to judge about itself. So findings at or above severity are re-checked by an independent adjudicator asked to **refute** rather than to agree — an asymmetric question, because "confirm" is the default a lazy answer gives and "refute" is not. Refuted (diff evidence against the finding, and confirmations short of quorum) retains the finding with `filtered` state and the refutation as its reason, which is the only path that removes a finding and the one place this stage fails *toward keeping*; confirmed publishes it with the adjudication recorded; undecided publishes it unchanged, because an inconclusive check is not evidence against a finding. The port is one method on purpose: the strong implementation is this plugin's own multi-engine council, and the shipped one is a single adversarial route.

**Deep review** (`reviewDeep`, off) reads every reviewed file with its own read-only child agent, which can search for callers and open the implementation a test covers instead of judging the diff alone. It is off by default because it opens one child agent per file — a decision with a cost rather than a better default.

**The stop-time review is opt-in, and it is one pass.** `reviewMode` is `off` (costs nothing), `record` (the pass runs and its findings become durable session events, so what a review said is answerable later without re-running it), or `gate` (that same pass also injects findings at or above `reviewThreshold` once `reviewCooldownTurns` has elapsed). A per-turn reviewer and a stop gate sound like two features and are one review: run separately they would each read the same diff of the same change set, pay for it twice, and could disagree about the same tree. Three rules bound the cost, and each one is a test:

1. A turn that changed nothing is never reviewed, so a conversation turn costs no git call.
2. A change set is reviewed once, latched on the fingerprint of the changed paths **and** the workspace revision — a second edit of an already-modified file changes no path, so the path list alone would call two different states the same state.
3. A run is confined to what the turn touched (`include` carries the turn's own changed paths), so files that were already dirty are not re-reviewed and their findings are not reported as this turn's. The turn's paths come from the Host's own per-turn record where one exists and fall back to the workspace's uncommitted change set where it does not (`review/turn-scope.ts`, which also owns the reasons a narrowing is refused).

Delivery is an injected message, which is the mechanism the Harness gives at stop time: it continues the turn, so the Agent has to answer the finding before it can finish. That is what makes this a gate rather than a notification, and it is the same shape `verify-on-stop` uses.

**The route is the plugin's second-model route** (`advisorProvider` / `advisorModel`, defaulting to OpenCode's virtual `auto` route), not a new pair of settings: both are "the model this plugin calls on its own behalf", the pair is already the one a user configures and the UI edits, and a second pair would be a second place for the same intent to set and disagree. Resolution happens per request, so a settings change takes effect without a reload, and a fresh install reviews out of the box instead of failing on the first call.

**From the UI** the review Remote is fire-and-forget: a run spends model calls per file and can take minutes, so the call starts the run and answers with the runs as they stand, and the caller polls the same Remote it used to start it. A second concurrent run in the same workspace is refused with a sentence naming the run that holds the slot, rather than queued into something that looks like a hang. Every Remote takes a session id and resolves the working directory from it — a path parameter would let a browser ask about a directory the session never opened. The settings page shows the mode, threshold, cooldown, deep review, and escalation, and renders the report with its coverage arithmetic.

## Hunk-level Change Tracking

Checkpoints answer "what did the workspace look like before that call" at file granularity; they cannot answer *which* call introduced a line, and they cannot take back one call's edit while others' stay. Hunk tracking records, for every mutating tool call, the contiguous line regions that call changed, attributed to the harness's own `callId`, and reverts a hunk against the file's current text.

Both halves live on the tool seam: the pre-execute hook reads the pre-image of the files the call names, and the post-execute hook diffs them and records the hunks. Recording runs for a *failed* call too — a mutation that wrote and then reported an error is the change nobody finds by reading the transcript. Two decisions are worth knowing about:

- **A later edit supersedes the lines it replaced.** Offsets are maintained as edits arrive, so an earlier hunk keeps a usable position; when a later edit covers an earlier hunk's lines, that hunk refuses to revert on its own and names the hunk that covered it. Reverting the covering call restores that state, which is why the refusal points there.
- **Revert verifies before it splices.** The recorded post-image must still be at its offset, or be found uniquely elsewhere (an edit above it moved it). Anything else is reported as `drifted` rather than guessed — including a pure deletion whose neighbours no longer match, because an empty post-image matches everywhere and the module will not pick one of the blank lines that look alike. File line endings are preserved.

The Agent reads the journal with `engineering_hunks` (bounded metadata plus a five-line preview, never the whole region) and undoes one with `engineering_hunk_revert`, which takes either a hunk id or a call id together with a file. Both are registered unconditionally, unlike the code-graph families: the journal is filled by the tool seam whatever engines are installed, so reading it must not depend on one being present.

Arguments come from the model, so the file a call names is refused unless it resolves inside the workspace: a pre-image read of `../../id_rsa` would put a credential's contents in a journal the model can ask about later.

<a id="context-compression-headroom"></a>
## Context Compression (Headroom)

Headroom compresses oversized tool output before the model sees it. The durable session log keeps the full original, the compressed text carries a `hash=<24 hex>` marker, and the model gains `headroom_retrieve` to fetch any omitted text back — lossy on the wire, lossless end-to-end. Every strategy is routed by *shape* (log, JSON, diff, search, table, config, prose) and each one only runs when it actually shrinks its input.

### Code skeletonization

Source code has no shape signature, so the port originally left it alone — and measurement showed that was the single largest cost it could have addressed. In a sample of 17 sessions / 133 steps, `read` produced 875,706 of the 1,025,038 tokens of tool output ingested (85%), and because the Harness re-sends the whole transcript on every step (`deriveMessages` does not trim), those bytes were transmitted 21,365,476 tokens in total across the sample.

`headroomCodeSkeletonEnabled` (on by default) assigns `read`, `read_file`, and `view` results a skeleton. The safety contract is a subsequence: **every retained line is byte-exact original text, including its `N: ` prefix**; only whole contiguous runs of body lines are replaced, each by one marker naming the line range it covers. Imports, declarations, type/interface members, signatures (including multi-line parameter lists), decorators, attributes, doc comments, arrow-function class fields, and top-level closing delimiters all survive. What is dropped is implementation — so an Edit anchored on a retained line still matches, and the marker states exactly which line numbers the reader no longer sees. A run shorter than three lines is kept rather than marked, because a marker costs more than the lines it would replace.

A read is declined rather than guessed at when it is smaller than 2 KB, is not a numbered envelope, has non-consecutive line numbers, is already owned by another compressor (JSON, config, logs, search, diffs, tables, HTML), is prose by extension and detector, is an error result, or would shrink by less than 25%. Reads of windows starting at an offset are supported, since that is how agents read large files.

Measured on 1,983 real repository sources, the skeleton reduces the applied files by 61.5% in aggregate (median 58.3%, p25 49.5%). Replaying the sampled sessions with reads skeletonized drops total re-transmission from 21,365,476 to 17,820,922 tokens: **16.6% of everything sent**, without a config change, and without losing any line the model can still match against.

Turning the switch off restores byte-exact reads. The read-fold knob is unrelated: it applies lossless folds to reads that happen to look like search or log output.

### On-demand tool schemas

The tool block is the other fixed cost: in the same sample, 45.7-47.4 KB of every request (11,700-12,130 tokens) was tool JSONSchema, and 37 of the 61-74 tools were this plugin's — 14,380 chars, 27% of the block, re-sent on every step of every turn. A turn that edits a setting never touches a graph query, memory CRUD, checkpoint restore, council orchestration, or media generation.

`deferredToolSchemasEnabled` (on by default) keeps those tools registered but withholds their schemas. On `agent/session-start` the plugin scopes the agent's tools with `deny: [...deferred]` in one attempt that can never block the session; the Harness derives the wire schema from the visible set, and a denied name fails a direct call with `UNKNOWN_TOOL` — visibility and callability read from one source of truth, so the model cannot call what it was not shown, nor see a tool it cannot call. `tool_search` then lifts the denial for the tools it returned, so a deferred tool is exactly as usable as an immediate one after one discovery call. Query grammar follows Claude Code's `ToolSearch` on purpose: `select:A,B` for exact names, `+term rest` to require a term in the name, and bare keywords to rank.

`tool_search`, `engineering_status`, `engineering_repo_map`, `advisor_review`, and `headroom_retrieve` never defer. Deferring the entry point would be a lockout, the first two are what a user reaches for when nothing else works, and the last two answer something the model has already been shown — a hint to consult the advisor, or a hash inside a compression marker — where a discovery round-trip is pure latency.

The tool's description is **static**, and deliberately names no deferred tool. A dynamic index there would mutate the tool block on every settings change and void the prompt-cache prefix for everything after it, which is the failure Claude Code's own source records (~10.2% of their fleet cache-creation tokens): a far larger loss than the definitions saved. The index is returned by a no-argument `tool_search` call instead.

A keyword query is ranked by BM25F over the name and the description (`tool-search-rank.ts`), not by counting substring hits: rarity is computed over the deferred catalog itself, term frequency saturates, description length is normalized, and a term of three or more characters that prefixes a word counts as half a hit. The three failures plain counting had are the three a catalog of a few hundred tools makes obvious — a word every description contains out-ranking the one that matters, the longest description winning, and a repeated word outbidding a tool's own name. The documented ceiling on `max_results` is enforced where the answer is formed, not only where it is described.

The index is priced like any other output (`tool-catalog-budget.ts`, 1,000 tokens): it renders `name — summary` while that fits, then the bare names, then one line per name prefix with a count and a few samples. Each level says what it dropped and how to ask for it back, and no level can hide a name — `list:<prefix>` (and `list:all`) returns names without schemas, which is how a name that grouping summarised away stays reachable. Today's 37-tool catalog measures about 930 tokens, just under the budget, so the change is inert until a catalog actually outgrows it.

<a id="context-discipline-command-policy-and-plan-mode"></a>
## Context Discipline, Command Policy, and Plan Mode

These mechanisms share one idea: a rule that only exists as prose cannot be enforced, tested, or reviewed — and a cost the model cannot see is a cost it cannot avoid.

**Differential context injection** (`context-fragments.ts`). Injected standing context is split into named sections, each with a snapshot. A section that did not change sends **nothing**; a section that changed sends a **replacement notice** first; a section that went away sends an explicit **removal notice** instead of being silently omitted, because an instruction the model merely stops seeing is an instruction it keeps following. `unknown` (after a resume, a compaction, or a restart) is treated as *possibly still held* and re-sends with a notice rather than skipping one. Sections report `incomplete` when a budget shortened them, so "we looked and there is nothing" stays distinguishable from "we stopped looking". The engine is pure: `plan()` computes, `commit()` records what was actually appended, so a cancelled turn cannot desynchronize the log from the model's context.

**Cache-miss attribution** (`cache-attribution.ts`). The ledger already recorded what each turn cost; this adds what it *wasted*. Per turn it computes the previous prompt bytes that were not read from cache, prices them at the paid rate minus the cache-read rate, and labels the cause: the model changed, the request came back after the provider TTL, or the prefix itself moved. Movement at or below 1024 tokens is ignored as breakpoint granularity, and a provider that never reports caching is reported as unattributable rather than as a 100% miss every turn.

This runs *inside* the local ledger (`token-usage.ts`), not beside it: every reported turn becomes one observation while the session walk is already in flight, so the dashboard shows re-billed tokens next to the input total that motivated them. The block is omitted — never zeroed — when the range has nothing to compare, because "this provider does not report caching" and "this range wasted nothing" are opposite conclusions from the same silence. Pricing is not invented either: with no rates in scope the panel states tokens only.

**Model-visible context budget** (`context-budget.ts`). Our spend probes found that compaction never runs in practice and that the model never learns how full its own context is — so the party that could avoid the cost (by reading a range instead of a whole file, or by compacting early) is the one party not told the number. Codex closes this with a `<rollout_budget>`-style fragment plus a `get_context_remaining` tool, and the hard half is not the number but injecting it without destroying the cache the number describes: a fragment that changes every turn rewrites the prefix every turn, which is the failure Claude Code's own source records for a dynamic agent list (~10.2% of their fleet cache-creation tokens). So the injected text is **quantized into five bands** — identical for as long as the session stays inside one, with a replacement notice only on a crossing, and it is *appended*, so everything before the last cache breakpoint stays a hit. The exact number lives in `engineering_context_budget`, whose schema is deferred and therefore costs nothing until asked for.

Three rules make the signal trustworthy enough to act on. **Estimated is not measured**: the token meter's baseline is either provider usage or a heuristic, and a heuristic is labelled as one, because a model told "4,000 tokens left" by a guess will make real decisions on a fake number. **An unknown window is stated as unknown**: a model that advertises no context window gets its used figure and no invented denominator. **No threshold is prescribed**: a band names a condition and the remedies that apply to it rather than ordering an action at a token count, and the reserve is only taken out of room that exists — a 150k request against a 100k window is 50k over, not 50k plus whatever reply was planned.

**Declarative command policy** (`command-policy.ts`). Rules are data: `pattern` (ordered tokens, alternatives allowed), `decision ∈ allow | prompt | forbidden`, `justification`, and — the part that matters — `match` and `notMatch` examples. **A rule whose own examples do not hold is rejected at load time** with a diagnostic, so the rule set tests itself where it is written. Longest pattern wins and ties go to the earlier rule, which is how a narrow `forbidden` sits in front of a broad `prompt`. `hostExecutable(name, paths)` pins which absolute paths may resolve through a basename rule, so a planted `./git` cannot satisfy the rule written for `/usr/bin/git`. The guard turns only `forbidden` into a denial: a monotonic guard cannot convert a denial back into an approval prompt, so `prompt` is left to the approval layer that can actually ask.

**Plan Mode** (`plan-mode.ts`). A conversation mode that structurally refuses workspace mutation: file-mutating tools are refused, shell commands are judged by the same policy above (anything it does not clear is refused with the rule's own justification), and reading, searching, and running checks stay available. The mode is durable per conversation and **does not end because a sentence asked for execution** — only `engineering_plan_mode` with `action: "exit"` leaves it. The mode rules are injected through the fragment log, so leaving Plan Mode sends the removal notice rather than leaving stale restrictions live.

**Action review** (`action-review.ts`). The policy half of a Guardian-style reviewer: a delta transcript cursor keyed to a history generation (a compacted or rolled-back history forces a full re-read), per-section token caps that include the truncation marker in their own budget, a per-session review budget, and a stable review cache key derived from the session rather than the action. Absence is never an allow: no reviewer configured, an exhausted budget, and a reviewer that threw all return `ask-user`.

**Injected-surface lock** (`surface-lock.ts`). `engineering_surface_report` measures how many bytes of tool schema and guidance this plugin injects and diffs that against a reviewed lock (`added` / `removed` / `changed` reported separately), so editing a prompt is a visible diff instead of an invisible one. The token figure is labelled an estimate everywhere it appears — `approximateTokens` is *not* a tokenizer count and not the cost of a task.

**Cache-cold clearing** (`cache-cold.ts`). A second, narrower compaction path with one rule: when more than an hour has passed since the last main-loop assistant message, the provider's prompt cache has certainly expired and the entire prefix will be rewritten anyway — so older tool results are cleared **before** the next request, shrinking exactly the part that is already certain to be re-billed. The reason is not that the content is old. The one-hour threshold sits past every published TTL, so the mechanism cannot manufacture a miss that would not have happened, and clear markers are per-session so the same content is never processed twice: clearing is idempotent by construction, not by the caller remembering.

**Request-shape fingerprinting** (`request-shape.ts`). Cache-miss attribution above is arithmetic on the ledger; this is the causal half. Before each request the wire shape is hashed — system text, the tool set, **each tool's schema separately**, model, betas, budget band — and the next response's cache-read drop is attributed to a named change. Per-tool hashes exist because the dominant real case is the tool *set* unchanged while one tool's description moved, which no added/removed count can see; that case is named as the specific tool that moved. Flags that once flipped mid-conversation and invalidated the prefix are sticky-on: a flag that stops mattering is kept on rather than allowed to flip back, because the second flip is the expensive one.

**Proportional verification** (`verification-tier.ts`). Verification used to cost the same for a one-line guard as for a scheduler rewrite, which over-charged the small change and — worse — under-evidenced the large one. Tiers are now chosen from the change itself (`git status --porcelain` for *what* moved, so an untracked new file counts, plus `diff --numstat` and each untracked file's own length), with security fragments, architectural fragments (manifests, lockfiles, CI, migrations), and breadth all forcing `thorough`. Two invariants hold at every tier: **a tier may reduce which stages run, never what counts as evidence** — a skipped stage still reports `skipped` and a run without a probe is still `unverified` — and **the tier is reported with what it omitted**, because "no failures" and "no failures among the checks we ran" are different claims and only one of them is true. Coverage is inferred from paths alone, so a change that ships no test file can never reach the light tier however small it is.

**Credential screening for memory** (`secret-scan.ts`). Project memory is written from what the agent read, so a `.npmrc` or a pasted curl command can put a real token into an entry that then outlives the session and is re-injected into later conversations. The curated rule set is a subset in the useful direction: rules with a distinctive vendor prefix and a near-zero false-positive rate, deliberately without the generic keyword-context rules that make people turn a scanner off. The scanner never returns the secret — a finding carries a four-character prefix and a length — and confidence is part of the match. On the write path a *labelled* credential (the existing keyword rule) and a *vendor-prefixed* one both refuse the entry, while a shape-only match (a JWT, a bare `sk-`, a PEM blob) is redacted in place and the entry is kept, because losing an opaque identifier costs less than keeping a credential.

**Side-channel budget invariant** (`side-channel-budget.ts`). Claude Code carries this as a hard operating rule for its classifier: a side prompt must stay strictly smaller than the main loop so compaction happens before the *side channel* overflows. Our Advisor and each council perspective are exactly such channels, so each call is measured against the harness's compaction threshold (the window times `compaction-basic`'s default ratio) before it is sent, not after it fails; the comparison is against the threshold rather than the current conversation size, because a large channel in a session that has not grown yet is precisely the case that breaks. Records keep the **worst** footprint per channel rather than the latest — a channel that was over the line once will be again, while "the last call was small" proves nothing. This is reported, never enforced: the plugin cannot resize another component's prompt, and refusing to review would trade a measurable cost for a silent loss of oversight. An unknown threshold produces no warning, since judging a footprint against an unnamed line reports it safe by default.

**Isolation reporting** (`isolation-report.ts`). A member's restriction is reported as what was *requested*, which mechanism is actually narrowing it (`tool-scope`, `harness-policy`, `both`, or `none`), and a single `restricted` flag for a caller to branch on — computed from the **resolved tool set** and a read-back of the sandbox mode, never from the role's intent. "We asked for read-only" and "read-only is in force" are different facts, and a brief that conflates them is how a write-capable member is mistaken for a restricted one. The one outcome that is never silent is `enforcedBy: none` on a read-only request: it carries a `fallbackReason`, and a `workspace-write` member in its own worktree is reported as *contained* rather than restricted, because containment is what a private worktree actually buys.

<a id="prompt-composition"></a>
## Prompt Composition

`context-budget.ts` says how *full* the window is; `cache-attribution.ts` says what a miss *cost*. Neither says what the tokens are *made of*, which is the question behind most of the platform's real decisions: the deferred-schema work exists because tool definitions were 45.7–47.4 KB of a 13,454-token fixed block, and that figure came from one offline measurement rather than from anything the model or a user can ask at runtime. Without a breakdown, "the prompt is large" has no next step — the model cannot tell a bloated tool block (defer, or turn a pack off) from a long conversation (compact) from accumulated rules and Skills (a settings change).

`engineering_context_prompt` answers it as a tree, one node at a time: system text, the tool block, standing guidance, Skills, injected fragments, and the conversation, each with its own size. Snapshots are kept per session and cleared on teardown, and the tool is classified as a reader in `tool-manifest.ts`, so asking what the prompt costs is not a turn that moved the workspace. Like `engineering_context_budget`, it is deferred: the precision costs nothing until it is asked for.

<a id="post-compaction-rehydration"></a>
## Post-Compaction Rehydration

A summary alone loses standing context that was never part of the conversation's semantic content. After the Harness compactor shadows a span, `rehydrationEnabled` (on) re-injects what the shadowed range used to carry: durable project memory, the latest todo list, and the latest engineering checkpoint — so work continues instead of the model "forgetting" a plan that was never in the summary.

Everything is replayed from data the session already recorded (todo and write events, memory recall, checkpoint events), so a replay cannot disagree with the history it restores. The rehydrated body deliberately carries neither credentials nor reasoning content, because they are not a todo and not a checkpoint. `rehydrationArcEnabled` (off) adds the optional conversation-arc variant, which folds goals and decisions the same way. This mirrors the Claude Code rehydration learning; the mechanism is the fragment log, so leaving a section sends a removal notice rather than letting a stale restriction stay live.

<a id="project-memory"></a>
## Project Memory

Durable per-project memory is local SQLite state under `DSH_HOME/freecodego/engineering/memory`. Recall is the reviewed-only `Search → Timeline → Get` flow — drafts never enter automatic recall — and recall injection is fenced and budgeted (`engineeringMemoryContextTokenBudget`, 1,200 tokens by default) with tags neutralized so repository text cannot impersonate memory. Credential screening happens on the write path: a labelled or vendor-prefixed credential refuses the entry, a shape-only match is redacted in place, and a finding never returns the secret — only a four-character prefix and a length.

Five pieces of that are easy to miss, so they are spelled out here.

**Consolidation ("dream") is a staged rollout, because it writes.** A pass takes a *fenced lease* rather than a mutex — a lock file with an expiry, so a crashed pass is recoverable by construction while a **live** lease is reported as `lease-held` instead of retried, because two passes consolidating the same observations would each write a topic the other does not know about. It then reads a *frozen snapshot* of the observations that existed when it started and ignores later arrivals: those are the next pass's input, and letting a running pass see arrivals would make its output depend on how long it took, which makes a bad consolidation impossible to reproduce. One tool-free model call runs over the snapshot, and topics are written atomically. `memoryRollout` therefore has four stages rather than a switch — `off`, `record_only`, `shadow`, and `active` — and `shadow` is what makes the feature safe to turn on: it runs the whole consolidation including the model call and commits nothing, so an operator can read what the model *would* have written before letting it write. Disabling the pipeline fails closed.

**`MEMORY.md` is a bounded index of absolute pointers.** Paths are absolute because a relative pointer has to be resolved against a scope root, and which root that is depends on where the index was found; a model that reconstructs that reasoning wrongly does not report a broken path, it reports having found nothing. Overflow drops whole lines and states how many, because truncating a description would leave the index claiming to describe a record it no longer describes — the reader cannot tell a short summary from a cut-off one — while a dropped line is visible and the count is actionable.

**Forgetting requires evidence, never a pattern.** "Forget what you know about X" is the one request this subsystem must not answer by turning X into a set of files: that is a relevance decision, and one that lands slightly too broadly has deleted records the user wanted to keep, with no undo, in a store whose entire value is that it remembers. So the caller does the one thing only the caller can do — it reads the bytes it intends to remove and hands them over with their hash — and this module is purely mechanical: verify the evidence against the file on disk and remove exactly that file. A directory or a glob is refused because "everything under here" is a decision again and the evidence for it is not something a caller can have read; a hash mismatch and four other shapes are refusals rather than warnings, and each refusal says which one it is.

**Memory has an admin side.** The settings panel can consolidate on demand, rebuild the manifest, export reviewed memory, write a backup, and sweep expired content, all scoped to an open workspace-backed session. Only the user-facing Remotes can approve, reject, export, purge, or delete records, and memory can also graduate into Skill drafts under `.freecodego/skill-drafts/`.

**Telemetry is a schema, not a convention.** Telemetry is the easiest place in a feature to leak what the feature knows: a memory pipeline sees user statements, topics, keywords, file paths, and the model's output, so an innocuous `{ topic: slug }` field would put a distilled version of a private note into whatever collects metrics, permanently, with no way to un-send it. Every event is therefore *built* through one constructor that refuses an unknown field and refuses a string that is not one of the declared values for its field — a free-text field cannot be added by accident because there is no shape that would accept one — and the refusal throws rather than dropping, so a developer who believes their metric is collected fails in a test instead of silently.

<a id="plugin-conflict-protection"></a>
## Plugin Conflict Protection

The `freecodego-harness-plugin` composition entry enables Plugin Conflict Protection by default: the switch is that entry's own setting, read from the settings service. The guard installs when the entry activates and statically scans every entry module and its local imports for literal duplicate Tool names, command names, settings namespaces, HTTP routes, model Provider ids, and UI Slot ids. Timing is relative: entries that initialize after that point are wrapped before they start, and the ones already running are recorded first, so an entry starting later is still refused a resource an earlier one owns. A programmatic mount that supplies no settings port — nothing in the shipped composition does — intercepts nothing: the switch is what turns interception on, and a mount that supplied no settings document never asked for it. When it finds an exclusive resource already owned by an active entry, it keeps the earlier entry, disables the later one before it runs, and saves a repair record for the settings page. The browser notification identifies both entries and the duplicate resource.

The scanner never executes third-party code and intentionally ignores dynamic or computed registrations. It prevents reliable duplicate registrations, not unrelated plugins that merely provide similar user-facing features.

<a id="release-updates"></a>
## Release Updates

The update service reads the releases of `XiangSu-ce/dsh-plugin-freecodego`, rather than updating one Host component in isolation. A release is tagged `freecodego-v<version>` — the family prefix keeps several release families' tags apart in one repository, and the bare `v<version>` form stays readable — and carries its bundle tarball as `<package name>-<Harness version>.tgz` — for this package, `freecodego-0.1.7-alpha.2.tgz` for the bundle built for Harness `0.1.7-alpha.2` — so one request answers both questions a check asks: which version is newest, and which Harness it was built for. The asset names the Harness line rather than the bundle version, so that a hotfix stays identifiable: its tag is the exact version, one dotted segment deeper, while its asset still says which line it belongs to. A release whose asset carries the bundle version instead installs too — the lookup accepts both spellings and falls back to a release's only tarball — because a name that disagrees with the tag is not a reason to leave an update unreachable. Only a release for the running Harness is offered — an exact match, or a hotfix one dotted segment deeper — and the highest one wins. Checks run shortly after startup and then daily; installation runs `dsh plugin add --save-exact <tarball url>`, the same entry point the user installed with, and stages the result in a sibling Profile before atomically promoting it. The pre-update Profile stays available until the restarted Host remains healthy, and the settings page can restore it before confirmation. A version can be withdrawn by editing its release, which a published npm version cannot; updating never restarts the process implicitly, so a Host restart is required before the new bundle is loaded.

<a id="zcode-glm-53-flash-promotion"></a>
## Zcode GLM-5.3 Flash Promotion

The Zcode model directory annotates `glm-5.3-flash` only when the Host has a Coding Plan credential for the active Z.AI account. The limited-free window is calculated in `Asia/Shanghai`: before the 20th of each month, from 23:00 to 09:00 the next morning, requests are displayed as not consuming tokens. The model remains available outside the window, but the UI clearly reports that the limited-free period is inactive; no client-side clock or account claim can grant the entitlement.

<a id="mcp-and-skills"></a>
## MCP And Skills

The `freecodego-harness-plugin` entry's settings document stores switches, third-party MCP servers, and extra Skill roots. Both switches default to on, because both are additive: they mount what the inventory names and nothing else, so an off default only made the capability wait for someone to find the switch. Enabled MCP servers are connected once by the Host and registered as Harness tools for the DeepSeek engine. Claude receives the discovered schemas through its in-process `freecodego-host` MCP server and calls the Host bridge, while Codex receives the same enabled server definitions in its plugin-owned app-server config.

Enabled Skill roots are discovered by the Harness filesystem Skill provider. A skills.sh installation atomically registers the Host-owned community directory as an enabled custom root, so the imported one-level `SKILL.md` bundle is visible immediately to DeepSeek and to the next native session. Claude loads enabled Skills through the Host bridge and Codex receives them through `skills/extraRoots/set`. Disabling a capability unloads its managed provider and prevents future native sessions from receiving it; existing sessions must be restarted to replace their native app-server inventory.

The embedded community page reads bounded, paginated MCP.so and skills.sh metadata through Host Remotes. MCP entries are one-click installable only when their published detail contains an HTTP endpoint or stdio command representable by the shared registry and no unresolved environment or header values; entries requiring credentials stay in manual configuration instead of reporting a nonfunctional installation. Skill entries import a matching `SKILL.md` only from a validated GitHub source repository into the Host-owned community Skill root.

A Skill install is a record that can be checked, not a copy: the source is read through spellings like `owner/repo#ref&path:…`, the payload is staged and promoted atomically, and `skill-lock.json` is written **last** with the commit the content actually came from — the pin the card shows, and the reason a Skill that landed without a record says so instead of reporting success. A same-name collision is refused, naming both sources, before any byte reaches the root; removal goes through the same record, deleting the directory first and the entry second, so the record never describes files that are gone.

An install can also choose where it lands. The placement table is `--agent` × `--scope` — `harness`/`agents` × `project`/`user` — resolved against the folder this Host runs in, and the project tier requires a trusted folder: the gate runs **before** the path is built, because an untrusted checkout's `.agents/skills` is a directory that repository controls. The page renders the whole matrix including the reason an unusable row carries, so an untrusted folder cannot look like a combination that does not exist, and the chosen axes travel to the Host, which resolves them again on its own side — a folder can lose its trust between the two reads. Each placement mounts its own managed-root id, since reusing the community root's id would unmount the list the page reads its own entries from, and removal searches every managed root, so a placed Skill is removable from the card it was added on.

That destination is remembered, and where it is remembered is deliberate: the choice is written to the settings document of this plugin's own composition entry (`preferredSkillPlacement`, two axes — never the root they resolve to, which is derived from the workspace, `$DSH_HOME` and the home directory and would outlive all three), so it survives a restart, is readable and editable in the settings file beside the other switches, and is shared by every client of this Host rather than living in one browser's local storage. A remembered destination whose row is unusable here is still reported and still sent: the install is refused with the matrix's own reason instead of quietly landing in the community root, because a preference that silently redirects is worse than one that says why it cannot be honoured.

<a id="optional-harness-capabilities"></a>
## Optional Harness Capabilities

Browser control, desktop control, and session-history retrieval are the Harness's own capabilities, and no bundle mounts any of them: this bundle carries their rows in `bundle-latest/cordis.patch.yml` with `disabled: true`, so a deployment that wants one turns it on where its other Loader entries are managed instead of editing a file inside `node_modules`. All three rows are off for two reasons that hold for every one of them.

None of those packages is in this bundle's `peerDependencies`, the list that is the install contract, so an enabled row would name a package the Harness need not supply. And an unresolvable row fails at a different grain depending on where it is mounted: a preset carrying one is reported broken and becomes unselectable, while a Host-plane row fails that entry alone, because the Loader catches the import error, logs it, and keeps the rest of the tree running. The Host plane is therefore the only plane that can hold an optional capability at all.

The capability is the Harness's; the engine behind it may not be. This table is what a deployment is actually consenting to, with the license each dependency carries:

| Capability | Mounted rows | Drives | License |
|---|---|---|---|
| Browser control | `browser-use`, `browser-use-playwright-mcp` | [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Apache-2.0 |
| Desktop control | `computer-use`, `computer-use-cua-driver-native` | [Cua Driver](https://github.com/trycua/cua) | MIT |
| Session-history retrieval | `tool-session-query` | nothing outside the Harness | MIT |

### Browser control

Enable both rows. `mode` is required and has no default: the row ships `mode: launch` with `headless: true`, and `mode: attach` with an `endpoint` drives a browser you already have open, keeping its tabs and login state. The service holds a single provider slot and rejects a second registration, so Chrome DevTools MCP and Stagehand are swaps rather than additions.

The prerequisite is a browser the upstream runtime can launch; an existing Chromium is named with `executablePath`. A launched browser belongs to the live Agent and Session, is reused across turns of that session, and is closed when its session runtime is disposed — reloading or forking starts fresh state, with no cookies or pages restored from the log. An attached browser stays externally owned and is reserved for one session. Initialization completes before creation or resume does, so a provider that cannot start rejects that creation instead of continuing without a browser, and a cancelled call cannot undo a browser action already delivered.

One configuration hazard is worth carrying over from upstream: when the system prompt's `toolOrder` is configured, browser tools have to stay under `<unlisted-tools>`, because listing them explicitly can make prompt assembly fail for sessions that hold no browser connection. This bundle sets no `toolOrder`.

### Desktop control

Enable `computer-use` and `computer-use-cua-driver-native`. The native provider has no configuration fields and loads the exact Cua Driver npm version declared beside it. The alternative is `computer-use-cua-driver-mcp`, which drives an already installed `cua-driver` executable over MCP — the choice when a separate application should own desktop permissions and execution, at the price of installing one.

The prerequisites are the machine's rather than the deployment's: platform binaries arrive through npm optional dependencies, so those must stay enabled, and the application that launches the Host needs desktop permission grants. The native runtime shares the Host process, which its own documentation states plainly — a native crash can terminate the Host. Screenshots additionally need an attachment store and a model route that declares image input.

One registered provider does not reserve a desktop for a session, so callers coordinate whole observe-act-verify workflows themselves, and a cancelled call cannot undo input the desktop already received.

### Session-history retrieval

This one is a single row and adds no dependency to install: `tool-session-query` injects services the base composition already mounts, so enabling it is the whole opt-in for the tools themselves.

Content search is a second switch, and this part is easy to miss. The base mounts `session-query-sqlite` with `openAt: never` deliberately: the query service stays available for exact reads, titles, and lineage while SQLite is never opened. Enabling the tools without the override below therefore yields five tools of which three work and two always answer `SESSION_QUERY_SEARCH_DISABLED`, and the Web sidebar keeps matching titles and workspace names only. This bundle's patch file is the later patch layer the base names, so the pair belongs together:

```yaml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-index.db')
    openAt: first-search
```

The five tools are read-only, and cross-session access is authorized per call by exact `cwd` equality with the caller's own session. The cost is prompt surface: enabling the package adds fixed guidance plus five tool schemas to every model request, which `engineering_surface_report` reports as injected bytes against the reviewed lock.

<a id="third-party-plugin-tools"></a>
## Third-Party Plugin Tools

Native Codex and Claude sessions project the same Agent-scoped Tool schemas that Harness exposes to DeepSeek. This includes tools registered by later third-party plugins, such as canvas or domain-specific workflow tools; FreeCodeGo does not maintain a name allowlist. Calls return through the Host ToolRuntime, so the original plugin still owns validation, permissions, audit events, cancellation, and execution. MCP and Skill capabilities may also retain their specialized native integrations, but the generic projection never hides a third-party tool merely because of its name.

Codex refreshes this inventory before every prompt and Claude rebuilds its in-process MCP server for every query. Installing, disabling, or restricting a plugin therefore takes effect on the next native turn without recreating the conversation. Only schemas visible in `ctx.tools.schemas(agent)` are projected; Host or scope-hidden tools never cross the native bridge.

<a id="media-defaults"></a>
## Media Defaults

The Host registers `freecodego_generate_image`, `freecodego_generate_video`, and `freecodego_generate_audio` for DeepSeek, Codex, and Claude. Each execution reads the live image/video/audio default from this entry's `mediaDefaults`; the model-facing schema deliberately has no model override. Gateway requests reuse the Host-vault account token and the selected model's route key. Agnes defaults reuse the existing Agnes Host client. Base64 image responses are admitted to Harness attachment storage and returned as image content blocks; audio bytes are saved under the active workspace's `.freecodego/generated-media` directory.

### The image/video switch

`mediaGenerationEnabled` (on by default) is the master switch for producing pictures and clips. It governs `freecodego_generate_image`, `freecodego_generate_video`, and the legacy `agnes_generate_image` / `agnes_generate_video` aliases, which are the same capability under older names. Turning it off **unregisters** them: the names leave the model's tool list entirely instead of failing at call time, because the thing being switched off is the cost of carrying those schemas in every request. `freecodego_generate_audio` and `freecodego_transcribe_audio` are deliberately outside it — one writes a file into the active workspace and the other reads one out of it, so neither is what "stop making pictures and clips" asks to lose. The settings page renders the switch together with the names it governs (`mediaGenerationStatus` / `mediaGenerationSetEnabled`), reporting what the switch owns separately from what the profile actually mounted: a profile with no Agnes account is not described as missing tools it never had.

### Which protocols

The transport is chosen from the **provider**, never from a keyword in a model id: a gateway model whose id contains "image" is still the gateway's, and sending it down another provider's transport fails with a credential error that names the wrong cause. Image generation speaks six shapes:

| Provider family | Endpoint and body |
|---|---|
| `openai`, `grok`, the gateway (`freecodego` / `logfare` / `agnes`), and every unrecognized provider | `POST /images/generations`; `response_format: b64_json`, except on `gpt-image*`, which reject that field |
| the same, with reference images | `POST /images/edits` (`image`, then `images[]`) |
| `volcengine` / `ark` / `seedance` / `bytedance` / `doubao` (Seedream) | still `/images/generations`, with sources in `image: [...]` |
| `google` / `gemini` | `POST /models/{model}:generateContent` with `responseModalities: ['TEXT','IMAGE']` |
| `google` / `gemini` whose id contains `imagen` | `POST /models/{model}:predict`; a source frame must be inline base64, since that protocol has no field for a URL |
| `dashscope` / `qwen` / `aliyun` | `POST /api/v1/services/aigc/multimodal-generation/generation`, sizing written `2048*2048` |

Responses are read in five vendor shapes in a fixed order — the Images API's `data[]`, Gemini's inline parts, Imagen's `predictions[]`, DashScope's `output.choices[].message.content[].image`, and the Responses API's `output[].result` — so a body matching two of them cannot produce the same image twice. A URL-only result is downloaded into attachment storage, because an image the user cannot see is not an image; only a failed download keeps the URL.

Video generation speaks nine protocols:

| Protocol | Providers it matches | Create → poll | Known durations |
|---|---|---|---|
| `kling` | `kling` / `kuaishou` / 可灵 | `/videos/text2video` · `image2video` · `multi-image2video` → the same path plus `{id}` | 5 or 10 seconds (spelled as strings) |
| `ark` | `volcengine` / `ark` / `seedance` / `bytedance` / `doubao` | `/contents/generations/tasks` → `/contents/generations/tasks/{id}` | not declared |
| `dashscope` | `dashscope` / `aliyun` / `qwen` / `wanx` | `/api/v1/services/aigc/video-generation/video-synthesis` (requires `X-DashScope-Async: enable`) → `/api/v1/tasks/{id}` | not declared |
| `minimax` | `minimax` / `hailuo` | `/v2/video_generation` → `/v2/query/video_generation/{id}` | not declared |
| `vidu` | `vidu` | `/ent/v2/text2video` · `img2video` · `start-end2video` · `reference2video` → `/ent/v2/tasks/{id}/creations` | not declared |
| `gemini` | `google` / `gemini` | `/models/{model}:predictLongRunning` → the operation `name` | not declared |
| `xai` | `xai` / `grok` | `/videos/generations` → `/videos`, or `/videos/edits` · `/videos/extensions` when a source video is given | 2 through 10 seconds |
| `openai` | `openai` | `/videos` → `/videos/{id}` | not declared |
| `gateway` | the gateway, and every unrecognized provider | `/videos/generations` → `/videos/generations/{id}` | not declared |

Kling authenticates with an HS256 token minted from `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` (falling back to a single bearer key, which is what an OpenAI-shaped reseller in front of it expects) and Vidu uses `Authorization: Token` rather than `Bearer`.

A duration a route cannot render is a **route limitation, not a bad request**: the message names the durations that route accepts and the fallback ladder tries the next one, rather than clamping the value and returning a shorter video than was asked for. "Not declared" means the plugin does not encode that provider's window and passes the caller's value through unchanged — inventing a window would turn a request the provider can serve into a refusal.

### Which models

The roster is **live, not pinned**: candidates are collected on every request from the Harness model directory (whatever you configured on the Models page), the managed catalog, the Logfare directory, and the Agnes directory. A route's category is inferred from its id (`veo` / `seedance` / `kling` / `sora` / `wan` → video; `gpt-image` / `dall-e` / `imagen` / `flux` / `sdxl` / `stable-diffusion` / `midjourney` / `ideogram` / `recraft` / `qwen-image` → image) and can be overridden by hand in the settings page's model categories. Known entries include the gateway's `gpt-image-2` (`images/generations` + `images/edits`) and Logfare's `flux-1-schnell`, `flux-2-dev`, `flux-2-klein-4b`, `flux-2-klein-9b`, and `sdxl-lightning`.

Every call carries a per-route circuit breaker: two consecutive failures put that route behind healthy ones for five minutes, and a route that declined by its own declaration (a length it cannot render) is not counted as a failure, because it never sent anything. Only a route's own problem — exhausted balance, a disabled endpoint, a rate limit, an outage — falls through to the next route. A wrong credential or a refused prompt fails outright, since every other route would answer the same way at the price of another paid video task.

<a id="model-picker-and-provider-accounts"></a>
## Model Picker and Provider Accounts

The model list a user actually reads is the stock Harness menu, and the Host registers every adapter it can serve. Six mechanisms shape what that menu shows and how it behaves.

**Browser-mediated OAuth sign-in.** The plugin has no window to receive a browser fragment and no `freecodego://` protocol handler, so it drives the existing `/auth/oauth/{provider}/start` flow with `redirect=/oauth/desktop?state=<ours>&plugin=1`. The backend callback stores the issued pair under that state (and shows the user a plain confirmation page instead of a deep link) while this side polls `GET /auth/oauth/desktop/poll` until the pair arrives, then adopts it into the Host credential vault. The same card completes MFA and can bind or create the account, sending the verification code through Host Remotes.

**What the picker shows is the user's decision.** The Accounts-and-providers page is the only place a user can say "I do not want WorkBuddy in my model list", because the Host registers every adapter it can serve. Storage is *negative* — visible unless explicitly recorded hidden — with two declared exceptions: a metered provider defaults its priced rows to hidden, and a curated provider defaults its unnamed rows to hidden. Only decisions that disagree with the default are stored, which has three consequences worth stating: nothing changes for a user who never opens the controls, a model a provider adds later arrives visible, and a newly added **priced** model does not arrive switched on by itself. The price is asked per row rather than per provider, because a metered provider's roster usually holds both. The control is read by the picker decorator, so the answer reaches a menu that is already open beside it, and the panel owns its own storage subscription because the setting belongs to the provider rather than to whichever page rendered it.

**The stock menu is labelled, not replaced.** The official selector remains the owner of selection, focus, scrolling, and reasoning effort; this layer only appends non-interactive labels (source, price class, provider health) to model rows that expose the stable ARIA menu contract. So a user learns which rows are free, metered, or degraded without a second picker existing to drift out of sync.

**A refused selection never reads as an applied one.** A wrapper that only watches for a throw treats a refusal as an applied selection and clears the reason it just wrote, so the echo checks the *result* the directory publishes (`status: 'error'` plus the message) and keeps the throw branch only for the case where a Session cannot select at all.

**A short-lived reconnect does not empty the menu.** A separate retry layer observes the directory, recognises transport failures (`failed to fetch`, `carrier offline`, `remote event generation ended`, an aborted remote invocation), and re-loads on a 1 minute / 10 minute / 30 minute backoff without clearing the last good directory. A menu that was open when the carrier dropped recovers instead of going blank, and repeated installation keeps one subscription rather than adding another per render.

**A cold catalog in milliseconds, not seconds.** The Host builds its model catalog by asking every registered route for its model list at once, waiting for the slowest answer, and then resolving metadata for every model it got back. Twelve of this deployment's thirteen routes belong to this plugin, and they are the only ones that must read a network directory — each connector rotating accounts through its own endpoint with a multi-second budget. Measured against a restarted Host, the first catalog took 5,528 ms and the warm one 12 ms, and for those 5.5 seconds the menu had no provider group to draw, which is what made the picker look like it had not opened at all. The FreeCodeGo half is therefore answered from the directory this deployment already knows (`known-provider-catalog.ts`) instead of from a fresh round of provider reads.

**One failure table, three decisions.** The same failure arrives in a different shape from every route — a `fetch` rejection, a status code on a custom error, a DOMException from an abort signal, an adapter's machine code, a provider's own wording — and reacting to the message at each call site is how a rate limit gets retried forever while a context overflow is retried until the budget is gone. `provider-error-classify.ts` funnels every failure through one table, and each kind maps to one decision: retry, cool the account down, or fail the turn.

<a id="settings-migration-orphan-engineering-keys"></a>
## Settings Migration: Orphan Engineering Keys

A DSH home can be written by more than one build of this plugin. The published alpha package writes four keys this repository never reads — `engineeringProfile`, `engineeringTelemetryEnabled`, `engineeringLearningDraftsEnabled`, and `engineeringTelemetryRetentionDays` — so a home that was used by both builds ends up carrying dead settings: no code path reads them, the settings page never shows them, and nothing fails, which is exactly why they are worth naming.

They were removed from the local home with the rest of the file preserved byte-for-byte (backup left beside it as `settings.yaml.bak-orphan-keys-*`). The capability they *name* is not uniformly absent here:

| Removed key | State in this repository |
| --- | --- |
| `engineeringLearningDraftsEnabled` | The behaviour exists, but not as a tool: the Skills section of settings derives drafts through the `engineeringSkillDraft` Host Remote, which writes them under `.freecodego/skill-drafts/` from memory the user already reviewed. It is not switchable today. |
| `engineeringProfile` | No profile tiering exists; the individual switches are the contract. |
| `engineeringTelemetryEnabled` / `engineeringTelemetryRetentionDays` | No telemetry collection or retention exists in this build. |

If an alpha profile is still in use under `profiles/freecodego-alpha`, its own settings document is separate; removing these keys from the shared home does not touch it, and the alpha build will re-add whatever it needs the next time it runs.

<a id="community-plugins"></a>
## Community Plugins

The community plugin page reads the active profile dependencies and bundle list to show installed plugins. FreeCodeGo records the source URL and direct package names returned by each installation, so GitHub and multi-package installs remain recognizable. Uninstall first disables matching Loader entries, then removes the direct dependencies and bundle activations from the profile; the next Harness start cannot load the removed plugin.

When a `gateway` is configured, the bundle reuses the existing FreeCodeGo v1 routes for mobile authentication, bootstrap/model state, quota, runtime health and model pricing. Browser Remotes receive only redacted state. No provider-specific credential is exposed through the UI.

`gateway.baseUrl` defaults to `https://freecodego.com` and must be an HTTPS deployment address. The plugin does not use an HTTP loopback gateway.

WorkBuddy is a separate `workbuddy` provider. It uses the WorkBuddy CN device authorization flow (`POST /v2/plugin/auth/state?platform=CLI`, browser `authUrl`, then `GET /v2/plugin/auth/token?state=...` and `GET /v2/plugin/login/account?state=...`). Access and refresh tokens are stored through the Host credentials service under `WORKBUDDY_AUTH`; browser Remotes receive only redacted status. `GET /console/enterprises/personal/models` is filtered to the real `cli` agent models, and chat uses `POST /v2/chat/completions` with one automatic refresh/retry after HTTP 401. The login flow requires the user to complete the opened browser authorization; the plugin does not bypass CAPTCHA, device confirmation, or other manual steps. Multiple WorkBuddy accounts are stored under the Host credential reference and shown as redacted account rows. Chat and model requests rotate through accounts; HTTP 401 reauthentication failures and 402/429 quota responses cool the affected account before the next account is attempted.

Agnes AI is a separate `agnes` provider. Its Host-only account flow uses the documented control-plane endpoints for verification, registration, login, and API-key creation, then stores the returned session and generated API key under `AGNES_AUTH` and `AGNES_API_KEY`. The API route is `https://apihub.agnes-ai.com/v1`; the browser receives only redacted status.

Local OpenAI-compatible and Anthropic-compatible providers use the existing `@deepseek-ai/dsh-llm-pi-ai` plugin and the shared Models settings editor. Add routes under its `providers` configuration and store `apiKeyEnv` values through the Harness credential service. For example:

```yaml
- id: freecodego-local-openai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      freecodego-local-openai:
        displayName: FreeCodeGo local OpenAI
        api: openai-completions
        baseURL: https://gateway.example/v1
        apiKeyEnv: FREECODEGO_LOCAL_OPENAI_KEY
        models:
          - id: coding-model
            name: Coding Model
            contextWindow: 128000
            maxTokens: 16384
```

The settings page covers the account: quota, usage and the live model pricing table.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt sections

#### What the model sees

The plugin contributes numbered `ctx.systemPrompt.section` blocks instead of editing Harness-owned text: the Plan Mode rules, the context-discipline rules, and one line per composite tool it mounts. A section exists only while its switch is on, so a composition that disables Plan Mode or mounts no token meter contributes no section for it.

##### Composite edit guidance

```markdown
Use edit_and_run when a change and the check that proves it are one step: give the edit and the verification command together. The command runs only if the edit landed, and both results come back in one call.
```

#### Token effect

Every mounted section is charged on every request in its session. The Plan Mode and context-discipline rules are the two longest; each per-tool line is one sentence, and an unmounted section costs nothing.

#### KV Cache effect

Fixed text at fixed `order` values stays inside the cached prefix across turns. A settings change that mounts or unmounts a section shifts every later section, invalidating the prefix from that point on.

### Advisor and engineering tools

#### What the model sees

`advisor_status`, `advisor_review`, and `advisor_notes` expose the independent Advisor: its route, one bounded review, and the durable notes it already recorded. The engineering suite (`engineering_status`, `engineering_inspect`, `engineering_context_budget`, `engineering_context_compact`, `engineering_context_snip`, `engineering_context_prompt`, `engineering_surface_report`, `engineering_plan_mode`, the `engineering_team_*` verbs, and the `engineering_memory_*`, `engineering_graph_*`, `engineering_codegraph_*`, and `engineering_checkpoint_*` families) exposes the durable board, memory, repository graph, and checkpoints. Media generation arrives as `agnes_generate_image` and `agnes_generate_video` only when a media provider is authorized. Every one of those names is declared once, in `tool-manifest.ts`, together with what holding it needs and whether Plan Mode may call it. That table is what the Plan Mode fence and the verification gate read, and a test checks it against the registration literals in the source in both directions — so a tool this page names but the plugin does not register fails the suite rather than this paragraph.

#### Token effect

Every registered tool costs its description and argument schema in the request, which is why the list stays closed and the largest entries are fetched on demand: `tool_search` returns a deferred description and `headroom_retrieve` returns a spilled result only when the model asks for one.

#### KV Cache effect

Registration order is stable, so the tool block sits inside the cached prefix. Mounting or unmounting one tool family rewrites the block and invalidates the prefix from that tool onward.

### Injected guidance

#### What the model sees

Advisor guidance arrives as a follow-up turn, never as a rewritten earlier message: a concluded review is delivered as `record`, as an injected turn, or as a steer, and the Agent reads it in the turn that carries it. Plan Mode rules are stated in their own section rather than folded into the tool descriptions.

#### Token effect

A delivered note is charged once, in the turn that carries it. The durable `advisor/note`, `advisor/delivery`, and `advisor/state` records are log-only and never enter a request.

#### KV Cache effect

Injection appends after the cached prefix, so a delivered note leaves earlier cache intact — the reason this channel exists instead of a prompt rewrite.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

These limits define when this plugin needs special operational care. They are current constraints, not a task backlog.

- **Verification history is process-local** — persisted jobs and cancellation are not exposed yet.
- **The context budget needs a mounted token meter** — without one, pressure reads as unmeasurable rather than zero and the fragment is absent.
- **Cache waste is attributed from the local ledger** — the gateway reports billing totals, not per-turn request prefixes, and dollars are attributed only when the range carries rates, because an unpriced figure is worse than none.
- **The action reviewer is complete policy with no reviewer attached** — `action-review.ts` stays unbound on the per-tool hot path, where a model review would add the request per tool call this plugin exists to reduce.
- **Tier selection infers coverage from changed paths** — it says "this change arrived with a test-file change" and never "these tests exercise this change"; a caller that knows real coverage should pass it directly.
- **The side-channel threshold derives from `compaction-basic`'s default ratio** — a composition that overrides that ratio makes the figure approximate, which is why the check warns and never refuses.
- **Cache-cold clearing edits the request only** — it cannot delete a cached prefix on the server.
- **The credential scanner is a curated subset** — it is not a general secret detector, and it screens memory writes only; engine audit summaries and exported bundles keep their own field-keyed redaction.
- **Code Graph invokes the official CLI** — code-only build, incremental update, and bounded read-only queries.
- **Graphify's sidecars remain release gates** — the internal MCP sidecar, persisted build queue, user cancellation, dependency hash lock, runtime update channel, and Canvas adapter are not shipped.
- **CodeGraph has no Canvas adapter and no `overview` tool** — its CLI ships no hub-ranking or whole-graph export command, so the bounded Canvas projection stays Graphify-only.
- **Freshness comes from hooks, not a background watcher** — both engines update from the post-turn auto-update hook and explicit user actions, and `codegraph` runs without its daemon so a query never contends with a second writer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the Host plugin's lifecycle and published services are covered by its composition tests.

The sections above are ordered by what a reader arrives with, not by mount order: routing and review first, then the engineering surface, then context discipline (the group of features that exist to keep a long session affordable), then the surfaces a deployment configures (settings, media, providers), and finally the operational notes for an installed home.

Where a Harness package already owns a capability, this plugin attaches to it instead of registering a second implementation, and the enhancement it still keeps is stated next to the section it belongs to. That rule is recorded per conflict in [`../../../COMPATIBILITY.md`](../../../COMPATIBILITY.md).

</details>

**Runtime invariant:** every capability above is gated by the settings switch its section names, and no section registers a second implementation of a Harness-owned contract.
