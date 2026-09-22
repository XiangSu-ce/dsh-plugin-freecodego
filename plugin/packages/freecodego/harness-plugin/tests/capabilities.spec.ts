import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FreeCodeGoCapabilityRegistry, MCP_SECRET_REDACTED } from '../src/capabilities.ts'
import type { FreeCodeGoCapabilitySettings, FreeCodeGoMcpServer, FreeCodeGoSkillRoot } from '../src/types.ts'

function emptySettings(): FreeCodeGoCapabilitySettings {
  return {
    mcpEnabled: false,
    skillEnabled: false,
    voiceInputEnabled: true,
    sessionDeleteEnabled: true,
    modelCategories: {},
    mcpServers: [],
    skillRoots: [],
    skillInvocationOverrides: {},
  }
}

/** The definition `ctx.plugin` receives, as far as this bench asserts on it. */
type MountedPluginDefinition = { readonly name: string }

/** The one member the registry reads off a mounted plugin's returned handle. */
type MountedPluginHandle = { dispose: () => Promise<void> }

function bench(initial: FreeCodeGoCapabilitySettings = emptySettings(), schemas: (agent?: unknown) => readonly unknown[] = () => [], skills?: unknown, projectEntries?: () => Promise<{ readonly mcpServers: readonly FreeCodeGoMcpServer[]; readonly skillRoots: readonly FreeCodeGoSkillRoot[] }>, trust?: (directory: string) => Promise<{ readonly trusted: boolean; readonly reason: string }>, fileSystem?: unknown) {
  let stored = initial
  const dispose = vi.fn(async () => undefined)
  // Declared with the parameters and the handle shape the registry really uses,
  // so an override may inspect the definition and return a plain async dispose
  // instead of a `vi.fn()` that only happened to satisfy the old signature.
  const plugin = vi.fn(async (_definition: MountedPluginDefinition): Promise<MountedPluginHandle> => ({ dispose }))
  const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }))
  const ctx = {
    plugin,
    get: vi.fn((key: string) => key === 'skills' ? skills : key === 'fs' ? fileSystem : undefined),
    tools: { schemas, execute },
  }
  const settings = {
    get: () => stored,
    // The real scope **merges** a patch into the document: plain objects merge recursively,
    // every other value replaces, and `undefined` entries are stripped so a sparse patch
    // cannot erase lower keys. Replacing the whole document here made a *clear* look like it
    // worked while the live harness showed it did not — a fake has to be at least as lossy
    // as the thing it stands in for, or the tests that hang on deletion pass for the wrong
    // reason.
    update: vi.fn(async (patch: FreeCodeGoCapabilitySettings) => {
      const merged: Record<string, unknown> = { ...stored }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        merged[key] = value
      }
      stored = merged as unknown as FreeCodeGoCapabilitySettings
    }),
  }
  const registry = new FreeCodeGoCapabilityRegistry(
    ctx as never,
    settings as never,
    trust as never ?? (async () => ({ trusted: true, reason: 'granted' })),
    projectEntries,
  )
  return { registry, settings, plugin, dispose, execute, read: () => stored }
}

/** One discovered Skill as the shared registry reports it. */
interface SkillFixture {
  readonly name: string
  readonly description?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly path?: string
  readonly content?: string
  /** The provider's own statement about its resources, as `ctx.skills.get()` returns it. */
  readonly resourceBase?: { readonly kind: string; readonly [key: string]: unknown }
}

/**
 * An in-memory filesystem service: a target is its own path, and a child is
 * contained when its path descends from the parent's.
 *
 * It stands in for the composition this seam exists for — the Skill's files are
 * in a filesystem the host process cannot read at all, so a listing that appears
 * can only have come through the service.
 */
function memoryFileSystem(tree: ReadonlyMap<string, readonly { readonly name: string; readonly type: 'file' | 'directory'; readonly text?: string }[]>, escapes: readonly string[] = []): { readonly resolve: (path: string) => Promise<unknown>; readonly listDir: (target: unknown) => Promise<readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly target: unknown; readonly size?: number }[]>; readonly readText: (target: unknown) => Promise<string>; readonly contains: (parent: unknown, child: unknown) => boolean; readonly reads: string[] } {
  const reads: string[] = []
  const pathOf = (target: unknown): string => (target as { path: string }).path
  const texts = new Map<string, string>()
  for (const [directory, entries] of tree) {
    for (const entry of entries) if (entry.text !== undefined) texts.set(resolve(directory, entry.name), entry.text)
  }
  return {
    reads,
    resolve: async (path: string) => ({ path: resolve(path) }),
    listDir: async (target: unknown) => (tree.get(pathOf(target)) ?? []).map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { path: resolve(pathOf(target), entry.name) },
      ...(entry.text === undefined ? {} : { size: Buffer.byteLength(entry.text, 'utf8') }),
    })),
    readText: async (target: unknown) => {
      const path = pathOf(target)
      reads.push(path)
      const text = texts.get(path)
      if (text === undefined) throw new Error(`no such file in this filesystem: ${path}`)
      return text
    },
    contains: (parent: unknown, child: unknown) => !escapes.includes(pathOf(child)) && pathOf(child).startsWith(`${pathOf(parent)}${sep}`),
  }
}

