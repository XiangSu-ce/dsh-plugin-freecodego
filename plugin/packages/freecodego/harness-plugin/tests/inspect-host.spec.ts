/**
 * G9 — the host-side assembler.
 *
 * The assertion that matters most is the trust gate: an untrusted checkout's
 * hook, rule and persona files must not be opened in order to report them. A
 * report that reads them is a smaller version of the bug the gate exists to
 * prevent — and the report's contents would then be the repository's words.
 */

import { describe, expect, test } from 'vitest'

import type { WorkspaceChangeEntry, WorkspaceChangeScope } from '../src/engineering-quality.ts'
import { collectInspectReport, INSPECT_SECTIONS } from '../src/inspect/collect.ts'
import { buildInspectCollectors, type InspectHostPort } from '../src/inspect/host.ts'

/** A change scope around a list of entries, as `readWorkspaceChangeScope` returns one. */
function scopeOf(entries: readonly WorkspaceChangeEntry[]): WorkspaceChangeScope {
  return { changedPaths: entries.map(entry => entry.path), linesChanged: entries.length, entries }
}

/** A port backed by a fixture file system. */
function port(overrides: Partial<InspectHostPort> & { readonly files?: Record<string, string> } = {}): {
  port: InspectHostPort
  reads: string[]
} {
  /** Forward slashes, so a Windows run and a POSIX run index the fixture alike. */
  const normalize = (path: string): string => path.replaceAll('\\', '/')
  const files = new Map(Object.entries(overrides.files ?? {}).map(([key, value]) => [normalize(key), value]))
  const reads: string[] = []
  const base: InspectHostPort = {
    workspace: () => '/repo',
    home: () => '/home/user',
    dataHome: () => '/home/user/.dsh',
    trust: async () => ({ enabled: true, trusted: true, reason: 'trusted-repository', root: '/repo' }),
    // The common composition: no Harness hook bridge mounted, so this reader owns
    // the Claude dialect. A case that mounts one passes its own answer.
    claudeHookDialect: () => 'plugin' as const,
    capabilities: async () => ({ skills: [], mcpServers: [], mcpTools: [] }),
    sandbox: () => ({ denyPatterns: [] }),
    engines: () => ({ deepseek: { available: true } }),
    // The fixture's keys are written with forward slashes, and the plugin builds
    // paths with `path.join`, which is a backslash on Windows. Normalizing here
    // rather than in the plugin keeps the fixture readable and keeps the plugin
    // separator-correct on the platform it runs on.
    readFile: async (target) => {
      reads.push(target)
      return files.get(normalize(target))
    },
    listDir: async (target) => {
      reads.push(`${target}/`)
      const directory = normalize(target)
      return [...files.keys()].filter(key => key.startsWith(`${directory}/`)).map(key => key.slice(directory.length + 1))
    },
    // Defaults that answer "we could not tell": the scan section then reports why
    // rather than an empty scan, and a case that wants a change set supplies one.
    changes: async () => undefined,
    fileSize: async () => undefined,
    repositoryRoot: async () => undefined,
    ...overrides,
  }
  return { port: base, reads }
}

/** Collect one section from the fixture. */
async function section(host: InspectHostPort, id: string) {
  const report = await collectInspectReport(buildInspectCollectors(host), 1_000)
  return report.sections.find(entry => entry.id === id)!
}

