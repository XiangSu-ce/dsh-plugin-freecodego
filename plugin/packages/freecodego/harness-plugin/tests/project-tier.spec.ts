/**
 * The project tier's consumed half.
 *
 * What these cases protect
 * ------------------------
 * `project-config.ts` decides *which* keys a repository may set. This module
 * decides what those keys *do*, and the interesting failures are all
 * asymmetries between a repository and the user whose machine it is running on:
 *
 * 1. **A repository must not be able to impersonate the user's own entries.**
 *    Every id is namespaced, so a file that declares `id: "my-laptop-server"`
 *    cannot collide with — let alone replace — the server the user configured
 *    under that id.
 * 2. **A repository must not be able to weaken the guard.** `permissionRules`
 *    compile into their own policy that is consulted *beside* the built-in one.
 *    The case below writes the most hostile rule it can — an `allow` for
 *    `rm -rf /` — and asserts the built-in denial still stands.
 * 3. **One bad entry must not cost the good ones.** The document is authored by
 *    whoever wrote the repository, so parsing is defensive and every rejection is
 *    a note rather than a throw.
 */

import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BUILT_IN_COMMAND_POLICY, commandPolicyDenial, compileCommandPolicy } from '../src/command-policy.ts'
import { projectTierFrom } from '../src/project-tier.ts'
import { freeCodeGoToolGuard, projectCommandPolicyDenial } from '../src/tool-guards.ts'

const ROOT = '/work/checkout'
/** An absolute path on whichever platform the suite is running on. */
const shared = resolve('/opt/shared-skills')

/** The accepted-keys half of a read result, with nothing ignored. */
function accepted(value: Record<string, unknown>): { accepted: Record<string, unknown>; ignored: string[] } {
  return { accepted: value, ignored: [] }
}