/** A bench whose Skill service answers with the supplied fixtures. */
function skillBench(entries: readonly SkillFixture[], overrides: Partial<FreeCodeGoCapabilitySettings> = {}, fileSystem?: unknown) {
  const definitions = entries.map(entry => ({
    name: entry.name,
    description: entry.description ?? `${entry.name} description`,
    source: 'custom',
    provider: 'test',
    content: entry.content ?? `# ${entry.name}`,
    ...entry.path === undefined ? {} : { path: entry.path },
    ...entry.resourceBase === undefined ? {} : { resourceBase: entry.resourceBase },
    invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
  }))
  const service = {
    snapshot: vi.fn(async () => ({ skills: definitions })),
    get: vi.fn(async (name: string) => definitions.find(definition => definition.name === name)),
  }
  const b = bench({ ...emptySettings(), skillEnabled: true, ...overrides }, () => [], service, undefined, undefined, fileSystem)
  return { ...b, service }
}

describe('FreeCodeGoCapabilityRegistry Skill roots', () => {
  it('persists one manual model category override and removes it when auto classification is restored', async () => {
    const b = bench()
    const key = 'freecodego\u0000image-route'

    await b.registry.setModelCategory({ key, category: 'text' })
    expect(b.read().modelCategories).toEqual({ [key]: 'text' })

    await b.registry.setModelCategory({ key })
    expect(b.read().modelCategories).toEqual({})
    await b.registry.dispose()
  })

  it('rejects malformed manual model category keys and values', async () => {
    const b = bench()

    await expect(b.registry.setModelCategory({ key: 'missing-separator', category: 'image' })).rejects.toThrow(/key is invalid/)
    await expect(b.registry.setModelCategory({ key: 'freecodego\u0000image-route', category: 'invalid' as never })).rejects.toThrow(/category is invalid/)
    await b.registry.dispose()
  })

  it('publishes every Agent-scoped plugin tool to native runtimes', () => {
    const agent = { id: 'native-parent' }
    const schemas = vi.fn((scope?: unknown) => scope === agent
      ? [
        { name: 'subagent', description: 'delegate', parameters: {} },
        { name: 'list_subagent_models', description: 'discover', parameters: {} },
        { name: 'advisor_status', description: 'advisor status', parameters: {} },
        { name: 'advisor_review', description: 'advisor review', parameters: {} },
        { name: 'advisor_notes', description: 'advisor notes', parameters: {} },
        { name: 'canvas_render', description: 'render a third-party canvas', parameters: {} },
        { name: 'mcp__filesystem', description: 'separate MCP bridge', parameters: {} },
        { name: 'skill', description: 'separate Skill bridge', parameters: {} },
      ]
      : [])
    const b = bench(emptySettings(), schemas)

    expect(b.registry.nativeConfiguration(agent as never).harnessTools.map(tool => tool.name)).toEqual([
      'subagent',
      'list_subagent_models',
      'advisor_status',
      'advisor_review',
      'advisor_notes',
      'canvas_render',
      'mcp__filesystem',
      'skill',
    ])
    expect(schemas).toHaveBeenCalledWith(agent)
  })

  it('executes a third-party plugin tool against the same Agent-scoped schema used for projection', async () => {
    const agent = { id: 'native-parent' }
    const schemas = vi.fn((scope?: unknown) => scope === agent
      ? [{ name: 'canvas_render', description: 'render a canvas', parameters: {} }]
      : [])
    const b = bench(emptySettings(), schemas)

    await expect(b.registry.executeHarnessTool(agent as never, 'canvas_render', {}, new AbortController().signal)).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    expect(b.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'canvas_render', agent }))
  })

  it('does not expose or execute a plugin tool hidden from the calling Agent scope', async () => {
    const agent = { id: 'restricted-native-parent' }
    const schemas = vi.fn((scope?: unknown) => scope === agent
      ? [{ name: 'canvas_read', description: 'allowed canvas reader', parameters: {} }]
      : [{ name: 'canvas_admin', description: 'host-only canvas administration', parameters: {} }])
    const b = bench(emptySettings(), schemas)

    expect(b.registry.nativeConfiguration(agent as never).harnessTools.map(tool => tool.name)).toEqual(['canvas_read'])
    await expect(b.registry.executeHarnessTool(agent as never, 'canvas_admin', {}, new AbortController().signal)).rejects.toThrow('not available to this native Agent')
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('atomically enables and mounts the managed community Skill root', async () => {
    const b = bench()
    const directory = resolve('community-skills')

    const snapshot = await b.registry.enableManagedSkillRoot('freecodego-community', directory)

    expect(b.settings.update).toHaveBeenCalledOnce()
    expect(snapshot.skillEnabled).toBe(true)
    expect(snapshot.skillRoots).toEqual([{ id: 'freecodego-community', enabled: true, path: directory }])
    expect(b.plugin).toHaveBeenCalledWith(expect.objectContaining({ name: 'freecodego-skill-roots' }), {
      providerName: 'freecodego-configured',
      includeDefaultRoots: false,
      customSkillDirs: [directory],
    })

    await b.registry.dispose()
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('replaces a disabled duplicate path instead of adding a second provider root', async () => {
    const directory = resolve('community-skills')
    const b = bench({
      ...emptySettings(),
      skillRoots: [{ id: 'old-community-root', enabled: false, path: directory }],
    })

    await b.registry.enableManagedSkillRoot('freecodego-community', directory)

    expect(b.read().skillRoots).toEqual([{ id: 'freecodego-community', enabled: true, path: directory }])
    await b.registry.dispose()
  })

  it('rejects relative and duplicate manually configured Skill roots', async () => {
    const directory = resolve('existing-skills')
    const b = bench({
      ...emptySettings(),
      skillRoots: [{ id: 'existing', enabled: true, path: directory }],
    })

    await expect(b.registry.saveSkillRoot({ enabled: true, path: 'relative-skills' })).rejects.toThrow(/absolute/)
    await expect(b.registry.saveSkillRoot({ enabled: true, path: directory })).rejects.toThrow(/already configured/)
  })

  it('treats a case-only Skill root change as a change only where the filesystem does', async () => {
    // `/Skills` and `/skills` are the same directory on Windows and different
    // ones on POSIX. A comparison key that always case-folds made the POSIX
    // change look like a no-op, so the new root was saved but never mounted.
    const directory = resolve('Case-Skills')
    const b = bench({
      ...emptySettings(),
      skillEnabled: true,
      skillRoots: [{ id: 'root', enabled: true, path: directory }],
    })

    await b.registry.saveSkillRoot({ id: 'root', enabled: true, path: directory })
    const mountsBefore = b.plugin.mock.calls.length
    await b.registry.saveSkillRoot({ id: 'root', enabled: true, path: directory.toLowerCase() })

    if (process.platform === 'win32') {
      // Windows folds case, so this is the same directory: no remount is correct.
      expect(b.plugin.mock.calls.length).toBe(mountsBefore)
    } else {
      expect(b.plugin.mock.calls.length).toBeGreaterThan(mountsBefore)
    }
    await b.registry.dispose()
  })

  it('redacts MCP env and headers from browser snapshots and keeps them out of native capability snapshots', async () => {
    const b = bench({
      ...emptySettings(),
      mcpEnabled: true,
      mcpServers: [{ id: 'private-mcp', enabled: true, transport: 'streamable-http', serverName: 'private', command: '', args: [], env: { API_KEY: 'top-secret' }, cwd: '', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer top-secret' } }],
    })
    const snapshot = await b.registry.snapshot()
    expect(snapshot.mcpServers[0]).toMatchObject({ env: { API_KEY: MCP_SECRET_REDACTED }, headers: { Authorization: MCP_SECRET_REDACTED } })
    expect(b.registry.nativeConfiguration()).not.toHaveProperty('mcpServers')
    await b.registry.dispose()
  })

  it('preserves redacted MCP values only for an update of the same configured server', async () => {
    const b = bench({
      ...emptySettings(),
      mcpEnabled: true,
      mcpServers: [{ id: 'private-mcp', enabled: true, transport: 'streamable-http', serverName: 'private', command: '', args: [], env: { API_KEY: 'top-secret' }, cwd: '', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer top-secret' } }],
    })
    await b.registry.saveMcpServer({ id: 'private-mcp', enabled: true, transport: 'streamable-http', serverName: 'private', command: '', args: [], env: { API_KEY: MCP_SECRET_REDACTED }, cwd: '', url: 'https://mcp.example.test', headers: { Authorization: MCP_SECRET_REDACTED } })
    expect(b.registry.nativeConfiguration()).not.toHaveProperty('mcpServers')
    await expect(b.registry.saveMcpServer({ enabled: true, transport: 'stdio', serverName: 'new', command: 'node', args: [], env: { API_KEY: MCP_SECRET_REDACTED }, cwd: '', url: '', headers: {} })).rejects.toThrow(/must be entered/)
    await b.registry.dispose()
  })

  it('keeps mounting later MCP servers when one fails and reports the failure in the snapshot', async () => {
    const settings = {
      ...emptySettings(),
      mcpEnabled: true,
      mcpServers: [
        { id: 'broken-mcp', enabled: true, transport: 'stdio' as const, serverName: 'broken', command: 'missing-binary', args: [], env: {}, cwd: '', url: '', headers: {} },
        { id: 'healthy-mcp', enabled: true, transport: 'streamable-http' as const, serverName: 'healthy', command: '', args: [], env: {}, cwd: '', url: 'https://mcp.example.test', headers: {} },
      ],
    }
    const b = bench(settings)
    b.plugin.mockImplementation(async (definition: { name: string }) => {
      if (definition.name === 'freecodego-mcp-broken') throw new Error('spawn missing-binary failed')
      return { dispose: async () => undefined }
    })
    await b.registry.setEnabled({})
    await vi.waitFor(() => { expect(b.plugin).toHaveBeenCalledTimes(2) })

    const snapshot = await b.registry.snapshot()

    expect(b.plugin).toHaveBeenCalledWith(expect.objectContaining({ name: 'freecodego-mcp-healthy' }), expect.anything())
    expect(snapshot.mountErrors).toEqual([{ id: 'broken-mcp', message: 'spawn missing-binary failed' }])

    b.plugin.mockImplementation(async () => ({ dispose: async () => undefined }))
    await b.registry.setEnabled({ mcpEnabled: true })
    await vi.waitFor(() => { expect(b.plugin).toHaveBeenCalledTimes(4) })
    expect((await b.registry.snapshot()).mountErrors).toBeUndefined()
    await b.registry.dispose()
  })

  it('lists the Skills only a human may invoke while the model-facing catalog keeps filtering them', async () => {
    const b = skillBench([
      { name: 'code-review', modelInvocable: true, userInvocable: true },
      { name: 'ask-matt', modelInvocable: false, userInvocable: true },
    ])

    // `disable-model-invocation` narrows the model's reach, not the user's: the
    // Claude bridge `skill/list` and the subagent projection must still honor it.
    expect((await b.registry.listSkills()).map(skill => skill.name)).toEqual(['code-review'])
    expect(await b.registry.listSkillInventory()).toEqual([
      { name: 'code-review', description: 'code-review description', source: 'custom', modelInvocable: true, userInvocable: true },
      { name: 'ask-matt', description: 'ask-matt description', source: 'custom', modelInvocable: false, userInvocable: true },
    ])
    expect((await b.registry.snapshot()).skills.map(skill => skill.name)).toEqual(['code-review', 'ask-matt'])

    await b.registry.dispose()
  })

  it('reads a virtual Skill\'s companion files from the base its provider declared', async () => {
    // `dsh-badge` is the case this exists for: a bundled Skill whose provider
    // declares a resource directory and reports **no** `SKILL.md` path. Deriving
    // the directory from the path read every asset it advertises as absent.
    const assets = await mkdtemp(join(tmpdir(), 'freecodego-skill-assets-'))
    try {
      await writeFile(join(assets, 'badge.svg'), '<svg/>')
      await writeFile(join(assets, 'badge.json'), '{}')
      const b = skillBench([
        { name: 'dsh-badge', modelInvocable: true, userInvocable: true, content: '# dsh-badge', resourceBase: { kind: 'directory', path: assets } },
      ])

      const detail = await b.registry.readSkill('dsh-badge')
      expect(detail.files).toEqual([{ path: 'badge.json', bytes: 2 }, { path: 'badge.svg', bytes: 6 }])
      await expect(b.registry.readSkill('dsh-badge', 'badge.svg')).resolves
        .toMatchObject({ file: { path: 'badge.svg', bytes: 6, content: '<svg/>' } })

      await b.registry.dispose()
    } finally {
      await rm(assets, { recursive: true, force: true })
    }
  })

  it('lists and reads a Skill through the Harness filesystem seam when the host cannot reach it', async () => {
    // The whole point of the seam: this directory does not exist in the host
    // process at all, so anything the dialog shows came through the service — the
    // same one that delivered the Skill body the model sees.
    const root = join(tmpdir(), 'freecodego-sandbox-skill')
    const fileSystem = memoryFileSystem(new Map([
      [root, [{ name: 'agents', type: 'directory' as const }, { name: 'DESIGN.md', type: 'file' as const, text: 'twice' }]],
      [join(root, 'agents'), [{ name: 'brief.md', type: 'file' as const, text: 'brief' }]],
    ]))
    const b = skillBench([
      { name: 'sandboxed', modelInvocable: true, userInvocable: true, resourceBase: { kind: 'directory', path: root } },
    ], {}, fileSystem)

    const detail = await b.registry.readSkill('sandboxed')
    expect(detail.files).toEqual([{ path: 'agents/brief.md', bytes: 5 }, { path: 'DESIGN.md', bytes: 5 }])
    await expect(b.registry.readSkill('sandboxed', 'agents/brief.md')).resolves
      .toMatchObject({ file: { path: 'agents/brief.md', bytes: 5, content: 'brief' } })
    expect(fileSystem.reads).toEqual([resolve(root, 'agents', 'brief.md')])

    await b.registry.dispose()
  })

  it('asks the backend whether a listed file is inside the Skill directory', async () => {
    const root = join(tmpdir(), 'freecodego-sandbox-escape')
    const link = resolve(root, 'link.md')
    // The listing carries `link.md`; the backend says that target is not inside
    // the Skill directory. Only the containment answer can refuse it, which is
    // the rule the host-filesystem path enforces with its symlink check.
    const fileSystem = memoryFileSystem(new Map([
      [root, [{ name: 'notes.md', type: 'file' as const, text: 'ordinary notes' }, { name: 'link.md', type: 'file' as const, text: 'PRIVATE KEY MATERIAL' }]],
    ]), [link])
    const b = skillBench([
      { name: 'escaping', modelInvocable: true, userInvocable: true, resourceBase: { kind: 'directory', path: root } },
    ], {}, fileSystem)

    expect((await b.registry.readSkill('escaping')).files.map(file => file.path)).toEqual(['link.md', 'notes.md'])
    await expect(b.registry.readSkill('escaping', 'link.md')).rejects.toThrow(/resolves outside this Skill directory/)
    await expect(b.registry.readSkill('escaping', 'notes.md')).resolves.toMatchObject({ file: { content: 'ordinary notes' } })

    await b.registry.dispose()
  })

  it('names the reason a Skill\'s resources cannot be listed instead of reading the local disk', async () => {
    const b = skillBench([
      { name: 'remote-skill', modelInvocable: true, userInvocable: true, resourceBase: { kind: 'url', url: 'https://skills.example.test/remote/' } },
      { name: 'opaque-skill', modelInvocable: true, userInvocable: true, resourceBase: { kind: 'opaque', description: 'the provider resolves these itself' } },
      { name: 'future-skill', modelInvocable: true, userInvocable: true, resourceBase: { kind: 'git-tree', ref: 'HEAD' } },
    ])

    expect((await b.registry.readSkill('remote-skill')).files).toEqual([])
    await expect(b.registry.readSkill('remote-skill', 'badge.svg')).rejects.toThrow(/served from https:\/\/skills\.example\.test\/remote\//)
    await expect(b.registry.readSkill('opaque-skill', 'badge.svg')).rejects.toThrow(/the provider resolves these itself/)
    // A base this build does not know is refused rather than downgraded to the
    // SKILL.md directory, which would be a different Skill's files at worst.
    await expect(b.registry.readSkill('future-skill', 'badge.svg')).rejects.toThrow(/"git-tree" resource base/)

    await b.registry.dispose()
  })

  it('reads a Skill body with its companion files, including the entries the model cannot invoke', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-skill-read-'))
    try {
      await writeFile(join(directory, 'SKILL.md'), '# body')
      await writeFile(join(directory, 'DESIGN-IT-TWICE.md'), 'design twice')
      const b = skillBench([
        { name: 'codebase-design', modelInvocable: true, userInvocable: true, path: join(directory, 'SKILL.md'), content: '# codebase-design' },
        { name: 'ask-matt', modelInvocable: false, userInvocable: true, path: join(directory, 'SKILL.md'), content: '# ask-matt' },
      ])

      const detail = await b.registry.readSkill('codebase-design')
      expect(detail).toMatchObject({ name: 'codebase-design', content: '# codebase-design', modelInvocable: true })
      expect(detail.files).toEqual([{ path: 'DESIGN-IT-TWICE.md', bytes: 12 }])

      const file = await b.registry.readSkill('codebase-design', 'DESIGN-IT-TWICE.md')
      expect(file.file).toEqual({ path: 'DESIGN-IT-TWICE.md', bytes: 12, content: 'design twice' })

      // The dialog exists for exactly these rows: nothing else in the UI
      // describes a Skill the model will never advertise.
      await expect(b.registry.readSkill('ask-matt')).resolves.toMatchObject({ content: '# ask-matt', modelInvocable: false, userInvocable: true })
      await expect(b.registry.loadSkill('ask-matt')).rejects.toThrow(/not available/)
      await expect(b.registry.readSkill('missing-skill')).rejects.toThrow(/not available/)
      await expect(b.registry.readSkill('codebase-design', 'SKILL.md')).rejects.toThrow(/not a file in this Skill directory/)

      await b.registry.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shows what a thin alias Skill actually forwards to, and nothing for a real body', async () => {
    const b = skillBench([
      { name: 'grill-me', modelInvocable: false, userInvocable: true, content: 'Call the Skill tool with "grilling".' },
      { name: 'grill-with-docs', modelInvocable: false, userInvocable: true, content: 'Call the Skill tool twice, for "grilling" and "domain-modeling".' },
      { name: 'grilling', modelInvocable: true, userInvocable: true, content: '# the interview' },
      { name: 'domain-modeling', modelInvocable: true, userInvocable: true, content: '# the glossary' },
      { name: 'code-review', modelInvocable: true, userInvocable: true, content: 'Review the diff on both axes.' },
      // A body that opens with the alias phrase but keeps working afterwards is
      // the Skill's own prose, so nothing may be printed under it.
      { name: 'improve-codebase-architecture', modelInvocable: false, userInvocable: true, content: 'Call the Skill tool to load a plan first.\n\nThen scan the codebase.' },
    ])

    expect((await b.registry.readSkill('grill-me')).forwarded).toEqual([
      { name: 'grilling', description: 'grilling description', content: '# the interview' },
    ])
    expect((await b.registry.readSkill('grill-with-docs')).forwarded.map(target => target.name)).toEqual(['grilling', 'domain-modeling'])
    expect((await b.registry.readSkill('code-review')).forwarded).toEqual([])
    expect((await b.registry.readSkill('improve-codebase-architecture')).forwarded).toEqual([])
    // A companion read carries no forwards: the caller asked for that file.
    expect((await b.registry.readSkill('grilling')).forwarded).toEqual([])

    await b.registry.dispose()
  })

  it('drops a forward whose target is unknown instead of failing the read', async () => {
    const b = skillBench([
      { name: 'grill-me', modelInvocable: false, userInvocable: true, content: 'Call the Skill tool with "grilling".' },
      { name: 'self-ref', modelInvocable: false, userInvocable: true, content: 'Call the Skill tool with "self-ref".' },
    ])

    // The alias is readable, so a target that cannot be resolved shows less
    // rather than refusing to open the dialog at all.
    await expect(b.registry.readSkill('grill-me')).resolves.toMatchObject({ content: 'Call the Skill tool with "grilling".', forwarded: [] })
    expect((await b.registry.readSkill('self-ref')).forwarded).toEqual([])

    await b.registry.dispose()
  })

  it('persists one Skill invocation override, resolves it on every model-facing surface, and clears it', async () => {
    const b = skillBench([
      { name: 'grill-me', modelInvocable: false, userInvocable: true },
    ])

    // The Skill file says manual-only, so nothing model-facing offers it.
    expect((await b.registry.listSkills()).map(skill => skill.name)).toEqual([])
    expect((await b.registry.snapshot()).skills).toEqual([
      { name: 'grill-me', description: 'grill-me description', source: 'custom', modelInvocable: false, userInvocable: true },
    ])
    expect(b.registry.skillInvocationLocked('grill-me')).toBe(false)

    await b.registry.setSkillInvocation({ name: 'grill-me', modelInvocable: true })

    expect(b.read().skillInvocationOverrides).toEqual({ 'grill-me': true })
    // Harness 0.1.6 resolves `modelInvocable` inside the shared Skill registry,
    // which has no override seam, so the answer has to be applied by this Host's
    // own resolution surfaces instead — the model-facing catalog, the loader,
    // the settings inventory, and the root `skill` tool guard all agree.
    expect((await b.registry.listSkills()).map(skill => skill.name)).toEqual(['grill-me'])
    await expect(b.registry.loadSkill('grill-me')).resolves.toMatchObject({ name: 'grill-me' })
    expect((await b.registry.listSkillInventory())[0]).toMatchObject({ name: 'grill-me', modelInvocable: true, userInvocable: true })
    expect(b.registry.skillInvocationLocked('grill-me')).toBe(false)

    // The stored answer works in the other direction too: it can take a Skill
    // the file hands to the model and put it back behind the user's hand.
    await b.registry.setSkillInvocation({ name: 'grill-me', modelInvocable: false })
    expect((await b.registry.listSkills()).map(skill => skill.name)).toEqual([])
    await expect(b.registry.loadSkill('grill-me')).rejects.toThrow(/not available/)
    expect(b.registry.skillInvocationLocked('grill-me')).toBe(true)

    // Deleting the key is the only way back to whatever the Skill file says.
    await b.registry.setSkillInvocation({ name: 'grill-me' })
    expect(b.read().skillInvocationOverrides).toEqual({})
    expect((await b.registry.listSkills()).map(skill => skill.name)).toEqual([])
    expect(b.registry.skillInvocationLocked('grill-me')).toBe(false)

    await b.registry.dispose()
  })

  it('rejects an invocation override that is not a Skill name or not a boolean', async () => {
    const b = skillBench([])

    await expect(b.registry.setSkillInvocation({ name: 'Not A Name', modelInvocable: true })).rejects.toThrow(/name is invalid/)
    await expect(b.registry.setSkillInvocation({ name: 'grill-me', modelInvocable: 'yes' as never })).rejects.toThrow(/must be a boolean/)
    expect(b.read().skillInvocationOverrides).toEqual({})

    await b.registry.dispose()
  })

  it('refuses a Skill read when the Skill family is switched off', async () => {
    const b = skillBench([{ name: 'ask-matt', modelInvocable: false, userInvocable: true }], { skillEnabled: false })

    await expect(b.registry.listSkillInventory()).resolves.toEqual([])
    await expect(b.registry.readSkill('ask-matt')).rejects.toThrow(/disabled/)

    await b.registry.dispose()
  })
})

/**
 * The repository's own entries, mounted beside the user's.
 *
 * `project-tier.ts` parses them and `index.ts` reads them; what these cases pin is
 * the half in between — that a project entry reaches the *same* mount calls a
 * user-declared one does, and that it is judged by the *same* gate. A tier whose
 * entries were parsed and never handed to `ctx.plugin` is the defect this whole
 * change exists for, and it looked exactly like a working tier from the settings
 * surface.
 */
describe('FreeCodeGoCapabilityRegistry project entries', () => {
  const projectServer: FreeCodeGoMcpServer = {
    id: 'project:staging',
    enabled: true,
    transport: 'stdio',
    serverName: 'staging',
    command: 'node',
    args: ['serve.js'],
    env: {},
    cwd: '',
    url: '',
    headers: {},
  }
  const projectRoot: FreeCodeGoSkillRoot = { id: 'project:repo', enabled: true, path: '/work/repo/.claude/skills' }
  const bothOn = { ...emptySettings(), mcpEnabled: true, skillEnabled: true }

  const mountedNames = (plugin: ReturnType<typeof bench>['plugin']): string[] =>
    plugin.mock.calls.map(call => (call[0] as unknown as { readonly name: string }).name)

  it('mounts a repository’s server and Skill root through the user’s own path', async () => {
    const b = bench(bothOn, () => [], undefined, async () => ({ mcpServers: [projectServer], skillRoots: [projectRoot] }))

    await b.registry.remount()

    const names = mountedNames(b.plugin)
    expect(names).toContain('freecodego-mcp-staging')
    expect(names).toContain('freecodego-skill-roots')
    // The Skill mount carries the repository's resolved directory, so the proof is
    // about the entry that was read rather than about a mount that happened.
    const calls = b.plugin.mock.calls as unknown as readonly (readonly [unknown, unknown] | undefined)[]
    const skillCall = calls.find(call => (call?.[0] as { readonly name: string } | undefined)?.name === 'freecodego-skill-roots')
    expect((skillCall?.[1] as unknown as { readonly customSkillDirs: readonly string[] } | undefined)?.customSkillDirs).toEqual([projectRoot.path])
    // …and the server mount carries the server, not a placeholder.
    const serverCall = calls.find(call => (call?.[0] as { readonly name: string } | undefined)?.name === 'freecodego-mcp-staging')
    expect(serverCall?.[1]).toMatchObject({ transport: 'stdio', serverName: 'staging', command: 'node', args: ['serve.js'] })

    await b.registry.dispose()
  })

  it('judges a project entry with the same gate as the user’s, and names it as a project entry', async () => {
    const b = bench(
      bothOn,
      () => [],
      undefined,
      // A pinned `cwd` is what makes a server the gate's business (the same rule
      // the user's own servers follow), and a Skill root always is.
      async () => ({ mcpServers: [{ ...projectServer, cwd: '/work/repo/staging' }], skillRoots: [projectRoot] }),
      async () => ({ trusted: false, reason: 'no-record' }),
    )

    await b.registry.remount()

    const refused = (await b.registry.snapshot()).trustRefusals?.map(entry => entry.id) ?? []
    expect(refused).toContain('mcp:project:staging')
    expect(refused).toContain('skill:project:repo')
    expect(mountedNames(b.plugin)).not.toContain('freecodego-mcp-staging')

    await b.registry.dispose()
  })

  it('mounts nothing from a repository while the user’s own master switch is off', async () => {
    const b = bench(emptySettings(), () => [], undefined, async () => ({ mcpServers: [projectServer], skillRoots: [projectRoot] }))

    await b.registry.remount()

    // `mcpEnabled` / `skillEnabled` are the user's answer about their machine, and
    // a repository's file is not a way around it.
    expect(mountedNames(b.plugin)).toEqual([])

    await b.registry.dispose()
  })
})

/**
 * The remembered Skill destination, which is a preference and not a mount.
 *
 * Two claims are worth a gate here. First, what gets stored is the *choice* — two
 * axes — rather than the directory they resolve to, because that directory is derived
 * from the workspace, `$DSH_HOME` and the home directory, and a saved path would
 * outlive all three. Second, remembering a destination must not remount anything: it
 * changes where a future install lands, not which providers this process holds, and a
 * write that quietly remounted the Skill fiber would tear down in-flight tool calls to
 * change a dropdown.
 */
describe('FreeCodeGoCapabilityRegistry Skill destination preference', () => {
  it('stores the two axes, and reports them in the snapshot', async () => {
    const b = bench()

    await b.registry.setPreferredSkillPlacement({ agent: 'harness', scope: 'user' })

    expect(b.read().preferredSkillPlacement).toEqual({ agent: 'harness', scope: 'user' })
    expect((await b.registry.snapshot()).preferredSkillPlacement).toEqual({ agent: 'harness', scope: 'user' })
    // Nothing was mounted: a destination is not a root that already exists.
    expect(b.plugin).not.toHaveBeenCalled()
    await b.registry.dispose()
  })

  it('remembers a path-free choice, which is the whole point of storing axes', async () => {
    const b = bench()

    await b.registry.setPreferredSkillPlacement({ agent: 'agents', scope: 'project' })

    const stored = b.read().preferredSkillPlacement
    expect(Object.keys(stored ?? {}).sort()).toEqual(['agent', 'scope'])
    // The member that would have carried a directory is absent. A stored root would
    // name a folder this process happened to be in when the user clicked.
    expect(JSON.stringify(stored)).not.toContain('/')
  })

  it('clears a stored preference by writing a value, because a settings write merges', async () => {
    const b = bench()
    await b.registry.setPreferredSkillPlacement({ agent: 'harness', scope: 'project' })

    await b.registry.setPreferredSkillPlacement({})

    // The document carries the explicit `null`, not an absent key. This is the assertion
    // the live harness earned: `update` merges, so a patch that simply left the field out
    // would keep the old destination, and the user asking for the default back would still
    // be installing into their last choice.
    expect(b.read().preferredSkillPlacement).toBeNull()
    // Above that line, though, "no preference" is one fact: the snapshot a client reads
    // reports the same absence it reports for a field that was never written.
    expect((await b.registry.snapshot()).preferredSkillPlacement).toBeUndefined()
    expect(b.registry.configuration().preferredSkillPlacement).toBeUndefined()
    await b.registry.dispose()
  })

  it('refuses half a placement instead of guessing the other half', async () => {
    const b = bench()

    await expect(b.registry.setPreferredSkillPlacement({ agent: 'harness' })).rejects.toThrow(/both axes/u)
    await expect(b.registry.setPreferredSkillPlacement({ scope: 'user' })).rejects.toThrow(/both axes/u)

    expect(b.read().preferredSkillPlacement).toBeUndefined()
    await b.registry.dispose()
  })

  it('refuses an agent or scope the matrix does not know', async () => {
    const b = bench()

    // The declared input type already refuses both of these — a TypeScript caller cannot
    // write them — and the checks above still exist because the remote boundary is untyped
    // at runtime: the browser reaches this method by string name with whatever the payload
    // carries, and the settings document can be edited by hand.
    await expect(b.registry.setPreferredSkillPlacement({ agent: 'custom', scope: 'user' } as never)).rejects.toThrow(/Skill placement agent/u)
    await expect(b.registry.setPreferredSkillPlacement({ agent: 'harness', scope: 'machine' } as never)).rejects.toThrow(/Skill placement scope/u)

    await b.registry.dispose()
  })

  it('refuses a record written by something that disagreed about the vocabulary', async () => {
    // The settings file is editable by hand and readable by an older build. A spelling
    // this table does not know would sit there looking like an applied preference while
    // every install ignored it, so the write path refuses it rather than persisting it.
    const b = bench({ ...emptySettings(), preferredSkillPlacement: { agent: 'codex', scope: 'user' } as never })

    await expect(b.registry.setEnabled({ skillEnabled: true })).rejects.toThrow(/Skill placement agent/u)

    await b.registry.dispose()
  })
})
