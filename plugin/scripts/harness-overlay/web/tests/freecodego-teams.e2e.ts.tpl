// Web e2e scenarios: an official optional bundle is enabled at runtime on a profile
// that also mounts the FreeCodeGo distribution bundle. The Harness's own plugin is
// the one that has to end up serving the capability — the FreeCodeGo bundle carries
// upstream's own modules as stand-ins for a composition that never selected the
// official bundles — so a live enable is exactly the window where the two meet and
// only one of them may keep the resources. The panel's own operation is what is
// exercised, because its reconcile is the thing that reported 启用失败.
//
// Two shapes of "only one owner" are covered here. The Auto-review row is a stand-in
// that hands the capability over. The team runtime is the case where this bundle
// has *nothing* to hand over: the official `…agent-team-profile` mounts upstream's
// team modules by name, so the bundle mounts no copy of them and must not have one
// appear when the official bundle arrives — the collision that
// `service "agentTeams" has been registered` used to describe.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const FREECODEGO_BUNDLE = fileURLToPath(new URL('../../../packages/freecodego/bundle-latest', import.meta.url))

/** One switch, its rows, and the stand-in this bundle carries for each of them. */
interface Scenario {
  readonly title: string
  readonly bundle: string
  readonly officialEntryIds: readonly string[]
  readonly standInEntryIds: readonly string[]
  /**
   * Rows this bundle must not mount at all: the duplicates that were deleted rather
   * than arbitrated. Enabling the official bundle is the moment a copy would show
   * up, so the window is asserted rather than the launch-time composition.
   */
  readonly absentEntryIds?: readonly string[]
}

const SCENARIOS: readonly Scenario[] = [
  {
    title: '智能体团队',
    bundle: '@deepseek-ai/dsh-experimental-agent-team-profile',
    officialEntryIds: ['agent-team', 'tool-agent-team', 'ui-agent-team'],
    standInEntryIds: [],
    // The parent profile bundle the deleted pair named, plus the bundle this one's
    // module ids were compiled under. A row for either means the second copy is back.
    absentEntryIds: ['freecodego-agent-team', 'freecodego-tool-agent-team'],
  },
  {
    title: '自动授权审查',
    bundle: '@deepseek-ai/dsh-experimental-auto-review',
    officialEntryIds: ['auto-review'],
    standInEntryIds: ['freecodego-auto-review'],
  },
]

/**
 * The two cross-engine providers this bundle mounts, and the name each one
 * registers on `ctx.subagents`. The names are upstream's own defaults, which is
 * what makes them the ones the official `spawn_teammate` defaults its
 * `freshProvider`/`forkProvider` config against.
 */
const CROSS_ENGINE_PROVIDERS: readonly { readonly entry: string, readonly provider: string }[] = [
  { entry: 'freecodego-subagent-codex', provider: 'codex' },
  { entry: 'freecodego-subagent-claude-code', provider: 'claude-code' },
]

describe('web e2e: cross-engine subagent providers beside the official team', () => {
  it('registers the Harness own Codex and Claude providers for spawn_teammate', async () => {
    const scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
    })
    try {
      const providerNames = (): readonly string[] => scaffold.ctx.subagents.list()
      const names = providerNames()
      for (const { entry, provider } of CROSS_ENGINE_PROVIDERS) {
        expect(names, `${entry} must register provider "${provider}"`).toContain(provider)
        const row = [...scaffold.ctx.loader.entries()].find(candidate => candidate.options.id === entry)
        expect(String(row?.options.name), `${entry} must name this bundle's artifact`).toBe(`freecodego/${entry.replace('freecodego-', '')}`)
        expect(String(row?.fiber?.uid), `${entry} must serve`).not.toBe('null')
      }
    } finally {
      await scaffold.close().catch(() => undefined)
    }
  }, 120_000)
})