describe('projectTierFrom', () => {
  it('namespaces every id so a repository cannot impersonate the user’s entries', () => {
    const tier = projectTierFrom(accepted({
      mcpServers: [{ id: 'my-laptop-server', serverName: 'staging', command: 'node' }],
      skillRoots: [{ id: 'my-laptop-server', path: './skills' }],
    }) as never, ROOT)
    // The declared ids are `my-laptop-server`, which is exactly what a user's own
    // entry is called. The prefix is the only thing standing between the two
    // inventories, so it is asserted from both families.
    expect(tier.mcpServers[0]?.id).toBe('project:my-laptop-server')
    expect(tier.skillRoots[0]?.id).toBe('project:my-laptop-server')
    expect(tier.mcpServers[0]?.serverName).toBe('staging')
  })

  it('resolves declared paths against the repository, not the process', () => {
    const tier = projectTierFrom(accepted({
      skillRoots: ['./skills', { path: 'tools/skills' }, { path: shared }],
      mcpServers: [{ serverName: 'staging', command: 'node', cwd: './staging' }],
    }) as never, ROOT)
    expect(tier.skillRoots.map(root => root.path)).toEqual([
      resolve(ROOT, './skills'),
      resolve(ROOT, 'tools/skills'),
      // An absolute path is left alone: it is the one thing a checked-in file
      // cannot have meant relative to the repository.
      shared,
    ])
    expect(tier.mcpServers[0]?.cwd).toBe(resolve(ROOT, './staging'))
  })

  it('infers the transport and defaults the optional fields', () => {
    const tier = projectTierFrom(accepted({
      mcpServers: [
        // The report's own fixture shape: no `transport`, a command.
        { serverName: 'staging', command: 'node', args: ['serve.js'] },
        // A url and no command is plainly an HTTP server.
        { serverName: 'remote', url: 'https://mcp.example.test' },
        { serverName: 'explicit', transport: 'streamable-http', url: 'https://mcp.example.test/2' },
      ],
    }) as never, ROOT)
    expect(tier.mcpServers.map(server => server.transport)).toEqual(['stdio', 'streamable-http', 'streamable-http'])
    expect(tier.mcpServers[0]).toMatchObject({ enabled: true, args: ['serve.js'], env: {}, headers: {}, cwd: '' })
  })

  it('sets one unusable entry aside without losing the rest', () => {
    const tier = projectTierFrom(accepted({
      mcpServers: [
        'not-an-object',
        { serverName: 'no command' },
        { serverName: 'stdio-without-command', transport: 'stdio' },
        { serverName: 'http-without-url', transport: 'streamable-http' },
        { serverName: 'bad args', command: 'node', args: [1, 2] },
        { serverName: 'bad env', command: 'node', env: { KEY: 1 } },
        { serverName: 'good', command: 'node' },
      ],
      skillRoots: [42, { path: '' }, { path: './skills' }],
    }) as never, ROOT)
    expect(tier.mcpServers.map(server => server.serverName)).toEqual(['good'])
    expect(tier.skillRoots.map(root => root.path)).toEqual([resolve(ROOT, './skills')])
    // Each rejection is named, because the alternative — a repository author
    // seeing an accepted key and no server — is indistinguishable from a typo.
    expect(tier.notes.length).toBeGreaterThanOrEqual(7)
    expect(tier.notes.some(note => note.includes('mcpServers[1]'))).toBe(true)
    expect(tier.notes.some(note => note.includes('skillRoots[0]'))).toBe(true)
  })

  it('reports a non-array family instead of throwing', () => {
    const tier = projectTierFrom(accepted({ mcpServers: { staging: {} }, skillRoots: 'skills' }) as never, ROOT)
    expect(tier.mcpServers).toEqual([])
    expect(tier.skillRoots).toEqual([])
    expect(tier.notes).toEqual(['mcpServers is not an array, so no server was mounted', 'skillRoots is not an array, so no root was mounted'])
  })

  it('keeps a root whose path is longer than an id may be', () => {
    // The regression this pins: the id used to be derived from the resolved
    // absolute path, which is over 80 characters for any realistic checkout — so
    // every deep root was dropped with a note its author would read as a typo.
    // Built through `resolve` so the path is absolute on the platform running the
    // suite: a POSIX-looking `/work/…` is absolute on Windows too, and the point
    // here is the length, not the spelling.
    const deep = resolve(ROOT, `${'nested/'.repeat(20)}skills`)
    const tier = projectTierFrom(accepted({ skillRoots: [{ path: deep }] }) as never, ROOT)
    expect(tier.skillRoots).toHaveLength(1)
    expect(tier.skillRoots[0]?.path).toBe(deep)
    expect((tier.skillRoots[0]?.id ?? '').length).toBeLessThanOrEqual(80)
    // Distinct roots sharing a basename stay distinct.
    const two = projectTierFrom(accepted({ skillRoots: [{ path: 'a/skills' }, { path: 'b/skills' }] }) as never, ROOT)
    expect(new Set(two.skillRoots.map(root => root.id)).size).toBe(2)
  })

  it('caps each family at the same limit the user’s own inventory carries', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ serverName: `s${index}`, command: 'node' }))
    const tier = projectTierFrom(accepted({ mcpServers: many }) as never, ROOT)
    expect(tier.mcpServers).toHaveLength(24)
    expect(tier.notes.some(note => note.includes('only the first 24'))).toBe(true)
  })

  it('compiles the repository’s rules into their own policy, and reports the dropped ones', () => {
    const tier = projectTierFrom(accepted({
      permissionRules: {
        rules: [
          { pattern: ['terraform', 'apply'], decision: 'forbidden', justification: 'Apply from the review pipeline.' },
          // A rule whose own example does not hold is dropped by the compiler —
          // the tier must surface that rather than mount a rule set that lies.
          { pattern: ['foo'], decision: 'forbidden', match: [['bar']] },
        ],
      },
    }) as never, ROOT)
    expect(tier.policy?.rules.map(rule => rule.pattern)).toEqual([['terraform', 'apply']])
    expect(tier.notes.some(note => note.includes('permissionRules:'))).toBe(true)
  })

  it('declares no policy at all when every rule was dropped', () => {
    const tier = projectTierFrom(accepted({ permissionRules: { rules: [{ pattern: [] }] } }) as never, ROOT)
    expect(tier.policy).toBeUndefined()
  })

  it('keeps the entries it already parsed when the rules block is unreadable', () => {
    // "One bad entry must not cost the good ones" is the promise this file's header
    // makes, and the rules block was the one place it did not hold: `match: 5` was read
    // with `for ... of` inside the compiler, so it threw out of `projectTierFrom` and
    // took the MCP servers and Skill roots this function had already parsed with it —
    // the caller has no catch. Both halves are asserted, because "the policy is absent"
    // on its own would also pass if the whole tier had been dropped.
    const tier = projectTierFrom(accepted({
      mcpServers: [{ serverName: 'ok', command: 'node' }],
      skillRoots: ['./skills'],
      permissionRules: { rules: [{ pattern: ['git'], match: 5 }] },
    }) as never, ROOT)
    expect(tier.mcpServers.map(server => server.serverName)).toEqual(['ok'])
    expect(tier.skillRoots).toHaveLength(1)
    expect(tier.policy).toBeUndefined()
    expect(tier.notes.some(note => note.includes('permissionRules'))).toBe(true)
  })

  it('hands the hooks block over unparsed', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }] }
    const tier = projectTierFrom(accepted({ hooks }) as never, ROOT)
    expect(tier.hooks).toBe(hooks)
    expect(projectTierFrom(accepted({}) as never, ROOT).hooks).toBeUndefined()
  })
})

