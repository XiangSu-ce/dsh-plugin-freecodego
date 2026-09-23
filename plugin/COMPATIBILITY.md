# Harness Target

FreeCodeGo targets DeepSeek Harness `0.1.7-alpha.2` at tag
`dsh-v0.1.7-alpha.2`. The checked-in candidate source follows that official
at the commit recorded in `harness.lock.json`; that lock file is the sole
source used by assembly, builds, tests, and release verification.

Clean checkouts materialize that exact official commit in place with
`pnpm run sync:harness`; the command overwrites official Harness directories
and preserves only `packages/freecodego` as the private overlay.

The active composition mounts the official base and web bundles plus
`freecodego`. FreeCodeGo owns its behavior through
the public AgentFactory, session-event registration, settings, model-directory,
tool, and client-slot APIs. It does not patch the official Harness source.

## Single-Authority Boundaries

Where the Harness already implements something this plugin also needed, the
Harness owns the state and the plugin keeps only the part the Harness has no
equivalent for. One authority per fact, read through one seam, with the plugin's
own implementation kept as the fallback for a composition that mounts no Harness
counterpart — not as a second peer that can disagree:

- **Plan mode.** `ctx.planMode` owns the mode, the `plan` projection, the
  `plan:policy` section, `exit_plan_mode`, and `/plan`. The plugin reads its mode
  there and writes transitions through it, and injects only the enforcement
  addendum — that this deployment refuses a mutating call — because the Harness's
  own section already states the rules. Its durable store remains the fallback.
  (`plan-mode.ts`, `findUpstreamPlanMode`.)
- **Approval.** The Harness's `auto` permission preset is the user asking the
  Harness to decide, so the plugin's approval reviewer stands down while that
  preset is selected; its own reviewer answers the prompt only where the Harness
  has no preset gate. (`action-reviewer.ts`, `standsDown`.)
- **Scheduling.** `@deepseek-ai/dsh-schedule` owns reminders: the durable record,
  the `schedule` projection, delivery, and `schedule_create` / `_list` / `_delete`.
  It is not mounted by any upstream bundle, so this composition mounts it. The
  plugin contributes calendar arithmetic only — `freecodego_schedule_plan` answers
  when a cron rule next falls and whether one `every_seconds` reminder can carry
  it — and stores no reminder of its own. (`automation.ts`.)
- **Teams.** `ctx.agentTeams` plus `tool-agent-team` own the roster, mailbox, and
  shared board. While they are composed the plugin does not register its own
  `engineering_team_board` / `_plan` / `_claim` / `_task_update` /
  `_member_start` / `_member_stop`, and keeps `engineering_team_merge` (writer
  worktree isolation) and `engineering_team_recover`. The bundle loads the
  Harness's team rows before `freecodego` so the decision is settled before the
  first request catalog is assembled. (`team/authority.ts`.)

- **Provider rows.** A row is disabled only when a row that stays mounted still
  supplies the id it was supplying, *in the registry that reads it*. Provider ids
  are per-registry, and one string can name two of them: `deepseek-official` is
  both the LLM route (`ctx.llm.registerAdapter`, named by
  `agent-default-model.provider`) and the web search provider
  (`ctx.web.registerSearchProvider`, named by `web.searchProvider`), so the plugin's
  composition leaves `llm-deepseek` and `web-search-deepseek` mounted and registers
  its own model adapters *beside* the official one rather than in place of it.
  Disabling the two of them once made every `web_search` throw the Harness's own
  `WEB_PROVIDER_CONFIGURED_MISSING` (`packages/web/web/src/index.ts`) and left a
  fresh profile's default model naming nothing.
  (`harness-plugin/tests/alpha-composition.spec.ts` holds the guard: it parses the
  base composition and the plugin patch, and requires a mounted supplier for every
  provider reference the composed tree names.)
- **Tool-result compaction.** `@deepseek-ai/dsh-compaction-tool-result-pruner`
  owns a result it shrank: its replacement is durable, replayable and priced by the
  meter, and what is left in the session carries its `PRUNE_MARKER`. `cache-cold`
  clears only results the Harness has *not* rewritten, because the text it would
  park is the remnant (head + marker + tail) while the marker it writes promises the
  full result at the locator. Its own view transform stays the increment: it is a
  per-request projection that keeps the prompt cache break in one place, which a
  durable replacement cannot do. (`cache-cold.ts`, `HARNESS_PRUNE_MARKER`.)
- **Spill storage.** `ctx.spillStore` owns the bytes. The plugin's `CcrStore` is
  the fast path and the whole answer where no backend is mounted, and every held
  write is archived through the Harness's store (`headroom/ccr-spill.ts`), with the
  delivered text naming the backend's locator so the copy is reachable after a
  restart. `spill_recall` (byte-exact paging) and `headroom_retrieve` are the
  increments; the Harness's policy keeps its own `read`-skipping, cap-bounded
  behaviour and is never pre-empted. (`result-spill.ts`, `spill-recall.ts`.)
- **Entry enablement.** The Loader owns it: `plugin-manager` writes it, its page
  shows it, and `dsh plugin` addresses it. The plugin's third-party conflict guard
  is therefore opt-in (`pluginConflictProtectionEnabled`, off unless a deployment
  asks for it), intercepts no entry while it is off, and — when it is on — keeps the
  already-running entry and disables the later claimant before its code starts. The
  Harness's own registries refuse a duplicate with the message that names the
  conflicting resource, and a refused `init()` fails that one entry.
  (`plugin-conflicts.ts`.)
- **Token accounting.** `ctx.tokenMeter` is the reading: the plugin asks it to
  `measure()` a session and reports the answer as measured. Its own
  `token-estimate.ts` exists only because the prompt-composition surface prices
  content too, and it mirrors the host's density so one prompt cannot report two
  numbers; the injection (a band-quantized budget fragment plus the on-demand
  report tool) is what the plugin adds. (`context-budget.ts`, `token-estimate.ts`.)