describe('web e2e: official bundles beside the FreeCodeGo bundle', () => {
  for (const scenario of SCENARIOS) {
    it(`leaves one owner of 本体 ${scenario.title} across a live enable and disable`, async () => {
      const scaffold = await launchWebScaffold({
        profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
      })
      try {
        const rows = (): readonly {
          options: { id?: string, name?: string }
          fiber?: { state?: number, uid?: unknown }
          disabled?: unknown
        }[] => [...scaffold.ctx.loader.entries()].filter(entry =>
          scenario.officialEntryIds.includes(String(entry.options.id))
          || scenario.standInEntryIds.includes(String(entry.options.id))
          || scenario.absentEntryIds?.includes(String(entry.options.id)) === true)
        const describeRow = (entry: { options: { id?: string }, fiber?: { state?: number, uid?: unknown }, disabled?: unknown }): string => {
          let evaluated = '?'
          try { evaluated = String(entry.disabled) } catch { evaluated = 'throws' }
          return `${String(entry.options.id)}:state=${String(entry.fiber?.state)} uid=${String(entry.fiber?.uid)} disabled=${evaluated}`
        }
        const start = Date.now()
        const timeline: string[] = []
        let last = ''
        const tick = (label?: string): void => {
          const state = rows().map(describeRow).join(' | ')
          const at = `${label === undefined ? '' : `${label} `}+${String(Date.now() - start)}ms`
          if (state !== last) {
            last = state
            timeline.push(`${at} ${state}`)
          } else if (label !== undefined) timeline.push(at)
        }
        const notes: string[] = []
        const logger = scaffold.ctx.logger as unknown as { error: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }
        for (const level of ['error', 'warn'] as const) {
          const original = logger[level].bind(logger)
          logger[level] = (...args: unknown[]) => {
            const text = args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' ')
            if (/freecodego|agentTeam|auto-review|registered|nested|did not activate/i.test(text)) notes.push(`${level}: ${text.slice(0, 240)}`)
            original(...args)
          }
        }
        const timer = setInterval(() => { tick() }, 50)
        try {
          tick('before')
          const result = await scaffold.ctx.pluginManager.setBundleEnabled(scenario.bundle, true)
          tick('RESOLVED')
          await new Promise(resolve => setTimeout(resolve, 8_000))
          tick('final')
          // The timeline is the evidence when this breaks, so it travels with the first
          // assertion rather than only through a dump that a green run never shows.
          const evidence = `${timeline.join('\n')}\nFINAL\n${rows().map(describeRow).join('\n')}\nNOTES\n${notes.join('\n')}`
          expect(String(result.error ?? ''), `the panel's own reconcile reported a failure\n${evidence}`).toBe('')
          expect(notes.filter(note => note.startsWith('error:') || note.includes('did not activate')), evidence).toEqual([])
          for (const id of scenario.officialEntryIds) {
            const entry = rows().find(row => row.options.id === id)
            expect(`${id}:${String(entry?.fiber?.uid)}`, `${id} must serve the capability`).not.toBe(`${id}:null`)
          }
          for (const id of scenario.standInEntryIds) {
            const entry = rows().find(row => row.options.id === id)
            // The fallback yields: stopped, and reading as disabled so the Loader's own
            // audit skips it rather than reporting a row that was deliberately taken down.
            expect(`${id}:${String(entry?.fiber?.uid)}:${String(entry?.disabled)}`, `${id} must stand down`)
              .toBe(`${id}:null:true`)
          }
          for (const id of scenario.absentEntryIds ?? []) {
            // Not stood down — never mounted. The row does not exist in the tree at
            // all, whatever the Loader did with the official bundle, which is what
            // "this bundle ships no copy of it" means at runtime. Compared as a
            // boolean rather than against `undefined`: the received value on failure
            // is a Loader `Entry`, and vitest's own printer throws on it.
            const found = rows().find(row => row.options.id === id)
            expect(found === undefined, `${id} must not exist in the tree\n${evidence}`).toBe(true)
          }

          // And the other direction of the same rule: switching the official bundle
          // back off has to leave the capability with this bundle rather than with
          // neither. That is the desktop case's repair seen from the live side.
          const off = await scaffold.ctx.pluginManager.setBundleEnabled(scenario.bundle, false)
          tick('OFF')
          await new Promise(resolve => setTimeout(resolve, 8_000))
          tick('off-final')
          const offEvidence = `${timeline.slice(-6).join('\n')}\nFINAL\n${rows().map(describeRow).join('\n')}`
          expect(String(off.error ?? ''), `switching the bundle back off reported a failure\n${offEvidence}`).toBe('')
          for (const id of scenario.standInEntryIds) {
            const entry = rows().find(row => row.options.id === id)
            expect(String(entry?.fiber?.uid ?? 'null'), `${id} must carry the capability again\n${offEvidence}`).not.toBe('null')
          }
          for (const id of scenario.officialEntryIds) {
            expect(rows().some(row => row.options.id === id), `${id} must be gone with its bundle\n${offEvidence}`).toBe(false)
          }
        } finally {
          clearInterval(timer)
        }
      } finally {
        // The FreeCodeGo plugin keeps a lock under the scaffold home, which a recursive
        // removal can hit while the Host is still shutting down; the assertions above are
        // the scenario, so teardown does not replace their failure with this one.
        await scaffold.close().catch(() => undefined)
      }
    }, 120_000)
  }
})
