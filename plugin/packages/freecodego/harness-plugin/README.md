---
description: "The installable Cordis bundle that mounts the FreeCodeGo engine inventory, Host configuration surface, engineering tools, and settings Remotes for DeepSeek Harness."
kind: "package-reference"
---

# dsh-freecodego-harness-plugin

English | [中文](README.zh.md)

## Summary

Installable Cordis bundle for the FreeCodeGo root-engine inventory and Host configuration surface.

The bundle mounts `dsh-agent-engine` and publishes one standard DeepSeek engine descriptor plus Codex and Claude descriptors. Native engines are admitted only when their verified artifact manifest, digest, protocol ABI, worker path, and state directory are supplied together. The companion router is the single Harness `AgentFactory`; a requested native engine never falls back to DeepSeek.

`setDefaultEngine` changes the engine used by future sessions. When `ctx.settings` is mounted, the choice is persisted in the `freecodego-harness` namespace; existing sessions remain pinned to their durable engine plan. Claude credentials are resolved from `ctx.credentials` immediately before the private worker is spawned and never cross the Remote or native JSONL protocol.

`setDefaultModel` persists a compatible managed model id alongside the engine; new-session defaults include both values while existing sessions remain pinned.

Where this README names a decision, the decision is the contract: a feature is gated by the settings switch it names, an ownership conflict with the Harness is settled in favour of the Harness, and a capability this plugin does not implement is stated as deferred rather than implied by silence.

## Table of Contents

