/**
 * The upstream seams this plugin's enhancements read, pinned as text.
 *
 * Why a source gate rather than a behavioural one
 * -----------------------------------------------
 * Every fact below belongs to another package, and none of them is exported in a
 * form this plugin can import: a provider name is a *default in a schema*, the
 * registry's collision is an *error code*, the Auto gate's refusal code is a
 * module-private constant, and two of the seams are call shapes inside functions
 * this plugin never calls. Reading them from the tree is the only way to notice an
 * upstream rename **here**, where it fails a test in this repository, instead of in
 * a deployment, where it fails when a user flips a switch.
 *
 * That is the difference this file exists to make. The enhancements are additive
 * and capability-probed, so a renamed seam usually degrades to "the enhancement
 * does nothing" — a silent loss. A red test is the loud version.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/upstream-seam-contracts
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  FREECODEGO_DENIAL_CODE,
  HARNESS_AUTO_DENIAL_CODE,
  HARNESS_AUTO_FAILURE_PREFIX,
  OUTER_SCRIPT_TOOL,
} from '../src/review-coverage.ts'
import { TEAM_EVENT_TYPES } from '../src/team-workflow.ts'
import { OFFICIAL_FALLBACK_COVERAGE, STAND_IN_MODULES } from '../src/stand-in-rows.ts'

/**
 * Read one source, relative to the packages directory this repository holds them
 * in — `core/tools/src/ptc.ts`, `freecodego/bundle-latest/cordis.patch.yml`. The
 * plugin's own bundle patch is read through this too: it is where the stand-in
 * pairing is declared, so it is as much a seam the plugin reads as any upstream
 * file.
 * @param relative - path under the packages directory.
 * @returns the file's text.
 */
async function upstream(relative: string): Promise<string> {
  return await readFile(new URL(`../../../${relative}`, import.meta.url), 'utf8')
}

describe('the outer script tool this plugin reviews on the Auto preset', () => {
  it('is the name the Harness itself declares', async () => {
    const source = await upstream('core/tools/src/ptc.ts')
    expect(source).toContain(`export const RUN_CODE_NAME = '${OUTER_SCRIPT_TOOL}'`)
  })
})

describe('the subagent provider registry this plugin mounts official providers into', () => {
  it('still offers the registration and listing this plugin and the team tool use', async () => {
    const source = await upstream('subagent/subagent/src/index.ts')
    // Registration is the seam the two provider rows go through.
    expect(source).toContain('registerProvider(provider: SubagentProvider): () => void')
    expect(source).toContain('list(): string[]')
    // And the collision is a *throw*, which is why official-first arbitration is
    // implemented for the provider pair rather than left to chance: two rows that
    // register one name cannot both start.
    expect(source).toContain('a subagent provider named "${name}" is already registered')
  })

  it('declares the provider names this bundle\'s rows register', async () => {
    const codex = await upstream('subagent/subagent-codex/src/index.ts')
    const claude = await upstream('subagent/subagent-claude-code/src/index.ts')
    expect(codex).toContain('const DEFAULT_PROVIDER_NAME = \'codex\'')
    expect(claude).toContain('const DEFAULT_PROVIDER_NAME = \'claude-code\'')
    // Both rows are mounted without a `providerName` config, so these defaults are
    // what `spawn_teammate` resolves when a model names an engine.
    expect(codex).toContain('providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME)')
    expect(claude).toContain('providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME)')
  })
})

describe('the official team tool whose provider selection this plugin feeds', () => {
  it('still defaults to the in-process providers, and still selects by name', async () => {
    const source = await upstream('experimental/tool-agent-team/src/index.ts')
    expect(source).toContain("freshProvider: z.string().default('spawn')")
    expect(source).toContain("forkProvider: z.string().default('fork')")
    expect(source).toContain('ctx.agentTeams.spawnTeammate(agent, {')
    // The provider is chosen from config rather than hard-coded, which is what
    // makes mounting a cross-engine provider row enough to reach it.
    expect(source).toContain("provider: context === 'fork' ? config.forkProvider : config.freshProvider")
  })
})

describe('the Team session-event vocabulary the board reader folds', () => {
  it('is the union the Harness records', async () => {
    const projection = await upstream('experimental/agent-team/src/projection.ts')
    // Read off the module's own predicate rather than off the type alias: the
    // alias is one line naming a mapped type, while the predicate spells out every
    // member of the union, which is the list this reader has to match.
    const marker = 'export function isTeamEvent('
    expect(projection).toContain(marker)
    const predicate = projection.slice(projection.indexOf(marker))
    const body = predicate.slice(0, predicate.indexOf('\n}\n') + 3)
    for (const type of TEAM_EVENT_TYPES) {
      expect(body, `${type} must still be a Team session event`).toContain(`'${type}'`)
    }
    // The task statuses the evidence line distinguishes between.
    expect(projection).toContain("status: z.enum(['pending', 'in_progress', 'completed', 'deleted'])")
    expect(projection).toContain("phase: z.enum(['provisioning', 'active', 'failed'])")
  })
})

