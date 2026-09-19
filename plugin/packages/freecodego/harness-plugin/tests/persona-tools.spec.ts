/**
 * The persona tools, and the three things they must not do.
 *
 * A spawn missing a required input must be **refused**, not started hopefully. A
 * caller asking for isolation in a composition that cannot isolate must be
 * **refused**, not quietly given the shared checkout. And a child that returns
 * short must be **reported**, with its work kept.
 *
 * The fourth, which is why this file exists at all: when isolation *is*
 * available, the child's working directory must really be the copy. A persona
 * system that reports `worktree` while starting the child in the parent's
 * checkout is worse than one with no isolation at all, because the caller stops
 * checking.
 */

import { describe, expect, test } from 'vitest'

import { normalizePersona, type PersonaDefinition } from '../src/persona/contract.ts'
import { loadPersonaRoster } from '../src/persona/files.ts'
import {
  PersonaRuns,
  composeChildBrief,
  loadPersonaInstructions,
  namedOutputsIn,
  personaToolDefinitions,
  renderRoster,
  type PersonaRoster,
  type PersonaToolDeps,
} from '../src/persona/tools.ts'

function persona(raw: Record<string, unknown>, name = 'reviewer'): PersonaDefinition {
  const parsed = normalizePersona(raw, name, 'project', `/p/${name}.toml`)
  if ('issue' in parsed) throw new Error(parsed.issue.reason)
  return parsed.persona
}

const REVIEWER = persona({
  instructions: 'Review the change.',
  inputs: [{ name: 'diff', io_type: 'text', required: true }, { name: 'ticket', io_type: 'text', required: false }],
  outputs: [{ name: 'findings', io_type: 'list', required: true }, { name: 'summary', io_type: 'text', required: false }],
})

const WORKTREE_WRITER = persona({
  instructions: 'Implement the task.',
  default_isolation: 'worktree',
}, 'implementer')

const ROSTER: PersonaRoster = { personas: [REVIEWER, WORKTREE_WRITER], shadowed: [], issues: [] }

/** A deps set whose spawn records what it was called with. */
/**
 * A full dependency set, with overrides.
 *
 * An override of `undefined` is how a test removes a port, so the signature has
 * to allow it: `exactOptionalPropertyTypes` would otherwise read
 * `{ isolate: undefined }` as "the default isolate", which is the opposite of
 * what the caller is asking for.
 */
function deps(overrides: Partial<Record<keyof PersonaToolDeps, PersonaToolDeps[keyof PersonaToolDeps] | undefined>> = {}): { deps: PersonaToolDeps; spawns: unknown[] } {
  const spawns: unknown[] = []
  const value: PersonaToolDeps = {
    roster: async () => ROSTER,
    instructions: async p => p.instructions,
    spawn: async (input) => { spawns.push(input) },
    isolate: async input => ({ path: `/isolated/${input.sessionId}`, strategy: 'git' }),
    newSessionId: () => 'child-1',
    callerOf: exec => (exec === undefined ? undefined : { cwd: '/workspace', agent: { id: 'parent' } }),
  }
  // An override of `undefined` drops the port rather than leaving a present-but-
  // undefined one: the spawn tool tests for the port's absence, and
  // `exactOptionalPropertyTypes` does not make the two spellings equivalent.
  const mutable = value as unknown as Record<string, unknown>
  for (const [key, replacement] of Object.entries(overrides)) {
    if (replacement === undefined) delete mutable[key]
    else mutable[key] = replacement
  }
  return { deps: value, spawns }
}

const toolOf = (definitions: readonly { readonly name?: unknown }[], name: string): ((args: unknown, exec: unknown) => Promise<Record<string, unknown>>) =>
  (definitions.find(definition => definition.name === name) as unknown as { execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>> }).execute

const EXEC = { agent: { session: { id: 'parent' } } }