- [Documentation](#documentation)
- [Subagent Model Routing](#subagent-model-routing)
- [Advisor Review Loop](#advisor-review-loop)
- [Engineering Enhancement](#engineering-enhancement)
- [Context Compression (Headroom)](#context-compression-headroom)
- [Context Discipline, Command Policy, and Plan Mode](#context-discipline-command-policy-and-plan-mode)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Plugin Conflict Protection](#plugin-conflict-protection)
- [NPM Updates](#npm-updates)
- [Zcode GLM-5.3 Flash Promotion](#zcode-glm-53-flash-promotion)
- [MCP And Skills](#mcp-and-skills)
- [Third-Party Plugin Tools](#third-party-plugin-tools)
- [Media Defaults](#media-defaults)
- [Settings Migration: Orphan Engineering Keys](#settings-migration-orphan-engineering-keys)
- [Community Plugins](#community-plugins)
- [Dev Note](#dev-note)

-----

## Documentation

This README is the top-level document: it describes every feature the plugin mounts, what it decides, and why. Two topics are large enough to live beside it, and both are written in Chinese:

- [`docs/free-providers.zh.md`](docs/free-providers.zh.md) — the free-model Provider integrations (Cline, WorkBuddy International): upstream contracts, the account pool, and the rotation semantics both adapters implement.
- [`freecodego-api/docs/backend-contract.zh.md`](../freecodego-api/docs/backend-contract.zh.md) — the endpoint-by-endpoint contract between this plugin and the FreeCodeGo backend, including which field owns routing outcomes and billing.

Everything else lives in the package READMEs under `packages/freecodego/`: `harness-ui` for the settings surface, `freecodego-api` for the backend client, `agent-engine-router` for route selection, `root-agent` plus `runtime-codex` / `runtime-claude` / `native-runtime-host` / `native-runtime-protocol` for the native engines, and `bundle-latest` for release assembly.

## Subagent Model Routing

With `autoSubagentModelSelection` enabled (the default), the Host synchronizes every live text-model route into Harness' `subagent-model-selection` setting. New top-level sessions therefore receive the standard `subagent` fields `provider`, `model`, and `reasoning_effort`, plus the on-demand `list_subagent_models` discovery tool, without requiring a user-maintained checkbox list. A temporarily failing provider retains its last authorized routes until its catalog recovers.

Spawned children inherit the parent's FreeCodeGo execution engine and may override the exact LLM route per delegation. DeepSeek executes the child in the official AgentLoop; Codex and Claude keep their native runtime while routing the selected model through the Host bridge. Existing sessions retain their durable Subagent policy; create a new conversation after the authorized catalog changes.

## Advisor Review Loop

The independent Advisor is enabled by default on the public `freecodego/hy3` route. It reviews durable turn events with a separate model context and has only bounded, read-only workspace tools (`read`, `glob`, and `grep`). Its findings and token usage are appended to the Harness session; credentials, hidden reasoning, and unrestricted primary-Agent tools are never copied into the review context.

Every DeepSeek, Codex, and Claude Agent receives `advisor_status`, `advisor_review`, and `advisor_notes`. This lets the active Agent inspect the reviewer, request a second opinion at a useful checkpoint, and consume prior findings without a separate UI action. A concrete concern or blocker steers the Agent, while low-severity or cooldown findings are injected at the next safe step. Native Codex and Claude consume steering as a subsequent native turn and stage injections until the next user turn. Disabling Agent control keeps findings as `record` events only. Changing the Advisor route or delivery settings applies live; native sessions refresh their projected Harness tools before each turn.

Session deletion is idempotent for stale sidebar rows: when a session log was already removed but a cached projection still lists the id, the Host clears its workspace association and returns success instead of leaving an undeletable Ungrouped row. Live or running sessions still must be closed before deletion.

## Engineering Enhancement

### Multi-engine Engineering Team

The Engineering Team keeps the current root Agent on its selected engine while starting isolated DeepSeek, Codex, and Claude child Agents for a bounded, read-only review. `engineering_team_start` accepts an objective and draft plan, runs an independent round, optionally runs one cross-examination round, and records consensus, dissent, participant states, and a final recommendation in the parent Session. A child cannot edit files, execute shell commands, create another team, or change permissions. Missing runtimes and failed participants are reported independently; the team reaches quorum only when the configured minimum number of participants completes.

The team can run in the foreground or return a `council_*` id for polling with `engineering_team_status`; `engineering_team_cancel` cancels all child Agents. Completed reports remain available through `engineering_team_report` and the `engineeringTeamReports` Host Remote after the parent Session is restored. Set `engineeringCouncilAutoRun` to run a review automatically after an approved `exit_plan_mode` plan; it is off by default so users retain explicit control.

A completed report is evidence, not edit permission. The user must explicitly approve or reject it through the engineering team approval command or the `engineeringTeamDecision` Remote before implementation. Only an approved report can run engineering team verification; the default run records `scope`, `build`, `types`, `lint`, and `tests` results in the parent Session.

#### Multi-member team

`engineeringTeamEnabled` (on by default) adds the runtime a team needs to be more than several agents in one directory:

| Surface | Tools | What it guarantees |
|---|---|---|
| Task board | `engineering_team_board`, `engineering_team_plan`, `engineering_team_claim`, `engineering_team_task_update` | One owner per task, dependencies gate availability, availability is id order, only the owner closes a task |
| Members | `engineering_team_member_start`, `engineering_team_member_stop`, `engineering_team_recover` | Each member is a real child Agent with a role-scoped tool allow list; membership is durable on disk, liveness is read live and never mirrored |
| Merge | `engineering_team_merge` | A conflicting merge is aborted before it is reported, and the conflicting paths are named in the report |
| Context | `engineering_context_compact`, `engineering_context_snip`, `engineering_context_budget` | Compaction is available on demand instead of only under pressure, and the model can ask how full its window is before it decides |

The **board is the spine**. Tasks are handed out in id order, a task whose dependencies are unfinished is never offered, and a claim cannot be stolen: a refusal names who holds the task or what it is waiting for, because those need different fixes. Only the current owner may complete or fail a task, which is what makes the board an audit of who did what rather than a wish list. A task blocked by a failed dependency is *derived*, not stored, so retrying the dependency clears it without a status migration.

**Waiting on a person is a state, not a verdict.** A member that needs a human had two ways to say so and both were lies: `failed` claims the work is broken (and turns every dependent into a blocked task), and staying `claimed` says nothing at all. `needs-review` records it — who is waited on, since when, which claim it belongs to — the board counts it in its own bucket and names the parked tasks, its owner resumes it once the answer arrives, and `rerun` reopens a failed or cancelled task under the same id instead of `create` minting a new one and losing the attempt count. Every status change is appended to a per-task ledger by the single writer, because the latest `note` cannot answer the question that matters later: why the previous step happened.

**Every writer gets its own git worktree** on its own branch, created by `git worktree add` under `.freecodego/worktrees/<member>` (added to `.git/info/exclude`, so the isolation does not become untracked noise). The shared tree changes only on `engineering_team_merge`, and a conflicting merge is git-merge-aborted *before* the conflict is reported — isolation is only worth anything if a failure stays local. The branch survives a release; it is deleted only after it has been merged.

**Isolation is granted only when it can be, and withdrawn only when it is safe.** Three rules sit on that pair of verbs. A worktree that still holds uncommitted changes is *kept* — `release` reports the paths it found and asks for `acknowledgeLostWorktree: true` before it discards anything, because a cleanup that silently destroys a member's only copy is the one step in this module that can lose work. A removal that failed leaves the registration `active` and says so, rather than marking the entry abandoned while its directory is still on disk, which is how a worktree becomes invisible to every later cleanup. And `allocate` refuses a **dirty workspace**: a writer branches from `HEAD` so no uncommitted edit reaches the copy, but the dirty tree *is* the state a later merge lands on, and "merge into a tree with edits" has no defined base — `allowDirtyWorkspace` is the explicit way to say that was understood. A copy that is already there, clean and on the member's own branch, is handed back instead of failing (`git worktree add` refuses a path that is already checked out), while a registration whose path or branch disagrees with the convention is refused by name rather than reused.

**The isolation facts are stored, not reconstructed.** `engineering_team_recover` reports each live worktree through a locked field set — `workspaceMode`, `worktreeMode`, `teamStateRoot`, `workingDir`, `worktreeRepoRoot`, `worktreePath`, `worktreeBranch`, `worktreeDetached`, `worktreeCreated`, `worktreeState` — read from the durable record rather than re-derived from the directory name, because a reconstruction is exactly what silently disagrees once a second naming convention exists. One list (`LOCKED_ISOLATION_FIELDS`) is what the report selects and what a test pins, so a field added to the record and forgotten in the report is a failing test. The record is derived from the entry rather than stored beside it: `path`, `branch`, `strategy` and `createdAt` already persist there, and a second stored copy of the same fact is an invariant with two owners.

**Roles are data** (`team/roles.ts`, overridable per project in `.freecodego/team-roles.json`). Each role carries purpose, capabilities, a tool allow/deny list, a model, a turn cap, a sandbox mode, a report contract, and — the line that keeps duties separate — an explicit *not responsible for*. The allow list is intersected with the capability set, so a role that cannot write cannot be handed a write tool by naming one, and `explorer` and `verifier` are read-only by construction. A member's brief is generated from its role record, so adding a role is adding a record, not a prompt branch.

**Membership is durable; liveness is not mirrored.** The board records an owner by member id and a writer's worktree is registered against one, so both survive the process that created them. Because the board and the member registry are on disk, `engineering_team_recover` can answer after a restart what was in flight: which member stopped, the task it held, and the worktree whose work is still on disk. Everything else about a member — is it still running, what has it said — is read from the live child Agent rather than copied into a file, because a mirror of another process's state can only ever be wrong.

**Context control is manual as well as automatic.** The Harness compacts on pressure, and its automatic pruner and compactor ship disabled. The two tools here let the model act on the one thing it notices first — that a region is finished with — and they report `changed: false` with a reason when the engine found nothing safe to replace, rather than claiming a compaction that never happened. Snipping validates tool-call pairing; an unbalanced boundary is refused rather than silently widened.

Every `engineering_team_*` and `engineering_context_*` name matches the deferred tool prefix rule, so none of this costs a request that never uses it.

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

The optional Engineering Enhancement master switch mounts audited bundled engineering Skills, static asset Doctor checks, bounded declared-script verification, and Host-owned tools shared by DeepSeek, Claude, and Codex. The settings page contains only the master switch; detailed controls live in the dynamic Engineering sidebar entry.

Engineering Memory is local SQLite state under `DSH_HOME/freecodego/engineering/memory`. Agents can save drafts and use the reviewed-only `Search -> Timeline -> Get` flow. Only the user-facing Remote can approve, reject, export, purge, or delete records. Drafts never enter automatic recall, and memory actions are scoped through an open workspace-backed session.

Plugin-private state — memory, checkpoints, the Code Graph and Graphify runtimes, jobs, plan mode, and teams — resolves its root through one helper rather than per module: `FREECODEGO_HOME` when it is set to a non-empty value, otherwise `DSH_HOME`, otherwise `~/.dsh`. Every `DSH_HOME/...` path below is written against that rule, so setting `FREECODEGO_HOME` moves all of them at once. Host-owned files (`.credentials.yaml`, `settings.yaml`, `profiles/`, `runtimes/`, `state/`, `.agent-presets/`, `skills/`) never follow the override: the Host writes and reads those, and a second root would leave the settings surface and the credentials service disagreeing about which file is the truth.

Code Graph offers two interchangeable engines and mounts exactly one Agent tool family, selected by the `engineeringGraphEngine` setting (`auto` prefers the Python-free engine, `graphify`/`codegraph` mean that engine or nothing).

The Graphify engine downloads the official `graphifyy==0.9.52` Wheel after SHA-256 verification and bootstraps a SHA-256-pinned official uv release plus private Python 3.12 under `DSH_HOME/freecodego/engineering/graphify`. Its initial build uses Graphify's original code-only extractor and writes the graph, caches, and reports only to the plugin-owned project directory. It does not create a workspace `graphify-out`, install hooks, change `PATH`, or use a Lite Graph. Once a user builds a graph, the Agent receives the bounded official Graphify search, explain, path, impact, and overview tools.

The CodeGraph engine downloads the official self-contained platform bundle (48-62 MB) for the running OS/CPU after SHA-256 verification and unpacks it under `DSH_HOME/freecodego/engineering/codegraph`. The bundle carries its own Node runtime, so this engine needs no Python, no `uv`, and no wheel; musl Linux is refused rather than approximated, because the official Linux bundles are glibc-linked. CodeGraph resolves its index directory as a single path segment under the project root, so this engine keeps its index in the workspace at `.codegraph-freecodego` instead of under `DSH_HOME`; the directory carries a self-ignoring `.gitignore`, and the plugin removes it only on an explicit user action. Every plugin-owned process runs with anonymous telemetry, the background daemon, and the CLI's own download fallback disabled, and the plugin never runs `codegraph install`, which would rewrite the user's other agent configurations. Once a user builds an index, the Agent receives the bounded `engineering_codegraph_explore`, `_search`, `_explain`, `_path`, and `_affected` tools.

Both engines install and verify through one shared download path: an artifact streams to disk while hashing, a transient transfer failure is retried once, and a digest mismatch is final and never retried.

### Deterministic scan selection

Which changed files a scan covers is decided by a pure function rather than by a prompt, because a prompt cannot answer the three questions a user eventually asks: which files, why not the others, and whether anything was skipped. `src/scan-selection.ts` takes the changed paths plus one measured fact per path and returns one decision per file — selected, or excluded with the reason — and seals the coverage denominator: the exact set a run must account for. It performs no IO, no git read and no model call, so a preview and a run consume the same answer instead of deriving two that drift apart.

The gates run in a stated order, because the order is the substance. A deletion has no content left and leaves the denominator first. A credential path is refused before any pattern rule, so a credential file inside vendored source reports `credential` — the reason that explains why nobody looked at it. A pattern then names a path where a finding could not be acted on: installed dependencies, vendored source, build output, generated metadata, lockfiles. Test files are deliberately **not** excluded, which is a departure from the upstream default table this was modelled on (Alibaba's Apache-2.0 `open-code-review`): the defect class this plugin watches hardest is a test that asserts nothing while reporting green, and a scan that never opens a test file cannot see one.

Size is the last gate, and it is a ceiling on bytes rather than on the estimate: the estimate is priced for display through the plugin's single token estimator so this module cannot become a second place that prices text. A file whose size could not be judged stays **selected** and is named as unchecked. "Not measured" and "small" are different answers, and only one of them is a reason to look away; reading the unknown as either one would be a budget that passes by not looking.

`engineering_inspect` reports the selection as its `scan` section: the denominator, every exclusion with its reason, the byte and token totals a run would read, and the names of any files whose size was unchecked. That section is deliberately **not** folder-trust-gated, and the difference is what it reads — sizes and path names, never content. A byte count is not an instruction, and gating it would remove the one diagnostic that still works on a checkout nobody has trusted. The reconciliation half of the ledger — which selected files a run actually accounted for — is not implemented, because nothing in this plugin records a per-file scan outcome yet: the council and advisor reports carry findings rather than the set of files they covered.

## Hunk-level Change Tracking

Checkpoints answer "what did the workspace look like before that call" at file granularity; they cannot answer *which* call introduced a line, and they cannot take back one call's edit while others' stay. Hunk tracking records, for every mutating tool call, the contiguous line regions that call changed, attributed to the harness's own `callId`, and reverts a hunk against the file's current text.

Both halves live on the tool seam: the pre-execute hook reads the pre-image of the files the call names, and the post-execute hook diffs them and records the hunks. Recording runs for a *failed* call too — a mutation that wrote and then reported an error is the change nobody finds by reading the transcript. Two decisions are worth knowing about:

- **A later edit supersedes the lines it replaced.** Offsets are maintained as edits arrive, so an earlier hunk keeps a usable position; when a later edit covers an earlier hunk's lines, that hunk refuses to revert on its own and names the hunk that covered it. Reverting the covering call restores that state, which is why the refusal points there.
- **Revert verifies before it splices.** The recorded post-image must still be at its offset, or be found uniquely elsewhere (an edit above it moved it). Anything else is reported as `drifted` rather than guessed — including a pure deletion whose neighbours no longer match, because an empty post-image matches everywhere and the module will not pick one of the blank lines that look alike. File line endings are preserved.

The Agent reads the journal with `engineering_hunks` (bounded metadata plus a five-line preview, never the whole region) and undoes one with `engineering_hunk_revert`, which takes either a hunk id or a call id together with a file. Both are registered unconditionally, unlike the code-graph families: the journal is filled by the tool seam whatever engines are installed, so reading it must not depend on one being present.

Arguments come from the model, so the file a call names is refused unless it resolves inside the workspace: a pre-image read of `../../id_rsa` would put a credential's contents in a journal the model can ask about later.

## Context Compression (Headroom)

Headroom compresses oversized tool output before the model sees it. The durable session log keeps the full original, the compressed text carries a `hash=<24 hex>` marker, and the model gains `headroom_retrieve` to fetch any omitted text back — lossy on the wire, lossless end-to-end. Every strategy is routed by *shape* (log, JSON, diff, search, table, config, prose) and each one only runs when it actually shrinks its input.

### Code skeletonization

Source code has no shape signature, so the port originally left it alone — and measurement showed that was the single largest cost it could have addressed. In a sample of 17 sessions / 133 steps, `read` produced 875,706 of the 1,025,038 tokens of tool output ingested (85%), and because the Harness re-sends the whole transcript on every step (`deriveMessages` does not trim), those bytes were transmitted 21,365,476 tokens in total across the sample.

`headroomCodeSkeletonEnabled` (on by default) assigns `read`, `read_file`, and `view` results a skeleton. The safety contract is a subsequence: **every retained line is byte-exact original text, including its `N: ` prefix**; only whole contiguous runs of body lines are replaced, each by one marker naming the line range it covers. Imports, declarations, type/interface members, signatures (including multi-line parameter lists), decorators, attributes, doc comments, arrow-function class fields, and top-level closing delimiters all survive. What is dropped is implementation — so an Edit anchored on a retained line still matches, and the marker states exactly which line numbers the reader no longer sees. A run shorter than three lines is kept rather than marked, because a marker costs more than the lines it would replace.

A read is declined rather than guessed at when it is smaller than 2 KB, is not a numbered envelope, has non-consecutive line numbers, is already owned by another compressor (JSON, config, logs, search, diffs, tables, HTML), is prose by extension and detector, is an error result, or would shrink by less than 25%. Reads of windows starting at an offset are supported, since that is how agents read large files.

Measured on 1,983 real repository sources, the skeleton reduces the applied files by 61.5% in aggregate (median 58.3%, p25 49.5%). Replaying the sampled sessions with reads skeletonized drops total re-transmission from 21,365,476 to 17,820,922 tokens: **16.6% of everything sent**, without a config change, and without losing any line the model can still match against.

Turning the switch off restores byte-exact reads. The read-fold knob is unrelated: it applies lossless folds to reads that happen to look like search or log output.

### Deferred tool schemas

The tool block is the other fixed cost: in the same sample, 45.7-47.4 KB of every request (11,700-12,130 tokens) was tool JSONSchema, and 37 of the 61-74 tools were this plugin's — 14,380 chars, 27% of the block, re-sent on every step of every turn. A turn that edits a setting never touches a graph query, memory CRUD, checkpoint restore, team orchestration, or media generation.

`deferredToolSchemasEnabled` (on by default) keeps those tools registered but withholds their schemas. On `agent/session-start` the plugin scopes the agent's tools with `deny: [...deferred]` in one attempt that can never block the session; the Harness derives the wire schema from the visible set, and a denied name fails a direct call with `UNKNOWN_TOOL` — visibility and callability read from one source of truth, so the model cannot call what it was not shown, nor see a tool it cannot call. `tool_search` then lifts the denial for the tools it returned, so a deferred tool is exactly as usable as an immediate one after one discovery call. Query grammar follows Claude Code's `ToolSearch` on purpose: `select:A,B` for exact names, `+term rest` to require a term in the name, and bare keywords to rank.

`tool_search`, `engineering_status`, `engineering_repo_map`, `advisor_review`, and `headroom_retrieve` never defer. Deferring the entry point would be a lockout, the first two are what a user reaches for when nothing else works, and the last two answer something the model has already been shown — a hint to consult the advisor, or a hash inside a compression marker — where a discovery round-trip is pure latency.

The tool's description is **static**, and deliberately names no deferred tool. A dynamic index there would mutate the tool block on every settings change and void the prompt-cache prefix for everything after it, which is the failure Claude Code's own source records (~10.2% of their fleet cache-creation tokens): a far larger loss than the definitions saved. The index is returned by a no-argument `tool_search` call instead.

A keyword query is ranked by BM25F over the name and the description (`tool-search-rank.ts`), not by counting substring hits: rarity is computed over the deferred catalog itself, term frequency saturates, description length is normalized, and a term of three or more characters that prefixes a word counts as half a hit. The three failures plain counting had are the three a catalog of a few hundred tools makes obvious — a word every description contains out-ranking the one that matters, the longest description winning, and a repeated word outbidding a tool's own name. The documented ceiling on `max_results` is enforced where the answer is formed, not only where it is described.

The index is priced like any other output (`tool-catalog-budget.ts`, 1,000 tokens): it renders `name — summary` while that fits, then the bare names, then one line per name prefix with a count and a few samples. Each level says what it dropped and how to ask for it back, and no level can hide a name — `list:<prefix>` (and `list:all`) returns names without schemas, which is how a name that grouping summarised away stays reachable. Today's 37-tool catalog measures about 930 tokens, just under the budget, so the change is inert until a catalog actually outgrows it.

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

**Task board revisions** (`team/board.ts`). Every task carries a revision that advances on every mutation, so `claim` can require the revision the caller last read and the loser of a race fails cleanly instead of overwriting a decision. A claim also mints a **claim token**, and the strict door (`transition`) demands it: an owner name that survives a restart is not evidence that the same member still holds the work. `complete`/`fail` remain the ownership-only path for a single-process team and are documented as the weaker one. `approve` records decisions on the task, so the board is the audit record.

Because the strict door is the default, the token has to travel: a member started for a task receives that task's claim token in its brief and is told to present it when it closes. Withholding it would hand the member work it is structurally unable to finish — it could only stall or ask the parent to close work on its behalf — so `member_start` passes it through and a test pins the hand-off.

**Cache-cold clearing** (`cache-cold.ts`). A second, narrower compaction path with one rule: when more than an hour has passed since the last main-loop assistant message, the provider's prompt cache has certainly expired and the entire prefix will be rewritten anyway — so older tool results are cleared **before** the next request, shrinking exactly the part that is already certain to be re-billed. The reason is not that the content is old. The one-hour threshold sits past every published TTL, so the mechanism cannot manufacture a miss that would not have happened, and clear markers are per-session so the same content is never processed twice: clearing is idempotent by construction, not by the caller remembering.

**Request-shape fingerprinting** (`request-shape.ts`). Cache-miss attribution above is arithmetic on the ledger; this is the causal half. Before each request the wire shape is hashed — system text, the tool set, **each tool's schema separately**, model, betas, budget band — and the next response's cache-read drop is attributed to a named change. Per-tool hashes exist because the dominant real case is the tool *set* unchanged while one tool's description moved, which no added/removed count can see; that case is named as the specific tool that moved. Flags that once flipped mid-conversation and invalidated the prefix are sticky-on: a flag that stops mattering is kept on rather than allowed to flip back, because the second flip is the expensive one.

**Proportional verification** (`verification-tier.ts`). Verification used to cost the same for a one-line guard as for a scheduler rewrite, which over-charged the small change and — worse — under-evidenced the large one. Tiers are now chosen from the change itself (`git status --porcelain` for *what* moved, so an untracked new file counts, plus `diff --numstat` and each untracked file's own length), with security fragments, architectural fragments (manifests, lockfiles, CI, migrations), and breadth all forcing `thorough`. Two invariants hold at every tier: **a tier may reduce which stages run, never what counts as evidence** — a skipped stage still reports `skipped` and a run without a probe is still `unverified` — and **the tier is reported with what it omitted**, because "no failures" and "no failures among the checks we ran" are different claims and only one of them is true. Coverage is inferred from paths alone, so a change that ships no test file can never reach the light tier however small it is.

**Credential screening for memory** (`secret-scan.ts`). Project memory is written from what the agent read, so a `.npmrc` or a pasted curl command can put a real token into an entry that then outlives the session and is re-injected into later conversations. The curated rule set is a subset in the useful direction: rules with a distinctive vendor prefix and a near-zero false-positive rate, deliberately without the generic keyword-context rules that make people turn a scanner off. The scanner never returns the secret — a finding carries a four-character prefix and a length — and confidence is part of the match. On the write path a *labelled* credential (the existing keyword rule) and a *vendor-prefixed* one both refuse the entry, while a shape-only match (a JWT, a bare `sk-`, a PEM blob) is redacted in place and the entry is kept, because losing an opaque identifier costs less than keeping a credential.

**Side-channel budget invariant** (`side-channel-budget.ts`). Claude Code carries this as a hard operating rule for its classifier: a side prompt must stay strictly smaller than the main loop so compaction happens before the *side channel* overflows. Our Advisor and each council perspective are exactly such channels, so each call is measured against the harness's compaction threshold (the window times `compaction-basic`'s default ratio) before it is sent, not after it fails; the comparison is against the threshold rather than the current conversation size, because a large channel in a session that has not grown yet is precisely the case that breaks. Records keep the **worst** footprint per channel rather than the latest — a channel that was over the line once will be again, while "the last call was small" proves nothing. This is reported, never enforced: the plugin cannot resize another component's prompt, and refusing to review would trade a measurable cost for a silent loss of oversight. An unknown threshold produces no warning, since judging a footprint against an unnamed line reports it safe by default.

**Isolation reporting** (`isolation-report.ts`). A member's restriction is reported as what was *requested*, which mechanism is actually narrowing it (`tool-scope`, `harness-policy`, `both`, or `none`), and a single `restricted` flag for a caller to branch on — computed from the **resolved tool set** and a read-back of the sandbox mode, never from the role's intent. "We asked for read-only" and "read-only is in force" are different facts, and a brief that conflates them is how a write-capable member is mistaken for a restricted one. The one outcome that is never silent is `enforcedBy: none` on a read-only request: it carries a `fallbackReason`, and a `workspace-write` member in its own worktree is reported as *contained* rather than restricted, because containment is what a private worktree actually buys.

## Known Limitations and Deferred Work

Verification history is process-local and does not yet expose persisted jobs or cancellation. Team members are not yet resumable in-process: a restarted Host reports what was in flight from the durable board and member registry, but the member itself has to be started again (its worktree and branch survive, so its work does not). The role library ships five roles; the role-record shape is the extension point for more. The context budget depends on a mounted token meter; a composition without one reports pressure as unmeasurable rather than as zero, so the fragment is simply absent there. Cache waste is attributed from the local ledger only — the gateway endpoint reports billing totals, not per-turn request prefixes — and dollars are attributed only when the range carries rates, since an unpriced figure is worse than none. The action reviewer (`action-review.ts`) is complete policy with no reviewer attached: a model review on the per-tool hot path would add a request per tool call, which is the cost this plugin exists to reduce, so it stays unbound until a review is worth that. Tier selection infers coverage from *changed paths* and not from coverage instrumentation, so it says "this change arrived with a test-file change" and never "these tests exercise this change"; a caller that knows real coverage should pass it directly. The side-channel threshold is derived from `compaction-basic`'s default ratio, so a composition that overrides that ratio makes the figure approximate — which is why the check warns and never refuses. Cache-cold clearing deletes old tool results from the request only; it cannot edit a cached prefix on the server, which would be the stronger version of the same idea. The credential scanner is a curated subset, not a general secret detector, and it screens memory writes only — engine audit summaries and exported bundles still rely on their own field-keyed redaction. Code Graph currently invokes the official CLI for code-only build, incremental update, and bounded read-only queries; the internal Graphify MCP sidecar, persisted build queue, user cancellation, dependency hash lock, runtime update channel, and Canvas adapter remain release gates. The CodeGraph engine has no Canvas adapter (the bounded Canvas projection remains Graphify-only) and no `overview` tool, because its CLI ships no hub-ranking or whole-graph export command; freshness for both engines comes from the post-turn auto-update hook and explicit user actions rather than a background watcher, and `codegraph` runs without its daemon so a query never contends with a second writer.

## Plugin Conflict Protection

The `freecodego-harness` settings namespace enables Plugin Conflict Protection by default. The `dsh` profile launcher installs the guard before the Loader starts the profile tree, then FreeCodeGo statically scans each later entry module and local imports for literal duplicate Tool names, command names, settings namespaces, HTTP routes, model Provider ids, and UI Slot ids. When it finds an exclusive resource already owned by an active entry, it keeps the earlier entry, disables the later one before it runs, and saves a repair record for the settings page. The browser notification identifies both entries and the duplicate resource.

The scanner never executes third-party code and intentionally ignores dynamic or computed registrations. It prevents reliable duplicate registrations, not unrelated plugins that merely provide similar user-facing features.

## NPM Updates

The update service tracks the published `freecodego` entry package, rather than updating one Host component in isolation. It checks npm after startup and daily, supports the `latest`, `next`, and `canary` dist-tags, and stages the selected version in a sibling Profile before atomically promoting it. The pre-update Profile stays available until the restarted Host remains healthy; the settings page can restore it before confirmation. Updating never restarts the process implicitly, so a Host restart is required before the new bundle is loaded.

## Zcode GLM-5.3 Flash Promotion

The Zcode model directory annotates `glm-5.3-flash` only when the Host has a Coding Plan credential for the active Z.AI account. The limited-free window is calculated in `Asia/Shanghai`: before the 20th of each month, from 23:00 to 09:00 the next morning, requests are displayed as not consuming tokens. The model remains available outside the window, but the UI clearly reports that the limited-free period is inactive; no client-side clock or account claim can grant the entitlement.

## MCP And Skills

The `freecodego-harness` settings namespace stores switches, third-party MCP servers, and extra Skill roots. Both switches default to off. Enabled MCP servers are connected once by the Host and registered as Harness tools for the DeepSeek engine. Claude receives the discovered schemas through its in-process `freecodego-host` MCP server and calls the Host bridge, while Codex receives the same enabled server definitions in its plugin-owned app-server config.

Enabled Skill roots are discovered by the Harness filesystem Skill provider. A skills.sh installation atomically registers the Host-owned community directory as an enabled custom root, so the imported one-level `SKILL.md` bundle is visible immediately to DeepSeek and to the next native session. Claude loads enabled Skills through the Host bridge and Codex receives them through `skills/extraRoots/set`. Disabling a capability unloads its managed provider and prevents future native sessions from receiving it; existing sessions must be restarted to replace their native app-server inventory.

The embedded community page reads bounded, paginated MCP.so and skills.sh metadata through Host Remotes. MCP entries are one-click installable only when their published detail contains an HTTP endpoint or stdio command representable by the shared registry and no unresolved environment or header values; entries requiring credentials stay in manual configuration instead of reporting a nonfunctional installation. Skill entries import a matching `SKILL.md` only from a validated GitHub source repository into the Host-owned community Skill root.

## Third-Party Plugin Tools

Native Codex and Claude sessions project the same Agent-scoped Tool schemas that Harness exposes to DeepSeek. This includes tools registered by later third-party plugins, such as canvas or domain-specific workflow tools; FreeCodeGo does not maintain a name allowlist. Calls return through the Host ToolRuntime, so the original plugin still owns validation, permissions, audit events, cancellation, and execution. MCP and Skill capabilities may also retain their specialized native integrations, but the generic projection never hides a third-party tool merely because of its name.

Codex refreshes this inventory before every prompt and Claude rebuilds its in-process MCP server for every query. Installing, disabling, or restricting a plugin therefore takes effect on the next native turn without recreating the conversation. Only schemas visible in `ctx.tools.schemas(agent)` are projected; Host or scope-hidden tools never cross the native bridge.

## Media Defaults

The Host registers `freecodego_generate_image`, `freecodego_generate_video`, and `freecodego_generate_audio` for DeepSeek, Codex, and Claude. Each execution reads the live image/video/audio default from `freecodego-harness.mediaDefaults`; the model-facing schema deliberately has no model override. Gateway requests reuse the Host-vault account token and the selected model's route key. Agnes defaults reuse the existing Agnes Host client. Base64 image responses are admitted to Harness attachment storage and returned as image content blocks; audio bytes are saved under the active workspace's `.freecodego/generated-media` directory.

## Settings Migration: Orphan Engineering Keys

A DSH home can be written by more than one build of this plugin. The published alpha package writes four keys this repository never reads — `engineeringProfile`, `engineeringTelemetryEnabled`, `engineeringLearningDraftsEnabled`, and `engineeringTelemetryRetentionDays` — so a home that was used by both builds ends up carrying dead settings: no code path reads them, the settings page never shows them, and nothing fails, which is exactly why they are worth naming.

They were removed from the local home with the rest of the file preserved byte-for-byte (backup left beside it as `settings.yaml.bak-orphan-keys-*`). The capability they *name* is not uniformly absent here:

| Removed key | State in this repository |
| --- | --- |
| `engineeringLearningDraftsEnabled` | The behaviour exists as the `engineering_skill_draft` tool, which derives drafts only from memory the user already reviewed. It is not switchable today. |
| `engineeringProfile` | No profile tiering exists; the individual switches are the contract. |
| `engineeringTelemetryEnabled` / `engineeringTelemetryRetentionDays` | No telemetry collection or retention exists in this build. |

If an alpha profile is still in use under `profiles/freecodego-alpha`, its own settings document is separate; removing these keys from the shared home does not touch it, and the alpha build will re-add whatever it needs the next time it runs.

## Community Plugins

The community plugin page reads the active profile dependencies and bundle list to show installed plugins. FreeCodeGo records the source URL and direct package names returned by each installation, so GitHub and multi-package installs remain recognizable. Uninstall first disables matching Loader entries, then removes the direct dependencies and bundle activations from the profile; the next Harness start cannot load the removed plugin.

When a `gateway` is configured, the bundle reuses the existing FreeCodeGo v1 routes for mobile authentication, bootstrap/model state, quota, runtime health, model pricing, plans, checkout, and order polling. Browser Remotes receive only redacted state. No provider-specific credential is exposed through the UI.

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

The settings page displays account/quota/usage details, selects payment methods and plans, opens checkout links, polls orders, and displays the live model pricing table. Payment verification/cancellation and receipt-email delivery are wired. Provider-specific payment confirmation, binary receipt download, complete runtime artifact coverage, clean-profile installation, and assembled Web E2E remain release gates.

-----

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the Host plugin's lifecycle and published services are covered by its composition tests.

The sections above are ordered by what a reader arrives with, not by mount order: routing and review first, then the engineering surface, then context discipline (the group of features that exist to keep a long session affordable), then the surfaces a deployment configures (settings, media, providers), and finally the operational notes for an installed home.

Where a Harness package already owns a capability, this plugin attaches to it instead of registering a second implementation, and the enhancement it still keeps is stated next to the section it belongs to. That rule is recorded per conflict in [`../../../COMPATIBILITY.md`](../../../COMPATIBILITY.md).

</details>

**Runtime invariant:** every capability above is gated by the settings switch its section names, and no section registers a second implementation of a Harness-owned contract.
