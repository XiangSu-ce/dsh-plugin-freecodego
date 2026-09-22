/**
 * `.claude/settings.json` is read by two systems, and only one of them may run it.
 *
 * The Harness's own bridge (`@deepseek-ai/dsh-hooks-claude-code`) parses the same
 * file with the same event→matcher-group grammar and *runs the command*. This
 * plugin's reader does too. A composition that mounts both therefore fires every
 * Claude hook twice, and nothing in a hook's own side effect says so — the failure
 * is two authors writing the same record.
 *
 * So the native system keeps the file: when a row mounting the bridge is present,
 * this reader leaves `.claude/settings.json` alone and keeps the two dialects no
 * Harness package parses. These cases pin that, and pin the two ways it could go
 * wrong silently: filtering only one of the two tiers, and a report that lists
 * fewer files without naming the owner.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/hook-dialect-standdown
 */

import { describe, expect, it } from 'vitest'

import { claudeHookDialectOf, harnessOwnsClaudeHookFiles, loadHookDocuments, PROJECT_HOOK_FILES, USER_HOOK_FILES } from '../src/hooks/files.ts'
import { buildInspectCollectors } from '../src/inspect/host.ts'
import type { InspectHostPort } from '../src/inspect/host.ts'
import type { JsonValue } from '../src/inspect/collect.ts'

/** The bridge's package name, as a profile writes it. */
const BRIDGE = '@deepseek-ai/dsh-hooks-claude-code'

/** Every hook file this build knows about, with contents that parse. */
const FIXTURE: Readonly<Record<string, string>> = {
  '/repo/.freecodego/hooks.json': JSON.stringify({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'our-project' }] }] }),
  '/repo/.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'claude-project' }] }] } }),
  '/repo/.cursor/hooks.json': JSON.stringify({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'cursor-project' }] }] }),
  '/home/user/.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'claude-user' }] }] } }),
  '/home/user/.cursor/hooks.json': JSON.stringify({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'cursor-user' }] }] }),
}

/** Read every document the given dialect owner would load. */
async function documents(claudeDialect: 'plugin' | 'harness'): Promise<readonly string[]> {
  const read: string[] = []
  const documents = await loadHookDocuments({
    workspaceRoot: '/repo',
    trusted: true,
    home: '/home/user',
    port: {
      readFile: async (target) => {
        read.push(target.replaceAll('\\', '/'))
        return FIXTURE[target.replaceAll('\\', '/')]
      },
    },
    claudeDialect,
  })
  return documents.map(document => document.path)
}

/** An inspect port over the fixture, with a chosen dialect owner. */
function port(claudeDialect: 'plugin' | 'harness'): InspectHostPort {
  const normalize = (path: string): string => path.replaceAll('\\', '/')
  return {
    workspace: () => '/repo',
    home: () => '/home/user',
    dataHome: () => '/home/user/.dsh',
    trust: async () => ({ enabled: true, trusted: true, reason: 'trusted-repository', root: '/repo' }),
    claudeHookDialect: () => claudeDialect,
    capabilities: async () => ({ skills: [], mcpServers: [], mcpTools: [] }),
    sandbox: () => ({ denyPatterns: [] }),
    engines: () => ({ deepseek: { available: true } }),
    readFile: async (target) => FIXTURE[normalize(target)],
    listDir: async () => [],
    changes: async () => undefined,
    fileSize: async () => undefined,
    repositoryRoot: async () => undefined,
  }
}

/** Collect the hooks section from an inspect port. */
async function hooksSection(claudeDialect: 'plugin' | 'harness'): Promise<Record<string, JsonValue>> {
  const collector = buildInspectCollectors(port(claudeDialect)).find(entry => entry.id === 'hooks')
  if (collector === undefined) throw new Error('the hooks section is not registered')
  return await collector.collect() as Record<string, JsonValue>
}

