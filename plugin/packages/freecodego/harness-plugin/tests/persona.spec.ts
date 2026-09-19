/**
 * A2 — personas as files, with a contract that can refuse a spawn.
 *
 * The two assertions worth reading first are the mutation probes: a missing
 * required *input* must refuse, and a missing required *output* must not.
 */

import { describe, expect, test } from 'vitest'

import {
  checkSpawnInputs,
  checkSpawnOutputs,
  mergePersonaInstructions,
  normalizePersona,
  type PersonaDefinition,
} from '../src/persona/contract.ts'
import { discoverPersonas, parsePersonaFile, parseTomlSubset, type PersonaFile } from '../src/persona/discovery.ts'
import { DEFAULT_PERSONA_ISOLATION, resolvePersonaRuntime } from '../src/persona/resolve.ts'

/** A persona with a full contract, for the quadrant tests. */
function personaWithContract(): PersonaDefinition {
  const normalized = normalizePersona(
    {
      description: 'researches',
      instructions: 'Be thorough.',
      inputs: [
        { name: 'question', io_type: 'text', required: true },
        { name: 'hint', io_type: 'text', required: false },
      ],
      outputs: [
        { name: 'findings', io_type: 'markdown', required: true },
        { name: 'notes', io_type: 'text', required: false },
      ],
    },
    'researcher',
    'user',
    '/p/researcher.toml',
  )
  if (!('persona' in normalized)) throw new Error('fixture should be valid')
  return normalized.persona
}

describe('the TOML subset', () => {
  test('parses comments, sections and the four scalar kinds', () => {
    const parsed = parseTomlSubset([
      '# a persona',
      'description = "does things" # trailing',
      'instructions = "line one\\nline two"',
      'model = "gpt-5"',
      'reasoning_effort = "high"',
      'default_isolation = "worktree"',
      'enabled = true',
      'retries = 3',
      'tags = ["a", "b"]',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual({
      description: 'does things',
      instructions: 'line one\nline two',
      model: 'gpt-5',
      reasoning_effort: 'high',
      default_isolation: 'worktree',
      enabled: true,
      retries: 3,
      tags: ['a', 'b'],
    })
  })

  test('reads an escaped backslash as a backslash, not as the start of an escape', () => {
    // A Windows path is the case that matters: `instructions_file =
    // "C:\\notes\\style.md"` means one backslash per separator. Expanding `\n`
    // before collapsing `\\` reads the `\\n` of `\\notes` as a newline, so the path
    // the persona carries is not the path the file wrote — and the file is refused
    // later, at spawn time, for a reason that has nothing to do with what was typed.
    const parsed = parseTomlSubset('instructions_file = "C:\\\\notes\\\\style.md"')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.instructions_file).toBe('C:\\notes\\style.md')
    // An escape this subset does not define is left as written rather than
    // dropped: `\\t` is two characters, which is at least recoverable.
    const unknown = parseTomlSubset('instructions = "a\\tb"')
    expect(unknown.ok).toBe(true)
    if (!unknown.ok) return
    expect(unknown.value.instructions).toBe('a\\tb')
  })

  test('refuses a key or a section declared twice instead of keeping the last one', () => {
    // TOML forbids both, and this parser's contract is to refuse what it does not
    // support rather than drop a declaration silently: the first value in a
    // duplicated pair would otherwise disappear with no refusal anywhere.
    const duplicateKey = parseTomlSubset('instructions = "a"\ninstructions = "b"')
    expect(duplicateKey.ok).toBe(false)
    if (duplicateKey.ok) return
    expect(duplicateKey.issue.reason).toContain('twice')

    const duplicateSection = parseTomlSubset('[hooks]\ncommand = "a"\n[hooks]\ncommand = "b"')
    expect(duplicateSection.ok).toBe(false)
  })

  test('does not treat a # inside a string as a comment', () => {
    const parsed = parseTomlSubset('instructions = "use # not comments"')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.instructions).toBe('use # not comments')
  })

  test.each([
    ['unterminated string', 'default_isolation = "worktree'],
    ['inline table', 'x = { a = 1 }'],
    ['array of tables', '[[inputs]]'],
    ['missing value', 'model ='],
    ['bare word value', 'model = gpt5'],
    ['unterminated array', 'tags = ["a"'],
    ['no equals', 'just some words'],
  ] as const)('refuses %s instead of guessing', (_label, line) => {
    // The failure this prevents: parsing what it recognizes and dropping the
    // rest, so a persona runs without the isolation line that failed to parse.
    const parsed = parseTomlSubset(line)
    expect(parsed.ok).toBe(false)
  })

  test('names the line that was refused', () => {
    const parsed = parseTomlSubset('model = "x"\ndefault_isolation = "worktree')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issue.line).toBe(2)
  })
})