- **Image budget.** `@deepseek-ai/dsh-compaction-image-offload` owns the
  offload-and-retry for a route that rejects a request over its image budget; the
  plugin only classifies `IMAGE_OFFLOAD_REQUIRED` as a non-retryable request
  (`provider-error-classify.ts`), so the retry stays the Harness's.
- **Skill resources.** A loaded Skill's `resourceBase` is the provider's own answer to
  "where are this Skill's relative resources", and it is the *only* answer that covers a
  virtual Skill: the bundled `dsh-badge` skill declares an asset directory and reports no
  `SKILL.md` path at all. The Skills dialog reads the declared base first
  (`skillResourceLocation` in `skill-detail.ts`) and infers the directory from the reported
  path only for a provider that declared none — the fallback, not the first answer. A base
  this build cannot read (`url`, `opaque`, or a `kind` from a newer Harness) is reported in
  the provider's own masked wording rather than downgraded to a local read, because listing
  local files while telling the user about remote ones is how a dialog shows a wrong file.
  **Reading those files is the Harness's filesystem seam too**: `ctx.fs` when the composition
  mounts it (`resolve`/`listDir`/`readText`/`contains`, so the dialog sees the same filesystem
  the model does and containment is the backend's canonical answer), the host's own filesystem
  only as the fallback. (`capabilities.ts` `readSkill`, `skill-detail.ts` `SkillCompanionFs`.)
- **Advisor evidence.** The reviewer's `read`, `glob`, and `grep` are the Harness's own tools:
  the loop offers their mounted schemas and dispatches each call through `ctx.tools.execute`
  with the calling agent, so evidence arrives through the mounted filesystem seam, the
  registry's `tools/pre-execute` pipeline (where this plugin's credential-path guard and the
  deployment's approval policy already sit), and the tools' own paging. The plugin keeps only
  what nothing else provides: its own side-channel loop and route, the cross-perspective
  evidence cache (one execution serves every council perspective asking the same question),
  and a named bound on what it hands the reviewer — a prefix the reviewer was not told about
  is the one it reasons about as if it were whole. It ships no tools of its own any more.
  (`advisor.ts` `ADVISOR_REVIEW_TOOLS`, `executeReviewTool`, `AdvisorEvidenceCache`.)
- **Profile package operations.** `dsh plugin` owns every profile manifest edit:
  the dependency, the `dsh.profile.bundles` line that mounts a bundle, the overlay
  patch that line loads, and the diagnostic log. The community marketplace asks
  the CLI to `add` and `remove` (`community-remotes.ts` → `runDsh`) and edits no
  manifest itself; its own hand-rolled bundle reconciliation was a second writer
  of the same file that could only drift from the CLI's rules. Because the CLI
  activates as it installs, the asset scan runs *after* the install and a refusal
  takes that activation back — a freshly added package is `remove`d through the
  same CLI, and a name that was already installed (the update case, where there is
  no retained previous version to restore) has its loader entries disabled instead,
  so the next start mounts nothing it did not mount before.
  (`community-remotes.ts`, `plugin-update.ts` `runDsh`.)
- **Hook files.** `.claude/settings.json` is read by two systems that both *run the
  command*: this plugin's hook reader and the Harness's own bridge
  (`@deepseek-ai/dsh-hooks-claude-code`, which parses the same event→matcher-group
  grammar). The native row keeps the file — when a row mounting that bridge is
  present, the plugin's reader stands down from `.claude/settings.json` in **both**
  tiers and keeps the dialects no Harness package parses (`.freecodego/hooks.json`,
  `.cursor/hooks.json`). The answer is read off the Loader, because the bridge is in
  no bundle (the profiles that mount it insert the row themselves), and every
  unreadable answer keeps the file this reader's rather than claiming the Harness
  runs hooks it never loaded. The `hooks` section of the inspect report names the
  owner of the dialect instead of quietly listing one file fewer.
  (`hooks/files.ts` `harnessOwnsClaudeHookFiles` / `claudeHookDialectOf`,
  `index.ts` `claudeHookDialect`, `inspect/host.ts`.)

The two Harness capabilities this composition mounts and no upstream bundle does
are bundled from official source by `scripts/build-freecodego-bundle.mjs` and
listed in `packages/freecodego/bundle-latest/cordis.patch.yml` as
`freecodego/schedule` and `freecodego/auto-review`.

## NPM Version Selection

The public package is `freecodego@0.1.7-alpha.2`. Its version and
`freecodego.harnessBaseline` must exactly equal the supported Harness version.
Do not publish another patch-level plugin version for this Harness line. The
bundle metadata and release checks reject a package whose declared Harness
baseline does not match the supported source line.

Provider routing is identity-preserving: Logfare, B.AI, OpenRouter, OpenCode,
and any user-defined `llm-pi-ai` provider stay on their own adapter and
credentials. The FreeCodeGo gateway is selected only for models explicitly
owned by the FreeCodeGo catalog.

The patched `dsh plugin --profile freecodego` and `freecodego-latest` commands
initialize the profile with the official base/web layers, then install the
exact matching Bundle automatically. Existing Profiles can use the same
command with `add` to migrate to the current Bundle.

Historical Alpha.5, RC5, v012, and legacy compatibility packages have been
removed from the source tree. Do not reintroduce compatibility branches or
fallback release paths unless a future Harness line is intentionally supported
and covered by a separate published composition.

Promote changes only after the alpha.2 Host and Client builds, focused
FreeCodeGo tests, a clean web-profile smoke test, and native Codex/Claude
runtime smokes pass on supported platforms.