describe('the official modules this bundle stands down for', () => {
  it('names packages that exist, with a row for each capability', () => {
    // Every pair is a real module name and a real row in the bundle patch; the
    // pairing itself is asserted by the patch's own rows, and this pins the shape
    // that the handover and the conflict guard both read.
    for (const [official, standIn] of OFFICIAL_FALLBACK_COVERAGE) {
      expect(official.startsWith('@deepseek-ai/')).toBe(true)
      expect(STAND_IN_MODULES.get(standIn)).toBe(official)
    }
    // The roster itself, because the two directions fail differently and politely.
    // The team pair that used to be here is deleted rather than arbitrated: the
    // official `…agent-team-profile` bundle mounts those two modules **by name**, so
    // the copy was a second implementation of a mounted capability. What is left is
    // the set that is genuinely this bundle's to carry — an official bundle no
    // shipped profile selects, two subagent packages **no** upstream bundle mounts,
    // and the session-history tools, which no bundle mounts either and which the
    // `dsh` install contract does not carry at all. An entry added here without a
    // patch row would be arbitration for a row nobody mounts; a patch row added
    // without an entry is a stand-in the handover never stands down, which is the
    // collision the team pair was deleted for. Both are caught below rather than by
    // this list.
    expect([...OFFICIAL_FALLBACK_COVERAGE.keys()].sort()).toEqual([
      '@deepseek-ai/dsh-experimental-auto-review',
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-tool-session-query',
    ])
  })

  it('is exactly the set the bundle patch asks this plugin about', async () => {
    // Read off the patch rather than restated: every official module a `!!js`
    // stand-down in this bundle's patch asks the live service about is a key of the
    // table, and every key is asked about. The patch is where the pairing is
    // declared, so the two files drifting apart — a row added, a row deleted, an
    // official module renamed — has to fail in this repository.
    const patch = await upstream('freecodego/bundle-latest/cordis.patch.yml')
    const asked = new Set([...patch.matchAll(/freecodegoOfficialRows'\)\?\.holds\('([^']+)'\)/gu)]
      .map(match => match[1] ?? ''))
    expect([...asked].sort()).toEqual([...OFFICIAL_FALLBACK_COVERAGE.keys()].sort())
  })
})

describe('the agent-factory slot this plugin\'s root-engine router replaces in place', () => {
  it('is still the private slot the router swaps, and the loop is still its fallback', async () => {
    const registry = await upstream('core/agent/src/index.ts')
    // The router reads `ctx.agents.factory.target` and replaces `target` with
    // itself; that is the whole reason a plugin can serve root sessions without
    // standing up a second AgentRegistry. Both halves of the slot are private on
    // the registry, so `as unknown as` is the router's only way in and this text
    // is the only way to notice a rename before a session fails to open.
    expect(registry).toContain('interface FactorySlot {')
    expect(registry).toContain('readonly target: AgentFactory')
    expect(registry).toContain('private factory: FactorySlot | undefined')
    expect(registry).toContain('setFactory(factory: AgentFactory): () => void')
    // Everything that is not a native engine route is delegated back through
    // `agentLoop`, so the loop has to remain the factory the registry holds.
    const loop = await upstream('core/agent-loop/src/index.ts')
    expect(loop).toContain('export class AgentLoop extends Service implements AgentFactory')
  })

  it('is still absent upstream, which is why root engine selection is a plugin extension', async () => {
    // The tripwire for a future migration. Today no Harness release declares a
    // root-engine seam — the concepts below are this plugin\'s own names — and
    // this test says so out loud. The day upstream ships one, the two assertions
    // fail and the plugin\'s engine registry becomes a migration candidate rather
    // than a permanent extension. Until then there is nothing to move onto, and
    // the harness-plugin tests for `agent-engine-server.spec.ts` pin the
    // behaviour that would move.
    const registry = await upstream('core/agent/src/index.ts')
    expect(registry).not.toContain('agentEngines')
    const loop = await upstream('core/agent-loop/src/index.ts')
    expect(loop).not.toContain('AgentEnginePlan')
  })
})

describe('the speech registry this plugin lends its own recognizer to', () => {
  it('still offers registration by provider, and still selects one by id', async () => {
    const source = await upstream('experimental/speech-to-text/src/index.ts')
    // Registration is the whole seam: the plugin contributes a recognizer and
    // reads nothing else, so this signature is the contract it is built on.
    expect(source).toContain('register(provider: SpeechProvider): () => Promise<void>')
    expect(source).toContain('defaultProvider: z.string().min(1).required().volatile()')
    // A selection whose language the provider does not list is refused, which is
    // why the plugin's provider claims `auto` — the registry's own default.
    expect(source).toContain('if (!registration.provider.info.languages.includes(language))')
  })

  it('still suppresses the install prompt for a provider that cannot need one', async () => {
    // The single expression this whole feature is shaped around: a `cloud`
    // provider with no `preparation` can satisfy neither conjunct, so no local
    // model is downloaded and no prompt is raised. If upstream widens this (a
    // cloud provider that needs preparing, or a prompt no longer gated on the
    // location), the plugin's provider silently starts prompting instead — so the
    // expression is pinned as text here.
    const view = await upstream('experimental/client-ui-voice-input/src/client/VoiceInput.tsx')
    expect(view).toContain('needsInstallation={readiness.connected && provider?.location === \'host-local\' && provider.preparation.phase === \'unprepared\'}')
    // The two members it reads, in the contract that declares them.
    const types = await upstream('experimental/speech-to-text/src/types.ts')
    expect(types).toContain("readonly location: 'host-local' | 'cloud'")
    expect(types).toContain('readonly preparation?: SpeechPreparation')
  })

  it('is still provided under the service name this plugin injects', async () => {
    // The plugin waits for the registry by name (`ctx.inject(['speechToText'])`),
    // which is how it survives a voice bundle mounted after it was. A renamed
    // service would not be an error anywhere: the injection would simply never
    // resolve, and the feature would look like a plugin that does nothing.
    const source = await upstream('experimental/speech-to-text/src/index.ts')
    expect(source).toContain("super(ctx, 'speechToText')")
    expect(source).toContain('speechToText: SpeechToText')
  })

  it('still refuses a selection it cannot serve, which is why a withdrawal owes the user a repair', async () => {
    // Two halves of one fact. `resolve` (and `selectedProvider`, on the selection
    // path) *throws* for an id that is not in the roster rather than falling back
    // — so a provider that leaves while the selection still names it does not
    // simply stop working, it fails the user's next dictation. That is the whole
    // reason `handSelectionBack` exists, and it is why this plugin never points
    // the default at itself: it can decline to register, and a composition-level
    // default cannot be taken back.
    const source = await upstream('experimental/speech-to-text/src/index.ts')
    expect(source).toContain('if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)')
    // The repair writes through the registry's own selection API, which persists
    // into the voice bundle's profile entry — so the text here is the seam, and a
    // rename of it is a broken hand-back rather than a compile error.
    expect(source).toContain('async configure(patch: SpeechSelectionPatch): Promise<void>')
    expect(source).toContain('configure(patch: SpeechSelectionPatch): Promise<void>')
    // And the roster this plugin reads to decide whether the selection is its own.
    expect(source).toContain('snapshot(): SpeechSnapshot')
    expect(source).toContain('providerId: this.config.defaultProvider.get() as SpeechProviderId')
  })

  it('still ships a local model as the bundle default, which is what the plugin displaces', async () => {
    const patch = await upstream('experimental/voice-input-bundle/cordis.patch.yml')
    // The plugin's provider is only useful because this default is the
    // downloadable one: the user's manual choice in the voice page is between
    // this row's recognizer and the plugin's.
    expect(patch).toContain('defaultProvider: sensevoice-local')
  })
})

describe('the Auto review vocabulary this plugin reads off the Harness gate', () => {
  it('is still declared the same way in that module', async () => {
    const source = await upstream('experimental/auto-review/src/index.ts')
    expect(source).toContain(`AUTO_REVIEW_DENIED_CODE = '${HARNESS_AUTO_DENIAL_CODE}'`)
    expect(source).toContain('const REVIEW_POLICY = ')
    expect(source).toContain('`Auto review of tool "${exec.name}" failed; its body was not executed: ${message}`')
    // The exclusion this coverage exists for, in the gate's own terms.
    expect(source).toContain('exec.parent === undefined && exec.name === RUN_CODE_NAME')
  })

  it('keeps this plugin\'s own refusal code apart from the Harness\'s', () => {
    expect(FREECODEGO_DENIAL_CODE).not.toBe(HARNESS_AUTO_DENIAL_CODE)
    // The failure prefix has to be a prefix of the gate's failure message and not
    // of its considered refusal, or the two are read as one.
    expect(`${HARNESS_AUTO_FAILURE_PREFIX} "bash" failed; its body was not executed: x`)
      .toContain(HARNESS_AUTO_FAILURE_PREFIX)
    expect('Auto review rejected tool "bash"; its body was not executed').not.toContain(HARNESS_AUTO_FAILURE_PREFIX)
  })
})
