/**
 * Plan Mode: the file, the states, the fence, and the review.
 *
 * What these cases protect
 * ------------------------
 * Two of Plan Mode's properties are the reason it exists, and both are easy to lose
 * to a plausible refactor:
 *
 * 1. **The fence is containment, not a prompt.** It must hold in every approval mode,
 *    including one that removes prompts entirely. A fence keyed on the approval mode
 *    would look right in every test that uses the default and be absent in exactly the
 *    configuration where the user turned prompts off.
 * 2. **`active` has one source.** The harness projection is the truth; a second flag
 *    here would be able to disagree with it, and the symptom — a UI showing plan mode
 *    over a model that is not in it — has no obviously wrong side.
 *
 * The restart collapse is tested rather than assumed because the transients' home (a
 * field in memory) is the kind of detail a refactor moves to disk for durability.
 */

import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanFileStore, PLAN_FILE_NAME, isPlanFile, planDirectory, planFilePath, safeSegment } from '../src/plan/plan-file.ts'
import { composePlanReworkMessage, planReviewSurface } from '../src/plan/plan-review.ts'
import { PLAN_SECTIONS, inspectPlanSections } from '../src/plan/plan-sections.ts'
import { BUILT_IN_COMMAND_POLICY, compileCommandPolicy } from '../src/command-policy.ts'
import { PLAN_MODE_ALLOWED_PLUGIN_TOOLS, PLAN_MODE_MUTATING_TOOLS, PlanModeStore, findUpstreamPlanMode, planModeRefusal, planModeSessionKey } from '../src/plan-mode.ts'
import { nativeToolDenial } from '../src/native-tool-guard.ts'

const PLAN = '/data/freecodego/plans/session-1/plan.md'

describe('plan file', () => {
  it('makes a session id safe to use as one path segment', () => {
    // A separator in a session id would place the plan outside the directory meant to
    // contain it; `..` would place it outside the plugin's data root entirely.
    expect(safeSegment('../../etc')).not.toContain('/')
    expect(safeSegment('..')).not.toMatch(/^\./u)
    // Not `_`, which is what the id `_` maps to: the placeholder for an empty id
    // was an id another id could be, and `plan-file-segment.spec.ts` pins the
    // injectivity that rules out.
    expect(safeSegment('')).toBe('~')
    expect(safeSegment('_')).toBe('_')
    expect(safeSegment('session-1')).toBe('session-1')
  })

  it('recognizes this session’s plan file through a normalizing comparison', () => {
    // A relative path or a doubled separator must still count, or a caller asking
    // about the plan it just wrote would be told it is a different file. (No fence
    // calls this today: Plan Mode's containment refuses mutating tools by name.)
    expect(isPlanFile('s', planFilePath('s'))).toBe(true)
    expect(isPlanFile('s', `${planFilePath('s')}/`)).toBe(true)
    expect(isPlanFile('s', planFilePath('other'))).toBe(false)
  })

  it('names the plan file the same way the review surface does', () => {
    expect(planFilePath('s').endsWith(PLAN_FILE_NAME)).toBe(true)
    expect(planDirectory('s')).not.toContain(PLAN_FILE_NAME)
  })
})

