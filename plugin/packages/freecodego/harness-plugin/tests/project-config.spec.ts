/**
 * The project configuration tier.
 *
 * What these cases protect
 * ------------------------
 * The tier's whole justification is that a *repository* wrote the file. So the two
 * failures worth testing are not "does it parse" — that is the easy half — but:
 *
 * 1. **A key outside the whitelist takes effect.** Every such key would be a
 *    repository-chosen value landing on the user's machine, and the dangerous ones
 *    (`defaultModel`, guard switches, credential routes) look exactly like the
 *    allowed ones in a diff. Only the four describing the repository's own content
 *    may pass.
 * 2. **The file is read before trust is decided.** A gate that reads first and
 *    discards afterwards has still put untrusted content in the process. The
 *    untrusted case below asserts the reader was *never called*, which is the only
 *    version of this that means anything.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  PROJECT_CONFIG_RELATIVE_PATH,
  PROJECT_CONFIG_WHITELIST,
  loadProjectConfig,
  readProjectConfig,
} from '../src/project-config.ts'

describe('PROJECT_CONFIG_WHITELIST', () => {
  it('admits only keys that describe the repository’s own content', () => {
    // A closed list, asserted rather than described: widening it is the exact
    // change this tier must not be able to make quietly.
    expect([...PROJECT_CONFIG_WHITELIST]).toStrictEqual(['mcpServers', 'skillRoots', 'permissionRules', 'hooks'])
  })

  it('excludes the keys a repository must never choose for the user', () => {
    // Named individually so the omission reads as a decision. Each of these is a
    // value the user's own settings own.
    for (const key of ['defaultModel', 'defaultEngine', 'advisorProvider', 'folderTrustEnabled', 'envReadGuardEnabled', 'planModeEnabled']) {
      expect(PROJECT_CONFIG_WHITELIST as readonly string[]).not.toContain(key)
    }
  })
})

describe('readProjectConfig', () => {
  it('reads an absent or empty document as no configuration at all', () => {
    expect(readProjectConfig(undefined)).toStrictEqual({ accepted: {}, ignored: [] })
    expect(readProjectConfig('')).toStrictEqual({ accepted: {}, ignored: [] })
    expect(readProjectConfig('   \n ')).toStrictEqual({ accepted: {}, ignored: [] })
  })

  it('reports invalid JSON instead of throwing', () => {
    // A checked-in typo must not stop the host from booting, and its author still
    // needs to hear about it — so the failure is a note, not an exception.
    const result = readProjectConfig('{ not json')
    expect(result.accepted).toStrictEqual({})
    expect(result.note).toContain(PROJECT_CONFIG_RELATIVE_PATH)
  })

  it('reports a non-object document', () => {
    expect(readProjectConfig('[]').note).toContain('must be a JSON object')
    expect(readProjectConfig('"text"').note).toContain('must be a JSON object')
  })

  it('accepts every whitelisted key', () => {
    const result = readProjectConfig(JSON.stringify({
      mcpServers: [{ id: 'staging' }],
      skillRoots: ['./skills'],
      permissionRules: [{ tool: 'Bash', allow: true }],
      hooks: { PreToolUse: ['./scripts/check.sh'] },
    }))
    expect(Object.keys(result.accepted).sort()).toStrictEqual([...PROJECT_CONFIG_WHITELIST].sort())
    expect(result.ignored).toStrictEqual([])
    expect(result.note).toBeUndefined()
  })

  it('ignores keys outside the whitelist and names them', () => {
    const result = readProjectConfig(JSON.stringify({ defaultModel: 'gpt-image-2', mcpServers: [] }))
    expect(Object.keys(result.accepted)).toStrictEqual(['mcpServers'])
    // Reported rather than dropped silently: an author who wrote `defaultModel` in
    // good faith has to be told why nothing happened.
    expect(result.ignored).toStrictEqual(['defaultModel'])
  })

  it('treats a null value as unset rather than as a value', () => {
    // `"mcpServers": null` means "this checkout has none". Handing `null` to a
    // consumer expecting an array is how that becomes a crash instead.
    const result = readProjectConfig(JSON.stringify({ mcpServers: null, skillRoots: ['./skills'] }))
    expect('mcpServers' in result.accepted).toBe(false)
    expect(result.accepted.skillRoots).toStrictEqual(['./skills'])
  })

  it('keeps the accepted keys apart from the ignored ones', () => {
    const result = readProjectConfig(JSON.stringify({ hooks: {}, nonsense: 1 }))
    expect(result.accepted).toStrictEqual({ hooks: {} })
    expect(result.ignored).toStrictEqual(['nonsense'])
  })
})

describe('loadProjectConfig', () => {
  it('never opens the file for an untrusted repository', async () => {
    // The gate is asked before the read. Reading first and discarding afterwards
    // would still have parsed untrusted content inside the process.
    const read = vi.fn(async () => '{"mcpServers":[]}')
    const result = await loadProjectConfig({
      root: '/work/repo',
      trusted: { trusted: false, reason: 'no-record' },
      read,
    })
    expect(read).not.toHaveBeenCalled()
    expect(result.accepted).toStrictEqual({})
    expect(result.note).toContain('no-record')
  })

  it('reads the document for a trusted repository', async () => {
    const read = vi.fn(async () => '{"mcpServers":[{"id":"staging"}]}')
    const result = await loadProjectConfig({
      root: '/work/repo',
      trusted: { trusted: true, reason: 'granted' },
      read,
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.accepted.mcpServers).toStrictEqual([{ id: 'staging' }])
  })

  it('resolves the path under the root without doubling separators', async () => {
    const read = vi.fn(async () => undefined)
    await loadProjectConfig({ root: '/work/repo/', trusted: { trusted: true, reason: 'granted' }, read })
    expect(read).toHaveBeenCalledWith(`/work/repo/${PROJECT_CONFIG_RELATIVE_PATH}`)
  })

  it('treats an unreadable document as absent', async () => {
    const result = await loadProjectConfig({
      root: '/work/repo',
      trusted: { trusted: true, reason: 'granted' },
      read: async () => { throw new Error('EACCES') },
    })
    expect(result).toStrictEqual({ accepted: {}, ignored: [] })
  })
})
