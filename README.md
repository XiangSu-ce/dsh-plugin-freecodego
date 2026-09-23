# dsh-plugin-freecodego

**FreeCodeGo for DeepSeek Harness** — a Cordis bundle that adds the FreeCodeGo engine inventory, a managed free-model gateway, per-provider accounts, media generation, and the engineering (code-graph + memory) toolchain to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

English | [中文](README.zh.md)

FreeCodeGo is **not** a DeepSeek product, and this is not an official DeepSeek distribution: it is a plugin that mounts into a Harness you install yourself. See [TRADEMARK.md](plugin/TRADEMARK.md) for the naming policy that applies to forks of this repository.

## Screenshots

The five views below are the plugin as it looks mounted: the plugin market card shows the same set, and the first one is what that card previews.

**Model picker** — the managed catalog and the free providers it reads, grouped by provider, each row carrying its own free and latency label; the composer's engine selector sits beside it.

![Model picker: provider groups with free rows and the engine selector in the composer](plugin/packages/freecodego/bundle-latest/screenshots/01-model-picker.png)

**Accounts and providers** — Settings → FreeCodeGo → Accounts & providers: each provider's key stays in the Harness host, and that provider's free-model roster is listed under it.

![Settings showing a per-provider API key field and the provider's free-model roster](plugin/packages/freecodego/bundle-latest/screenshots/02-providers-and-accounts.png)

**Engineering enhancement** — the master switch and what sits behind it: engineering skills, project-long-term memory, the code graph, post-implementation verification, and multi-role review.

![Engineering enhancement settings: the master switch and its per-capability toggles](plugin/packages/freecodego/bundle-latest/screenshots/03-engineering-enhancement.png)

**Plugin safety and updates** — conflict protection at load time, the release update check, and the unified MCP / Skill capability layer.

![Plugin conflict protection, the update check, and the MCP/Skill capability layer](plugin/packages/freecodego/bundle-latest/screenshots/04-plugin-safety-and-updates.png)

**Community picks** — the DSH market ranking and the MCP.SO directory, installed into the local Harness with one click.

![Community picks: the DSH market ranking and the MCP.SO directory, each with one-click install](plugin/packages/freecodego/bundle-latest/screenshots/05-community-mcp-marketplace.png)

## What it adds

- **Managed model catalogs** — one picker over the FreeCodeGo gateway and the free providers it manages (OpenCode, Logfare, SenseNova, NVIDIA, VyceAI, Kilo, Agnes, Cline, WorkBuddy International, Qoder, TRAE, Groq Whisper), each row carrying its own health, rate, and training-data label.
- **Native engines** — a session runs on DeepSeek, Codex, or Claude, each behind its own verified runtime, with this plugin's router as the only Harness `AgentFactory`.
- **Advisor review loop** — an independent, read-only reviewer that steers the active Agent with bounded findings.
- **Code review** — an OCR-style reviewer over the change itself (the workspace, a ref range from its merge base, or one commit), with four layer-resolved rule sets, per-file coverage accounting, three report formats, adversarial re-checking of high-severity findings, and an opt-in stop-time gate.
- **Engineering enhancement** (behind one master switch) — multi-engine engineering review, a multi-member team, CodeGraph / Graphify code graphs, durable per-project engineering memory, checkpoints and a hunk journal, a repository map, and deterministic scan inspection.
- **Context and cost discipline** — Headroom output compression (including code skeletonization), deferred tool schemas with `tool_search`, cache-cold clearing with spill recall, a model-visible context budget, and cache-miss attribution.
- **Guardrails** — a declarative command policy, Plan Mode, folder trust, a credential-path shield that also covers native engines, and credential screening on memory writes.
- **Model menu control** — the provider and model rows the chat picker shows, non-interactive price/health labels on the stock menu, a picker label that echoes the durable selection, and a reconnect retry that does not empty an open menu.
- **Capabilities** — MCP servers, Skill roots (including skills.sh installs), LSP auto-mount, calendar scheduling rules, declarative hook chains, media generation and audio transcription, voice input, agent presets, and personas.
- **Release updates** — the plugin reads this repository's releases and installs the bundle built for the Harness you are running.

Every feature below states the setting that gates it, and where something is off by default it says so. The decision behind each one is written up in [`plugin/packages/freecodego/harness-plugin/README.md`](plugin/packages/freecodego/harness-plugin/README.md), the top-level feature document.

## Free models

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

## Feature tour

### Engines and routing

- **Three engines, one router.** DeepSeek executes in the official AgentLoop; Codex and Claude run behind a managed native runtime (a child-process host plus the Host-in-process Claude Agent SDK runtime) and stream back through the Host bridge. The router is the **only** Harness `AgentFactory`, so a session asked for a native engine never silently falls back to DeepSeek.
- **Admission, not assumption.** A native engine is admitted only when its verified manifest, digest, protocol ABI, worker path, and state directory arrive together. Runtimes are downloaded through one shared path that hashes while it streams, retries a transient transfer once, and treats a digest mismatch as final.
- **Defaults.** `setDefaultEngine` and `setDefaultModel` set what new sessions start on and persist in the settings document of this plugin's own composition entry (`freecodego-harness-plugin`); existing sessions keep their durable plan.
- **Subagent routing** (`autoSubagentModelSelection`, on). Every live text-model route is synchronized into Harness's `subagent-model-selection`, so new top-level sessions receive `provider` / `model` / `reasoning_effort` plus an on-demand `list_subagent_models` discovery tool. Children inherit the parent's execution engine and may override the exact LLM route per delegation; a temporarily failing provider keeps its last authorized routes.
- **Third-party plugin tools in native sessions.** Codex and Claude project the same Agent-scoped tool schemas DeepSeek sees — including tools registered by later plugins — with no name allowlist, and calls return through the Host ToolRuntime so the owning plugin keeps validation, permissions, audit, and cancellation. Codex refreshes the inventory before every prompt; Claude rebuilds its in-process MCP server for every query.
- **Local routes.** OpenAI-compatible and Anthropic-compatible providers use the existing `dsh-llm-pi-ai` plugin and the shared Models settings editor; API keys are stored through the Harness credential service and never reach the browser.
- **Zcode GLM-5.3 Flash promotion.** The Zcode directory annotates `glm-5.3-flash` only when the active Z.AI account holds a Coding Plan credential, and the limited-free window (Asia/Shanghai, 23:00–09:00, before the 20th of each month) is computed Host-side — no client clock or account claim can grant the entitlement.

### Model catalogs, providers, and accounts

- **One catalog, many upstreams.** The picker lists the FreeCodeGo gateway together with the free providers the plugin manages: OpenCode, Logfare, SenseNova, NVIDIA, VyceAI, Kilo, Agnes, Cline, WorkBuddy International, Qoder, and TRAE, with Groq Whisper for audio transcription. Rows carry health, rate, and training-data labels, refreshed through bounded cache TTLs, and a provider that temporarily fails keeps its last authorized routes rather than emptying the picker.
- **Provider-specific adapters over shared account pools.** Each free provider has its own upstream contract (there is a measured reason not to reuse one generic OpenAI-compatible adapter), and the four pooled families — Cline, WorkBuddy International, Qoder, and TRAE — rotate through accounts: quota is issued per model or per account, requests rotate, and an HTTP 401 reauthentication failure or a 402/429 quota response cools the affected account before the next one is tried.
- **Sign-in flows.** WorkBuddy International uses the device authorization flow (a browser URL the user confirms, then polling) and stores access/refresh tokens through the Host credential service under `WORKBUDDY_AUTH`; multiple accounts can be added and removed independently. Agnes registers or logs in through its control-plane endpoints and creates a default API key, stored under `AGNES_AUTH` / `AGNES_API_KEY`. Cline and Logfare credentials likewise live as credential references.
- **Browser-mediated OAuth sign-in.** A Harness plugin has no window to receive a browser fragment and no `freecodego://` handler, so sign-in drives the backend's own `/auth/oauth/{provider}/start` with `redirect=/oauth/desktop?state=<ours>&plugin=1`, polls `GET /auth/oauth/desktop/poll` until the issued pair arrives, and adopts that pair into the Host credential vault — the backend stores it under the state it was handed and shows a plain confirmation page instead of a deep link. The same card completes MFA, binds or creates the account, and sends the verification code, all through Host Remotes.
- **What the model picker shows is the user's decision.** The chat model list is the stock Harness menu and the Host registers every adapter it can serve, so the Accounts-and-providers page is where a provider or a single model is switched out of it. Storage is *negative* — visible unless recorded hidden — with two declared exceptions: a metered provider's priced rows default to hidden and a curated provider's unnamed rows default to hidden, so nothing changes for a user who never opens the controls while a newly added, priced model does not switch itself on. The control reaches a menu that is already open beside it, because the decision belongs to the provider rather than to whichever page rendered it.
- **The stock menu is labelled, not replaced.** The official selector keeps ownership of selection, focus, scrolling, and reasoning effort; this plugin only appends non-interactive labels — source, price class, provider health — to rows that expose the stable ARIA menu contract, so the menu teaches which rows are free, metered, or degraded without a second picker to keep in sync.
- **A refusal never reads as an applied selection.** The picker's own label is kept in sync with the Session's durable selection, and a refused `selectModel` resolves with the Remote failure rather than throwing, so the echo checks the *result* instead of only watching for a throw — otherwise a refusal would clear the reason it had just written. A separate retry layer absorbs a short-lived Host reconnect (1m, 10m, 30m backoff) without clearing the last directory, so a menu that was open when the carrier dropped recovers instead of going empty.
- **A cold catalog in milliseconds, not seconds.** The Host builds its model catalog by asking every registered route for its model list at once and waiting for the slowest answer; twelve of this deployment's thirteen routes belong to this plugin and are the only ones that must read a network directory. Measured against a restarted Host, the first catalog took 5,528 ms and the warm one 12 ms — 5.5 seconds in which the menu had no provider group to draw, which is exactly what makes an opening picker look like it never opened. The FreeCodeGo half is therefore answered from the directory this deployment already knows, not from a fresh round of provider reads.
- **One failure table, three decisions.** The same failure arrives in a different shape from every route — a `fetch` rejection, a status code on a custom error, a DOMException from an abort signal, an adapter's machine code, a provider's own wording — and reacting to the message at each call site is how a rate limit gets retried forever while a context overflow is retried until the budget is gone. Every failure is classified once, and each kind maps to one decision: retry, cool the account down, or fail the turn.
- **Redaction is the rule.** The browser receives only redacted state: no provider credential, session token, or API key is ever sent to the UI, and no parallel credential protocol is added beside the Harness one.
- **Gateway account, billing, and plans.** With `gateway.baseUrl` configured (default `https://freecodego.com`, HTTPS required) the settings surface shows account, quota, and usage details, selects payment methods and plans, opens checkout links, polls orders, and renders the live model pricing table, reusing the FreeCodeGo v1 routes for mobile authentication, bootstrap/model state, quota, runtime health, pricing, plans, checkout, and order polling. Payment verification/cancellation and receipt-email delivery are wired; provider-specific payment confirmation, binary receipt download, complete runtime artifact coverage, clean-profile installation, and assembled Web E2E remain release gates.
- **Media defaults** (this entry's `mediaDefaults`). `freecodego_generate_image`, `freecodego_generate_video`, `freecodego_generate_audio`, and `freecodego_transcribe_audio` read the live default at execution time; the model-facing schema deliberately has no model override. Gateway media requests reuse the Host-vault account token, base64 images are admitted to Harness attachment storage and returned as image content blocks, and generated audio is saved under the workspace's `.freecodego/generated-media`.
- **Image and video generation is one switch away from gone** (`mediaGenerationEnabled`, on by default). It governs `freecodego_generate_image`, `freecodego_generate_video`, and the legacy `agnes_generate_image` / `agnes_generate_video` names, and switching it off **unregisters** them so they leave the model's tool list instead of failing at call time. `freecodego_generate_audio` and `freecodego_transcribe_audio` are outside it: one writes into the active workspace and the other reads out of it.
- **Image and video routes follow the provider, not the model name.** Image generation speaks the OpenAI Images contract (`/images/generations`, `/images/edits` when sources are attached), Seedream's `image: [...]` fusion body, Gemini's `:generateContent`, Imagen's `:predict`, and DashScope's `multimodal-generation`. Video generation speaks nine: Kling (`text2video` / `image2video` / `multi-image2video`), Ark (`/contents/generations/tasks`), DashScope's async video-synthesis, MiniMax Hailuo, Vidu, Gemini's Veo `:predictLongRunning`, xAI's `/videos/generations` including edits and extensions, OpenAI's `/videos`, and the gateway's portable shape for everything unrecognized. The model roster is read live from the Harness model directory, the managed catalog, Logfare, and Agnes rather than pinned, and the package README carries the full table.

### Advisor review loop

- An independent reviewer, enabled by default on the public `freecodego/hy3` route, reads durable turn events with a **separate** model context and holds only bounded, read-only workspace tools (`read`, `glob`, `grep`). Credentials, hidden reasoning, and unrestricted primary-Agent tools are never copied into the review context.
- Every DeepSeek, Codex, and Claude Agent receives `advisor_status`, `advisor_review`, and `advisor_notes`, so the active Agent can inspect the reviewer, ask for a second opinion at a checkpoint, and consume prior findings without a separate UI action.
- A concrete concern or blocker steers the Agent; low-severity or cooldown findings are injected at the next safe step. Native Codex and Claude consume steering as a subsequent native turn and stage injections until the next user turn. Findings and token usage are appended to the Harness session; with Agent control off they stay `record` events only.
- Route and delivery settings apply live, and native sessions refresh their projected Harness tools before each turn.

### Engineering enhancement

Engineering Enhancement sits behind one master switch (`engineeringEnabled`, **on** by default). It mounts audited bundled engineering Skills, static asset Doctor checks, bounded declared-script verification, and Host-owned tools shared by DeepSeek, Claude, and Codex. Switching it off stands the whole pack down. The settings page holds the master switch; the detailed controls live in the dynamic Engineering sidebar entry.

#### Multi-engine review and verification

- `engineering_team_start` keeps the current root Agent on its selected engine while starting isolated DeepSeek, Codex, and Claude child Agents for a bounded, read-only review of an objective and a draft plan, with an optional cross-examination round. Children cannot edit files, execute shell commands, create another team, or change permissions. Participants may be toggled independently, and the settings panel reports whether the Codex/Claude runtime is installed before allowing one to be enabled.
- Quorum is reached only when the configured minimum number of participants completes; missing runtimes and failed participants are reported independently. The team runs in the foreground or returns a `council_*` id for polling with `engineering_team_status`, `engineering_team_cancel` stops all children, and completed reports stay available through `engineering_team_report` after the parent session is restored. `engineeringCouncilAutoRun` (off) can run a review automatically after an approved plan, so users keep explicit control by default.
- Jobs expose an explicit lifecycle (`queued`, `running`, `awaiting_approval`, `implementing`, `verifying`, terminal states) persisted as session events, so an interrupted active job is restored as `stale` rather than silently lost. Approval records carry a plan digest, workspace fingerprint, policy digest, and expiry; a change to any of them fails closed and requires a fresh review.
- **A completed report is evidence, not edit permission.** The user must explicitly approve or reject it before implementation; only an approved report can run verification, and the primary Agent must call `engineering_team_mark_implemented` with a bounded summary before `engineering_team_verify` is accepted.
- **Verification is computed, not inferred.** Every stage result carries the command that ran and the exit status it returned, and a stage that could not run reports `skipped`, `unavailable`, or `refused` — never a pass. The verdict is `verified` only when every declared stage passed with recorded evidence **and** at least one adversarial probe ran and held its expectation. A probe is declared before it runs, with an explicit expectation (including `fail` for a guard that should refuse the new input) and a rationale naming the breakage it would catch, so a guard that stops firing turns the run red instead of passing silently.
- **Probes are model-authored, so the controls fail closed.** An empty, malformed, or blank-rationale probe — or one that reaches the network, publishes, or deletes — is recorded as `refused`, which forces `failed`. Commands spawn without a shell, network fetches are disabled, each probe shares a five-minute timeout, and the workspace is fingerprinted around every probe so a check that mutates the tree cannot also be the evidence that the tree is fine.
- **Proportional verification.** The tier (`light` / `standard` / `thorough`) is chosen from the change itself, with security fragments, architectural fragments (manifests, lockfiles, CI, migrations), and breadth forcing `thorough`. Two invariants hold at every tier: a tier may reduce which stages run but never what counts as evidence, and the tier is reported together with what it omitted.
- **A verification is re-read when it is asked about, not only when it ran.** The run's own evidence answers whether its probe was attributable; the claim's *reach* is a different question, and it changes after the run ends — the workspace can be edited again, and a record that was true when it was written becomes a green light for work it never saw. The audit therefore re-checks the claim against the tree as it stands, which is how a passing verification stops being quoted for a change it never covered.
- Approved reports can also be written into the workspace as a `spec` / `plan` / `tasks` triple, which turns a completed review into a diffable artifact the project owns rather than a conversation nobody else can read.

#### Code review

The reviewer is an OCR-style (open-code-review) pipeline rebuilt as Host-owned machinery: four tools over one engine, a deterministic preview that spends no model call, and an optional stop-time gate.

- **Four doors, one engine.** `engineering_code_review` reviews a change (`mode: workspace | range | commit`, with `from` / `to` / `commit` and an output format of `text | json | sarif`); `engineering_review_rules` answers what *would* be reviewed and under which rule, which is both the cheap way to test an exclude pattern and the LLM-free half a caller needs to do the reviewing itself; `engineering_review_status` says what is running now; `engineering_review_report` re-renders the last result for another reader — a person, an agent, or a scanning integration.
- **What gets reviewed is a decision, not a `git diff | head`.** A workspace review means staged *and* unstaged *and* untracked changes, because the untracked half is what a naive diff never shows and where a new file's worst bug lives; a range review diffs from the **merge base**, or every commit on the base branch arrives as this reviewer's problem; a commit review diffs against its own first parent. Skips are a closed set of reasons — binary content, an oversized file, the project's own exclude pattern — each one recorded, because a file that vanishes without a reason is indistinguishable from a file the review forgot.
- **Coverage is accounted for, including the files it did not read.** A run cannot finish while a file is still `pending`: the check names the missing files instead of letting the denominator shrink quietly. One assembled report is rendered three ways, so the same run cannot state a finding in text that its SARIF omits or count coverage differently per format; a finding the fact-checker disproved, or that adjudication refuted, stays in `json` with the reason it was dropped, and `text` states the count it withheld — because a report that silently omits findings teaches its reader that the count is the whole truth.
- **Rules resolve in layers: `custom` → `project` → `global` → `system`.** The first matching layer wins, not the first matching pattern across all layers, which is what makes a project's override an override rather than a merge. A project's standard lives in `.opencodereview/rule.json`, `.dsh/review.json` or `.freecodego/review.json` — the first that exists becomes *the* project layer, because merging two would make the effective standard a document nobody wrote — and the user-level `~/.opencodereview/rule.json` is the one layer a repository cannot author. A malformed rule file is reported, never ignored: a project that believes its standard is enforced while the file has a trailing comma is worse off than one that never wrote a file. `mergeSystemRule` on an entry opts into the shipped baseline as well, so adding a check cannot silently drop every default.
- **High-severity findings are re-checked adversarially** (`reviewEscalation`, off). The reviewer that produced a `critical` is the worst available judge of whether it is real, so an independent adjudicator is asked to **refute** instead of to agree — an asymmetric question, because "confirm" is what a lazy answer gives. A refutation requires diff evidence against the finding and a failure to reach the confirming quorum, it is the only path that removes a finding, and unlike the fact-checker this stage fails *toward keeping*.
- **Deep review** (`reviewDeep`, off) reads every changed file with its own read-only child agent, which can search for callers and open the implementation a test covers instead of judging the diff alone. Off by default because it opens one child agent per file — a decision with a cost, not a better default.
- **The stop-time gate is opt-in.** `reviewMode` is `off`, `record` (the pass runs and its findings become durable session events) or `gate` (the same pass also injects findings at or above `reviewThreshold` once the cooldown has elapsed; an injected message continues the turn, so the Agent has to answer the finding before it can finish). It is deliberately *one* pass with two delivery channels: a per-turn reviewer and a stop gate would read the same diff of the same change set twice and could disagree about the same tree. Three rules bound the cost, and each one is a test: a turn that changed nothing is never reviewed, a change set is reviewed once per fingerprint *and* workspace revision (a second edit of an already-modified file changes no path, so the path list alone would call two different states the same state), and a run is confined to what the turn touched rather than to everything already dirty.
- **The panel and the tools share one route.** Reviews use the plugin's second-model route (`advisorProvider` / `advisorModel`, defaulting to OpenCode's virtual `auto`), not a new pair of settings, so a fresh install reviews out of the box and a settings change applies without a reload. The settings page shows the mode, threshold, cooldown, deep review and escalation, starts a run (fire-and-forget, then polls the same Remote) and renders the report with its coverage arithmetic.

#### Multi-member team

- **The board is the spine.** Tasks are handed out in id order, a task whose dependencies are unfinished is never offered, and a claim cannot be stolen — a refusal names who holds the task or what it is waiting for. Only the current owner may complete or fail a task, which is what makes the board an audit of who did what. Every mutation advances a revision and appends to a per-task ledger, a strict door demands the claim token so an owner name surviving a restart is not mistaken for the same member, and `rerun` reopens a failed or cancelled task under the same id instead of losing its attempt count.
- **Waiting on a person is a state, not a verdict.** `needs-review` records who is waited on, since when, and which claim it belongs to; the board counts it in its own bucket and names the parked tasks. A task blocked by a failed dependency is derived rather than stored, so retrying the dependency clears it without a status migration.
- **Members.** A member is a real child Agent with a role-scoped tool allow list; `engineering_team_member_start` / `_stop` and `engineering_team_recover` manage them. Membership is durable on disk; liveness is read from the live child and never mirrored.
- **Every writer gets its own git worktree** on its own branch under `.freecodego/worktrees/<member>` (registered in `.git/info/exclude` so isolation does not become untracked noise). The shared tree changes only on `engineering_team_merge`, and a conflicting merge is aborted *before* it is reported, with the conflicting paths named. A worktree that still holds uncommitted changes is kept unless the caller explicitly acknowledges losing it; a removal that failed stays visible as `active`. Worktree lifecycle is also exposed directly as `engineering_worktree_status`, `_list`, `_enter`, and `_exit`.
- **Roles are data** (`team/roles.ts`, overridable per project in `.freecodego/team-roles.json`). A role carries purpose, capabilities, a tool allow/deny list, a model, a turn cap, a sandbox mode, a report contract, and an explicit *not responsible for*. The allow list is intersected with the capability set, so a role that cannot write cannot be handed a write tool by naming one, and `explorer` and `verifier` are read-only by construction. Five roles ship today; adding one is adding a record.
- **Isolation is reported as what is in force**, not as what was requested: `enforcedBy` (`tool-scope`, `harness-policy`, `both`, or `none`) is computed from the resolved tool set and a read-back of the sandbox mode, and `enforcedBy: none` on a read-only request is never silent.
- **Manual context control.** `engineering_context_compact`, `engineering_context_snip`, and `engineering_context_budget` let the model act on the one thing it notices first — that a region is finished with — instead of waiting for pressure; snipping validates tool-call pairing and refuses an unbalanced boundary rather than silently widening it.

#### Code graphs

- **Two interchangeable engines, exactly one tool family mounted**, selected by `engineeringGraphEngine` (`auto` prefers the Python-free engine; `graphify` or `codegraph` means that engine or nothing).
- **Graphify** downloads the official `graphifyy==0.9.52` wheel after SHA-256 verification and bootstraps a SHA-256-pinned official `uv` release plus a private Python 3.12 under `DSH_HOME/freecodego/engineering/graphify`. Its build writes the graph, caches, and reports only to the plugin-owned project directory: no workspace `graphify-out`, no hooks, no `PATH` changes, no Lite Graph. Tools: `engineering_graph_status`, `_search`, `_explain`, `_path`, `_affected`, `_overview`, `_canvas`, `_mcp`.
- **CodeGraph** downloads the official self-contained platform bundle (48–62 MB) for the running OS/CPU after SHA-256 verification and unpacks it under `DSH_HOME/freecodego/engineering/codegraph`. The bundle carries its own Node runtime, so it needs no Python, no `uv`, and no wheel; musl Linux is refused rather than approximated. Its index lives in the workspace at `.codegraph-freecodego` (with a self-ignoring `.gitignore`) and is removed only on an explicit user action. Tools: `engineering_codegraph_status`, `_explore`, `_search`, `_explain`, `_path`, `_affected`.
- Both engines run with anonymous telemetry, the background daemon, and the CLI's own download fallback disabled, and the plugin never runs `codegraph install`, which would rewrite the user's other agent configurations. Freshness comes from the post-turn auto-update hook (`engineeringCodeGraphAutoUpdate`) and explicit user actions, not from a background watcher.
- `engineering_repo_map` is the always-available half: a zero-dependency identifier graph ranked with PageRank and rendered within a token budget, so a session-start map is never gated on a runtime install.

#### Engineering memory

- Project memory is local SQLite state under `DSH_HOME/freecodego/engineering/memory`. Agents can save drafts, and recall is the reviewed-only `Search → Timeline → Get` flow; drafts never enter automatic recall.
- Only the user-facing Remotes can approve, reject, export, purge, or delete records, and memory actions are scoped through an open workspace-backed session. Memory can also graduate into Skill drafts under `.freecodego/skill-drafts/`.
- Recall is fenced and budgeted (`engineeringMemoryContextTokenBudget`, 1,200 tokens by default), with the injected block fenced and its tags neutralized so repository text cannot impersonate memory.
- **Credential screening on the write path.** A labelled or vendor-prefixed credential refuses the entry outright, while a shape-only match (a JWT, a bare `sk-`, a PEM blob) is redacted in place and the entry is kept. A finding never returns the secret — only a four-character prefix and a length.
- **Consolidation is a staged rollout, because it writes.** A pass takes a fenced lease (a lock file with an expiry, so a crashed pass is recoverable while a *live* one is reported as `lease-held` rather than retried), reads a frozen snapshot of the observations that existed when it started, runs one tool-free model call, and writes topics atomically. `memoryRollout` therefore has four stages rather than a switch: `off`, `record_only`, `shadow` — which runs the whole pass including the model call and commits nothing, so an operator can read what the model *would* have written before letting it write — and `active`.
- **`MEMORY.md` is a bounded index of absolute pointers.** Paths are absolute because a relative pointer has to be resolved against a scope root, and a model that resolves it wrongly reports having found nothing rather than a broken path; overflow drops whole lines and states how many, because a truncated description leaves the index claiming to describe a record it no longer describes.
- **Forgetting requires evidence, never a pattern.** "Forget what you know about X" is the one request this subsystem must not answer by turning X into a set of files: that is a relevance decision whose overshoot deletes records with no undo, in a store whose whole value is that it remembers. The caller hands over the bytes it intends to remove together with their hash, and a directory, a glob, a hash mismatch and four other shapes are refusals rather than warnings.
- **Memory has an admin side, and telemetry is a schema.** The settings panel can consolidate on demand, rebuild the index, export reviewed memory, write a backup, and sweep expired content, all scoped to the open workspace session. Every telemetry event is *built* through one constructor that refuses an unknown field and refuses a free-text value, because a memory pipeline sees user statements, topic names, keywords and paths, and an innocuous `{ topic }` field would put a distilled version of a private note into whatever collects metrics — permanently. The refusal throws rather than dropping, so a belief that a metric is collected fails in a test instead of silently.

#### Checkpoints and hunk tracking

- Checkpoints (`engineering_checkpoint_capture`, `_diff`, `_pin`, `_list`, `_restore`) answer "what did the workspace look like before that call" at file granularity; `_restore` is the writer and is refused in Plan Mode.
- **Hunk tracking** records, for every mutating tool call, the contiguous line regions that call changed, attributed to the harness's own `callId`, and reverts a single hunk against the file's current text (`engineering_hunks`, `engineering_hunk_revert`). Recording runs for a *failed* call too, because a mutation that wrote and then reported an error is the change nobody finds by reading the transcript. A later edit supersedes the lines it replaced and the covered hunk refuses to revert on its own, naming the hunk that covered it. Revert verifies the recorded post-image is still at its offset or uniquely elsewhere and otherwise reports `drifted` rather than guessing; file line endings are preserved, and a path that resolves outside the workspace is refused.

#### Inspection, and deterministic scan selection

- `engineering_inspect` reports what a run would read, including the selection ledger: the coverage denominator, every exclusion with its reason, byte and token totals, and the names of any files whose size could not be judged. The gates run in a stated order — deletions leave the denominator first, credential paths are refused before any pattern rule (so a credential file inside vendored source reports `credential`), and patterns then name paths where a finding could not be acted on: dependencies, vendored source, build output, generated metadata, lockfiles. Test files are deliberately **not** excluded, because the defect class this plugin watches hardest is a test that asserts nothing while reporting green.
- That section is deliberately **not** folder-trust gated, and the difference is what it reads — sizes and path names, never content.
- Also here: `engineering_doctor` (static asset checks), `engineering_status`, `engineering_surface_report` (the injected-surface lock), `engineering_persona_list`, and `engineering_handoff_create`.

#### Evaluations and durable jobs

- `engineering-eval` is a deterministic, re-runnable capability evaluation of the plugin's own engineering machinery, because a claim of "caught up with upstream" that cannot be re-run is not evidence.
- Engineering jobs are durable and locally cancellable: the Harness job registry owns live runs (stable ids, `job_output` / `job_list` / `job_kill`, completion notices into the session) while a private SQLite store owns the audit trail and survives the process. Commands are never resumed after a Host restart — a job that was live is reopened as `interrupted`.

### Context and cost discipline

These mechanisms share one idea: a rule that only exists as prose cannot be enforced or reviewed, and a cost the model cannot see is a cost it cannot avoid.

- **Headroom output compression.** Oversized tool output is compressed by *shape* (log, JSON, diff, search, table, config, prose, HTML), each strategy running only when it actually shrinks its input. The durable session log keeps the full original, the compressed text carries a `hash=<24 hex>` marker, and `headroom_retrieve` fetches any omitted text back: lossy on the wire, lossless end-to-end.
- **Code skeletonization** (`headroomCodeSkeletonEnabled`, on). `read`, `read_file`, and `view` results are reduced to imports, declarations, type members, signatures, decorators, and doc comments. The contract is a subsequence: every retained line is byte-exact original text including its `N: ` prefix, only whole contiguous runs of body lines are replaced, and each is replaced by one marker naming the line range it covers — so an Edit anchored on a retained line still matches. A read is declined rather than guessed at when it is too small, already owned by another compressor, prose, an error, or would shrink by less than 25%. Measured on 1,983 real repository sources, the skeleton removes about 61.5% of applied file bytes (median 58.3%), and replaying sampled sessions drops re-transmitted tokens by 16.6%. Turning the switch off restores byte-exact reads.
- **Deferred tool schemas** (`deferredToolSchemasEnabled`, on). Deferred tools stay registered but withhold their schemas, so the tool block does not carry definitions for a turn that will never use them. `tool_search` returns definitions on demand and lifts the denial for exactly what it returned, so a deferred tool is as usable as an immediate one after one discovery call. Query forms: `select:A,B` for exact names, `+term rest` to require a term in a name, bare keywords to rank, and `list:<prefix>` (or `list:all`) for names without schemas. Ranking is BM25F over name and description — rarity computed against the deferred catalog, saturating term frequency, normalized by description length — rather than substring counting. The tool's own description is static on purpose: a dynamic index there would invalidate the prompt cache on every settings change. The index is priced like any other output and says what it dropped.
- **Cache-cold clearing** (`cacheColdClearEnabled`, on). When more than an hour has passed since the last main-loop assistant message, the provider's prompt cache has certainly expired and the whole prefix will be rewritten anyway, so older tool results are cleared *before* the next request. The threshold sits past every published TTL, so the mechanism cannot manufacture a miss that would not have happened, and per-session markers make clearing idempotent.
- **Spill and recall** (`spillRecallEnabled`, on). Cleared results are parked through the Harness spill capability and the marker carries a locator instead of a dead end, so re-reading the content no longer costs a re-run. `spill_recall` pages a parked artifact byte-exactly and returns the offset to ask for next, so walking it cannot silently stop at the start of a file.
- **Model-visible context budget** (`contextBudgetEnabled`, on). The model is told how full its window is, quantized into five bands so the cached prefix is not rewritten every turn and appended so everything before the last cache breakpoint stays a hit. Estimated is labelled as estimated; an unknown window is stated as unknown; no threshold is prescribed, only conditions and remedies. `engineering_context_budget` carries the exact number and is deferred, so the precision costs nothing until it is asked for.
- **Cache-miss attribution and request-shape fingerprinting** (`cacheBreakAttributionEnabled`, on). The local ledger records what each turn cost and what it *wasted*: the previous prompt bytes that were not read from cache, priced at the paid rate minus the cache-read rate, and labelled by cause (the model changed, the provider TTL expired, the prefix itself moved). Movement at or below 1024 tokens is ignored as breakpoint granularity, and a provider that never reports caching is reported as unattributable rather than as a 100% miss. Separately, each request's wire shape is hashed — system text, the tool set, **each tool's schema separately**, model, betas, budget band — so the next cache-read drop is attributed to a named change; a flag that once moved the prefix stays sticky-on rather than being allowed to flip back.
- **Differential context injection.** Injected standing context is split into named sections with snapshots: an unchanged section sends nothing, a changed section sends a replacement notice, a removed section sends an explicit removal notice (an instruction the model merely stops seeing is one it keeps following), and `unknown` after a resume, compaction, or restart is treated as possibly still held. A section shortened by its budget reports `incomplete`, so "we looked and there is nothing" stays distinguishable from "we stopped looking".
- **Compaction economics and fidelity.** Whether compacting pays for itself is computed rather than assumed — compacting rewrites the reusable prefix and is billed as a cache *write* — and a compaction summary is checked against the history it replaced, because that summary is the one artifact whose source was deleted in the same commit.
- **Runaway-loop guards.** `assistantLoopGuardEnabled` reads the assistant stream while the answer is still being written and stops repetition in the model's own prose; `doomLoopGuardEnabled` and the repeated-tool-call guard cover the other failure mode; `abort-drain.ts` finishes work that was already computed when a turn is cancelled instead of abandoning results the user already paid for.
- **Side-channel budget.** The Advisor and each council perspective are side channels, so each call is measured against the Harness compaction threshold before it is sent, and the worst footprint per channel is what is recorded. This is reported, never enforced.
- **What the prompt is made of** (`engineering_context_prompt`). `context-budget.ts` says how *full* the window is and cache attribution says what a miss *cost*; neither says what the tokens are *made of*, which is the question behind the platform's own decisions — the deferred-schema work exists because tool definitions were 45.7–47.4 KB of a 13,454-token fixed block, a figure found by one offline measurement rather than by anything askable at runtime. The tool returns the tree node by node (system text, tool block, standing guidance, Skills, injected fragments, conversation), each with its own size, so "the prompt is large" has a next step.
- **Post-compaction rehydration** (`rehydrationEnabled`, on). A summary alone loses standing context that was never part of the conversation's semantic content, so after the compactor shadows a span the plugin re-injects what the shadowed range used to carry: durable project memory, the latest todo list, and the latest engineering checkpoint. Everything is replayed from data the session already recorded, so a replay cannot disagree with the history it restores. The optional arc variant (`rehydrationArcEnabled`, off) folds goals and decisions the same way.

### Guardrails

- **Folder trust** (`folderTrustEnabled`, on) is one gate for every project-scoped surface driven by repository content — project MCP servers, project Skill roots, project personas, and project team roles — so opening an untrusted checkout cannot make the host execute or read anything by itself, and the user has one action that means *I trust this repository*. The PATH-probe LSP mount is deliberately **not** gated: it reads nothing the repository supplies.
- **Declarative command policy** (`commandPolicyEnabled`, on). Rules are data: ordered-token patterns with alternatives, a decision of `allow` / `prompt` / `forbidden`, a justification, and `match` / `notMatch` examples — and a rule whose own examples do not hold is rejected at load with a diagnostic, so the rule set tests itself where it is written. Longest pattern wins and ties go to the earlier rule, which is how a narrow `forbidden` sits in front of a broad `prompt`. `hostExecutable(name, paths)` pins which absolute paths may resolve through a basename rule, so a planted `./git` cannot satisfy a rule written for `/usr/bin/git`. Only `forbidden` becomes a denial: a monotonic guard cannot convert a denial back into an approval prompt, so `prompt` is left to the approval layer that can actually ask.
- **Plan Mode** (`planModeEnabled`, on) is a durable per-conversation mode that structurally refuses workspace mutation: file-mutating tools are refused, shell commands are judged by the same command policy, and reading, searching, and running checks stay available. It does not end because a sentence asked for execution — only `engineering_plan_mode` with `action: "exit"` leaves it, and the mode rules are injected through the fragment log so leaving sends a removal notice instead of leaving stale restrictions live.
- **The credential-path shield and the command policy reach native engines.** Native engines ship their own file and shell tools, which never cross the Harness tool registry; the plugin therefore also enforces its guards at the native permission seam, so Codex and Claude cannot silently skip what the Host would have refused.
- **Action review policy** (`engineeringActionReviewEnabled`, off, and deliberately unbound on the per-tool hot path). The policy half is complete: a delta transcript cursor keyed to a history generation, per-section token caps that include their own truncation marker in the budget, a per-session review budget, and a stable cache key. Absence is never an allow — no reviewer configured, an exhausted budget, and a reviewer that threw all return `ask-user`.
- **Injected-surface lock.** `engineering_surface_report` measures how many bytes of tool schema and guidance this plugin injects and diffs that against a reviewed lock, so editing a prompt is a visible diff instead of an invisible one.

### Capabilities beyond the model loop

- **MCP servers** (`mcpEnabled`, off). Enabled servers are connected once by the Host and registered as Harness tools for DeepSeek; Claude receives the discovered schemas through its in-process `freecodego-host` MCP server and calls the Host bridge, and Codex receives the enabled server definitions in its plugin-owned app-server config. The community page reads bounded, paginated MCP.so metadata through Host Remotes and offers one-click install only when the published detail is representable by the shared registry with no unresolved environment or header values; anything requiring credentials stays in manual configuration instead of reporting a non-functional install.
- **Skills** (`skillEnabled`, off; the starter root is on). Enabled roots are discovered by the Harness filesystem Skill provider; a skills.sh installation atomically registers the Host-owned community directory so the imported `SKILL.md` bundle is visible immediately to DeepSeek and to the next native session. Claude loads enabled Skills through the Host bridge, Codex receives them through `skills/extraRoots/set`, and disabling a capability unloads its provider so future native sessions do not receive it. The bundled library is audited as a whole and split across roots: a starter root of ten Skills is on by default (four disciplines the model applies on its own, plus `/name` entries that cost nothing until typed), and 23 further audited Skills — including vendored `mattpocock/skills` entries — stay unmounted until the opt-in switch is turned on. A Skill map, draft generation from reviewed memory, collision checks, and a lockfile live beside them.
- **LSP auto-mount** (`lspEnabled`, on). The core LSP stack attaches only when candidate language-server executables actually resolve on PATH, so a machine without them boots normally instead of failing at load.
- **Scheduling and hook chains.** The Harness owns reminders and this plugin does not own a second scheduler; what it adds is the calendar arithmetic the Harness's rule set cannot express ("every weekday at 09:00", "the first of the month"), answered through `freecodego_schedule_plan`. `hookChainsEnabled` (on) adds declarative failure-recovery rules over a small event vocabulary with a depth guard and a cooldown, because a recovery layer that can storm is worse than none.
- **Media, transcription, and voice.** Image, video, and audio generation plus Whisper transcription as described above, and a voice-input control in the composer (`voiceInputEnabled`) that transcribes through the Groq Whisper route.
- **Web-search provider.** The stock web-search page configures an endpoint, a key, and a search budget, and leaves the model at DeepSeek's own default — the one part a FreeCodeGo installation wants to change. This plugin adds a model list under that page's own configuration, built from the directory it routes, and choosing a row writes that model's Anthropic-compatible endpoint, its wire model id, and a key of its own (`FREECODEGO_WEB_SEARCH_API_KEY`, never the provider's own reference, which keeps a user's DeepSeek key intact) into the `web-search-deepseek` namespace. The endpoint is normalized for the provider's join rule, and a provider reached through the local bridge is rebuilt automatically after a restart, because its route id and secret are minted per process: the Host re-resolves the remembered provider and model at startup, before the first search can run, and the page does the same on load when the Host could not (no credentials or settings service mounted). Only a binding this plugin never recorded a provider/model for — or one whose rebuild failed — asks the user to pick again.
- **Agent presets and personas.** The bundled agent presets are installed into `<DSH_HOME>/.agent-presets/` and kept in sync — written when absent, overwritten when the plugin's own version marker is recognized, and left alone when the user hand-edited them, so a preset appears in the mode picker without touching Harness source or restarting. Personas are TOML files with a stated precedence (inline settings → project `.freecodego/personas/` → `$DSH_HOME/freecodego/personas/` → bundled), a declarative input/output contract that can refuse a spawn when a required input is missing (a missing required output only warns), and a `default_isolation` that resolves into the worktree machinery. The project tier is trust-gated, so an untrusted checkout's persona files are not opened at all.
- **Housekeeping.** Session deletion (`sessionDeleteEnabled`) is reachable two ways that share one gate and one failure report: the trash control that appears at the end of a hovered session row, and a named *Delete session* row in that session's "…" menu under *Archive* — which is the only route a touch user or a keyboard user has to the same action. A delete from the menu dismisses the menu and reports its refusal through the same alert the hover control uses. It clears a stale sidebar row idempotently when the log is already gone, while a live session must be closed first, and the companion shows the selected session's activity as a character in two seats that always agree — the rail mark and a strip above the composer — with a labelled pose for each state rather than a shape that has to be guessed.

### Settings surface

The `FreeCodeGo` settings section is the Host configuration surface: engine generations and persisted default engine state, backend availability, provider routes, the media defaults, the WorkBuddy device-login card, the Agnes AI card, the engineering master switch, and the multi-engine team panel with quorum, failures, consensus, dissent, and explicit *Approve implementation* / *Reject plan* actions. A capability switch registers its own sidebar entry, so an inactive capability adds no dormant navigation:

| Entry | What it configures |
|---|---|
| `FreeCodeGo` | account, quota and usage, plans and checkout, device sessions, media defaults, the team panel, and the code review panel (mode, threshold, cooldown, deep review, escalation, and an on-demand run with its report) |
| `MCP` / `Skills` | MCP connections, discovered tools and quick templates; configured Skill roots versus the discovered catalog |
| `Advisor` | the Advisor route, delivery, notes, and memory drafts |
| `Engineering` | the master switch plus the detailed engineering controls |
| `Token usage` | the local ledger and the redacted usage dashboard |
| settings-dialog controls | the response language and the default engine, also reachable from the session header, the composer, and the General page |
| composer and rail | the engine badge, the voice-input control, and the agent companion |

Route creation and editing deliberately stay in the shared Models settings surface rather than a second editor, and the browser never receives stored key values. Reading a value the plugin cannot parse falls back to its documented default rather than failing the page.

### Plugin conflict protection

`pluginConflictProtectionEnabled` (on) installs the guard when the plugin's own composition entry activates. FreeCodeGo then statically scans every entry module and its local imports for literal duplicate Tool names, command names, settings namespaces, HTTP routes, model Provider ids, and UI Slot ids. Entries that initialize after that point are wrapped before they run, and the ones already running are recorded first, so an entry starting later is still refused a resource an earlier one owns; when that happens it keeps the earlier entry, disables the later one, and saves a repair record for the settings page, and the notification names both entries and the duplicate resource. The scanner never executes third-party code and intentionally ignores dynamic or computed registrations — it prevents reliable duplicate registrations, not unrelated plugins that merely provide similar user-facing features.

### Release updates

The update service reads the releases of `XiangSu-ce/dsh-plugin-freecodego` rather than updating one Host component in isolation. A release is tagged `freecodego-v<version>` — the family prefix keeps several release families' tags apart in one repository — and carries its bundle tarball as `<package name>-<Harness version>.tgz`, so one request answers both questions a check asks: which version is newest, and which Harness it was built for. The asset names the Harness line rather than the bundle version, so a hotfix stays identifiable: its tag is the exact version, one dotted segment deeper, while its asset still says which line it belongs to. A release whose asset carries the bundle version installs too — the lookup accepts both spellings and falls back to a release's only tarball — because a name that disagrees with the tag is not a reason to leave an update unreachable.

Only a release built for the running Harness is offered (an exact match, or a hotfix one dotted segment deeper) and the highest one wins. Checks run shortly after startup and then daily. Installation runs `dsh plugin --profile <profile> add --save-exact <tarball url>`, the same entry point the user installed with, scoped to the profile the update was checked from, and stages the result in a sibling Profile before atomically promoting it; the pre-update Profile stays available until the restarted Host remains healthy, and the settings page can restore it. A version can be withdrawn by editing its release, which a published npm version cannot, and updating never restarts the process implicitly.

### Where state lives

Plugin-private state — memory, checkpoints, the code-graph and Graphify runtimes, jobs, plan mode, and teams — resolves its root through one helper: `FREECODEGO_HOME` when it is set to a non-empty value, otherwise `DSH_HOME`, otherwise `~/.dsh`. Every `DSH_HOME/...` path above is written against that rule, so setting `FREECODEGO_HOME` moves all of them at once. Host-owned files (`.credentials.yaml`, `settings.yaml`, `profiles/`, `runtimes/`, `state/`, `.agent-presets/`, `skills/`) never follow that override, because the Host writes and reads them and a second root would leave the settings surface and the credentials service disagreeing about which file is the truth.

Two directories are workspace-local on purpose: `.codegraph-freecodego` is the CodeGraph index (a self-ignoring `.gitignore`; removed only on an explicit user action), and `.freecodego/` holds generated media, team worktrees, Skill drafts, project personas, project team roles, and the project `config.json` the trust gate decides whether to read.

## Tools the model sees

The plugin's own model-facing surface is declared once, in `tool-manifest.ts`, together with what holding each tool requires and whether Plan Mode may call it; the table is checked against the registration literals in the source in both directions, and Plan Mode's fences and the team role fence are views of it. The manifest holds 78 names today; `tool_search` is the discovery entry point when deferred schemas are withheld.

<details>
<summary>Tool families (click to expand)</summary>

| Family | Tools |
|---|---|
| Advisor | `advisor_status`, `advisor_review`, `advisor_notes`, `freecodego_advisor_read`, `freecodego_advisor_glob`, `freecodego_advisor_grep` |
| Media and scheduling | `agnes_generate_image`, `agnes_generate_video`, `freecodego_generate_image`, `freecodego_generate_video`, `freecodego_generate_audio`, `freecodego_transcribe_audio`, `freecodego_recovery_status`, `freecodego_schedule_plan` |
| Engineering diagnostics and memory | `engineering_status`, `engineering_doctor`, `engineering_repo_map`, `engineering_handoff_create`, `engineering_persona_list`, `engineering_inspect`, `engineering_surface_report`, `engineering_memory_search`, `_get`, `_timeline`, `_save`, `_export` |
| Checkpoints and hunks | `engineering_checkpoint_capture`, `_diff`, `_pin`, `_list`, `_restore`, `engineering_hunks`, `engineering_hunk_revert` |
| Code graphs | `engineering_graph_status`, `_search`, `_explain`, `_path`, `_affected`, `_overview`, `_canvas`, `_mcp`, `engineering_codegraph_status`, `_explore`, `_search`, `_explain`, `_path`, `_affected` |
| Plan and context | `engineering_plan_mode`, `engineering_context_budget`, `engineering_context_prompt`, `engineering_context_snip`, `engineering_context_compact` |
| Engineering team | `engineering_council_review`, `engineering_team_start`, `_status`, `_report`, `_cancel`, `_request_approval`, `_mark_implemented`, `_verify`, `_board`, `_plan`, `_claim`, `_task_update`, `_recover`, `_member_start`, `_member_stop`, `_merge`, `_subagent_start` |
| Code review | `engineering_code_review`, `engineering_review_rules`, `engineering_review_status`, `engineering_review_report` |
| Worktrees | `engineering_worktree_status`, `_list`, `_enter`, `_exit` |
| Compression, retrieval, and composite calls | `headroom_retrieve`, `inspect`, `read_document`, `spill_recall`, `edit_and_run` |

</details>

## Requirements

- **Node** `^22.19.0 || >=24.0.0`
- **DeepSeek Harness** `0.1.7-alpha.2`. The bundle declares `freecodego.harnessBaseline`, and an update is offered only for the line it was built for.

## Install

The bundle is distributed as a release asset, not from a package registry:

```sh
dsh plugin --profile web add --save-exact <tarball-url>
```

For example, the bundle built for Harness `0.1.7-alpha.2`:

```sh
dsh plugin --profile web add --save-exact \
  https://github.com/XiangSu-ce/dsh-plugin-freecodego/releases/download/freecodego-v0.1.7-alpha.2.1/freecodego-0.1.7-alpha.2.tgz
```

`--profile web` is the profile `dsh web` runs under; substitute your own profile name if you launched the Harness differently. A Host restart is required before the new bundle is loaded.

To build from source instead, the workspace is [`plugin/`](plugin):

```sh
cd plugin
pnpm install
pnpm run build
```

## Releases and asset naming

Every release is tagged `freecodego-v<version>`, and its tarball is named `<package>-<Harness version>.tgz` — for this bundle, `freecodego-0.1.7-alpha.2.tgz`. The asset names the **Harness line** rather than the bundle version, so a hotfix (`v0.1.7-alpha.2.1`) still says which line it belongs to. A release whose asset carries the bundle version installs too, and a release holding a single tarball is accepted whatever it is called — a name that disagrees with the tag is not a reason to leave an update unreachable.

The update service reads the releases of this repository, checks shortly after startup and then daily, and installs through the same `dsh plugin add --save-exact <url>` entry point the user installed with. Installation stages the bundle in a sibling Profile and promotes it atomically; the previous Profile stays restorable until the restarted Host is healthy.

## Packages

| Package | What it is |
|---|---|
| `freecodego` | the installable bundle — what `dsh plugin add` mounts |
| `@deepseek-ai/dsh-freecodego-harness-plugin` | engine inventory and Host configuration surface |
| `@deepseek-ai/dsh-freecodego-harness-ui` | the engine, account, and settings surface |
| `@deepseek-ai/dsh-freecodego-api` | the redacted FreeCodeGo backend client |
| `@deepseek-ai/dsh-freecodego-agent-engine-router` | the single `AgentFactory` router |
| `@deepseek-ai/dsh-freecodego-root-agent` | engine-neutral root-agent session bridge |
| `@deepseek-ai/dsh-freecodego-runtime-codex` | Codex app-server JSONL worker |
| `@deepseek-ai/dsh-freecodego-runtime-claude` | Claude Agent SDK runtime, driven in the Host process |
| `@deepseek-ai/dsh-freecodego-native-runtime-host` | managed child-process host for native workers |
| `@deepseek-ai/dsh-freecodego-native-runtime-protocol` | Node JSONL protocol primitives |

## Documentation

- [`plugin/packages/freecodego/harness-plugin/README.md`](plugin/packages/freecodego/harness-plugin/README.md) — the full feature document: every feature, the decision behind it, and the known limitations, plus the entry point to the per-package READMEs under `plugin/packages/freecodego/`.
- [`plugin/packages/freecodego/harness-plugin/docs/free-providers.zh.md`](plugin/packages/freecodego/harness-plugin/docs/free-providers.zh.md) — the Cline and WorkBuddy International integrations in depth: upstream contracts, the account pool, and the rotation semantics (Chinese).
- [`plugin/packages/freecodego/freecodego-api/docs/backend-contract.zh.md`](plugin/packages/freecodego/freecodego-api/docs/backend-contract.zh.md) — the endpoint-by-endpoint backend contract, including which field owns routing outcomes and billing (Chinese).
- Chinese companions ship beside each package README as `README.zh.md`.
- [`plugin/COMPATIBILITY.md`](plugin/COMPATIBILITY.md) — the Harness target and how a clean checkout materializes it.
- [`plugin/THIRD_PARTY_NOTICES.md`](plugin/THIRD_PARTY_NOTICES.md) — vendored and bundled third-party code.
- [`plugin/TRADEMARK.md`](plugin/TRADEMARK.md) — the FreeCodeGo trademark and fork naming policy.
- [`plugin/AWESOME_DSH_PLUGIN.md`](plugin/AWESOME_DSH_PLUGIN.md) — the entry this repository submits to the community plugin catalog, the rules that entry is checked against, and what has to be refreshed when a new Harness line ships.

## License

[AGPL-3.0-only](LICENSE) — the same license this repository's packages declare and the one DeepSeek Harness itself carries, so a distribution that composes the two stays under it. Vendored third-party copies keep their own notices; see [`plugin/THIRD_PARTY_NOTICES.md`](plugin/THIRD_PARTY_NOTICES.md).