/**
 * The property the whole design turns on: a project policy may add a denial and
 * may never remove one. Asserted through the guard rather than through the
 * compiler, because "two policies, either may deny" is a property of the guard.
 */
describe('a project command policy is monotonic', () => {
  const exec = (command: string): { name: string; arguments: { command: string } } => ({ name: 'bash', arguments: { command } })

  const guard = (project: ReturnType<typeof compileCommandPolicy> | undefined) => freeCodeGoToolGuard({
    settings: () => ({ commandPolicyEnabled: true, envReadGuardEnabled: false, doomLoopGuardEnabled: false }),
    projectPolicy: () => project,
  })

  it('keeps the built-in denial even when the repository allows the same command', () => {
    // The hostile document: a repository that names the built-in kill pattern and
    // declares it allowed. Without two separate evaluations this rule would be
    // appended after the built-in one and, on a pattern-length tie, lose — but
    // merged *before* it, it would win and silently un-forbid the command.
    const hostile = compileCommandPolicy({
      rules: [{ pattern: ['rm', '-rf', '/'], decision: 'allow' }],
    })
    expect(commandPolicyDenial(hostile, 'rm -rf /')).toBeUndefined()
    expect(guard(hostile)(exec('rm -rf /') as never)).toContain('Blocked by the FreeCodeGo command policy')
  })

  it('adds the repository’s own denial', () => {
    const project = compileCommandPolicy({
      rules: [{ pattern: ['terraform', 'apply'], decision: 'forbidden', justification: 'Apply from the review pipeline.' }],
    })
    const denial = guard(project)(exec('terraform apply') as never)
    expect(denial).toContain('Apply from the review pipeline.')
    // …and nothing else in the built-in policy moved.
    expect(guard(project)(exec('terraform plan') as never)).toBeUndefined()
    expect(commandPolicyDenial(compileCommandPolicy(BUILT_IN_COMMAND_POLICY), 'terraform plan')).toBeUndefined()
  })

  it('asks a repository’s policy for a `prompt`, and still leaves it to the approval layer', () => {
    const project = compileCommandPolicy({
      rules: [{ pattern: ['terraform', 'apply'], decision: 'prompt', justification: 'Ask first.' }],
    })
    // Only `forbidden` denies: the guard is a monotonic denial with no way back to
    // a question, so a `prompt` here must not become one.
    expect(projectCommandPolicyDenial(project, 'terraform apply')).toBeUndefined()
  })
})
