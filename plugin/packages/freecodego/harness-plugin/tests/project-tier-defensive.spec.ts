/**
 * The tier's "never a throw" promise, pinned against a compiler that throws.
 *
 * `projectTierFrom` parses a document authored by whoever wrote the repository, and
 * its header promises that a bad entry is "set aside with a note rather than taking a
 * plugin down". The rules block was the one place that promise did not hold: the
 * compiler read `match` with `for ... of`, so `match: 5` threw out of this function
 * and took the MCP servers and Skill roots it had already parsed with it — the caller
 * has no catch.
 *
 * The compiler rejects that shape now (asserted in `command-policy.spec.ts` and in
 * `project-tier.spec.ts`), so this file does not re-test it. It doubles the compiler
 * instead, which is the only way to assert what happens when the *next* unreadable
 * shape arrives: this path takes `unknown` from a repository file, and nothing
 * enforces the compiler's own no-throw property.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/command-policy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/command-policy.ts')>()
  return {
    ...actual,
    compileCommandPolicy: (): never => { throw new TypeError('the compiler was handed something it could not read') },
  }
})

import { projectTierFrom } from '../src/project-tier.ts'

const ROOT = '/work/checkout'

/** The accepted-keys half of a read result, with nothing ignored. */
function accepted(value: Record<string, unknown>): { accepted: Record<string, unknown>; ignored: string[] } {
  return { accepted: value, ignored: [] }
}

describe('a rules block the compiler cannot read', () => {
  it('costs the policy and nothing else', () => {
    const tier = projectTierFrom(accepted({
      mcpServers: [{ serverName: 'ok', command: 'node' }],
      skillRoots: ['./skills'],
      permissionRules: { rules: [{ pattern: ['git'] }] },
    }) as never, ROOT)
    // Both halves: "no policy" alone would also pass if the whole tier had been lost.
    expect(tier.mcpServers.map(server => server.serverName)).toEqual(['ok'])
    expect(tier.skillRoots).toHaveLength(1)
    expect(tier.policy).toBeUndefined()
    // Reported rather than swallowed: a repository whose rules silently stopped
    // applying is the worse outcome, which is why the catch pushes a note.
    expect(tier.notes.some(note => note.includes('could not be compiled'))).toBe(true)
    expect(tier.notes.some(note => note.includes('something it could not read'))).toBe(true)
  })
})