describe('parsing a persona file', () => {
  test('reads a .toml persona', () => {
    const parsed = parsePersonaFile({
      path: '/p/researcher.toml',
      source: 'user',
      contents: 'description = "researches"\ninstructions = "Be thorough."\n',
    })
    expect('persona' in parsed).toBe(true)
    if (!('persona' in parsed)) return
    expect(parsed.persona.name).toBe('researcher')
    expect(parsed.persona.source).toBe('user')
  })

  test('reads a .json persona', () => {
    const parsed = parsePersonaFile({
      path: '/p/builder.json',
      source: 'project',
      contents: JSON.stringify({ instructions: 'Build it.', default_isolation: 'worktree' }),
    })
    expect('persona' in parsed).toBe(true)
    if (!('persona' in parsed)) return
    expect(parsed.persona.defaultIsolation).toBe('worktree')
  })

  test('refuses an unsupported extension by name', () => {
    const parsed = parsePersonaFile({ path: '/p/x.yaml', source: 'user', contents: 'instructions: hi' })
    expect('issue' in parsed).toBe(true)
    if (!('issue' in parsed)) return
    expect(parsed.issue.reason).toContain('unsupported persona format')
  })

  test('refuses an unknown field rather than ignoring it', () => {
    // `default_isolaton` would otherwise configure nothing while looking right.
    const parsed = parsePersonaFile({
      path: '/p/x.toml',
      source: 'user',
      contents: 'instructions = "hi"\ndefault_isolaton = "worktree"',
    })
    expect('issue' in parsed).toBe(true)
    if (!('issue' in parsed)) return
    expect(parsed.issue.reason).toContain('unknown field')
  })

  test('refuses a persona with neither instructions nor instructions_file', () => {
    const parsed = parsePersonaFile({ path: '/p/x.toml', source: 'user', contents: 'description = "empty"' })
    expect('issue' in parsed).toBe(true)
  })

  test('refuses a bad default_isolation value', () => {
    const parsed = parsePersonaFile({ path: '/p/x.toml', source: 'user', contents: 'instructions = "hi"\ndefault_isolation = "sandbox"' })
    expect('issue' in parsed).toBe(true)
  })

  test('refuses a persona name that cannot be a lookup key', () => {
    const parsed = parsePersonaFile({ path: '/p/x.toml', source: 'user', contents: 'name = "Has Spaces"\ninstructions = "hi"' })
    expect('issue' in parsed).toBe(true)
  })

  test('falls back to the file name for the persona name', () => {
    const parsed = parsePersonaFile({ path: '/p/senior-reviewer.toml', source: 'user', contents: 'instructions = "hi"' })
    expect('persona' in parsed).toBe(true)
    if (!('persona' in parsed)) return
    expect(parsed.persona.name).toBe('senior-reviewer')
  })
})

describe('discovery precedence', () => {
  const files: readonly PersonaFile[] = [
    { path: '/bundled/reviewer.toml', source: 'bundled', contents: 'instructions = "bundled"' },
    { path: '/home/u/.dsh/freecodego/personas/reviewer.toml', source: 'user', contents: 'instructions = "user"' },
    { path: '/repo/.freecodego/personas/reviewer.toml', source: 'project', contents: 'instructions = "project"' },
    { path: 'inline:reviewer', source: 'inline', contents: JSON.stringify({ instructions: 'inline' }) },
  ]

  test('inline beats project beats user beats bundled', () => {
    const discovered = discoverPersonas(files, { projectTrusted: true })
    expect(discovered.personas).toHaveLength(1)
    expect(discovered.personas[0]!.instructions).toBe('inline')
  })

  test('reports two files in one tier that claim the same name', () => {
    // The cross-tier case is reported because a user asking "why did my edit do
    // nothing" deserves the answer; the same thing inside one tier has to be too,
    // and it is easier to hit — two files in one directory can declare the same
    // `name`.
    const discovered = discoverPersonas(
      [
        { path: '/repo/.freecodego/personas/one.toml', source: 'project', contents: 'name = "reviewer"\ninstructions = "first"' },
        { path: '/repo/.freecodego/personas/two.toml', source: 'project', contents: 'name = "reviewer"\ninstructions = "second"' },
      ],
      { projectTrusted: true },
    )
    // The later file still wins — that is not the defect — but the file that did
    // not contribute says so.
    expect(discovered.personas.map(persona => persona.name)).toEqual(['reviewer'])
    expect(discovered.personas[0]?.instructions).toBe('second')
    const collision = discovered.issues.find(issue => issue.reason.includes('reviewer'))
    expect(collision?.path).toBe('/repo/.freecodego/personas/one.toml')
    expect(collision?.reason).toContain('two.toml')
  })

  test('reports which sources were shadowed, most specific first', () => {
    const discovered = discoverPersonas(files, { projectTrusted: true })
    expect(discovered.shadowed).toEqual([
      { name: 'reviewer', sources: ['inline', 'project', 'user', 'bundled'] },
    ])
  })

  test('drops the project tier entirely when the folder is not trusted', () => {
    const discovered = discoverPersonas(files, { projectTrusted: false })
    expect(discovered.personas[0]!.instructions).toBe('inline')
    expect(discovered.issues.some(issue => issue.reason.includes('until the folder is trusted'))).toBe(true)
  })

  test('keeps personas with distinct names from every tier', () => {
    const discovered = discoverPersonas(
      [...files, { path: '/bundled/librarian.toml', source: 'bundled', contents: 'instructions = "index"' }],
      { projectTrusted: true },
    )
    expect(discovered.personas.map(entry => entry.name).sort()).toEqual(['librarian', 'reviewer'])
  })

  test('collects a refusal per bad file without losing the good ones', () => {
    const discovered = discoverPersonas(
      [files[1]!, { path: '/home/u/broken.yaml', source: 'user', contents: 'nope' }],
      { projectTrusted: true },
    )
    expect(discovered.personas).toHaveLength(1)
    expect(discovered.issues).toHaveLength(1)
  })
})