describe('engineering_persona_list', () => {
  test('renders the roster with what each persona requires and returns', async () => {
    const { deps: d } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_persona_list')({}, EXEC)
    const summary = String(result.summary)
    expect(result.count).toBe(2)
    expect(summary).toContain('reviewer [project]')
    expect(summary).toContain('requires: diff')
    expect(summary).toContain('returns: findings')
    expect(summary).toContain('isolation: worktree')
  })

  test('names shadowed personas and refused files, because those are why an edit did nothing', () => {
    const text = renderRoster({
      personas: [REVIEWER],
      shadowed: [{ name: 'reviewer', sources: ['project', 'user'] }],
      issues: [{ path: '/p/broken.toml', reason: 'unknown field "default_isolaton"' }],
    })
    expect(text).toContain('Shadowed: reviewer')
    expect(text).toContain('project wins')
    expect(text).toContain('default_isolaton')
  })

  test('an empty roster says where personas come from instead of rendering nothing', () => {
    const text = renderRoster({ personas: [], shadowed: [], issues: [] })
    expect(text).toContain('No personas resolve')
    expect(text).toContain('.freecodego/personas/')
  })

  test('json mode carries the declared contract rather than prose', async () => {
    const { deps: d } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_persona_list')({ json: true }, EXEC)
    expect(result.personas).toEqual([
      expect.objectContaining({ name: 'reviewer', inputs: expect.any(Array), outputs: expect.any(Array) }),
      expect.objectContaining({ name: 'implementer', defaultIsolation: 'worktree' }),
    ])
  })

  test('a call with no session behind it is refused rather than answered from process cwd', async () => {
    const { deps: d } = deps({ callerOf: () => undefined })
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_persona_list')({}, undefined)
    expect(String(result.error)).toContain('per workspace')
  })
})

describe('engineering_subagent_start', () => {
  test('refuses a spawn missing a required input, and names what is missing', async () => {
    const { deps: d, spawns } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'reviewer', task: 'review it', inputs: { ticket: 'ENG-1' } }, EXEC)
    expect(String(result.refused)).toContain('"diff"')
    expect(result.missing).toEqual(['diff'])
    // Nothing was started: a child with a hole in its brief must not exist.
    expect(spawns).toHaveLength(0)
  })

  test('starts a child with a brief that carries the inputs and the contract', async () => {
    const { deps: d, spawns } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')(
      { persona: 'reviewer', task: 'review it', inputs: { diff: '--- a\n+++ b', ticket: 'ENG-1' } },
      EXEC,
    )
    expect(result.sessionId).toBe('child-1')
    expect(result.cwd).toBe('/workspace')
    expect(result.expectedOutputs).toEqual(['findings'])
    const spawn = spawns[0] as { session: { brief: string; cwd: string } }
    expect(spawn.session.brief).toContain('Review the change.')
    expect(spawn.session.brief).toContain('--- a\n+++ b')
    // "Declared", not "Required": the block carries every declared output and marks
    // the optional ones, so the heading may not claim otherwise — see the brief
    // tests below.
    expect(spawn.session.brief).toContain('Declared outputs:')
    // The task is last, so the model reads it immediately before acting.
    expect(spawn.session.brief.indexOf('Task:')).toBeGreaterThan(spawn.session.brief.indexOf('Declared outputs:'))
  })

  test('really moves the child into the worktree, and says so', async () => {
    const { deps: d, spawns } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'implementer', task: 'do it' }, EXEC)
    expect(result.isolation).toBe('worktree')
    expect(result.cwd).toBe('/isolated/child-1')
    expect(String(result.note)).toContain('for real')
    expect((spawns[0] as { session: { cwd: string } }).session.cwd).toBe('/isolated/child-1')
  })

  test('refuses rather than silently running unisolated when isolation is impossible', async () => {
    // The failure this prevents: the caller asked for a copy, got the parent's
    // checkout, and stopped checking.
    const { deps: d, spawns } = deps({ isolate: undefined })
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'implementer', task: 'do it' }, EXEC)
    expect(String(result.refused)).toContain('cannot create a worktree')
    expect(spawns).toHaveLength(0)
  })

  test('an explicit isolation override beats the persona, in both directions', async () => {
    const { deps: d } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const none = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'implementer', task: 'do it', isolation: 'none' }, EXEC)
    expect(none.isolation).toBe('none')
    expect(none.isolationSource).toBe('override')
    const isolated = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'reviewer', task: 'review', inputs: { diff: 'x' }, isolation: 'worktree' }, EXEC)
    expect(isolated.isolation).toBe('worktree')
    expect(isolated.cwd).toBe('/isolated/child-1')
  })

  test('an unknown persona is refused with the closest names', async () => {
    const { deps: d } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'review', task: 'x' }, EXEC)
    expect(String(result.refused)).toContain('no persona named "review"')
    expect(String(result.refused)).toContain('"reviewer"')
  })

  test('a missing task is refused: the persona is how, not what', async () => {
    const { deps: d, spawns } = deps()
    const definitions = personaToolDefinitions(d, new PersonaRuns())
    const result = await toolOf(definitions, 'engineering_subagent_start')({ persona: 'reviewer', task: '   ' }, EXEC)
    expect(String(result.refused)).toContain('a task is required')
    expect(spawns).toHaveLength(0)
  })
})

