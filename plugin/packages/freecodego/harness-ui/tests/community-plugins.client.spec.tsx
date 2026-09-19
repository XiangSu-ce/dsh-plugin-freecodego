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