describe('the I/O contract', () => {
  // Four quadrants, checked before and after the spawn: 8 cases.
  test('required input supplied, before the spawn: allowed', () => {
    expect(checkSpawnInputs(personaWithContract(), ['question'])).toEqual({ ok: true })
  })

  test('required input + optional input supplied: allowed', () => {
    expect(checkSpawnInputs(personaWithContract(), ['question', 'hint'])).toEqual({ ok: true })
  })

  test('optional input missing: still allowed', () => {
    expect(checkSpawnInputs(personaWithContract(), ['question']).ok).toBe(true)
  })

  test('required input missing: REFUSED, with the field named', () => {
    const verdict = checkSpawnInputs(personaWithContract(), [])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.missing.map(field => field.name)).toEqual(['question'])
    expect(verdict.message).toContain('"question" (text)')
    expect(verdict.message).toContain('nothing was started')
  })

  test('required output produced: nothing reported', () => {
    expect(checkSpawnOutputs(personaWithContract(), ['findings']).missing).toEqual([])
  })

  test('required + optional output produced: nothing reported', () => {
    expect(checkSpawnOutputs(personaWithContract(), ['findings', 'notes']).missing).toEqual([])
  })

  test('optional output missing: nothing reported', () => {
    expect(checkSpawnOutputs(personaWithContract(), ['findings']).message).toBeUndefined()
  })

  test('required output missing: WARNS and keeps the result', () => {
    const verdict = checkSpawnOutputs(personaWithContract(), [])
    expect(verdict.missing.map(field => field.name)).toEqual(['findings'])
    expect(verdict.message).toContain('the rest of its result was kept')
  })

  test('duplicate input declarations are refused', () => {
    const normalized = normalizePersona(
      {
        instructions: 'x',
        inputs: [
          { name: 'a', io_type: 'text', required: true },
          { name: 'a', io_type: 'text', required: false },
        ],
      },
      'dup',
      'user',
      '/p/dup.toml',
    )
    expect('issue' in normalized).toBe(true)
  })

  test('refuses an unknown field inside an input, not only at the top level', () => {
    // The module's rule is that a field it does not understand is refused rather
    // than ignored, because "a typo here would silently do nothing". That rule one
    // level down covers `requried`, which would leave the field optional — so the
    // spawn this whole contract exists to refuse would have been allowed, and the
    // child would have started without the brief nobody noticed was optional.
    const normalized = normalizePersona(
      { instructions: 'x', inputs: [{ name: 'brief', io_type: 'text', requried: true }] },
      'typo',
      'user',
      '/p/typo.toml',
    )
    expect('issue' in normalized).toBe(true)
    if (!('issue' in normalized)) return
    expect(normalized.issue.reason).toContain('requried')
  })

  test('refuses a declared scalar that is not a string', () => {
    // Each of these used to be silently dropped, which is the failure the header
    // names: a persona that looks configured and does nothing. `model = 42` ran on
    // the deployment default, `name = 42` was replaced by the file name, and
    // `instructions_file = 42` left a persona with a file it never read.
    for (const field of ['name', 'description', 'instructions', 'instructions_file', 'model', 'reasoning_effort']) {
      const normalized = normalizePersona(
        { instructions: 'x', [field]: 42 },
        'typed',
        'user',
        '/p/typed.toml',
      )
      expect('issue' in normalized, `${field} = 42 must be refused`).toBe(true)
      if (!('issue' in normalized)) continue
      expect(normalized.issue.reason).toContain(field)
    }
  })

  test('keeps an empty string as "not declared" rather than refusing it', () => {
    // An empty value declares nothing, which is exactly what the line's absence
    // means — so this stays the tolerated spelling and only the wrong *type* is
    // refused.
    const normalized = normalizePersona({ instructions: 'x', model: '' }, 'empty', 'user', '/p/empty.toml')
    expect('persona' in normalized).toBe(true)
    if (!('persona' in normalized)) return
    expect(normalized.persona.model).toBeUndefined()
  })

  test('a non-boolean required is refused rather than coerced', () => {
    const normalized = normalizePersona(
      { instructions: 'x', inputs: [{ name: 'a', io_type: 'text', required: 'yes' }] },
      'coerce',
      'user',
      '/p/coerce.toml',
    )
    expect('issue' in normalized).toBe(true)
  })

  test('the description falls back to the first paragraph of the instructions', () => {
    const normalized = normalizePersona(
      { instructions: 'First line.\n\nSecond paragraph.' },
      'described',
      'user',
      '/p/x.toml',
    )
    expect('persona' in normalized).toBe(true)
    if (!('persona' in normalized)) return
    expect(normalized.persona.description).toBe('First line.')
  })
})