describe('who owns the Claude Code hook dialect', () => {
  it('recognises the bridge under the spellings a composition can use', () => {
    // The row's `name`, an alias whose basename is the package, and the id alone:
    // all three reach the same module, and a comparison against the full scoped
    // name would miss two of them and read the file twice.
    expect(harnessOwnsClaudeHookFiles([BRIDGE])).toBe(true)
    expect(harnessOwnsClaudeHookFiles(['vendor/freecodego/dsh-hooks-claude-code'])).toBe(true)
    expect(harnessOwnsClaudeHookFiles(['dsh-hooks-claude-code'])).toBe(true)
  })

  it('does not claim the file for rows that are not the bridge', () => {
    // The Codex bridge reads its own path and never this one, and the plugin's own
    // rows must not stand their own reader down.
    expect(harnessOwnsClaudeHookFiles(['@deepseek-ai/dsh-hooks-codex'])).toBe(false)
    expect(harnessOwnsClaudeHookFiles(['@deepseek-ai/dsh-freecodego-harness-plugin'])).toBe(false)
    expect(harnessOwnsClaudeHookFiles([])).toBe(false)
  })

  it('reads the answer off a Loader, and keeps the file when it cannot', () => {
    const mounted = { entries: () => [{ options: { name: BRIDGE } }, { options: { name: '@deepseek-ai/dsh-tools' } }] }
    expect(claudeHookDialectOf(mounted)).toBe('harness')
    expect(claudeHookDialectOf({ entries: () => [{ options: { name: '@deepseek-ai/dsh-tools' } }] })).toBe('plugin')
    // Every one of these is a Host that cannot answer, and the answer that keeps
    // the user's hooks running is the only safe one: standing down here would
    // claim the Harness runs a file it never loaded.
    expect(claudeHookDialectOf(undefined)).toBe('plugin')
    expect(claudeHookDialectOf({})).toBe('plugin')
    expect(claudeHookDialectOf({ entries: () => { throw new Error('loader is gone') } })).toBe('plugin')
    expect(claudeHookDialectOf({ entries: () => [null, { options: {} }, { options: { name: 7 } }] })).toBe('plugin')
  })
})

describe('the file set this reader opens', () => {
  it('reads every dialect when nothing else owns the Claude one', async () => {
    expect(await documents('plugin')).toEqual([
      '.freecodego/hooks.json',
      '.claude/settings.json',
      '.cursor/hooks.json',
      '~/.claude/settings.json',
      '~/.cursor/hooks.json',
    ])
  })

  it('leaves both tiers of .claude/settings.json to the Harness and keeps the rest', async () => {
    // Both tiers, deliberately: the project copy and the user copy of one file are
    // read by the same bridge, so a stand-down that filtered only `PROJECT_HOOK_FILES`
    // would keep firing the user's own Claude hooks a second time — while the
    // report said the dialect had been handed over.
    expect(await documents('harness')).toEqual([
      '.freecodego/hooks.json',
      '.cursor/hooks.json',
      '~/.cursor/hooks.json',
    ])
    expect(PROJECT_HOOK_FILES).toContain('.claude/settings.json')
    expect(USER_HOOK_FILES).toContain('.claude/settings.json')
  })
})

describe('what the inspect report says about it', () => {
  it('names the Harness as the Claude dialect owner rather than listing fewer files', async () => {
    const section = await hooksSection('harness')
    expect(section['claudeDialect']).toBe('harness')
    expect(String(section['claudeDialectNote'])).toContain(BRIDGE)
    expect(section['files']).not.toContain('.claude/settings.json')
    // The dialects this reader kept are still there — the stand-down is one file,
    // not the feature.
    expect(section['files']).toEqual(expect.arrayContaining(['.freecodego/hooks.json', '.cursor/hooks.json']))
  })

  it('claims the dialect and explains nothing when nothing else does', async () => {
    const section = await hooksSection('plugin')
    expect(section['claudeDialect']).toBe('plugin')
    // Absent rather than empty: a note is only true when there is something to say.
    expect(section['claudeDialectNote']).toBeUndefined()
    expect(section['files']).toContain('.claude/settings.json')
  })
})