describe('the assembled report', () => {
  test('produces every declared section, and only those, from a bare host', async () => {
    const report = await collectInspectReport(buildInspectCollectors(port().port), 1_000)
    // Derived from the declaration rather than counted in a literal: a section
    // added or removed without this file being edited would otherwise leave the
    // suite green while it silently stopped checking the assembler at all.
    expect(report.sections.map(entry => entry.id)).toEqual(INSPECT_SECTIONS.map(section => section.id))
    expect(report.sections).toHaveLength(INSPECT_SECTIONS.length)
    expect(report.unavailable).toEqual([])
  })

  test('the trust section reports the decision and its source root', async () => {
    const trust = await section(port().port, 'trust')
    expect(trust.data).toMatchObject({ enabled: true, trusted: true, reason: 'trusted-repository', root: '/repo' })
  })

  test('the trust section says when the gate is off, so `trusted: true` is not misread', async () => {
    const trust = await section(port({ trust: async () => ({ enabled: false, trusted: true, reason: 'disabled' }) }).port, 'trust')
    expect(String((trust.data as Record<string, unknown>).note)).toContain('disabled in settings')
  })

  test('the trust section survives a workspace that is not a repository', async () => {
    const trust = await section(port({ workspace: () => undefined, trust: async () => ({ enabled: true, trusted: false, reason: 'not-a-repository' }) }).port, 'trust')
    expect(trust.data).toMatchObject({ trusted: false, reason: 'not-a-repository', workspace: null })
  })
})

describe('file-backed sections are gated on trust', () => {
  const files = {
    '/repo/.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }] } }),
    '/repo/AGENTS.md': '# rules that a repository wrote',
    '/repo/.freecodego/personas/reviewer.toml': 'instructions = "review carefully"',
  }

  test('a trusted workspace reads and reports them', async () => {
    const { port: host } = port({ files })
    const hooks = await section(host, 'hooks')
    expect(hooks.data).toMatchObject({ total: 1 })
    // The rules section reports sizes and paths, not text: an inspect report that
    // echoed rule content would be a way to read an arbitrary file through a
    // diagnostics surface.
    const rules = await section(host, 'rules')
    expect(JSON.stringify(rules.data)).toContain('/repo/AGENTS.md')
    expect(JSON.stringify(rules.data)).not.toContain('a repository wrote')
    const personas = await section(host, 'personas')
    expect((personas.data as { count: number }).count).toBe(1)
  })

  test('an untrusted workspace has none of them opened, let alone reported', async () => {
    const { port: host, reads } = port({
      files,
      trust: async () => ({ enabled: true, trusted: false, reason: 'untrusted-repository' }),
    })
    const hooks = await section(host, 'hooks')
    expect(hooks.data).toMatchObject({ total: 0, projectFilesSkipped: true })
    // Not just filtered from the output: never read. The project path is named
    // explicitly, because the user's own home file is read regardless and a
    // substring check would be satisfied by it.
    expect(reads.filter(read => read.startsWith('/repo/'))).toEqual([])

    const rules = await section(host, 'rules')
    expect(JSON.stringify(rules.data)).not.toContain('/repo/AGENTS.md')

    // No refusal is reported here, and that is the correct outcome: the gate runs
    // before the read, so there is no project persona file to refuse. A refusal
    // would mean the file had been opened first.
    const personas = await section(host, 'personas')
    expect(personas.data).toMatchObject({ count: 0, issues: [] })
  })

  test('a disabled gate is not the same as a trusted one', async () => {
    const { port: host } = port({ files, trust: async () => ({ enabled: false, trusted: true, reason: 'disabled' }) })
    const hooks = await section(host, 'hooks')
    expect(hooks.data).toMatchObject({ total: 0, projectFilesSkipped: true })
  })

  test('user-level hook files are read regardless of workspace trust', async () => {
    // The user's own files are not something a repository can write.
    const { port: host } = port({
      files: { '/home/user/.cursor/hooks.json': JSON.stringify({ hooks: { beforeShellExecution: [{ command: 'mine.sh' }] } }) },
      trust: async () => ({ enabled: true, trusted: false, reason: 'untrusted-repository' }),
    })
    const hooks = await section(host, 'hooks')
    expect(hooks.data).toMatchObject({ total: 1 })
    expect((hooks.data as { files: string[] }).files).toEqual(['~/.cursor/hooks.json'])
  })
})