describe('the output contract', () => {
  test('a shortfall is reported, and the rest of the work is kept', () => {
    const runs = new PersonaRuns()
    runs.expect('c1', 'reviewer', ['findings', 'summary'])
    const outcome = runs.complete('c1', ['findings'])
    expect(outcome?.missing).toEqual(['summary'])
    expect(String(outcome?.message)).toContain('the rest of its result was kept')
  })

  test('a complete child reports no shortfall', () => {
    const runs = new PersonaRuns()
    runs.expect('c1', 'reviewer', ['findings'])
    expect(runs.complete('c1', ['findings'])).toEqual({ persona: 'reviewer', missing: [] })
  })

  test('a child that was never expected is not invented into a failure', () => {
    const runs = new PersonaRuns()
    expect(runs.complete('unknown', ['x'])).toBeUndefined()
  })

  test('a completed child stops being outstanding, so a long session does not accumulate', () => {
    const runs = new PersonaRuns()
    runs.expect('c1', 'reviewer', ['findings'])
    expect(runs.outstanding).toBe(1)
    runs.complete('c1', ['findings'])
    expect(runs.outstanding).toBe(0)
  })

  test('a persona with no required outputs is not tracked at all', () => {
    const runs = new PersonaRuns()
    runs.expect('c1', 'chatter', [])
    expect(runs.outstanding).toBe(0)
  })

  test('the contract a child owes is readable, so the end-of-run check can search for it', () => {
    const runs = new PersonaRuns()
    runs.expect('c1', 'reviewer', ['findings'])
    expect(runs.expectedFor('c1')).toEqual(['findings'])
    runs.complete('c1', ['findings'])
    expect(runs.expectedFor('c1')).toBeUndefined()
  })

  test('a shortfall can reach the agent that delegated', () => {
    const parent = { id: 'parent' }
    const runs = new PersonaRuns()
    runs.expect('c1', 'reviewer', ['findings'], parent)
    expect(runs.complete('c1', [])?.parent).toBe(parent)
  })
})

describe('reading the child\'s final message for output names', () => {
  test('finds a name that appears in the prose', () => {
    const blocks = [{ type: 'text', text: 'Summary below.\nfindings: nothing to report' }]
    expect(namedOutputsIn(blocks, ['findings', 'patch'])).toEqual(['findings'])
  })

  test('is a name search, so a missing name is the only thing it can report', () => {
    // Stated as a test because a caller will be tempted to read a hit as proof.
    // "found" here means the word appeared, not that the artifact exists.
    expect(namedOutputsIn([{ type: 'text', text: 'I could not produce findings' }], ['findings'])).toEqual(['findings'])
  })

  test('ignores non-text blocks and a message with no text at all', () => {
    expect(namedOutputsIn([{ type: 'image', data: 'x' }], ['findings'])).toEqual([])
    expect(namedOutputsIn(undefined, ['findings'])).toEqual([])
  })

  test('matches case-insensitively, because a child may capitalize a name', () => {
    expect(namedOutputsIn([{ type: 'text', text: 'FINDINGS' }], ['findings'])).toEqual(['findings'])
  })
})

describe('the brief', () => {
  test('passes undeclared inputs through and labels them, instead of dropping what was sent', () => {
    const brief = composeChildBrief({
      persona: REVIEWER,
      instructions: 'Review.',
      task: 'go',
      inputs: { diff: 'd', extra_note: 'from the user' },
    })
    expect(brief).toContain('extra_note (undeclared): from the user')
  })

  test('marks an optional input that was not supplied rather than omitting the line', () => {
    const brief = composeChildBrief({ persona: REVIEWER, instructions: '', task: 'go', inputs: { diff: 'd' } })
    expect(brief).toContain('ticket (text) [optional]: (not supplied)')
  })

  test('does not call an optional output required', () => {
    // The block lists every declared output, so a heading that says "Required" is a
    // claim about fields it does not distinguish: `REVIEWER` declares `summary` as
    // optional, and the brief told the child it was required. A child that believes
    // an optional artifact is mandatory does work nobody asked for, or reports a
    // failure it did not have — and the contract check would not have stopped it,
    // since only the required half is checked when the child returns.
    const brief = composeChildBrief({ persona: REVIEWER, instructions: 'Review.', task: 'go', inputs: { diff: 'd' } })
    expect(brief).toContain('- summary (text) [optional]')
    expect(brief).toContain('- findings (list)')
    expect(brief).not.toContain('Required output:')
  })
})