describe('PlanFileStore', () => {
  let directory: string
  let previousHome: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'freecodego-plan-'))
    previousHome = process.env.FREECODEGO_HOME
    process.env.FREECODEGO_HOME = directory
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FREECODEGO_HOME
    else process.env.FREECODEGO_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  })

  it('reads an absent plan as no plan rather than throwing', async () => {
    expect(await new PlanFileStore().read('session-1')).toBeUndefined()
  })

  it('round-trips a plan through the file', async () => {
    const store = new PlanFileStore()
    await store.write('session-1', '## Context\nwhy\n')
    // A second store is what a restart looks like: the plan has to survive outside
    // the object, or it is not the document of record at all.
    expect(await new PlanFileStore().forApproval('session-1')).toBe('## Context\nwhy\n')
  })

  it('terminates the file with a newline without doubling one', async () => {
    const store = new PlanFileStore()
    const file = await store.write('session-1', 'body')
    expect(await readFile(file, 'utf8')).toBe('body\n')
    await store.write('session-1', 'body\n')
    expect(await readFile(file, 'utf8')).toBe('body\n')
  })

  it('recognizes the plan only by spelling, so a symlinked ancestor is not the plan', async () => {
    // Measured, and pinned because the opposite used to be claimed in the source:
    // `resolve` normalizes a path without touching the filesystem, so this same file
    // reached through a link — or through Windows' 8.3 short name for a directory —
    // is a different string and compares unequal. The doc comment says so now; this
    // keeps it true, and keeps a future fence from reading `true` here as a
    // permission the comparison never established.
    const store = new PlanFileStore()
    const file = await store.write('session-1', 'body')
    const plans = planDirectory('session-1')
    const linked = join(dirname(plans), 'session-1-link')
    try {
      await symlink(plans, linked, 'junction')
    } catch {
      // A platform or account without the privilege to create a link: there is
      // nothing to measure, and a failure here would report the environment.
      return
    }
    expect(isPlanFile('session-1', file)).toBe(true)
    expect(isPlanFile('session-1', join(linked, PLAN_FILE_NAME))).toBe(false)
  })

  it('approves the text on disk, not a memory copy', async () => {
    // What is approved has to be the document of record, including a hand edit made
    // between entering and leaving.
    const store = new PlanFileStore()
    await store.write('session-1', 'original')
    await store.write('session-1', 'edited by hand')
    expect(await store.forApproval('session-1')).toBe('edited by hand\n')
  })
})

describe('plan sections', () => {
  it('names the five sections', () => {
    expect([...PLAN_SECTIONS]).toStrictEqual(['Context', 'Approach', 'Files', 'Reuse', 'Verification'])
  })

  const full = PLAN_SECTIONS.map(section => `## ${section}\ncontent\n`).join('\n')

  it('reports a complete plan as complete', () => {
    const report = inspectPlanSections(full)
    expect(report.present).toStrictEqual([...PLAN_SECTIONS])
    expect(report.missing).toStrictEqual([])
    expect(report.warnings).toStrictEqual([])
    expect(report.empty).toBe(false)
  })

  it('names the missing sections without blocking', () => {
    // A one-line plan for a one-line change is a good plan. A check that refused it
    // would teach authors to pad every plan until the check stopped complaining.
    const report = inspectPlanSections('## Context\nwhy\n## Approach\nhow\n')
    expect(report.missing).toStrictEqual(['Files', 'Reuse', 'Verification'])
    expect(report.warnings.join(' ')).toContain('no Files / Reuse / Verification section')
  })

  it('distinguishes a blank section from a missing one', () => {
    const report = inspectPlanSections('## Context\n\n## Approach\nhow\n## Files\nf\n## Reuse\nr\n## Verification\nv\n')
    expect(report.present).toContain('Context')
    expect(report.blank).toStrictEqual(['Context'])
    expect(report.warnings.join(' ')).toContain('Context is present but empty')
  })

  it('names a repeated blank section once', () => {
    // An author who writes the same heading twice is a thing that happens, and the
    // warning is read by a human: "Verification / Verification is present but empty"
    // reads as two problems and is one.
    const report = inspectPlanSections('## Context\nc\n## Verification\n\n## Verification\n\n')
    expect(report.blank).toStrictEqual(['Verification'])
    expect(report.warnings.join(' ')).toContain('Verification is present but empty')
    expect(report.warnings.join(' ')).not.toContain('Verification / Verification')
  })

  it('does not let a later section make an earlier blank one look filled', () => {
    const report = inspectPlanSections('## Context\n## Approach\nhow\n')
    expect(report.blank).toContain('Context')
  })

  it('gives one warning for an empty plan rather than five', () => {
    const report = inspectPlanSections('   ')
    expect(report.empty).toBe(true)
    expect(report.warnings).toStrictEqual(['the plan is empty'])
  })

  it('ignores headings the author added', () => {
    const report = inspectPlanSections(`${full}\n## Notes\nmine\n`)
    expect(report.missing).toStrictEqual([])
    expect(report.warnings).toStrictEqual([])
  })

  it('handles a large plan without losing a section', () => {
    const large = PLAN_SECTIONS.map(section => `## ${section}\n${'x'.repeat(20_000)}\n`).join('\n')
    expect(inspectPlanSections(large).missing).toStrictEqual([])
  })
})