describe('the hooks section merges dialects the way a dispatch would', () => {
  test('reports handler counts and sources per event', async () => {
    const { port: host } = port({
      files: {
        '/repo/.freecodego/hooks.json': JSON.stringify([{ event: 'Stop', command: 'verify.sh' }, { event: 'Stop', command: 'verify.sh' }]),
        '/home/user/.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'global.sh' }] }] } }),
      },
    })
    const hooks = await section(host, 'hooks')
    // The duplicate is one handler with two sources, not two handlers.
    expect(hooks.data).toMatchObject({ total: 2 })
  })

  test('a malformed hook file is reported rather than silently absent', async () => {
    const { port: host } = port({ files: { '/repo/.freecodego/hooks.json': '{ not json' } })
    const hooks = await section(host, 'hooks')
    const warnings = (hooks.data as { warnings: string[] }).warnings
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('the rules section shares the token estimator', () => {
  test('counts a rule file with the plugin-wide estimate', async () => {
    const { port: host } = port({ files: { '/repo/AGENTS.md': 'x'.repeat(400) } })
    const rules = await section(host, 'rules')
    expect(rules.data).toMatchObject({ count: 1, totalTokens: 100 })
  })

  test('reads additional rule documents from the project rules directory', async () => {
    const { port: host } = port({ files: { '/repo/.freecodego/rules/style.md': 'be terse', '/repo/.freecodego/rules/notes.txt': 'ignored' } })
    const rules = await section(host, 'rules')
    expect((rules.data as { entries: { path: string }[] }).entries.map(entry => entry.path)).toEqual(['/repo/.freecodego/rules/style.md'])
  })
})

describe('the MCP and skills sections read the registry, not the disk', () => {
  test('reports configured servers, tools and both failure lists', async () => {
    const { port: host } = port({
      capabilities: async () => ({
        skills: [{ name: 'demo', description: 'd', source: 'project-agents', invocation: 'auto' }],
        mcpServers: [{ id: 'fs', enabled: true, transport: 'stdio' }],
        mcpTools: [{ name: 'mcp__fs__read' }],
        mountErrors: [{ id: 'fs', message: 'spawn failed' }],
        trustRefusals: [{ id: 'other', message: 'folder is not trusted' }],
      }),
    })
    const mcp = await section(host, 'mcp')
    expect(mcp.data).toMatchObject({
      servers: [{ id: 'fs', enabled: true, transport: 'stdio' }],
      tools: ['mcp__fs__read'],
      mountErrors: [{ id: 'fs', message: 'spawn failed' }],
      trustRefusals: [{ id: 'other', message: 'folder is not trusted' }],
    })
    const skills = await section(host, 'skills')
    expect(skills.data).toMatchObject({ count: 1 })
  })

  test('an unnamed skill or server is labelled rather than dropped', async () => {
    const { port: host } = port({
      capabilities: async () => ({ skills: [{ description: 'no name' }], mcpServers: [{}], mcpTools: [] }),
    })
    expect((await section(host, 'skills')).data).toMatchObject({ count: 1 })
    expect((await section(host, 'mcp')).data).toMatchObject({ servers: [{ id: '(unnamed)' }] })
  })
})

describe('the scan section', () => {
  test('says it could not read the change set rather than reporting an empty scan', async () => {
    // "no files" and "we could not tell which files" are the same JSON unless the
    // difference is written down, and only one of them is a reason to relax.
    const scan = await section(port().port, 'scan')
    expect(scan.data).toMatchObject({ available: false, workspace: '/repo' })
    expect(String((scan.data as Record<string, unknown>).reason)).toContain('git')
  })

  test('reports the denominator, and the reason each excluded path left it', async () => {
    const { port: host } = port({
      changes: async () => scopeOf([
        { path: 'src/a.ts', status: 'M ', deleted: false, untracked: false },
        { path: 'packages/app/dist/b.js', status: '??', deleted: false, untracked: true },
      ]),
      fileSize: async () => 100,
    })
    const scan = await section(host, 'scan')
    expect(scan.data).toMatchObject({ available: true, denominator: 1, selected: ['src/a.ts'], excludedCount: 1 })
    expect((scan.data as { readonly excluded: readonly unknown[] }).excluded).toEqual([
      { path: 'packages/app/dist/b.js', exclusion: 'excluded-by-pattern', pattern: '**/dist/**', reason: 'build output' },
    ])
  })

  test('sizes only what it selects, so a deletion is never asked about', async () => {
    const sized: string[] = []
    const { port: host } = port({
      changes: async () => scopeOf([
        { path: 'src/gone.ts', status: 'D ', deleted: true, untracked: false },
        { path: 'src/a.ts', status: 'M ', deleted: false, untracked: false },
      ]),
      fileSize: async (target) => {
        sized.push(target.replaceAll('\\', '/'))
        return 10
      },
    })
    const scan = await section(host, 'scan')
    expect(sized).toEqual(['/repo/src/a.ts'])
    expect(scan.data).toMatchObject({ denominator: 1 })
  })

  test('names a file whose size it could not read instead of counting it as zero', async () => {
    const { port: host } = port({
      changes: async () => scopeOf([{ path: 'src/a.ts', status: 'M ', deleted: false, untracked: false }]),
      fileSize: async () => undefined,
    })
    expect((await section(host, 'scan')).data).toMatchObject({ sizeUnchecked: ['src/a.ts'], selectedBytes: 0 })
  })

  test('prices what it would read through the shared estimator', async () => {
    const { port: host } = port({
      changes: async () => scopeOf([{ path: 'src/a.ts', status: 'M ', deleted: false, untracked: false }]),
      fileSize: async () => 400,
    })
    expect((await section(host, 'scan')).data).toMatchObject({ selectedBytes: 400, selectedTokens: 100 })
  })

  test('resolves a changed path against the repository root, not the session workspace', async () => {
    // git reports changed paths relative to the *repository root*, so a workspace
    // that is a subdirectory of its repository must not be what resolves them.
    // Getting this wrong misses every size, and a missed size is indistinguishable
    // from a size nobody could measure — which is what made it silent: the ceiling
    // stopped applying while the report still looked complete.
    const sized: string[] = []
    const { port: host } = port({
      workspace: () => '/repo/packages/plugin',
      repositoryRoot: async () => '/repo',
      changes: async () => scopeOf([
        { path: 'packages/plugin/src/a.ts', status: 'M ', deleted: false, untracked: false },
      ]),
      fileSize: async (target) => {
        sized.push(target.replaceAll('\\', '/'))
        return 400
      },
    })
    const scan = await section(host, 'scan')
    expect(sized).toEqual(['/repo/packages/plugin/src/a.ts'])
    expect(scan.data).toMatchObject({
      repository: '/repo',
      denominator: 1,
      selectedBytes: 400,
      selectedTokens: 100,
      sizeUnchecked: [],
    })
  })

  test('is not gated on trust, because it reads sizes and names and never content', async () => {
    // The gate exists so a repository cannot author the instructions this process
    // acts on. A byte count is not an instruction, and gating here would remove the
    // one diagnostic that still works on a checkout nobody has trusted.
    const { port: host } = port({
      trust: async () => ({ enabled: true, trusted: false, reason: 'no-record' }),
      changes: async () => scopeOf([{ path: 'src/a.ts', status: 'M ', deleted: false, untracked: false }]),
      fileSize: async () => 10,
    })
    expect((await section(host, 'scan')).data).toMatchObject({ available: true, denominator: 1 })
  })
})

describe('section isolation end to end', () => {
  test('a reader that throws leaves every other section intact', async () => {
    const { port: host } = port({
      capabilities: async () => { throw new Error('registry is unavailable') },
    })
    const report = await collectInspectReport(buildInspectCollectors(host), 1_000)
    expect([...report.unavailable].sort()).toEqual(['mcp', 'skills'])
    // Two of the declared sections read the registry, and both are the ones just
    // asserted unavailable; everything else has to come back `ok`.
    expect(report.sections.filter(entry => entry.status === 'ok')).toHaveLength(INSPECT_SECTIONS.length - 2)
    expect(report.sections.find(entry => entry.id === 'mcp')!.reason).toBe('registry is unavailable')
  })
})
