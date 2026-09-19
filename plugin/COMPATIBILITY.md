# Harness Target

FreeCodeGo targets DeepSeek Harness `0.1.6-alpha.2` at tag
`dsh-v0.1.6-alpha.2`. The checked-in candidate source follows that official
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

The two Harness capabilities this composition mounts and no upstream bundle does
are bundled from official source by `scripts/build-freecodego-bundle.mjs` and
listed in `packages/freecodego/bundle-latest/cordis.patch.yml` as
`freecodego/schedule` and `freecodego/auto-review`.

## NPM Version Selection

The public package is `freecodego@0.1.6-alpha.2`. Its version and
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