describe('the roster loader', () => {
  /**
   * A reader over a fixed set of files, recording every path it was asked for.
   *
   * Keys use forward slashes and the plugin builds paths with `path.join`, so
   * both sides are normalized: the fixture stays readable and the loader stays
   * separator-correct on the platform it runs on.
   */
  function reader(files: Record<string, string>): { port: { readFile: (p: string) => Promise<string | undefined>; listDir: (p: string) => Promise<readonly string[]> }; opened: string[] } {
    const opened: string[] = []
    const normalize = (path: string): string => path.replaceAll('\\', '/')
    const table = new Map(Object.entries(files).map(([key, value]) => [normalize(key), value]))
    return {
      opened,
      port: {
        readFile: async (path) => {
          opened.push(normalize(path))
          return table.get(normalize(path))
        },
        listDir: async (directory) => {
          const base = normalize(directory)
          return [...table.keys()]
            .filter(path => path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes('/'))
            .map(path => path.slice(base.length + 1))
        },
      },
    }
  }

  const PROJECT = '/w/.freecodego/personas/reviewer.toml'
  const USER = '/data/personas/reviewer.toml'
  const FILES = {
    [PROJECT]: 'instructions = "project version"\n',
    [USER]: 'instructions = "user version"\n',
  }

  test('an untrusted workspace never has its persona files opened', async () => {
    // The distinction that matters: refusing after parsing still means this
    // process read an untrusted checkout's instructions.
    const r = reader(FILES)
    const roster = await loadPersonaRoster({ workspaceRoot: '/w', trusted: false, userDirectory: '/data/personas', port: r.port })
    expect(r.opened).not.toContain(PROJECT)
    expect(roster.personas.map(persona => persona.name)).toEqual(['reviewer'])
    expect(roster.personas[0]?.source).toBe('user')
  })

  test('a trusted workspace resolves the project tier over the user tier, and reports the shadowing', async () => {
    const r = reader(FILES)
    const roster = await loadPersonaRoster({ workspaceRoot: '/w', trusted: true, userDirectory: '/data/personas', port: r.port })
    expect(roster.personas).toHaveLength(1)
    expect(roster.personas[0]?.source).toBe('project')
    expect(roster.personas[0]?.instructions).toBe('project version')
    expect(roster.shadowed).toEqual([{ name: 'reviewer', sources: ['project', 'user'] }])
  })

  test('a file that is not a persona is reported as refused, not skipped', async () => {
    const r = reader({ '/w/.freecodego/personas/broken.toml': 'instructions = "x"\ndefault_isolaton = "worktree"\n' })
    const roster = await loadPersonaRoster({ workspaceRoot: '/w', trusted: true, userDirectory: '/data/personas', port: r.port })
    expect(roster.personas).toHaveLength(0)
    expect(roster.issues[0]?.reason).toContain('default_isolaton')
  })

  test('json personas are read on the same terms as toml', async () => {
    const r = reader({ '/w/.freecodego/personas/jsonone.json': JSON.stringify({ instructions: 'from json' }) })
    const roster = await loadPersonaRoster({ workspaceRoot: '/w', trusted: true, userDirectory: '/data/personas', port: r.port })
    expect(roster.personas[0]?.name).toBe('jsonone')
  })
})

describe('instructions_file', () => {
  test('appends the file after the inline instructions', async () => {
    const withFile = persona({ instructions: 'House style.', instructions_file: '/p/style.md' })
    const merged = await loadPersonaInstructions(withFile, async () => 'Local exception.')
    expect(merged.indexOf('House style.')).toBeLessThan(merged.indexOf('Local exception.'))
  })

  test('a file that could not be read is reported in the text the child receives', async () => {
    const withFile = persona({ instructions: 'House style.', instructions_file: '/p/style.md' })
    const merged = await loadPersonaInstructions(withFile, async () => undefined)
    expect(merged).toContain('could not be read')
  })
})