describe('instructions_file merge order', () => {
  const base = personaWithContract()

  test('the file is appended after the inline instructions', () => {
    // So a shared persona carries the house style and a project appends its
    // exception without copying the style in.
    const merged = mergePersonaInstructions({ ...base, instructions: 'inline', instructionsFile: 'style.md' }, 'file')
    expect(merged).toBe('inline\n\nfile')
  })

  test('an unreadable file is reported, not silently dropped', () => {
    const merged = mergePersonaInstructions({ ...base, instructions: 'inline', instructionsFile: 'missing.md' }, undefined)
    expect(merged).toContain('inline')
    expect(merged).toContain('could not be read')
    expect(merged).toContain('missing.md')
  })

  test('with no instructions_file the inline text is used unchanged', () => {
    expect(mergePersonaInstructions(base, 'ignored')).toBe(base.instructions)
  })
})

describe('runtime resolution and isolation', () => {
  const base = personaWithContract()

  test('an explicit override wins over the persona', () => {
    const runtime = resolvePersonaRuntime({ ...base, model: 'from-persona' }, { model: 'from-call' })
    expect(runtime.model).toBe('from-call')
  })

  test('the persona wins over the agent type default', () => {
    const runtime = resolvePersonaRuntime({ ...base, model: 'from-persona' }, {}, { model: 'from-type' })
    expect(runtime.model).toBe('from-persona')
  })

  test('the agent type default applies when nothing else declares one', () => {
    expect(resolvePersonaRuntime(base, {}, { model: 'from-type' }).model).toBe('from-type')
  })

  test('the build default isolation is none', () => {
    const runtime = resolvePersonaRuntime(base)
    expect(runtime.isolation).toBe(DEFAULT_PERSONA_ISOLATION)
    expect(runtime.isolationSource).toBe('default')
  })

  test('default_isolation = worktree resolves and reports its source', () => {
    const runtime = resolvePersonaRuntime({ ...base, defaultIsolation: 'worktree' })
    expect(runtime.isolation).toBe('worktree')
    expect(runtime.isolationSource).toBe('persona')
  })

  test('a call-site override can turn isolation off for one child', () => {
    const runtime = resolvePersonaRuntime({ ...base, defaultIsolation: 'worktree' }, { isolation: 'none' })
    expect(runtime.isolation).toBe('none')
    expect(runtime.isolationSource).toBe('override')
  })

  test('no child is exempt from the parent plan fence, whatever isolation it runs in', () => {
    // The design said a worktree child *is* exempt (it is dispatched from a plan,
    // so its work is the plan's execution). This deployment keys plan mode on the
    // root conversation, so a child is judged by its parent's mode — the opposite
    // rule — and this is the cross-check with A1 that pins it in both files.
    //
    // The deployment's version is the defensible one: an exemption for children
    // makes the fence a naming convention, because the fenced parent can delegate
    // the write it is not allowed to make.
    expect(resolvePersonaRuntime({ ...base, defaultIsolation: 'worktree' }).exemptFromPlanFence).toBe(false)
    expect(resolvePersonaRuntime(base).exemptFromPlanFence).toBe(false)
  })

  test('tools are not part of the resolution at all', () => {
    // A persona that could change the tool set would be a second, weaker gate on
    // a question the agent type already owns.
    const runtime = resolvePersonaRuntime(base, {}, {})
    expect(Object.keys(runtime)).not.toContain('tools')
  })
})
