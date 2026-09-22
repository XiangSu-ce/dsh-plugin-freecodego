// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityPluginsPage } from '../src/client/community-plugins.tsx'
import { README_FETCH_TIMEOUT_MS } from '../src/client/plugin-readme.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CommunityPluginsPage installed plugin actions', () => {
  it('detects an installed community package and offers uninstall', async () => {
    const url = 'https://github.com/example/community-plugin'
    const communityUninstall = vi.fn().mockResolvedValue({ ok: true as const, value: { ok: true as const, packageNames: ['@example/community-plugin'], restartRequired: true as const } })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'community-plugin', owner: 'example', url, category: 'tools', npm: '@example/community-plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: { '@example/community-plugin': '1.0.0' }, activation: { '@example/community-plugin': { state: 'live' } }, sources: { [url]: ['@example/community-plugin'] }, restartRequired: false } })}
      communityInstall={vi.fn()}
      communityUninstall={communityUninstall}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)

    const installedEntry = await screen.findByRole('button', { name: '已安装插件 (1)' })
    fireEvent.click(installedEntry)
    expect(screen.getByRole('button', { name: '返回社区' })).toBeTruthy()
    expect(screen.getByText('管理已通过社区页加入当前 Profile 的插件，可在此直接卸载。')).toBeTruthy()
    const uninstall = screen.getByRole('button', { name: '卸载' })
    fireEvent.click(uninstall)
    await waitFor(() => { expect(communityUninstall).toHaveBeenCalledWith(url) })
  })

  it('moves focus into community details and restores it after Escape closes the dialog', async () => {
    const url = 'https://example.test/community-plugin'
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'community-plugin', owner: 'example', url, category: 'tools', npm: '@example/community-plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)

    const card = await screen.findByRole('button', { name: /community-plugin/ })
    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog', { name: 'community-plugin' })
    const close = screen.getByRole('button', { name: '关闭' })
    await waitFor(() => { expect(document.activeElement).toBe(close) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(card)
    expect(dialog).toBeTruthy()
  })

  it('uses English marketplace content when both localized plugin descriptions are available', async () => {
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'community-plugin', owner: 'example', url: 'https://example.test/community-plugin', category: 'developer tools', description: { zh: '中文描述不应出现在英文页面', en: 'English plugin description' }, npm: '@example/community-plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="en"
    />)

    await screen.findByText('Popular community plugins')
    expect(screen.getByText('English plugin description')).toBeTruthy()
    expect(screen.queryByText('中文描述不应出现在英文页面')).toBeNull()
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('uses catalog artwork and falls back to the repository owner avatar', async () => {
    const { container } = render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [
        { name: 'brand-plugin', owner: 'example', url: 'https://example.test/brand-plugin', category: 'ui', iconUrl: 'https://cdn.example.test/brand-plugin.svg' },
        { name: 'durable-memory', owner: 'example', url: 'https://example.test/durable-memory', category: 'memory & knowledge' },
      ] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="en"
    />)

    await screen.findByText('brand-plugin')
    const catalogIcon = container.querySelector<HTMLImageElement>('img[data-fcg-plugin-icon="catalog"]')
    expect(catalogIcon?.getAttribute('src')).toBe('https://cdn.example.test/brand-plugin.svg')
    expect(container.querySelector<HTMLImageElement>('[data-fcg-plugin-icon="author"]')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/example?size=96')

    fireEvent.error(catalogIcon!)
    await waitFor(() => { expect(container.querySelector('img[data-fcg-plugin-icon="catalog"]')).toBeNull() })
    expect(container.querySelector<HTMLImageElement>('[data-fcg-plugin-icon="author"]')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/example?size=96')
  })

  it('opens an in-plugin dialog for a marketplace entry instead of a browser tab', async () => {
    const item = {
      id: 'skill:example',
      kind: 'skill' as const,
      title: 'example-skill',
      description: 'Upstream skills.sh description',
      category: 'developer tools',
      sourceUrl: 'https://github.com/example/skill',
      author: 'example',
      popularity: 12,
      installed: false,
      installable: true,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => '' }))
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [item] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    // The card's affordance is a button that opens the dialog, never an anchor
    // that leaves the plugin for a browser tab.
    expect(screen.queryByRole('link', { name: '详情' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog', { name: 'example-skill' })
    expect(dialog.textContent).toContain('Upstream skills.sh description')
    expect(screen.getByRole('link', { name: '在浏览器打开' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('reports a failed directory install as that, not as the marketplace being down', async () => {
    const item = {
      id: 'example-mcp',
      kind: 'mcp' as const,
      title: 'example-mcp',
      description: 'An MCP server',
      category: 'tools',
      sourceUrl: 'https://github.com/example/mcp',
      author: 'example',
      popularity: 3,
      installed: false,
      installable: true,
    }
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'mcp', total: 1, offset: 0, limit: 24, categories: [], items: [item] } })}
      mcpPresetInstall={vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'preset needs a token' } })}
      skillPresetInstall={vi.fn()}
      language="en"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'MCP' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const alert = await screen.findByRole('alert')
    // The directory answered and the install then failed: the banner must not
    // blame a marketplace that is demonstrably up.
    expect(alert.textContent).toContain('preset needs a token')
    expect(alert.textContent).not.toContain('marketplace is unavailable')
  })

  const installableSkill = {
    id: 'skill:example/example-skill',
    kind: 'skill' as const,
    title: 'example-skill',
    description: 'example',
    category: 'developer tools',
    sourceUrl: 'https://skills.sh/example/example-skill',
    author: 'example',
    popularity: 1,
    installed: false,
    installable: true,
  }

  it('reports the version a Skill install pinned, read from the record it returned', async () => {
    // A page that marked the entry "added" without reading this would look the
    // same whether the install had been recorded or silently lost.
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn().mockResolvedValue({ ok: true as const, value: {
        mcpEnabled: true,
        skillEnabled: true,
        skillInstall: { name: 'example-skill', resolvedCommit: 'a'.repeat(40), locked: true, idempotent: false, verification: [], collisions: [] },
      } })}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    fireEvent.click(await screen.findByRole('button', { name: '一键添加' }))

    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('example-skill')
    // The pin, shortened: the whole point of the record is naming a version.
    expect(note.textContent).toContain('aaaaaaa')
    expect(note.textContent).not.toContain('未能写入安装记录')
  })

  it('says so when a Skill landed without a record, rather than reporting a plain success', async () => {
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn().mockResolvedValue({ ok: true as const, value: {
        mcpEnabled: true,
        skillEnabled: true,
        skillInstall: { name: 'example-skill', resolvedCommit: 'b'.repeat(40), locked: false, idempotent: false, lockfileWarning: 'the state directory is not writable', verification: [], collisions: [] },
      } })}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    fireEvent.click(await screen.findByRole('button', { name: '一键添加' }))

    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('未能写入安装记录')
    expect(note.textContent).toContain('the state directory is not writable')
  })

  it('lets an install choose its destination, and names where it landed', async () => {
    // The placement matrix decides where a Skill goes; the page has to be able to show
    // the *reasons* its unusable rows carry, because a disabled option alone cannot
    // tell an untrusted checkout from a combination that does not exist. And the chosen
    // axes — not a cached path — are what the Host is handed.
    const skillPresetInstall = vi.fn().mockResolvedValue({ ok: true as const, value: {
      mcpEnabled: true,
      skillEnabled: true,
      skillInstall: { name: 'example-skill', resolvedCommit: 'c'.repeat(40), locked: true, idempotent: false, verification: [], collisions: [], placement: { root: 'C:\\home\\data\\skills', provenance: 'user, harness native' } },
    } })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={skillPresetInstall}
      skillPlacements={vi.fn().mockResolvedValue({ ok: true as const, value: {
        workspace: '/repo',
        projectTrusted: false,
        defaultRoot: '/home/profile/skills',
        rows: [
          { agent: 'harness', scope: 'project', ok: false, reason: 'installing into the project requires a trusted folder; trust it, or install with --scope user' },
          { agent: 'harness', scope: 'user', ok: true, root: 'C:\\home\\data\\skills', provenance: 'user, harness native' },
          { agent: 'agents', scope: 'user', ok: true, root: '/home/user/.agents/skills', provenance: 'user, shared agents' },
        ],
      } })}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    const selector = await screen.findByRole('combobox', { name: '安装位置' })
    // The default is the community root, named as the default rather than as a row.
    expect((selector as HTMLSelectElement).value).toBe('')
    const unavailable = (selector as HTMLSelectElement).querySelector('option[value="harness/project"]') as HTMLOptionElement
    expect(unavailable.disabled).toBe(true)
    expect(unavailable.textContent).toContain('不可用')
    // The reason travels with the option: it is the only thing that distinguishes an
    // untrusted folder from a placement this build cannot offer.
    expect(unavailable.title).toContain('trusted folder')

    fireEvent.change(selector, { target: { value: 'harness/user' } })
    fireEvent.click(await screen.findByRole('button', { name: '一键添加' }))

    await waitFor(() => { expect(skillPresetInstall).toHaveBeenCalledWith('skill:example/example-skill', { agent: 'harness', scope: 'user' }) })
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('user, harness native')
  })

  it('starts on the destination the user chose last time', async () => {
    // The preference is read from the matrix payload, which is the same read the rows come
    // from: a page whose selection came from a second read could show one destination and
    // install into another.
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn().mockResolvedValue({ ok: true as const, value: { mcpEnabled: true, skillEnabled: true, skillInstall: { name: 'example-skill', resolvedCommit: 'e'.repeat(40), locked: true, idempotent: false, verification: [], collisions: [] } } })}
      skillPlacements={vi.fn().mockResolvedValue({ ok: true as const, value: {
        workspace: '/repo',
        projectTrusted: true,
        defaultRoot: '/home/profile/skills',
        preferred: { agent: 'harness', scope: 'user' },
        rows: [
          { agent: 'harness', scope: 'project', ok: true, root: '/repo/.dsh/skills', provenance: 'project, harness native' },
          { agent: 'harness', scope: 'user', ok: true, root: 'C:\\home\\data\\skills', provenance: 'user, harness native' },
        ],
      } })}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))

    const selector = await screen.findByRole('combobox', { name: '安装位置' }) as HTMLSelectElement
    await waitFor(() => { expect(selector.value).toBe('harness/user') })
  })

  it('remembers a destination as it is picked, and clears it when the default is chosen again', async () => {
    // Written when the choice is made, not when an install uses it: the request is
    // "remember what I picked", and a user who picks a destination and then closes the
    // panel has still chosen one.
    const skillPlacementPrefer = vi.fn().mockResolvedValue({ ok: true as const, value: {} })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      skillPlacements={vi.fn().mockResolvedValue({ ok: true as const, value: {
        workspace: '/repo',
        projectTrusted: true,
        defaultRoot: '/home/profile/skills',
        rows: [
          { agent: 'harness', scope: 'project', ok: true, root: '/repo/.dsh/skills', provenance: 'project, harness native' },
          { agent: 'agents', scope: 'user', ok: true, root: '/home/user/.agents/skills', provenance: 'user, shared agents' },
        ],
      } })}
      skillPlacementPrefer={skillPlacementPrefer}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    const selector = await screen.findByRole('combobox', { name: '安装位置' })

    fireEvent.change(selector, { target: { value: 'agents/user' } })
    await waitFor(() => { expect(skillPlacementPrefer).toHaveBeenCalledWith({ agent: 'agents', scope: 'user' }) })

    // Back to the community root: absent axes are the clear, which is a different
    // request from "remember the destination named <already stored>"
    fireEvent.change(selector, { target: { value: '' } })
    await waitFor(() => { expect(skillPlacementPrefer).toHaveBeenLastCalledWith(undefined) })
  })

  it('keeps a remembered destination whose row is unusable, and refuses rather than redirecting', async () => {
    // The remembered project destination in a folder that is no longer trusted. Sending
    // nothing instead would install into the community root — the silent redirection the
    // matrix exists to prevent; the Host refuses with the reason the page shows.
    const skillPresetInstall = vi.fn()
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={skillPresetInstall}
      skillPlacements={vi.fn().mockResolvedValue({ ok: true as const, value: {
        workspace: '/repo',
        projectTrusted: false,
        defaultRoot: '/home/profile/skills',
        preferred: { agent: 'agents', scope: 'project' },
        rows: [
          { agent: 'agents', scope: 'project', ok: false, reason: 'installing into the project requires a trusted folder; trust it, or install with --scope user' },
          { agent: 'harness', scope: 'user', ok: true, root: '/home/.dsh/skills', provenance: 'user, harness native' },
        ],
      } })}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    const selector = await screen.findByRole('combobox', { name: '安装位置' }) as HTMLSelectElement
    await waitFor(() => { expect(selector.value).toBe('agents/project') })
    // The reason is on screen before anything is clicked: a disabled option alone cannot
    // tell an untrusted folder from a combination this build cannot offer.
    expect((await screen.findByRole('alert')).textContent).toContain('trusted folder')

    fireEvent.click(await screen.findByRole('button', { name: '一键添加' }))

    await waitFor(() => { expect(skillPresetInstall).toHaveBeenCalledWith('skill:example/example-skill', { agent: 'agents', scope: 'project' }) })
  })

  it('says the destination was not remembered instead of blaming the install', async () => {
    const skillPlacementPrefer = vi.fn().mockRejectedValue(new Error('FreeCodeGo settings are not configured'))
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      skillPlacements={vi.fn().mockResolvedValue({ ok: true as const, value: {
        workspace: '/repo',
        projectTrusted: true,
        defaultRoot: '/home/profile/skills',
        rows: [{ agent: 'harness', scope: 'user', ok: true, root: '/home/.dsh/skills', provenance: 'user, harness native' }],
      } })}
      skillPlacementPrefer={skillPlacementPrefer}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    fireEvent.change(await screen.findByRole('combobox', { name: '安装位置' }), { target: { value: 'harness/user' } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('安装位置偏好未能保存')
    expect(alert.textContent).toContain('FreeCodeGo settings are not configured')
    // The choice still applies here, which is why this is not the install banner.
    expect(alert.textContent).toContain('本次选择仍在本页生效')
  })

  it('installs into the community root when no matrix is declared, without a selector', async () => {
    // A Host older than the placement Remote still installs. The page must not render a
    // destination control it cannot fill, and the install must stay the one-argument
    // call those Hosts accept.
    const skillPresetInstall = vi.fn().mockResolvedValue({ ok: true as const, value: {
      mcpEnabled: true,
      skillEnabled: true,
      skillInstall: { name: 'example-skill', resolvedCommit: 'd'.repeat(40), locked: true, idempotent: false, verification: [], collisions: [] },
    } })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [installableSkill] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={skillPresetInstall}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    fireEvent.click(await screen.findByRole('button', { name: '一键添加' }))

    await waitFor(() => { expect(skillPresetInstall).toHaveBeenCalledWith('skill:example/example-skill', undefined) })
    expect(screen.queryByRole('combobox', { name: '安装位置' })).toBeNull()
  })

  it('offers Remove on an installed Skill and turns the card back into an installable one', async () => {
    // Installed is a claim the record supports, and removal is the answer to it: a
    // grid that could only ever add would leave the page's own badge with no way to
    // undo it.
    const skillPresetRemove = vi.fn().mockResolvedValue({ ok: true as const, value: {
      mcpEnabled: true,
      skillEnabled: true,
      skillRemove: { name: 'example-skill', directory: 'example-skill', recorded: true, detail: 'removed', verification: [] },
    } })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn().mockResolvedValue({ ok: true as const, value: { kind: 'skill', total: 1, offset: 0, limit: 24, categories: [], items: [{ ...installableSkill, installed: true }] } })}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      skillPresetRemove={skillPresetRemove}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }))
    // The entry is added, so the add button is spent and removal is what is offered.
    expect(await screen.findByRole('button', { name: '已添加' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除' }))

    await waitFor(() => { expect(skillPresetRemove).toHaveBeenCalledWith('skill:example/example-skill') })
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('已移除')
    expect(note.textContent).toContain('example-skill')
    // And the card is installable again, without re-reading the directory.
    expect(await screen.findByRole('button', { name: '一键添加' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull()
  })

  it('prefers the upstream Chinese README for the plugin dialog', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(url.endsWith('/README.zh.md')
      ? { ok: true, text: async () => '# 中文说明\n插件功能。' }
      : { ok: false, text: async () => '' }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'community-plugin', owner: 'example', url: 'https://github.com/example/community-plugin', category: 'tools', npm: 'dsh-community-plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('button', { name: /community-plugin/ }))
    await waitFor(() => { expect(screen.getByText(/插件功能/)).toBeTruthy() })
    expect(screen.getByText('已优先显示上游中文说明。')).toBeTruthy()
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/README.zh.md')
  })

  it('bounds an unanswered README read with a deadline and cancels it when the dialog closes', async () => {
    // Two different failures are guarded here. Without a deadline a GitHub
    // connection that never answers pins the dialog on "loading…" until the
    // browser's own socket timeout decides the question; without cancellation the
    // request outlives the dialog that asked for it.
    const signals: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => { signals.push(init?.signal); return new Promise(() => {}) }))
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const { unmount } = render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'community-plugin', owner: 'example', url: 'https://github.com/example/community-plugin', category: 'tools', npm: 'dsh-community-plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {}, restartRequired: false } })}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)

    fireEvent.click(await screen.findByRole('button', { name: /community-plugin/ }))
    await waitFor(() => { expect(signals.length).toBeGreaterThan(0) })
    const deadlineScheduled = setTimeoutSpy.mock.calls.some(call => call[1] === README_FETCH_TIMEOUT_MS)
    setTimeoutSpy.mockRestore()
    // The signal is what makes cancellation possible at all; the deadline is what
    // ends a read the server never answers.
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(deadlineScheduled).toBe(true)

    unmount()
    expect(signals[0]?.aborted).toBe(true)
  })
})