/**
 * The durable mode vocabulary, and the store's own behaviour.
 *
 * This block used to guard a four-state machine (`plan/plan-state.ts`) sitting
 * beside the runtime: `inactive | pending | active | exit-pending`, with the two
 * transients memory-only. That module is gone, because no runtime path ever read
 * it — the guard reads upstream's `plan` projection first and falls back to this
 * store, which is `plan`/`execute` and nothing else. Keeping a second vocabulary
 * for the same fact is the shape that produced the bug it was written against.
 *
 * What is left here is the fact that was worth keeping: the spelling in the
 * record, pinned against the writer rather than against a constant.
 */
describe('the persisted mode vocabulary', () => {
  it('spells a persisted phase the way the store reads it back', async () => {
    // Reading the store with the wrong strings does not fail loudly — an
    // unparseable record degrades to `execute`, so the symptom is Plan Mode off
    // after a restart, which is the failure the store exists to prevent. The
    // literals are asserted on a record this store wrote, so a store that renamed
    // its spelling without a reader that follows fails here.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-plan-state-'))
    try {
      const store = new PlanModeStore(join(root, 'modes'))
      await store.write('session-1', 'plan')
      const written = JSON.parse(await readFile(join(root, 'modes', 'session-1.json'), 'utf8')) as { readonly mode: string }
      expect(written.mode).toBe('plan')
      await expect(new PlanModeStore(join(root, 'modes')).read('session-1')).resolves.toBe('plan')
      await store.write('session-2', 'execute')
      const other = JSON.parse(await readFile(join(root, 'modes', 'session-2.json'), 'utf8')) as { readonly mode: string }
      expect(other.mode).toBe('execute')
      await expect(new PlanModeStore(join(root, 'modes')).read('session-2')).resolves.toBe('execute')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps distinct session ids distinct when their safe path spelling would collide', async () => {
    // Session ids are opaque. Stripping path separators made `a/b` and `ab` use
    // the same file, so enabling the fence in one conversation silently enabled
    // it in another after a restart.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-plan-state-'))
    try {
      const modes = join(root, 'modes')
      const writer = new PlanModeStore(modes)
      await writer.write('a/b', 'plan')
      await writer.write('ab', 'execute')
      const restarted = new PlanModeStore(modes)
      await expect(restarted.read('a/b')).resolves.toBe('plan')
      await expect(restarted.read('ab')).resolves.toBe('execute')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forgets a session without losing the durable mode', async () => {
    // `forget` is how the plugin releases this store's per-session row when a
    // conversation is disposed, because the store outlives every session it has
    // served. The risk in adding it is the opposite direction: a cache eviction that
    // takes the mode with it would silently drop the fence on a resumed session.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-plan-state-'))
    try {
      const store = new PlanModeStore(join(root, 'modes'))
      await store.write('session-1', 'plan')
      expect(store.peek('session-1')).toBe('plan')
      store.forget('session-1')
      expect(store.peek('session-1')).toBeUndefined()
      // The file is the truth, so the next read restores the same answer.
      await expect(store.read('session-1')).resolves.toBe('plan')
      await expect(new PlanModeStore(join(root, 'modes')).read('session-1')).resolves.toBe('plan')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists concurrent mode changes in call order', async () => {
    // The cache is updated synchronously, but two atomic writes still race at
    // the filesystem. If the earlier `plan` rename lands after `execute`, a
    // restart restores a fence the live process has already removed.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-plan-state-'))
    try {
      const modes = join(root, 'modes')
      const writer = new PlanModeStore(modes)
      await Promise.all([
        writer.write('session-1', 'plan'),
        writer.write('session-1', 'execute'),
      ])
      await expect(new PlanModeStore(modes).read('session-1')).resolves.toBe('execute')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('where the edit fence actually lives', () => {
  it('refuses a mutating tool by name', () => {
    // The containment Plan Mode needs is "nothing the model can call writes to the
    // workspace", and it is already implemented — more strongly than "only plan.md is
    // writable", which is the design this module was written from.
    for (const tool of ['write', 'edit', 'multi_edit', 'str_replace_editor', 'apply_patch']) {
      expect(planModeRefusal({ mode: 'plan', tool })?.message, `${tool} must be refused`).toContain('Plan Mode')
    }
  })

  it('does not need a writable plan file, because the model never writes it', () => {
    // `engineering_plan_mode` is on the allowed list, so the plan document is written
    // by this plugin's own tool. Nothing in the model's toolset has to be allowed to
    // write, which is what makes a name-based fence sufficient here.
    expect(PLAN_MODE_ALLOWED_PLUGIN_TOOLS).toContain('engineering_plan_mode')
  })

  it('refuses the known mutating tool names and no others', () => {
    // Asserted as a list so extending it is a visible edit rather than a comment that
    // went stale.
    expect([...PLAN_MODE_MUTATING_TOOLS]).toStrictEqual([
      'write', 'edit', 'multi_edit', 'apply_patch', 'create_file', 'write_file', 'notebook_edit',
      'notebook_write', 'str_replace', 'str_replace_editor', 'delete_file', 'move_file', 'fs_write', 'fs_edit',
      'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
      'workflow', 'ralph', 'spawn_teammate', 'send_message',
    ])
  })

  it('refuses the delegation itself, not only the write the child would make', () => {
    // The criterion this list is written from is "it writes repo-tracked files, *or
    // it runs another Agent that will*", and only the first half was enforced: the
    // Harness's own spawn spellings were absent, so a fenced conversation could not
    // call `write` but could call `subagent` and have the child call it.
    //
    // The fence had been left resting on the child inheriting its parent's mode.
    // That inheritance does not hold here, and the reason is worth stating where the
    // list is asserted: `modeFor` asks upstream plan mode first, upstream answers
    // from the *calling* agent's own `plan` projection, and a child's projection
    // carries `plan/mode` only when the child was seeded from the parent's log —
    // which the `fork` provider does and the `spawn` provider deliberately does not
    // (`subagent-spawn-in-process`: "Fresh child: no seed"). `workflow` and `ralph`
    // are mounted on `spawn` in this deployment's preset, so their children were
    // never fenced at all. The `PlanModeStore` that `persona/resolve.ts` cites as
    // the reason a child is judged by its parent's mode is unreachable in this
    // composition: `modeFor` returns upstream's answer before reaching it, and
    // `applyPlanMode` returns before writing it.
    //
    // `send_message` is on the list although it starts nothing by itself: it wakes
    // an inactive teammate, which is how a dormant writer's turn begins. The
    // control below is what keeps this from being "refuse everything".
    for (const tool of ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph', 'spawn_teammate', 'send_message']) {
      expect(planModeRefusal({ mode: 'plan', tool })?.reason, `${tool} must be refused`).toBe('mutating-tool')
      expect(planModeRefusal({ mode: 'execute', tool }), `${tool} must be callable outside plan mode`).toBeUndefined()
    }
  })

  it('refuses write_file, which a sibling list already called a writer and this fence did not', () => {
    // The name was absent while `verify-on-stop.ts`'s `WORKSPACE_MUTATING_TOOLS`
    // carried it, and while a comment in that file asserted that this fence refused
    // it. The reason it gave for the omission was that naming it here would fold an MCP server's
    // `mcp__filesystem__write_file` into a planning session. No such fold is possible:
    // `planModeRefusal` tests `PLAN_MODE_MUTATING_TOOLS.includes(tool)`, an exact
    // comparison, which the recorded-gap case below still relies on. So this entry
    // closes a hole rather than narrowing anything.
    const refusal = planModeRefusal({ mode: 'plan', tool: 'write_file' })
    expect(refusal?.reason).toBe('mutating-tool')
    expect(refusal?.tool).toBe('write_file')
  })

  it('records the known gap: an unclassified third-party tool that writes is allowed', () => {
    // Recorded rather than quietly closed. The mutation rule is a name list, so a tool
    // that is neither on it, nor prefixed by this plugin, nor the shell — an MCP
    // server's own `write_file`, for instance — passes. Closing it means extending the
    // "unclassified is refused" rule to third-party tools, which also removes
    // read-only MCP tools from what a planning session may call: a product decision
    // about what planning is allowed to do, so it is stated here and not taken
    // silently. This case is what will fail the moment someone closes the gap, forcing
    // the record to be updated with it.
    expect(planModeRefusal({ mode: 'plan', tool: 'mcp__filesystem__write_file' })).toBeUndefined()
  })

  it('records the boundary for the Harness capabilities this bundle mounts: not this fence’s to refuse', async () => {
    // The unclassified rule reaches names this plugin registered — by prefix, or from
    // its own manifest — so a capability that registers under its own name is neither
    // refused nor permitted *here*. Same shape as the third-party MCP writer above, and
    // deliberate for the same reason plus one of its own: a browser and a desktop are
    // not the workspace this mode freezes, a session-history read is the mode's own
    // business to allow, and a browser provider registers the tool names of the MCP
    // server it drives — a list this repository cannot read, so naming them here would
    // be a guess rather than a reading. All three capability rows ship `disabled` in
    // the composition, so a deployment turns one on before this becomes its question.
    // This case fails the moment someone closes the gap, which forces the record to be
    // updated with it.
    for (const tool of ['browser_navigate', 'computer_screenshot']) {
      expect(planModeRefusal({ mode: 'plan', tool }), `${tool} is not registered by this plugin`).toBeUndefined()
    }
    // The five query tools are read from the package that registers them: a retyped
    // list that stops matching is a record that stops recording. Absent upstream
    // source (a tree synced without `packages/`) means there is nothing to compare
    // against.
    let source: string
    try {
      source = await readFile(new URL('../../../session-query/tool-session-query/src/index.ts', import.meta.url), 'utf8')
    } catch {
      return
    }
    const names = [...source.matchAll(/name: '(session_[a-z_]+)'/gu)].map(match => match[1]!)
    expect(names.length, 'the query tool surface changed — re-read this record').toBe(5)
    for (const tool of names) {
      expect(planModeRefusal({ mode: 'plan', tool }), `${tool} is not this plugin's to refuse`).toBeUndefined()
    }
  })

  it('refuses the verification run, whose stages and probes spawn commands', () => {
    // The tool writes nothing itself, which is why it looks like a read. What it
    // does instead is spawn the project's own
    // build/type/lint/test scripts and up to five probe programs the verifier
    // authored, which is the same authority `bash` has, and `bash` is refused here
    // for any command the policy does not clear. That rule cannot be applied to a
    // tool argument, so the tool refuses a denied probe itself
    // (`probeCommandDenial`) and the mode refuses the call.
    const refusal = planModeRefusal({ mode: 'plan', tool: 'engineering_team_verify' })
    expect(refusal?.reason).toBe('mutating-tool')
    expect(planModeRefusal({ mode: 'execute', tool: 'engineering_team_verify' })).toBeUndefined()
  })

  it('classifies the worktree tools: the readouts are allowed, the two that change things are not', () => {
    // A newly registered plugin tool is refused until it is classified, so a missing
    // entry is a real capability loss and an extra one is a silent hole. Both
    // directions are asserted.
    expect(planModeRefusal({ mode: 'plan', tool: 'engineering_worktree_status' })).toBeUndefined()
    expect(planModeRefusal({ mode: 'plan', tool: 'engineering_worktree_list' })).toBeUndefined()
    for (const tool of ['engineering_worktree_enter', 'engineering_worktree_exit']) {
      expect(planModeRefusal({ mode: 'plan', tool })?.reason, `${tool} must be refused`).toBe('mutating-tool')
    }
  })

  it('gives a subagent its parent’s mode, which is the opposite of what the design said', () => {
    // Recorded because it contradicts a line in the design document, which lists
    // "a subagent is not bound by its parent's fence; each child starts from
    // inactive" as an accepted bypass. This deployment does not have that bypass:
    // plan mode is keyed on the root conversation, so a child is refused exactly
    // where its parent is.
    //
    // The design's version is the one worth rejecting. A fenced parent that can
    // hand its own tool calls to a child has a fence made of a naming convention,
    // and the child is the escape hatch — so the child inheriting the mode is the
    // property, and this test fails if it is ever reversed.
    const child = { id: 'child-1', session: { header: { parentSession: 'root-1' } } }
    const root = { id: 'root-1', session: { header: {} } }
    expect(planModeSessionKey(child)).toBe(planModeSessionKey(root))
  })

  it('leaves the shell to the declarative command policy, not to a keyword list', () => {
    // Plan Mode must not become a second, weaker copy of the command policy's rules.
    expect(planModeRefusal({ mode: 'plan', tool: 'bash', args: { command: 'ls' } })).toBeUndefined()
  })

  it('reaches the policy fence through the shell this platform actually registers', () => {
    // The base `cordis.patch.yml` disables `tool-bash` on win32 and enables
    // `tool-pwsh`, so on Windows the spelling above is unreachable and this branch
    // never ran: the very command refused as `bash` only prompted as `pwsh`, which
    // is the weaker answer this mode exists to avoid. Both spellings are asserted
    // together so neither can drift away from the other.
    const policy = compileCommandPolicy(BUILT_IN_COMMAND_POLICY)
    const viaBash = planModeRefusal({ mode: 'plan', tool: 'bash', args: { command: 'rm -rf /' }, policy })
    const viaWindowsShell = planModeRefusal({ mode: 'plan', tool: 'pwsh', args: { command: 'rm -rf /' }, policy })
    expect(viaBash?.reason).toBe('policy')
    expect(viaWindowsShell?.reason).toBe('policy')
    expect(viaWindowsShell?.message).toBe(viaBash?.message)
    // The control: a command the policy allows stays allowed, so the pair above
    // cannot be passing because the branch refuses everything it is handed.
    expect(planModeRefusal({ mode: 'plan', tool: 'pwsh', args: { command: 'ls' }, policy })).toBeUndefined()
  })

  it('takes the mode from upstream when it is composed, and only there', () => {
    // This case used to ask a four-state machine (`plan/plan-state.ts`: `inactive |
    // pending | active | exit-pending`) whether the workspace was frozen. That module
    // is gone — no runtime path read it — so the mode now arrives from the Harness's own
    // `plan` projection, and the durable store is only the fallback for a composition
    // that mounts none. Two rules decide whether the fence exists at all, which is why
    // they are pinned here: the lookup is total (a realm being torn down must fall back
    // to the store rather than take a tool call down), and a partial service is not a
    // service (`get` without `set` would leave the mode readable and unchangeable).
    const upstream = { get: () => ({ active: true, pending: true }), set: () => 'committed' as const }
    expect(findUpstreamPlanMode({ get: (name: string) => name === 'planMode' ? upstream : undefined })).toBe(upstream)
    expect(findUpstreamPlanMode({ get: () => { throw new Error('the realm is being torn down') } })).toBeUndefined()
    expect(findUpstreamPlanMode({ get: () => ({ get: () => ({ active: true }) }) })).toBeUndefined()
    expect(findUpstreamPlanMode(undefined)).toBeUndefined()
    // `pending` is read past on purpose: upstream keeps it as the selection awaiting the
    // next accepted pre-step, a phase only the interaction can advance. A local freeze
    // keyed on it would hold the workspace for a conversation nothing is going to move.
  })

  it('still refuses a native engine’s own mutating tool', async () => {
    // Native tools never cross the registry, so a fence installed only there would be
    // absent on both native engines; `nativeToolDenial` is the second surface.
    await expect(nativeToolDenial(
      { name: 'edit', arguments: { path: '/work/a.ts' } },
      {
        settings: () => ({ envReadGuardEnabled: false, commandPolicyEnabled: false, planModeEnabled: true }),
        planMode: { mode: 'plan' },
      },
    )).resolves.toBeDefined()
  })
})

describe('review composition', () => {
  it('opens a surface for an empty plan and says why', () => {
    // A surface that refused to open would leave plan mode active with no visible
    // approval action and no explanation.
    const surface = planReviewSurface(undefined)
    expect(surface.empty).toBe(true)
    expect(surface.body).toContain('No plan has been written yet')
    expect(surface.lineCount).toBe(1)
  })

  it('numbers the lines of a real plan', () => {
    const surface = planReviewSurface('a\nb')
    expect(surface.empty).toBe(false)
    expect(surface.lineCount).toBe(3)
  })

  it('composes a rework message addressed by line', () => {
    const composed = composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 4, endLine: 6, text: 'use the existing helper' }] })
    expect('message' in composed).toBe(true)
    if (!('message' in composed)) return
    expect(composed.message).toContain('lines 4-6')
    expect(composed.message).toContain('use the existing helper')
    expect(composed.message).toContain(PLAN)
  })

  it('addresses a single-line remark as one line', () => {
    const composed = composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 2, endLine: 2, text: 'why?' }] })
    expect('message' in composed && composed.message).toContain('- line 2: why?')
  })

  it('orders remarks by position so the plan is read in order', () => {
    const composed = composePlanReworkMessage({
      planPath: PLAN,
      comments: [{ startLine: 9, endLine: 9, text: 'later' }, { startLine: 1, endLine: 1, text: 'earlier' }],
    })
    if (!('message' in composed)) throw new Error('expected a message')
    expect(composed.message.indexOf('earlier')).toBeLessThan(composed.message.indexOf('later'))
  })

  it('carries notes alongside remarks', () => {
    const composed = composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 1, endLine: 1, text: 'x' }], notes: 'too broad' })
    if (!('message' in composed)) throw new Error('expected a message')
    expect(composed.message).toContain('Overall: too broad')
  })

  it('refuses an empty submission', () => {
    expect(composePlanReworkMessage({ planPath: PLAN })).toStrictEqual({ rejected: 'a rework request needs at least one comment or a note' })
    expect(composePlanReworkMessage({ planPath: PLAN, notes: '   ' })).toHaveProperty('rejected')
  })

  it('refuses an impossible line range instead of dropping the remark', () => {
    // A dropped remark is one the user believes they sent, which is the one outcome
    // a review step must not produce.
    expect(composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 5, endLine: 3, text: 'x' }] })).toHaveProperty('rejected')
    expect(composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 0, endLine: 1, text: 'x' }] })).toHaveProperty('rejected')
  })

  it('refuses a remark with no text rather than sending a blank bullet', () => {
    expect(composePlanReworkMessage({ planPath: PLAN, comments: [{ startLine: 1, endLine: 1, text: '  ' }] })).toHaveProperty('rejected')
  })
})

describe('the fence cannot be narrowed to one tool', () => {
  it('rejects a fence that guards `write` but not its siblings', () => {
    // The mutation: a list that names one writing tool. It agrees with the real one
    // for a write and disagrees for every other tool that can write a file, which is
    // the whole set the fence is for.
    const oneTool = (name: string): string | undefined => (name === 'write' ? 'refused' : undefined)
    expect(oneTool('write')).toBe('refused')
    expect(oneTool('edit')).toBeUndefined()
    expect(planModeRefusal({ mode: 'plan', tool: 'edit' })).toBeDefined()
  })

  it('rejects a fence that lets an unclassified plugin tool through', () => {
    // The other default is what made a newly added mutating tool callable in Plan Mode
    // without anyone noticing, so an unclassified plugin tool is refused.
    expect(planModeRefusal({ mode: 'plan', tool: 'engineering_something_new' })).toBeDefined()
  })
})
