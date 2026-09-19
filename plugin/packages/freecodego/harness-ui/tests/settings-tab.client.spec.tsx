// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { AutomationSettingsPanel, backendDefaultGroupName, CARD_CHANNEL_METHODS, categoryLabel, createRequestEpochGate, describePaymentError, DeviceSessionManager, isCardChannel, isFreePricingRow, orderSettlementCurrency, SandboxModePanel, selectedChannelDescription, splitPricingRows, EngineeringEvalPanel, EngineeringMemoryPanel, engineeringTeamState, engineeringVerificationLine, FreeCodeGoSettingsBoundary, FreeCodeGoSettingsTab, modelCategoryOf, modelGroupLabel, modelGroupRows, paymentLimitText, pricingGroupName, pricingGroupRate, pricingRowKey, pricingRows, PluginConflictNotice, severityTone, AdvisorSettingsSection, SkillSettingsSection } from '../src/client/settings-tab.tsx'
import { formatMoney, roundUpCurrency } from '../src/client/money-format.ts'
import type { GatewayModelPrice } from '../src/client/settings-tab.tsx'
import type { FreeCodeGoDeviceSessions } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { CommunityPluginsPage } from '../src/client/community-plugins.tsx'

function createSnapshotStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
    update: (mutate: (draft: T) => void) => { mutate(value); for (const listener of listeners) listener() },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

afterEach(() => {
  cleanup()
  globalThis.localStorage.clear()
})

// The settings tab is a slot component, so the host merges `GlobalStandardProps`
// into its props. Every fixture has to carry the hooks the host actually
// supplies, or it is standing in for a host that does not exist — which is
// exactly what the fixtures did before `tsconfig.test.json` started checking
// them. Same convention as `client/locale/tests/language-row.client.spec.tsx`.
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

// Each hook's snapshot type is derived from the hook itself, so a rename in the
// slot contract surfaces here instead of silently leaving a stale fixture.
type SessionsSnapshot = Parameters<Parameters<GlobalStandardProps['useSessions']>[0]>[0]
const noSessions: SessionsSnapshot = {
  ids: [], byId: {}, phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
}
const useSessions: GlobalStandardProps['useSessions'] = selector => selector(noSessions)

type WorkspacesSnapshot = Parameters<Parameters<GlobalStandardProps['useWorkspaces']>[0]>[0]
const noWorkspaces: WorkspacesSnapshot = { items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null }
const useWorkspaces: GlobalStandardProps['useWorkspaces'] = selector => selector(noWorkspaces)

type SessionStatusSnapshot = Parameters<Parameters<GlobalStandardProps['useSessionStatus']>[0]>[0]
const noSessionStatus: SessionStatusSnapshot = new Map()
const useSessionStatus: GlobalStandardProps['useSessionStatus'] = selector => selector(noSessionStatus)

/**
 * The fifth hook the host merges into every settings-section's props.
 *
 * Not a snapshot selector like its neighbours: it answers per Session identity, and
 * these sections read no retain counts at all — so the stub reports absence for
 * every question rather than standing in a shape nothing here looks at.
 */
const useSessionRetainInfo: GlobalStandardProps['useSessionRetainInfo'] =
  (() => undefined) as unknown as GlobalStandardProps['useSessionRetainInfo']

/** The five hooks the host merges into every settings-section's props. */
const hostStandardProps = { usePanelInfo, useSessionRetainInfo, useSessionStatus, useSessions, useWorkspaces } as const

describe('FreeCodeGoSettingsTab reconnect behavior', () => {
  it('shows a recoverable panel instead of a blank settings section when rendering fails', async () => {
    render(<FreeCodeGoSettingsBoundary
      {...hostStandardProps}
      close={vi.fn()}
      catalog={vi.fn() as never}
      accountStatus={vi.fn() as never}
      login={vi.fn() as never}
      logout={vi.fn() as never}
      communityCatalog={vi.fn() as never}
      communityEnvironment={vi.fn() as never}
      communityInstalled={vi.fn() as never}
      communityInstall={vi.fn() as never}
      language="en"
      t={(key: string) => key as never}
      useConnectionEpoch={(() => { throw new Error('ALPHA_RENDER_FIXTURE') }) as never}
    />)

    expect((await screen.findByRole('alert')).textContent).toContain('ALPHA_RENDER_FIXTURE')
    expect(screen.getByRole('button', { name: 'Retry loading' })).toBeTruthy()
  })

  it('treats a missing workspace session as an empty engineering-memory context', async () => {
    const list = vi.fn(async () => { throw new Error('REMOTE_SHOULD_NOT_BE_CALLED') })
    render(<EngineeringMemoryPanel
      enabled={true}
      currentSessionId={() => undefined}
      list={list as never}
      timeline={vi.fn() as never}
      get={vi.fn() as never}
      review={vi.fn() as never}
      remove={vi.fn() as never}
      purge={vi.fn() as never}
      exportReviewed={vi.fn() as never}
      backup={vi.fn() as never}
      retentionSweep={vi.fn() as never}
      search={vi.fn() as never}
      recall={vi.fn().mockResolvedValue({ ok: true as const, value: { projectId: 'proj', tokenBudget: 0, usedTokens: 0, records: [] } }) as never}
      consolidate={vi.fn() as never}
      manifest={vi.fn() as never}
    />)
    expect(await screen.findByText('打开工作区对话后查看长期记忆')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('downgrades a session without a workspace to the same empty memory state', async () => {
    const list = vi.fn(async () => ({ ok: false as const, error: { message: 'engineering memory requires an open workspace-backed conversation' } }))
    render(<EngineeringMemoryPanel
      enabled={true}
      currentSessionId={() => 'chat-without-workspace'}
      list={list as never}
      timeline={vi.fn() as never}
      get={vi.fn() as never}
      review={vi.fn() as never}
      remove={vi.fn() as never}
      purge={vi.fn() as never}
      exportReviewed={vi.fn() as never}
      backup={vi.fn() as never}
      retentionSweep={vi.fn() as never}
      search={vi.fn() as never}
      recall={vi.fn().mockResolvedValue({ ok: true as const, value: { projectId: 'proj', tokenBudget: 0, usedTokens: 0, records: [] } }) as never}
      consolidate={vi.fn() as never}
      manifest={vi.fn() as never}
    />)
    expect(await screen.findByText('打开工作区对话后查看长期记忆')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(list).toHaveBeenCalledWith('chat-without-workspace', expect.any(Object))
  })

  it('runs a consolidation pass and renders the rebuilt index from the panel', async () => {
    // Both gestures exist because the pass runs on a debounce and the index is
    // written only during one: without a button, a user who just turned the
    // stage up cannot see its effect, and a topic edited by hand has no way back
    // into the index. The status line reports the outcome verbatim, because
    // `skipped` and a `problem` are the answers a user has to act on — a bare
    // "done" would hide the stage that did nothing.
    const consolidate = vi.fn(async () => ({ ok: true as const, value: { outcome: 'skipped' as const, stage: 'shadow' as const, observations: 4, topicsWritten: 0, durationMs: 12 } }))
    const manifest = vi.fn(async () => ({ ok: true as const, value: { markdown: '# Memory index\n\n- alpha — a topic — /home/u/alpha.md', included: 1, omitted: 2, truncated: true } }))
    render(<EngineeringMemoryPanel
      enabled={true}
      currentSessionId={() => 'session-1'}
      list={vi.fn(async () => ({ ok: true as const, value: { records: [] } })) as never}
      timeline={vi.fn() as never}
      get={vi.fn() as never}
      review={vi.fn() as never}
      remove={vi.fn() as never}
      purge={vi.fn() as never}
      exportReviewed={vi.fn() as never}
      backup={vi.fn() as never}
      retentionSweep={vi.fn() as never}
      consolidate={consolidate as never}
      manifest={manifest as never}
    />)

    // Both actions live behind the 管理 disclosure, so it has to be opened.
    fireEvent.click(await screen.findByText('管理'))
    fireEvent.click(screen.getByText('立即整合'))
    await waitFor(() => { expect(consolidate).toHaveBeenCalledWith('session-1') })
    const consolidated = await screen.findByText(/整合 skipped/u)
    expect(consolidated.textContent).toContain('阶段 shadow')
    expect(consolidated.textContent).toContain('写入 0 个主题')

    fireEvent.click(screen.getByText('重建记忆索引'))
    await waitFor(() => { expect(manifest).toHaveBeenCalledWith('session-1') })
    // The omission is reported rather than hidden: an index that quietly drops
    // records reads as "these are all of them", which is the one wrong answer
    // the budget exists to avoid.
    const rebuilt = await screen.findByText(/预算内省略 2 条/u)
    expect(rebuilt.textContent).toContain('索引已截断')
    expect(screen.getByText(/- alpha — a topic/u)).toBeTruthy()
  })

  it('uses a persisted manual category override ahead of a model protocol', () => {
    const model = { id: 'image-protocol', displayName: 'Image Protocol', provider: 'freecodego', protocol: 'image_generation', availability: 'available', compatibleEngines: ['deepseek'], choices: [] } as const
    expect(modelCategoryOf(model, { 'freecodego\u0000image-protocol': 'text' })).toBe('text')
    expect(categoryLabel('image', 'en')).toBe('Image generation model')
  })

  it('classifies generation families without treating vision input models as image generators', () => {
    const model = (id: string) => ({ id, displayName: id, provider: 'custom', protocol: 'openai_chat_completions', availability: 'available', compatibleEngines: [], choices: [] } as const)
    expect(modelCategoryOf(model('deepseek-v4-flash-vision-exp'))).toBe('text')
    expect(modelCategoryOf(model('gpt-image-2'))).toBe('image')
    expect(modelCategoryOf(model('grok-image-latest'))).toBe('image')
    expect(modelCategoryOf(model('seedance-2.0'))).toBe('video')
    expect(modelCategoryOf(model('veo-3.1-generate-preview'))).toBe('video')
  })

  it('invalidates late UI requests after a newer request or component disposal', () => {
    const gate = createRequestEpochGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
    gate.invalidate()
    expect(second()).toBe(false)
  })

  it('does not restore an old capability snapshot after the connection resets', async () => {
    const epoch = createSnapshotStore(0)
    const first = Promise.withResolvers<any>()
    const capabilities = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true as const, value: { mcpEnabled: true, skillEnabled: false, voiceInputEnabled: true, sessionDeleteEnabled: true, modelCategories: {}, mcpServers: [], skillRoots: [], mcpTools: [], skills: [] } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      capabilities={capabilities}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(epoch)}
      t={(key: string) => key as never}
    />)

    await waitFor(() => { expect(capabilities).toHaveBeenCalledTimes(1) })
    act(() => { epoch.set(1) })
    await waitFor(() => { expect(capabilities).toHaveBeenCalledTimes(2) })
    first.resolve({ ok: true as const, value: { mcpEnabled: false, skillEnabled: false, voiceInputEnabled: true, sessionDeleteEnabled: true, modelCategories: {}, mcpServers: [], skillRoots: [], mcpTools: [], skills: [] } })

    fireEvent.click(await screen.findByText('设置'))
    const toggle = await screen.findByLabelText('MCP') as HTMLInputElement
    await waitFor(() => { expect(toggle.checked).toBe(true) })
  })

  it('links the overview page to the Telegram feedback group', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    // `t` echoes the key here, so the accessible name proves the row uses the
    // shared dictionary rather than a string duplicated inside the component.
    const link = await screen.findByRole('link', { name: 'telegramJoin' })
    expect(link.getAttribute('href')).toBe('https://t.me/freecodego')
    expect(link.getAttribute('target')).toBe('_blank')
    // Without `noopener` the opened group could reach back into this window.
    expect(link.getAttribute('rel')?.split(/\s+/)).toContain('noopener')

    // The plane stays a single `currentColor` glyph. A brand-blue disc here
    // would undo the monochrome treatment this row asked for, and the tight
    // viewBox is what keeps the standalone plane from rendering a third
    // smaller than the size it is asked for.
    const icon = link.querySelector('svg')
    expect(icon?.getAttribute('viewBox')).toBe('4.092 6.689 14.506 11.834')
    expect(icon?.querySelector('circle')).toBeNull()
    expect(icon?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
  })

  it('shows a recent automatic plugin repair in the application-wide modal', async () => {
    const status = vi.fn().mockResolvedValue({
      ok: true as const,
      value: {
        pluginConflictProtectionEnabled: true,
        pluginConflictRecords: [{
          id: 'repair-1',
          detectedAt: Date.now(),
          resource: 'tool' as const,
          resourceName: 'duplicate-tool',
          disabledEntryId: 'later-plugin',
          disabledModuleName: '@example/later-plugin',
          keptEntryId: 'first-plugin',
          keptModuleName: '@example/first-plugin',
        }],
      },
    })
    render(<PluginConflictNotice status={status} />)
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '插件冲突已自动修复' })).toBeTruthy() })
    expect(screen.getByText('@example/first-plugin')).toBeTruthy()
    expect(screen.getByText('@example/later-plugin')).toBeTruthy()
    expect(screen.getByText('tool：duplicate-tool')).toBeTruthy()
  })

  it('does not show a repair returned by a superseded conflict-status remote', async () => {
    const stale = Promise.withResolvers<any>()
    const oldStatus = vi.fn().mockReturnValue(stale.promise)
    const currentStatus = vi.fn().mockResolvedValue({ ok: true as const, value: { pluginConflictProtectionEnabled: true, pluginConflictRecords: [] } })
    const rendered = render(<PluginConflictNotice status={oldStatus} />)
    rendered.rerender(<PluginConflictNotice status={currentStatus} />)
    stale.resolve({
      ok: true as const,
      value: {
        pluginConflictProtectionEnabled: true,
        pluginConflictRecords: [{
          id: 'stale-repair', detectedAt: Date.now(), resource: 'tool' as const,
          resourceName: 'stale-tool', disabledEntryId: 'old-plugin',
          disabledModuleName: '@example/old-plugin', keptEntryId: 'kept-plugin',
          keptModuleName: '@example/kept-plugin',
        }],
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByRole('dialog', { name: '插件冲突已自动修复' })).toBeNull()
  })

  it('does not show an old conflict poll result after a newer poll completes', async () => {
    vi.useFakeTimers()
    try {
      const stale = Promise.withResolvers<any>()
      const status = vi.fn()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue({ ok: true as const, value: { pluginConflictProtectionEnabled: true, pluginConflictRecords: [] } })
      render(<PluginConflictNotice status={status} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      stale.resolve({
        ok: true as const,
        value: {
          pluginConflictProtectionEnabled: true,
          pluginConflictRecords: [{
            id: 'old-poll-repair', detectedAt: Date.now(), resource: 'tool' as const,
            resourceName: 'old-tool', disabledEntryId: 'old-plugin',
            disabledModuleName: '@example/old-plugin', keptEntryId: 'kept-plugin',
            keptModuleName: '@example/kept-plugin',
          }],
        },
      })
      await act(async () => { await Promise.resolve() })
      expect(screen.queryByRole('dialog', { name: '插件冲突已自动修复' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps automatic plugin conflict repair enabled by default and saves the switch', async () => {
    const pluginConflictStatus = vi.fn().mockResolvedValue({
      ok: true as const,
      value: { pluginConflictProtectionEnabled: true, pluginConflictRecords: [] },
    })
    const pluginConflictSetEnabled = vi.fn().mockResolvedValue({
      ok: true as const,
      value: { pluginConflictProtectionEnabled: false, pluginConflictRecords: [] },
    })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'freecodego', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      pluginConflictStatus={pluginConflictStatus}
      pluginConflictSetEnabled={pluginConflictSetEnabled}
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('设置')).toBeTruthy() })
    fireEvent.click(screen.getByText('设置'))
    const toggle = await screen.findByLabelText('自动修复插件冲突') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => { expect(pluginConflictSetEnabled).toHaveBeenCalledWith(false) })
  })

  it('never renders the conflict protection as on when the read itself failed', async () => {
    // `checked={snapshot?.pluginConflictProtectionEnabled !== false}` rendered
    // the box checked while the badge next to it read "已关闭", so the two
    // halves of the panel disagreed and the reading that said "protection is
    // on" was the wrong one. An unreadable Host must say so, not guess.
    const pluginConflictStatus = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'CONFLICT_STORE_UNREADABLE' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'freecodego', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      pluginConflictStatus={pluginConflictStatus}
      pluginConflictSetEnabled={vi.fn()}
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('设置')).toBeTruthy() })
    fireEvent.click(screen.getByText('设置'))
    const toggle = await screen.findByLabelText('自动修复插件冲突') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(true)
    // The badge must not claim either answer it does not have. Scoped to this
    // panel: the settings page renders other panels whose badges say 已关闭.
    const panel = toggle.closest('section') as HTMLElement
    expect(panel.textContent).toContain('状态未知')
    expect(panel.textContent).not.toContain('已开启')
    expect(panel.textContent).not.toContain('已关闭')
    expect(panel.textContent).toContain('冲突防护状态读取失败：CONFLICT_STORE_UNREADABLE')
  })

  it('reloads the engine catalog after a connection generation reset', async () => {
    const epoch = createSnapshotStore(0)
    const useConnectionEpoch = bindSnapshotSelector(epoch)
    const catalog = vi.fn()
      .mockResolvedValue({ ok: true as const, value: { defaultEngine: 'freecodego', engines: [{ id: 'freecodego', availability: 'available', generation: 1, reasons: [], draining: false, activeLeaseCount: 0 }] } })
    const accountStatus = vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })
    const t = (key: string): string => key
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={catalog}
      accountStatus={accountStatus}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'test', models: [] } })}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={useConnectionEpoch}
      t={t as never}
    />)
    await waitFor(() => { expect(screen.getAllByText('FreeCodeGo').length).toBeGreaterThan(0) })
    expect(catalog).toHaveBeenCalledTimes(1)
    act(() => { epoch.set(epoch.getSnapshot() + 1) })
    await waitFor(() => { expect(screen.getAllByText('FreeCodeGo').length).toBeGreaterThan(0) })
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(accountStatus).toHaveBeenCalledTimes(2)
  })

  it('publishes a capability change for the settings-sidebar entries after a switch is enabled', async () => {
    const snapshot = {
      mcpEnabled: false,
      skillEnabled: false,
      mcpServers: [],
      skillRoots: [],
      mcpTools: [],
      skills: [],
    } as const
    const capabilities = vi.fn().mockResolvedValue({ ok: true as const, value: snapshot })
    const capabilitiesSetEnabled = vi.fn().mockImplementation(async (input: { mcpEnabled?: boolean; skillEnabled?: boolean }) => ({
      ok: true as const,
      value: { ...snapshot, ...input },
    }))
    let changed: { mcpEnabled?: boolean; skillEnabled?: boolean } | undefined
    const onChanged = (event: Event): void => { changed = (event as CustomEvent<{ mcpEnabled?: boolean; skillEnabled?: boolean }>).detail }
    globalThis.addEventListener('freecodego:capability-change', onChanged)
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      capabilities={capabilities}
      capabilitiesSetEnabled={capabilitiesSetEnabled}
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('设置')).toBeTruthy() })
    expect(screen.queryByRole('button', { name: 'MCP' })).toBeNull()
    fireEvent.click(screen.getByText('设置'))
    try {
      fireEvent.click(screen.getByLabelText('MCP'))
      await waitFor(() => { expect(capabilitiesSetEnabled).toHaveBeenCalledWith({ mcpEnabled: true }) })
      expect(changed).toMatchObject({ mcpEnabled: true })
      expect(screen.queryByRole('button', { name: 'MCP' })).toBeNull()
    } finally {
      globalThis.removeEventListener('freecodego:capability-change', onChanged)
    }
  })

  it('keeps only the Advisor switch on the general settings page', async () => {
    const advisorSnapshot = {
      enabled: true,
      mode: 'async' as const,
      provider: 'freecodego',
      model: 'reviewer-small',
      routeReady: true,
      reviewTools: ['read', 'glob', 'grep'] as const,
      allowAgentControl: false,
      interruptCooldownTurns: 3,
      activeSessions: 0,
      queuedReviews: 0,
      noteCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      watchdogFiles: [],
      sideChannelWarnings: ['advisor: this side channel is at 140% of the compaction threshold'],
    }
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      advisorStatus={vi.fn().mockResolvedValue({ ok: true as const, value: advisorSnapshot })}
      advisorUpdate={vi.fn().mockResolvedValue({ ok: true as const, value: advisorSnapshot })}
      advisorModels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorNotes={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('设置')).toBeTruthy() })
    fireEvent.click(screen.getByText('设置'))
    expect(screen.getByRole('checkbox', { name: '启用 Advisor' })).toBeTruthy()
    // The side-channel invariant is surfaced next to the switch, because the one
    // party who can act on it (compact before the reviewer overflows) is reading
    // this page rather than the log.
    expect(screen.getByText('advisor: this side channel is at 140% of the compaction threshold')).toBeTruthy()
    expect(screen.queryByText('审查模式')).toBeNull()
    expect(screen.queryByText('保存 Advisor 配置')).toBeNull()
  })

  it('localizes payment channels and renders live gateway model tariffs', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: '001', email: '3527566745@qq.com', avatarUrl: 'data:image/webp;base64,UklGRg==', balance: 12 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'test', models: [] } })}
      sensenovaStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: false, baseUrl: 'https://token.sensenova.cn/v1' } })}
      sensenovaSetKey={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: true, baseUrl: 'https://token.sensenova.cn/v1' } })}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [{ id: 1, name: 'US$5 Developer Credit', price: 5, currency: 'USD' }] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [{ paymentType: 'alipay', currency: 'CNY', balanceRechargeMultiplier: 0.14 }] })}
      gatewayModelPrices={vi.fn().mockResolvedValue({ ok: true as const, value: [{ modelId: 'gpt-5.6', displayName: 'GPT 5.6', provider: 'openai', groupName: '后端分组乙', rateMultiplier: 0.5, billingMode: 'token' as const, currency: 'USD', inputPricePerMillion: 5, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.5, cacheWritePricePerMillion: 2.5 }] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('模型价格表')).toBeTruthy() })
    expect(screen.getByRole('option', { name: '支付宝 (CNY)' })).toBeTruthy()
    expect(screen.getByText('gpt-5.6')).toBeTruthy()
    // The price row is headed by the backend's own group name at that group's
    // rate, not by a gateway label this client typed in.
    expect(screen.getByText('后端分组乙')).toBeTruthy()
    expect(screen.getByText('×0.5')).toBeTruthy()
    expect(screen.queryByText('FreeCodeGo 网关')).toBeNull()
    expect(screen.getAllByText('US$5.00')).toHaveLength(2)
    // A tier card has to answer more than "how much": what the credit runs on,
    // how it is drawn down, and which payment methods settle it. Those lines are
    // the difference between a price list and an offer.
    expect(screen.getByText('一次性充值，余额长期有效，不自动续费')).toBeTruthy()
    expect(screen.getByText('支持支付宝、微信支付与国际信用卡（Visa / Mastercard / Amex / JCB）')).toBeTruthy()
    expect(screen.getByText('全部已授权模型通用：Claude、GPT、Gemini 与国产模型')).toBeTruthy()
    const avatar = screen.getByRole('img', { name: 'QQ 邮箱账户' })
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,UklGRg==')
    expect(screen.getByText('3527566745@qq.com')).toBeTruthy()
    expect(screen.queryByText('001')).toBeNull()
    // The accounts/providers page hosts the surviving providers (SenseNova,
    // Agnes, logfare) even though the retired ones are gone.
    fireEvent.click(screen.getByText('账号与提供商'))
    expect(screen.getByText('SenseNova')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '查看文档' })).toBeNull()
  })

  it('signs in across the whole row, with no second column of marketing copy', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'signed-out' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'test', models: [] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    const email = await screen.findByPlaceholderText('email')
    // The side column that used to sit beside the form said in four lines what the
    // form already implies, and it left the sign-in half empty on a wide panel.
    expect(document.querySelector('aside')).toBeNull()
    expect(screen.queryByText('一个账号，接通全部已授权模型')).toBeNull()
    expect(screen.queryByText('额度按实际用量扣减，长期有效')).toBeNull()
    // One card, laid out as a two-column form: address and password share a row,
    // so the width is used instead of stretching a single column.
    const form = email.parentElement as HTMLElement
    expect(form).toBe(screen.getByPlaceholderText('password').parentElement)
    expect(form.contains(screen.getByRole('button', { name: 'login' }))).toBe(true)
    expect(screen.getByRole('button', { name: 'Google' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeTruthy()
    // The card owns the row: the layout grid holds the card and nothing else.
    expect(form.parentElement?.parentElement?.children.length).toBe(1)
  })

  it('renders the VyceAI provider card first with the check-in pitch and the signup link', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      vyceStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: false, models: [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    // The tag lane carries the wire id the picker serves, not a display name.
    expect(await screen.findByText('deepseek-v4.1')).toBeTruthy()
    expect(screen.getByText(/每天签到免费领/)).toBeTruthy()
    expect(screen.getByText(/约等于 5 个 OpenCode Go 订阅额度/)).toBeTruthy()
    // VyceAI is the only provider card this render supplies.
    const cards = [...document.querySelectorAll('section[aria-label]')]
    const vyceCard = cards.find(card => card.getAttribute('aria-label') === 'VyceAI') as HTMLElement | undefined
    expect(vyceCard).toBeTruthy()
    // The apply button must carry the referral signup link, scoped to this card
    // because every provider card has its own "申请 API Key".
    const apply = [...vyceCard!.querySelectorAll('a')].find(anchor => anchor.textContent === '申请 API Key')
    expect(apply?.getAttribute('href')).toBe('https://vyceai.com/signup?ref=VYCE_RBSBEV')
    expect(cards.indexOf(vyceCard!)).toBeGreaterThanOrEqual(0)
    // The B.AI campaign is over: neither its card nor its model roster may come
    // back onto this page.
    expect(cards.find(card => card.getAttribute('aria-label') === 'B.AI')).toBeUndefined()
  })

  it('saves and clears the VyceAI key through the Host remote', async () => {
    const vyceSetKey = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { configured: true, models: [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] } })
      .mockResolvedValueOnce({ ok: true as const, value: { configured: false, models: [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      vyceStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: false, models: [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] } })}
      vyceSetKey={vyceSetKey}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    const input = await screen.findByPlaceholderText('粘贴 VyceAI API Key')
    fireEvent.change(input, { target: { value: 'vyce-live-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }))
    await vi.waitFor(() => { expect(vyceSetKey).toHaveBeenCalledWith('vyce-live-key') })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: '清除 Key' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '清除 Key' }))
    await vi.waitFor(() => { expect(vyceSetKey).toHaveBeenCalledWith('') })
  })

  it('manages the Cline account pool and names its live free routes', async () => {
    const clineRefresh = vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated', accounts: [], freeModels: [] } })
    const clineRemoveAccount = vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated', accounts: [], freeModels: [] } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      clineStatus={vi.fn().mockResolvedValue({ ok: true as const, value: {
        status: 'authenticated' as const,
        accounts: [
          { id: 'a@example.com', email: 'a@example.com', status: 'active' as const },
          { id: 'b@example.com', email: 'b@example.com', status: 'cooling' as const, cooldownUntil: Date.now() + 3_600_000 },
        ],
        activeAccountId: 'a@example.com',
        freeModels: [{ id: 'stepfun/step-3.7-flash', name: 'StepFun 3.7 Flash', provider: 'stepfun' }],
        usage: { windows: [{ id: 'five-hour', usedPercent: 12 }], balanceUsd: 0.5, plan: 'Free' },
      } })}
      clineRefresh={clineRefresh as never}
      clineRemoveAccount={clineRemoveAccount as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    expect(await screen.findByText('StepFun 3.7 Flash')).toBeTruthy()
    // A degraded pool says so in the summary line instead of looking fully healthy.
    expect(screen.getByText(/已登录 2 个账号 · 1 个免费模型 · 有账号不可用/)).toBeTruthy()
    fireEvent.click(screen.getByText('账号管理（2）'))
    expect(await screen.findByText('a@example.com')).toBeTruthy()
    expect(screen.getByText('b@example.com')).toBeTruthy()
    // A capped account explains itself instead of looking merely idle.
    expect(screen.getByText(/已限流，约 1 小时 0 分钟后恢复/)).toBeTruthy()
    // The usage panel shows plan windows and the credit balance.
    expect(screen.getByText(/Free · 余额 US\$0\.50/)).toBeTruthy()
    expect(screen.getByText('5 小时窗口')).toBeTruthy()
    expect(screen.getByText('12%')).toBeTruthy()
    fireEvent.click(screen.getAllByText('刷新')[0]!)
    expect(clineRefresh).toHaveBeenCalledWith('a@example.com')
    fireEvent.click(screen.getAllByText('移除')[1]!)
    expect(clineRemoveAccount).toHaveBeenCalledWith('b@example.com')
  })

  it('reports a spent model budget as a model problem, not a dead account', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      clineStatus={vi.fn().mockResolvedValue({ ok: true as const, value: {
        status: 'authenticated' as const,
        accounts: [
          // A capped route leaves the account in rotation and lists the route.
          { id: 'a@example.com', email: 'a@example.com', status: 'active' as const, coolingModels: [{ model: 'deepseek/deepseek-v4-flash', until: Date.now() + 3_600_000 }] },
          // A cached snapshot can outlive its own deadline; an elapsed park is
          // not a reason to render the account as limited any more.
          { id: 'b@example.com', email: 'b@example.com', status: 'cooling' as const, cooldownUntil: Date.now() - 60_000 },
        ],
        freeModels: [],
      } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    expect(await screen.findByText(/已登录 2 个账号 · 0 个免费模型 · 部分模型额度已用完/)).toBeTruthy()
    expect(screen.getByText(/部分模型的免费额度已用完（按模型计算），其他模型仍可使用/)).toBeTruthy()
    fireEvent.click(screen.getByText('账号管理（2）'))
    expect(await screen.findByText(/可用，参与轮询 · 1 个模型免费额度已用完：deepseek\/deepseek-v4-flash（约 1 小时 0 分钟后恢复）/)).toBeTruthy()
    // The expired park reads as usable instead of "已限流，约 0 分钟后恢复".
    const rows = screen.getAllByText(/可用，参与轮询/)
    expect(rows).toHaveLength(2)
    expect(screen.queryByText(/已限流，约 0 分钟/)).toBeNull()
  })

  it('keeps the Cline model cloud empty when the live feed is unreachable', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      clineStatus={vi.fn().mockResolvedValue({ ok: true as const, value: {
        status: 'authenticated' as const,
        accounts: [{ id: 'a@example.com', email: 'a@example.com', status: 'active' as const }],
        freeModels: [],
        usage: { windows: [] },
      } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    // Live-only: no fabricated rows; the summary states the zero honestly.
    expect(await screen.findByText('已登录 1 个账号 · 0 个免费模型')).toBeTruthy()
    expect(screen.queryByText(/DeepSeek V4 Flash|Poolside|StepFun/)).toBeNull()
  })

  it('adds a Cline account through the device login it polls', { timeout: 15_000 }, async () => {
    const clinePollLogin = vi.fn().mockResolvedValue({ ok: true as const, value: { pending: false } })
    const clineStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { status: 'signed-out' as const, accounts: [], freeModels: [] } })
      .mockResolvedValue({ ok: true as const, value: {
        status: 'authenticated' as const,
        accounts: [{ id: 'me@example.com', email: 'me@example.com', status: 'active' as const }],
        freeModels: [{ id: 'newco/new-free', name: 'New Free', provider: 'newco' }],
      } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      clineStatus={clineStatus as never}
      clineStartLogin={vi.fn().mockResolvedValue({ ok: true as const, value: { deviceCode: 'device-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.example/device', intervalSeconds: 3, expiresAt: Date.now() + 300_000 } })}
      clinePollLogin={clinePollLogin as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    fireEvent.click(await screen.findByText('添加账号'))
    fireEvent.click(await screen.findByText('使用 Cline 账号登录'))
    // The user code and the authorization link must be readable before the poll.
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText('打开授权页面').getAttribute('href')).toBe('https://auth.example/device')
    // The page, not the Host, owns the cadence: it polls until WorkOS accepts.
    await waitFor(() => { expect(clinePollLogin).toHaveBeenCalledWith('device-1') }, { timeout: 10_000 })
    expect(await screen.findByText('已登录 1 个账号 · 1 个免费模型', undefined, { timeout: 10_000 })).toBeTruthy()
  })

  it('offers the authorization page as an inert step when the ticket URL is not http(s)', async () => {
    // Defense in depth behind the Host's own allow-list: the ticket crosses a
    // Remote boundary as a plain string, and the Host's opener refuses anything
    // but http(s). A `javascript:` value that still arrived here must not become
    // code running in this origin one click later, and the step stays visible
    // (the user code and the cancel button are the useful parts) instead of
    // vanishing.
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      clineStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'signed-out' as const, accounts: [], freeModels: [] } }) as never}
      clineStartLogin={vi.fn().mockResolvedValue({ ok: true as const, value: { deviceCode: 'device-1', userCode: 'ABCD-EFGH', verificationUrl: 'javascript:alert(1)', intervalSeconds: 3, expiresAt: Date.now() + 300_000 } })}
      clinePollLogin={vi.fn().mockResolvedValue({ ok: true as const, value: { pending: true } }) as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    fireEvent.click(await screen.findByText('添加账号'))
    fireEvent.click(await screen.findByText('使用 Cline 账号登录'))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText('打开授权页面').getAttribute('href')).toBeNull()
  })

  it('accepts a Logfare key and a Cline refresh token the user already holds', async () => {
    // Both cards used to offer only their one provisioning path — apply for a
    // credential, or sign in through the browser — so a credential obtained
    // elsewhere had no way in. These are the manual entry points, and each one
    // trims before sending.
    const logfareSetKey = vi.fn().mockResolvedValue({ ok: true as const, value: {
      configured: true, sessionConfigured: true, trainingOptIn: false, premiumUnlocked: false,
      standardModelCount: 4, premiumModelCount: 3, standardModelNames: [], premiumModelNames: [],
    } })
    const clineAddAccount = vi.fn().mockResolvedValue({ ok: true as const, value: {
      status: 'authenticated' as const,
      accounts: [{ id: 'me@example.com', email: 'me@example.com', status: 'active' as const }],
      freeModels: [],
    } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      logfareStatus={vi.fn().mockResolvedValue({ ok: true as const, value: {
        configured: false, sessionConfigured: false, trainingOptIn: false, premiumUnlocked: false,
        standardModelCount: 0, premiumModelCount: 0, standardModelNames: [], premiumModelNames: [],
      } })}
      logfareSetKey={logfareSetKey as never}
      clineStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'signed-out' as const, accounts: [], freeModels: [] } })}
      clineAddAccount={clineAddAccount as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))

    const keyBox = await screen.findByLabelText('Logfare Key')
    const saveKey = within(keyBox.closest('div')!).getByRole('button', { name: '保存 Key' }) as HTMLButtonElement
    // An empty field must not submit: the Host would store an empty credential.
    expect(saveKey.disabled).toBe(true)
    fireEvent.change(keyBox, { target: { value: '  lf-abc  ' } })
    fireEvent.click(saveKey)
    await waitFor(() => { expect(logfareSetKey).toHaveBeenCalledWith('lf-abc') })

    // The Cline card keeps its pool body closed until the card action opens it.
    fireEvent.click(await screen.findByText('添加账号'))
    const tokenBox = await screen.findByLabelText('Cline refresh token')
    const addAccount = within(tokenBox.closest('div')!).getByRole('button', { name: '添加账号' }) as HTMLButtonElement
    expect(addAccount.disabled).toBe(true)
    fireEvent.change(tokenBox, { target: { value: '  tok-123  ' } })
    fireEvent.click(addAccount)
    await waitFor(() => { expect(clineAddAccount).toHaveBeenCalledWith('tok-123') })
  })

  it('renders the WorkBuddy card with accounts and free models when the Host reports them', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      workbuddyStatus={vi.fn().mockResolvedValue({ ok: true as const, value: {
        configured: true,
        accounts: [{ id: 'wb@example.com', email: 'wb@example.com', apiKeyConfigured: true }],
        freeModels: [{ id: 'wb/wb-free', displayName: 'WB Free', provider: 'workbuddy', supportsImages: false, rateMultiplier: 0 }],
      } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    expect(await screen.findByText('已登录 1 个账号 · 1 个免费模型')).toBeTruthy()
    // The referral link is the button itself: the code rides inside the href, and
    // the URL is never printed as text, so what the user sees cannot drift from
    // what the click opens.
    const registerLink = screen.getByRole('link', { name: '注册 WorkBuddy 账号（送 350 积分）' })
    expect(registerLink.getAttribute('href')).toBe('https://workbuddy.ai/invite?code=4DPQJNMC')
    expect(registerLink.getAttribute('target')).toBe('_blank')
    expect(registerLink.getAttribute('rel')).toContain('noreferrer')
    expect(screen.queryByText(/workbuddy\.ai\/invite/)).toBeNull()
    // The account manager panel follows the Cline pool manager pattern.
    fireEvent.click(screen.getByText('账号管理（1）'))
    expect(await screen.findByText('wb@example.com')).toBeTruthy()
    expect(screen.getByText('退出全部')).toBeTruthy()
  })

  it('shows each WorkBuddy account credit position and runs the check-in controls', async () => {
    const soon = Date.now() + 3 * 86_400_000
    const workbuddyRefreshCredits = vi.fn().mockResolvedValue({ ok: true as const, value: { configured: true, accounts: [], freeModels: [] } })
    const status = {
      configured: true,
      accounts: [
        {
          id: 'wb-1', email: 'wb-1@example.com', apiKeyConfigured: true,
          credits: { total: 500, remaining: 120, used: 380, soonestExpireAt: soon, expiringSoon: true, expired: false, checkedAt: Date.now() },
        },
        {
          id: 'wb-2', email: 'wb-2@example.com', apiKeyConfigured: true,
          credits: { total: 300, remaining: 300, used: 0, expiringSoon: false, expired: false, checkedAt: Date.now() },
        },
        // An account whose credit read was refused: the reason is the chip.
        {
          id: 'wb-3', email: 'wb-3@example.com', apiKeyConfigured: true,
          credits: { total: 0, remaining: 0, used: 0, expiringSoon: false, expired: false, checkedAt: Date.now(), error: 'gateway unavailable' },
        },
      ],
      freeModels: [{ id: 'wb/wb-free', displayName: 'WB Free', provider: 'workbuddy', supportsImages: false, rateMultiplier: 0 }],
    }
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      workbuddyStatus={vi.fn().mockResolvedValue({ ok: true as const, value: status }) as never}
      workbuddyRefreshCredits={workbuddyRefreshCredits as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    // The pool summary adds the credit position; each account card states its own.
    expect(await screen.findByText('已登录 3 个账号 · 1 个免费模型 · 积分剩余 420 / 800')).toBeTruthy()
    fireEvent.click(screen.getByText('账号管理（3）'))
    // A refused credit read states itself, with upstream's reason on hover.
    expect(screen.getByText('额度读取失败').getAttribute('title')).toBe('gateway unavailable')
    expect(await screen.findByText('积分即将到期')).toBeTruthy()
    expect(await screen.findByText('积分 120 / 500 · 3 天后到期')).toBeTruthy()
    expect(await screen.findByText('120 / 500')).toBeTruthy()
    expect(await screen.findByText('300 / 300')).toBeTruthy()
    // The button forces a credit sweep.
    fireEvent.click(screen.getByText('刷新额度'))
    await waitFor(() => { expect(workbuddyRefreshCredits).toHaveBeenCalled() })
  })

  it('adds a WorkBuddy account through the browser authorization it polls', { timeout: 15_000 }, async () => {
    let signedIn = false
    const workbuddyStatus = vi.fn().mockImplementation(() => Promise.resolve({ ok: true as const, value: signedIn
      ? { configured: true, accounts: [{ id: 'wb@example.com', email: 'wb@example.com', apiKeyConfigured: true }], freeModels: [] }
      : { configured: false, accounts: [], freeModels: [] } }))
    const workbuddyPollBrowserLogin = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { pending: true } })
      .mockImplementation(() => { signedIn = true; return Promise.resolve({ ok: true as const, value: { pending: false as const, state: { configured: true, accounts: [{ id: 'wb@example.com', email: 'wb@example.com', apiKeyConfigured: true }], freeModels: [] } } }) })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      workbuddyStatus={workbuddyStatus as never}
      workbuddyStartBrowserLogin={vi.fn().mockResolvedValue({ ok: true as const, value: { state: 'fcg_test_1', loginUrl: 'https://www.workbuddy.ai/console/auth/login?platform=plugin&state=fcg_test_1', expiresAt: Date.now() + 600_000 } })}
      workbuddyPollBrowserLogin={workbuddyPollBrowserLogin as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    // The password form is gone for good: authorization is browser based.
    expect(screen.queryByPlaceholderText('WorkBuddy 邮箱')).toBeNull()
    expect(screen.queryByPlaceholderText('WorkBuddy 密码')).toBeNull()
    // One click opens the upstream authorization page; the link is the fallback.
    fireEvent.click(await screen.findByText('使用 WorkBuddy 账号登录'))
    expect(await screen.findByText('打开授权页面').then((node) => { expect(node.getAttribute('href')).toContain('state=fcg_test_1'); return node })).toBeTruthy()
    // The page, not the Host, owns the cadence: it polls until tokens arrive.
    await waitFor(() => { expect(workbuddyPollBrowserLogin).toHaveBeenCalledWith('fcg_test_1') }, { timeout: 10_000 })
    expect(await screen.findByText(/已登录 1 个账号 · 0 个免费模型/, undefined, { timeout: 10_000 })).toBeTruthy()
  })

  it('keeps the WorkBuddy card off the page when the Host lacks the remote', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    expect(screen.queryByText('WorkBuddy')).toBeNull()
  })

  it('names the logfare routes from the live directory the Host already resolved', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      logfareStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: true, sessionConfigured: true, trainingOptIn: false, premiumUnlocked: false, standardModelCount: 2, premiumModelCount: 1, standardModelNames: ['Auto', 'Gemma 4 26B'], premiumModelNames: ['Rotated Premium Model'] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    expect(await screen.findByText('Auto')).toBeTruthy()
    expect(screen.getByText('Gemma 4 26B')).toBeTruthy()
    // A model the Host resolved live, which no client-side roster contains.
    expect(screen.getByText('Rotated Premium Model')).toBeTruthy()
    expect(screen.getByText('基础 2 · 高级 1')).toBeTruthy()
  })

  it('shows no model cloud when a live directory has not resolved yet', async () => {
    // An unreachable directory yields empty name arrays. That must read as
    // "nothing to list", not as an empty box or a stale built-in roster.
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      logfareStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { configured: true, sessionConfigured: true, trainingOptIn: false, premiumUnlocked: false, standardModelCount: 0, premiumModelCount: 0, standardModelNames: [], premiumModelNames: [] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('账号与提供商'))
    const card = await screen.findByLabelText('logfare')
    expect(card.querySelectorAll('[class*="tag"]').length).toBe(0)
    expect(screen.getByText('基础 0 · 高级 0')).toBeTruthy()
  })

  it('does not block settings synchronization on an unfinished price catalog request', async () => {
    const gatewayModelPrices = vi.fn(() => new Promise<never>(() => undefined))
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      gatewayModelPrices={gatewayModelPrices}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.queryByText(/正在同步账户、引擎与模型数据/)).toBeNull() })
    expect(gatewayModelPrices).toHaveBeenCalledWith('zh')
  })

  it('publishes fast provider and model results while unrelated remotes remain pending', async () => {
    const pending = vi.fn(() => new Promise<never>(() => undefined))
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: '001', email: 'user@example.com', balance: 1 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'independent', models: [{ id: 'regression-model', displayName: 'Regression Model', provider: 'test', protocol: 'openai', availability: 'available', compatibleEngines: ['deepseek'], choices: [] }] } })}
      paymentPlans={pending}
      paymentChannels={pending}
      gatewayModelPrices={pending}
      logfareStatus={pending}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByRole('option', { name: 'Regression Model' })).toBeTruthy() })
    // Fast remotes publish without waiting for the still-pending price tables.
    expect(screen.queryByText(/正在同步账户、引擎与模型数据/)).toBeNull()
  })

  it('keeps the settings page usable when the gateway account refresh fails', async () => {
    const backendCatalog = vi.fn()
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockRejectedValue(new Error('fetch failed'))}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={backendCatalog}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    expect((await screen.findByRole('alert')).textContent).toContain('fetch failed')
    expect(backendCatalog).toHaveBeenCalledTimes(1)
  })

  it('keeps the settings page usable when saving the default model fails', async () => {
    const setDefaultModel = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'MODEL_SAVE_FAILED' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: '001', email: 'user@example.com', balance: 1 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      setDefaultModel={setDefaultModel}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'save-failure', models: [{ id: 'save-failure-model', displayName: 'Save Failure Model', provider: 'test', protocol: 'openai', availability: 'available', compatibleEngines: ['deepseek'], choices: [] }] } })}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    const option = await screen.findByRole('option', { name: 'Save Failure Model' })
    fireEvent.change(option.closest('select')!, { target: { value: 'save-failure-model' } })
    await waitFor(() => { expect(setDefaultModel).toHaveBeenCalledWith('save-failure-model') })
    expect((await screen.findByRole('alert')).textContent).toContain('MODEL_SAVE_FAILED')
    expect(screen.getByText('Save Failure Model')).toBeTruthy()
    expect(screen.queryByText('无法读取 FreeCodeGo 引擎状态。')).toBeNull()
  })

  it('keeps the update setting enabled and reports a local error when its switch cannot be saved', async () => {
    const pluginUpdateSetEnabled = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'UPDATE_TOGGLE_FAILED' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      pluginUpdateStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { enabled: true, packageName: '@example/freecodego', currentVersion: '1.0.0', installation: 'release' as const, releaseRepository: 'XiangSu-ce/dsh-freecodego', phase: 'idle' as const, restartRequired: false } })}
      pluginUpdateSetEnabled={pluginUpdateSetEnabled}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    fireEvent.click(await screen.findByText('设置'))
    const toggle = await screen.findByLabelText('自动检查 FreeCodeGo 更新') as HTMLInputElement
    fireEvent.click(toggle)
    await waitFor(() => { expect(pluginUpdateSetEnabled).toHaveBeenCalledWith(false) })
    expect((await screen.findByRole('alert')).textContent).toContain('UPDATE_TOGGLE_FAILED')
    expect(toggle.checked).toBe(true)
  })

  it('names the update card\'s release source without offering a selector to change it', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      pluginUpdateStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { enabled: true, packageName: '@example/freecodego', currentVersion: '1.0.0', installation: 'release' as const, releaseRepository: 'XiangSu-ce/dsh-freecodego', phase: 'idle' as const, restartRequired: false } })}
      pluginUpdateSetEnabled={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    fireEvent.click(await screen.findByText('设置'))
    const card = (await screen.findByText('FreeCodeGo 更新')).closest('section')
    expect(card).not.toBeNull()
    // The release source is stated, not chosen: there is one, and the card has
    // no control that could imply otherwise.
    expect(card?.textContent).toContain('XiangSu-ce/dsh-freecodego')
    expect(card?.querySelector('select')).toBeNull()
  })

  it('localizes the update card and its accessible switch name in English', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      pluginUpdateStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { enabled: true, packageName: '@example/freecodego', currentVersion: '1.0.0', installation: 'release' as const, releaseRepository: 'XiangSu-ce/dsh-freecodego', phase: 'up-to-date' as const, restartRequired: false } })}
      pluginUpdateSetEnabled={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="en"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    fireEvent.click(await screen.findByText('Settings'))
    expect(await screen.findByText('FreeCodeGo updates')).toBeTruthy()
    expect(screen.getByLabelText('Automatically check for FreeCodeGo updates')).toBeTruthy()
    expect(screen.getByText(/Up to date/)).toBeTruthy()
  })

  it('renders English model controls and runtime package details without Chinese fallback copy', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      codexRuntimeStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: false, platform: 'win32' } })}
      codexRuntimePackages={vi.fn().mockResolvedValue({ ok: true as const, value: [{ id: 'codex-win32', platform: 'win32', label: 'Codex for Windows', runtimeVersion: '1.0.0', sourceRevision: 'test', installDirectory: 'runtime', compatible: true, source: 'official' as const, downloadURL: 'https://example.test/codex.zip' }] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="en"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    expect(await screen.findByText('Overview')).toBeTruthy()
    expect(screen.getByText('Accounts and providers')).toBeTruthy()
    fireEvent.click(screen.getByText('installCodex'))
    expect(await screen.findByRole('dialog', { name: 'Runtime package selection' })).toBeTruthy()
    expect(screen.getByText('Choose an official platform runtime package. It is verified and installed into the Harness runtime directory after download.')).toBeTruthy()
    expect(screen.getByText(/Current platform, ready to download and install/)).toBeTruthy()
    expect(screen.getByText('Download and install')).toBeTruthy()
    expect(screen.queryByText('选择官方平台运行包。下载完成后会自动校验并安装到 Harness runtime 目录。')).toBeNull()
  })

  it('retries an automatic media default after its initial persistence attempt fails', { timeout: 15_000 }, async () => {
    const setDefaultModel = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { message: 'MEDIA_DEFAULT_SAVE_FAILED' } })
      .mockResolvedValue({ ok: true as const, value: { model: 'image-auto' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [], mediaDefaults: { image: '', video: '', audio: '' } } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: 'fixture', email: 'fixture@example.test', balance: 0 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      setDefaultModel={setDefaultModel}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'media-default-retry', models: [{ id: 'image-auto', displayName: 'Image Auto', provider: 'freecodego', protocol: 'image_generation', availability: 'available', compatibleEngines: ['deepseek'], choices: [] }] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    // Assert the behaviour, not the ordering. The first mocked call fails and
    // every later one succeeds, so whichever category the effect reaches first
    // consumes the failure and must then be retried. Pinning this to 'image'
    // made the test depend on which category happened to be scheduled first —
    // an ordering detail that shifts with unrelated render timing — instead of
    // on the retry it is named for.
    await waitFor(
      () => {
        const attempts = new Map<string, number>()
        for (const [value] of setDefaultModel.mock.calls) {
          if (typeof value !== 'string') continue
          const match = /^__freecodego_media_default__:([a-z]+):/u.exec(value)
          if (match === null) continue
          attempts.set(match[1]!, (attempts.get(match[1]!) ?? 0) + 1)
        }
        expect([...attempts.values()].some(count => count >= 2)).toBe(true)
      },
      { timeout: 10_000 },
    )
  })

  it('waits for the capability snapshot before automatically persisting media defaults', async () => {
    const capabilityResult = Promise.withResolvers<{ readonly ok: true; readonly value: { readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly voiceInputEnabled: boolean; readonly sessionDeleteEnabled: boolean; readonly modelCategories: Record<string, never>; readonly mcpServers: readonly []; readonly skillRoots: readonly []; readonly mcpTools: readonly []; readonly skills: readonly [] } }>()
    const setDefaultModel = vi.fn().mockResolvedValue({ ok: true as const, value: { model: 'agnes-image-2.5-flash' } })
    const backendCatalog = vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'capability-gate', models: [{ id: 'image-auto', displayName: 'Image Auto', provider: 'freecodego', protocol: 'image_generation', availability: 'available', compatibleEngines: ['deepseek'], choices: [] }] } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [], mediaDefaults: { image: '', video: '', audio: '' } } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: 'fixture', email: 'fixture@example.test', balance: 0 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      setDefaultModel={setDefaultModel}
      capabilities={vi.fn(() => capabilityResult.promise)}
      backendCatalog={backendCatalog}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    await waitFor(() => { expect(backendCatalog).toHaveBeenCalled() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(setDefaultModel).not.toHaveBeenCalled()
    capabilityResult.resolve({ ok: true, value: { mcpEnabled: false, skillEnabled: false, voiceInputEnabled: true, sessionDeleteEnabled: true, modelCategories: {}, mcpServers: [], skillRoots: [], mcpTools: [], skills: [] } })
    await waitFor(() => { expect(setDefaultModel).toHaveBeenCalled() })
  })

  it('honors a persisted manual category override before selecting media defaults', async () => {
    const setDefaultModel = vi.fn().mockResolvedValue({ ok: true as const, value: { model: 'image-protocol' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [], mediaDefaults: { image: '', video: '', audio: '' } } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      setDefaultModel={setDefaultModel}
      capabilities={vi.fn().mockResolvedValue({ ok: true as const, value: { mcpEnabled: false, skillEnabled: false, voiceInputEnabled: true, sessionDeleteEnabled: true, modelCategories: { 'freecodego\u0000image-protocol': 'text' as const }, mcpServers: [], skillRoots: [], mcpTools: [], skills: [] } })}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'manual-category', models: [{ id: 'image-protocol', displayName: 'Image Protocol', provider: 'freecodego', protocol: 'image_generation', availability: 'available', compatibleEngines: ['deepseek'], choices: [] }] } })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)

    await waitFor(() => { expect(screen.getAllByText('FreeCodeGo').length).toBeGreaterThan(0) })
    expect(setDefaultModel).not.toHaveBeenCalledWith('__freecodego_media_default__:image:image-protocol')
  })

  it('derives the real QQ avatar endpoint when the backend has no stored avatar', async () => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: '001', email: '3527566745@qq.com', balance: 12 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      backendCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { catalogRevision: 'test', models: [] } })}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    await waitFor(() => { expect(screen.getByText('3527566745@qq.com')).toBeTruthy() })
    const avatar = screen.getByRole('img', { name: 'QQ 邮箱账户' })
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://q1.qlogo.cn/g?b=qq&nk=3527566745&s=160')
  })

  it('clears a stale restart banner after the Host reconnects', async () => {
    const communityInstalled = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { installed: { '@example/plugin': '1.0.0' }, activation: { '@example/plugin': { state: 'restart' } } } })
      .mockResolvedValue({ ok: true as const, value: { installed: { '@example/plugin': '1.0.0' }, activation: { '@example/plugin': { state: 'live' } } } })
    render(<CommunityPluginsPage
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [{ name: 'Example', owner: 'example', url: 'https://github.com/example/plugin', category: 'developer tools', npm: '@example/plugin' }] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: true, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={communityInstalled}
      communityInstall={vi.fn()}
      capabilityMarketplace={vi.fn()}
      mcpPresetInstall={vi.fn()}
      skillPresetInstall={vi.fn()}
      language="zh"
    />)
    // The pre-restart snapshot renders the banner…
    const banner = '插件安装或卸载后，部分改动需要重启 Harness 才会生效。'
    await waitFor(() => { expect(screen.queryByText(banner)).not.toBeNull() })
    // …and the page keeps asking the small installation endpoint until the new
    // Host reports every package live. Asserting the poll count before the
    // banner is gone is the point of the case: a page that renders the stale
    // snapshot once and never re-checks would satisfy the removal assertion by
    // never having shown the banner at all.
    await waitFor(() => { expect(communityInstalled.mock.calls.length).toBeGreaterThan(1) })
    await waitFor(() => { expect(screen.queryByText(banner)).toBeNull() })
  })

  // The overview account card is a two-mode surface now: sign in, or create
  // the account with an emailed code. Login mode must not carry the
  // registration controls, and the code button must count down before it can
  // be pressed again.
  it('switches the account card between signing in and registering', async () => {
    const labels: Record<string, string> = { login: '登录', register: '注册', email: '邮箱', password: '密码', verifyCode: '验证码', sendVerifyCode: '发送验证码', rememberLogin: '保持登录状态（重启后不用重新登录）' }
    const login = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'ACCOUNT_LOGIN_REJECTED' } })
    const register = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'ACCOUNT_REGISTER_REJECTED' } })
    const sendVerifyCode = vi.fn().mockResolvedValue({ ok: true as const, value: { countdown: 45 } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'signed-out' as const } })}
      login={login as never}
      register={register as never}
      sendVerifyCode={sendVerifyCode as never}
      logout={vi.fn()}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => (labels[key] ?? key) as never}
    />)
    expect(await screen.findByText('登录 FreeCodeGo')).toBeTruthy()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['登录', '注册'])
    // Signing in owns the two credential fields only.
    expect(screen.queryByText('发送验证码')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'me@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret' } })
    // The tab is a role=tab, so this resolves to the form's own submit button.
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    // The unchecked keep-signed-in box travels with the login call: it is the
    // whole wire contract that makes the Host hold the session in memory only.
    await waitFor(() => { expect(login).toHaveBeenCalledWith('me@example.com', 'secret', false) })

    fireEvent.click(screen.getByRole('tab', { name: '注册' }))
    fireEvent.change(screen.getByPlaceholderText('验证码'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    // The address typed in login mode is the one the code is sent to.
    await waitFor(() => { expect(sendVerifyCode).toHaveBeenCalledWith('me@example.com') })
    await waitFor(() => { expect(screen.getByRole('button', { name: /^\d+s$/ }).hasAttribute('disabled')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }))
    await waitFor(() => { expect(register).toHaveBeenCalledWith({ email: 'me@example.com', password: 'secret', verifyCode: '654321' }) })
  })

  // Google / GitHub are wired end to end from the card. Until the Host exposes
  // its provider endpoints the remote rejects with OAUTH_NOT_WIRED, which the
  // card has to explain in place — not by staying decorative or by looking like
  // a rejected credential.
  it('routes the Google and GitHub buttons through the OAuth remote', async () => {
    const oauthLogin = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'OAUTH_NOT_WIRED:google' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'signed-out' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      oauthLogin={oauthLogin as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    const google = await screen.findByRole('button', { name: 'Google' })
    // Real, reachable controls: the row is no longer an aria-hidden decoration.
    expect(google.hasAttribute('aria-hidden')).toBe(false)
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeTruthy()
    fireEvent.click(google)
    await waitFor(() => { expect(oauthLogin).toHaveBeenCalledWith('google') })
    expect((await screen.findByText(/尚未接入/)).textContent).toContain('Google')
  })

  // The paying user has to land on the console's result page. The bare
  // `/payment/result` path on freecodego.com is served by the marketing site,
  // so the return target carries the console mount, and the visible handoff
  // link has to agree with the URL the panel auto-opens.
  it('sends the checkout the console-qualified payment target', async () => {
    const labels: Record<string, string> = { checkout: '购买', openCheckout: '打开支付页', processing: '处理中…' }
    const paymentCheckout = vi.fn().mockResolvedValue({ ok: true as const, value: {
      orderId: '77', amount: 5, currency: 'CNY', state: 'pending',
      checkoutUrl: 'https://freecodego.com/rootadmin/payment/result?order_id=77', outTradeNo: 'out-77',
    } })
    vi.spyOn(globalThis, 'open').mockReturnValue(null)
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: 'me', email: 'me@example.com', balance: 10 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [{ id: 1, name: 'US$5 Developer Credit', price: 5, currency: 'USD' }] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [{ paymentType: 'alipay', currency: 'CNY', balanceRechargeMultiplier: 0.14 }] })}
      paymentCheckout={paymentCheckout as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => (labels[key] ?? key) as never}
    />)
    fireEvent.click(await screen.findByRole('button', { name: /^购买/ }))
    await waitFor(() => { expect(paymentCheckout).toHaveBeenCalledWith(0, 'alipay', 'https://freecodego.com/rootadmin/payment/result', expect.any(Number)) })
    // The console's public payment route is a legitimate handoff, so the page
    // stays one click away instead of being swallowed as an unsafe URL.
    const link = await screen.findByRole('link', { name: '打开支付页' })
    expect(link.getAttribute('href')).toBe('https://freecodego.com/rootadmin/payment/result?order_id=77')
  })

  // The console also hosts administrator-only pages. Those must never become a
  // clickable handoff, and the user has to be told the order has no usable
  // payment page rather than being left with a dead link.
  it('refuses to surface an administrator-only console page as a checkout link', async () => {
    const labels: Record<string, string> = { checkout: '购买', openCheckout: '打开支付页', processing: '处理中…' }
    const paymentCheckout = vi.fn().mockResolvedValue({ ok: true as const, value: {
      orderId: '78', amount: 5, currency: 'CNY', state: 'pending',
      checkoutUrl: 'https://freecodego.com/rootadmin/orders/78',
    } })
    vi.spyOn(globalThis, 'open').mockReturnValue(null)
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: 'me', email: 'me@example.com', balance: 10 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: [{ id: 1, name: 'US$5 Developer Credit', price: 5, currency: 'USD' }] })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [{ paymentType: 'alipay', currency: 'CNY', balanceRechargeMultiplier: 0.14 }] })}
      paymentCheckout={paymentCheckout as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => (labels[key] ?? key) as never}
    />)
    fireEvent.click(await screen.findByRole('button', { name: /^购买/ }))
    await waitFor(() => { expect(paymentCheckout).toHaveBeenCalled() })
    // The order now opens the in-panel payment dialog, so the guard is checked
    // there: an admin-only console URL is neither linked nor claimed, and the
    // dialog names the missing piece instead of rendering a dead surface.
    expect(screen.queryByRole('link', { name: '打开支付页' })).toBeNull()
    expect(await screen.findByText(/没有返回可用于支付的信息/)).toBeTruthy()
  })
})

describe('subscription tiers', () => {
  // The backend describes every tier it sells (description, features, list
  // price, validity) and each of those has to reach the plate. The regression:
  // the card read only name + price and printed the same two hardcoded bullets
  // for all tiers, so two tiers the backend had described differently rendered
  // identically and the section read as an empty price list.
  const renderTiers = async (plans: readonly Record<string, unknown>[]): Promise<void> => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: 'me', email: 'me@example.com', balance: 10 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      paymentPlans={vi.fn().mockResolvedValue({ ok: true as const, value: plans })}
      paymentChannels={vi.fn().mockResolvedValue({ ok: true as const, value: [{ paymentType: 'alipay', currency: 'CNY', balanceRechargeMultiplier: 0.14 }] })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    // One plate per sellable tier, each carrying the price caption.
    await waitFor(() => { expect(screen.getAllByText('到账额度')).toHaveLength(plans.length) })
  }

  it('carries each backend tier field through to its plate', async () => {
    await renderTiers([
      { id: 1, name: 'US$5 Developer Credit', description: '入门档', price: 5, currency: 'USD', features: ['never expires'], validityDays: 30, validityUnit: 'days' },
      { id: 2, name: 'US$20 Developer Credit', description: '主力档', price: 20, originalPrice: 30, currency: 'USD', features: ['priority routing'], validityDays: 90, validityUnit: 'days' },
    ])
    // The backend's own bullets, run through the same localization pass as the
    // plan name: a known phrase is translated, an unknown one is echoed rather
    // than dropped.
    expect(screen.getByText('余额永久有效')).toBeTruthy()
    expect(screen.getByText('priority routing')).toBeTruthy()
    expect(screen.getByText('入门档')).toBeTruthy()
    expect(screen.getByText('主力档')).toBeTruthy()
    // Validity is a fact the backend declared, not a constant this client typed.
    expect(screen.getByText('有效期 30 天')).toBeTruthy()
    expect(screen.getByText('有效期 90 天')).toBeTruthy()
    // The name and the markdown carry the current and the original price.
    expect(screen.getByText('US$20.00')).toBeTruthy()
    expect(screen.getByText('US$30.00')).toBeTruthy()
    expect(screen.getByText('省 33%')).toBeTruthy()
  })

  it('reads permanence from the declared unit, never from a day count', async () => {
    // Balance credit is permanent after purchase, and the ladder declares it as
    // `validityUnit: 'forever'` with no day count. The backend's `validity_days`
    // column defaults to 30 for a different product shape, so a plan carrying
    // both fields must still read as permanent rather than as a 30-day term.
    await renderTiers([
      { id: 1, name: 'Ladder Credit', price: 5, currency: 'USD', validityUnit: 'forever' },
      { id: 2, name: 'Both Fields', price: 10, currency: 'USD', validityUnit: 'forever', validityDays: 30 },
    ])
    // Two tiers that declare the same only line show it once, as the ladder's
    // shared note: the bullet list under the grid is where a line every tier
    // carries belongs, and repeating it inside both cards is what made the
    // ladder look like filler. The fact under test is unchanged — neither tier
    // reads as a 30-day term — so the count here is the shared rendering.
    expect(screen.getAllByText('购买后永久有效')).toHaveLength(1)
    expect(screen.queryByText(/有效期 \d+ 天/)).toBeNull()
  })

  it('falls back to the shared bullets only when the backend declared none', async () => {
    await renderTiers([{ id: 1, name: 'US$5 Developer Credit', price: 5, currency: 'USD' }])
    expect(screen.getByText('永久有效')).toBeTruthy()
    expect(screen.getByText('支持后续叠加充值')).toBeTruthy()
    // And it invents nothing: no validity, no check-in, no strike-through for a
    // tier that declared none of them.
    expect(screen.queryByText(/有效期/)).toBeNull()
    expect(screen.queryByText(/省 \d+%/)).toBeNull()
  })

  it('shows no markdown for an original price that is not a markdown', async () => {
    // `originalPrice` is the backend's list price. When it equals the price, or
    // sits below it, printing it struck through would misstate the offer, so
    // both the strike-through and the badge stay off. The assertions are scoped
    // to each plate because the account balance elsewhere on the page prints a
    // currency figure of its own.
    await renderTiers([
      { id: 1, name: 'equal', price: 20, originalPrice: 20, currency: 'USD' },
      { id: 2, name: 'lower', price: 20, originalPrice: 10, currency: 'USD' },
      // A real `original > price` pair whose markdown still rounds to zero: the
      // third case, and the only one that reaches the rounding guard, so a badge
      // reading "省 0%" is the failure this fixture exists to catch.
      { id: 3, name: 'rounding', price: 999.5, originalPrice: 1000, currency: 'USD' },
    ])
    const equal = screen.getByText('equal').closest('article') as HTMLElement
    const lower = screen.getByText('lower').closest('article') as HTMLElement
    const rounding = screen.getByText('rounding').closest('article') as HTMLElement
    for (const plate of [equal, lower, rounding]) {
      expect(within(plate).queryByText(/省 \d+%/)).toBeNull()
    }
    expect(within(equal).getByText('US$20.00')).toBeTruthy()
    // The lower original is not re-printed as a strike-through, and the equal one
    // is not struck through either.
    expect(within(lower).queryByText('US$10.00')).toBeNull()
    expect(within(equal).queryByText('US$20.00')).not.toBeNull()
    expect(within(rounding).getByText('US$999.50')).toBeTruthy()
  })
})

describe('pricing table groups', () => {
  // A row is what the host builds per `(model, group)` from `/models/options`:
  // the group name is the backend's own and the rate is the account's own, so
  // nothing here may re-derive either one.
  const price = (modelId: string, groupName: string, rateMultiplier: number, input: number): GatewayModelPrice => ({
    modelId, displayName: modelId, provider: 'openai', source: 'gateway', groupName, rateMultiplier,
    billingMode: 'token', currency: 'USD', inputPricePerMillion: input, outputPricePerMillion: input * 3,
  })

  it('keeps one row per priced group, each with its own rate', () => {
    // The regression: the table collapsed a model into the single cheapest
    // tariff, so a model sold through two groups showed one row and the other
    // group's name and rate never reached the table at all.
    const rows = pricingRows([
      price('gpt-5.6', '后端分组乙', 0.5, 5),
      price('gpt-5.6', '后端分组·免费', 0, 0),
    ])
    expect(rows.map(row => [row.modelId, row.groupName, row.rateMultiplier])).toEqual([
      ['gpt-5.6', '后端分组·免费', 0],
      ['gpt-5.6', '后端分组乙', 0.5],
    ])
  })

  it('still folds byte-identical rows and orders groups cheapest first', () => {
    const rows = pricingRows([
      price('glm-5.3', '后端分组乙', 0.5, 5),
      price('gpt-5.6', '后端分组乙', 0.5, 5),
      price('gpt-5.6', '后端分组乙', 0.5, 5),
    ])
    expect(rows.map(row => row.modelId)).toEqual(['glm-5.3', 'gpt-5.6'])
  })

  it('keeps two tariffs of one printed group name apart, cheapest first', () => {
    // A group's *name* is not its identity: the backend identifies a group by its
    // `group_id` and the table prints the name. Folding rows by the printed name
    // therefore merged two different tariffs — a zero-price promotion beside the
    // same group's paid route, or two account groups the backend names alike —
    // and kept whichever arrived last, so the table showed one of the two prices
    // with no way to tell which one a request would be charged.
    const rows = pricingRows([
      price('gpt-5.6', '后端分组乙', 1, 5),
      price('gpt-5.6', '后端分组乙', 0, 0),
    ])
    expect(rows.map(row => [row.groupName, row.rateMultiplier])).toEqual([
      ['后端分组乙', 0],
      ['后端分组乙', 1],
    ])
  })

  it('addresses every rendered row uniquely, whatever the group names are', () => {
    // React reuses a list by key, so a key that two rendered rows share is not a
    // cosmetic problem: the second row can paint over the first one's cells. The
    // price table builds its key from the same identity it folds on, so this is
    // the property that the fold has to hold.
    const rows = pricingRows([
      price('gpt-5.6', '后端分组乙', 1, 5),
      price('gpt-5.6', '后端分组乙', 0, 0),
      price('gpt-5.6', '后端分组甲', 0.5, 3),
      { ...price('gpt-image-2', '后端分组乙', 1, 0), billingMode: 'image', imagePrices: [{ label: '1K', price: 0.03 }] },
      { ...price('gpt-image-2', '后端分组乙', 1, 0), billingMode: 'image', imagePrices: [{ label: '1K', price: 0.12 }] },
    ])
    expect(rows.length).toBe(5)
    expect(new Set(rows.map(pricingRowKey)).size).toBe(rows.length)
  })

  it('reads the backend group name, falling back to the source only when it is empty', () => {
    expect(pricingGroupName(price('gpt-5.6', '后端分组乙', 0.5, 5), 'zh')).toBe('后端分组乙')
    expect(pricingGroupName({ ...price('deepseek-v4.1', '', 0, 0), source: 'vyce' }, 'zh')).toBe('VyceAI（签到额度抵扣）')
  })

  it('shows the group rate beside its name and reads zero as free', () => {
    expect(pricingGroupRate(price('gpt-5.6', '后端分组乙', 0.5, 5), 'zh')).toBe('×0.5')
    expect(pricingGroupRate(price('gpt-5.6', '后端分组·免费', 0, 0), 'zh')).toBe('免费')
  })
})

describe('gateway price table recovery', () => {
  // The failure the shipped build printed verbatim in the pricing panel.
  const transportFailure = 'client api: freeCodeGoHarness/gatewayModelPrices failed: transport failure for /api/freeCodeGoHarness/gatewayModelPrices: HTTP 404'
  const settingsCacheKey = 'freecodego:settings-cache:v1:zh'
  const row = (modelId: string, displayName: string): GatewayModelPrice => ({
    modelId, displayName, provider: 'openai', source: 'gateway', groupName: '后端分组乙', rateMultiplier: 1,
    billingMode: 'token', currency: 'USD', inputPricePerMillion: 5, outputPricePerMillion: 15,
  })

  const renderTab = async (overrides: {
    readonly gatewayModelPrices: (...args: never[]) => unknown
    readonly connectionEpoch?: unknown
  }): Promise<void> => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated' as const, user: { username: '001', email: 'user@example.com', balance: 12 } } })}
      login={vi.fn()}
      logout={vi.fn()}
      gatewayModelPrices={overrides.gatewayModelPrices as never}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={(overrides.connectionEpoch ?? bindSnapshotSelector(createSnapshotStore(0))) as never}
      t={(key: string) => key as never}
    />)
  }

  it('clears the pricing notice once the tariff read succeeds again', async () => {
    // A reconnect re-reads the tariff. The notice reports the last read, not a
    // permanent property of the endpoint, so it has to go when the read recovers —
    // keeping it pinned "pricing unavailable" on screen for the life of the panel.
    const epoch = createSnapshotStore(0)
    const gatewayModelPrices = vi.fn()
      .mockRejectedValueOnce(new Error(transportFailure))
      .mockResolvedValue({ ok: true as const, value: [row('glm-5.3', 'GLM 5.3')] })
    await renderTab({ gatewayModelPrices, connectionEpoch: bindSnapshotSelector(epoch) })
    expect(await screen.findByText(/价格表暂不可用/)).toBeTruthy()

    await act(async () => { epoch.set(1) })

    await waitFor(() => { expect(screen.queryByText(/价格表暂不可用/)).toBeNull() })
    expect(screen.getByText('glm-5.3')).toBeTruthy()
  })

  it('shows an image model by the picture, not by token columns it never charges', async () => {
    // The regression: `image` was not a billing mode on this side, so the
    // backend's `billing_mode: 'image'` row fell through to the token columns.
    // gpt-image-2 rendered four dashes under 输入/输出/缓存读/缓存写 while the
    // backend was charging a per-picture price the account could not see.
    const imageRow: GatewayModelPrice = {
      modelId: 'gpt-image-2', displayName: 'GPT Image 2', provider: 'openai', source: 'gateway',
      groupName: 'OpenAi', rateMultiplier: 0.5, billingMode: 'image', currency: 'USD',
      imagePrices: [
        { label: '1K', price: 0.015, originalPrice: 0.03 },
        { label: '2K', price: 0.03, originalPrice: 0.06 },
        { label: '4K', price: 0.06, originalPrice: 0.12 },
      ],
    }
    await renderTab({ gatewayModelPrices: vi.fn().mockResolvedValue({ ok: true as const, value: [imageRow] }) })

    await waitFor(() => { expect(screen.getByText('GPT Image 2')).toBeTruthy() })
    expect(screen.getByText('按张')).toBeTruthy()
    for (const label of ['1K', '2K', '4K']) expect(screen.getByText(label)).toBeTruthy()
    // Each tier shows the rate-adjusted price and strikes through the unit price
    // it came from, in the row's own currency. The 2K and 4K current prices are
    // also the 1K and 2K unit prices, hence two of each.
    expect(screen.getAllByText('US$0.015')).toHaveLength(1)
    expect(screen.getAllByText('US$0.03')).toHaveLength(2)
    expect(screen.getAllByText('US$0.06')).toHaveLength(2)
    expect(screen.getAllByText('US$0.12')).toHaveLength(1)
  })

  it('does not replay a pricing failure an earlier visit persisted', async () => {
    // A successful visit writes the cache, and this poisons it the way the shipped
    // build did: `saveSettingsCache` kept `gatewayPricingError` beside the prices, so
    // a browser that hit one 404 re-rendered that 404 on every later visit.
    await renderTab({ gatewayModelPrices: vi.fn().mockResolvedValue({ ok: true as const, value: [row('glm-5.3', 'GLM 5.3')] }) })
    await waitFor(() => { expect(screen.getByText('glm-5.3')).toBeTruthy() })
    const stored = JSON.parse(globalThis.localStorage.getItem(settingsCacheKey) ?? '{}') as { state: Record<string, unknown> }
    stored.state.gatewayPricingError = transportFailure
    globalThis.localStorage.setItem(settingsCacheKey, JSON.stringify(stored))
    cleanup()

    // The tariff stays pending on this visit, so nothing else can take the notice down.
    await renderTab({ gatewayModelPrices: vi.fn(() => new Promise<never>(() => undefined)) })

    await waitFor(() => { expect(screen.getByText('glm-5.3')).toBeTruthy() })
    expect(screen.queryByText(/价格表暂不可用/)).toBeNull()
  })
})

describe('model picker grouping', () => {
  // Real shape of a gateway row from the persisted managed catalog. The route
  // key is what the Host sends on the wire; it is not a name a user reads.
  const gateway = (id: string, groupId: number | undefined, multiplier: number | undefined) => ({
    id, displayName: id, provider: 'freecodego-cloud', protocol: 'openai_responses',
    availability: 'available', compatibleEngines: [],
    choices: [{ routeKey: `group:${String(groupId)}:${id}`, label: `group:${String(groupId)}:${id}`, availability: 'available', compatibleEngines: [], ...(groupId === undefined ? {} : { groupId }), ...(multiplier === undefined ? {} : { rateMultiplier: multiplier }) }],
  })
  const providerRow = (id: string, provider: string, label: string) => ({
    id, displayName: id, provider, protocol: 'image_generation',
    availability: 'available', compatibleEngines: [],
    choices: [{ routeKey: id, label, availability: 'available', compatibleEngines: [] }],
  })
  // The account's groups exactly as `/models/options` reports them: the sort
  // order is the backend's, and the rate is already the account's own.
  const groups = [
    { id: 7, name: '后端分组·免费', enabled: true, rateMultiplier: 0, sortOrder: 2 },
    { id: 4, name: '后端分组乙', enabled: true, rateMultiplier: 0.5, sortOrder: 1 },
  ]

  it('heads a grouped model with the backend group name, never its route key', () => {
    const rows = modelGroupRows([gateway('gpt-5.6-terra', 4, 0.5)], groups)
    expect(rows.map(([label]) => label)).toEqual(['后端分组乙'])
    // The regression: the heading used to come from `choices[0].label`, which on
    // the wire is the full route key, so every entry read as a routing id.
    expect(rows[0]![0]).not.toContain('group:')
    expect(rows[0]![0]).not.toContain('openai_responses')
  })

  it('names the backend default group so the unpinned route is inspectable', () => {
    // Routing follows `groups[].default` and no longer ranks groups by price, so
    // "which group serves when I picked no row" is a rule the settings surface
    // has to state — otherwise the only way to learn it is a wrong bill.
    expect(backendDefaultGroupName([...groups, { id: 9, name: '后端分组默认', enabled: true, default: true, sortOrder: 3 }])).toBe('后端分组默认')
    // No declaration is a real state: the picker's own group rows then decide.
    expect(backendDefaultGroupName(groups)).toBeUndefined()
    expect(backendDefaultGroupName()).toBeUndefined()
  })

  it('orders groups by the backend sort order rather than first appearance', () => {
    const rows = modelGroupRows([gateway('gpt-5.6-terra', 4, 0.5), gateway('glm-5.3', 7, 0)], groups)
    expect(rows.map(([label]) => label)).toEqual(['后端分组乙', '后端分组·免费'])
  })

  it('lists one row per group, so a model offered twice shows both rates', () => {
    const rows = modelGroupRows([gateway('gpt-5.6-terra', 4, 0.5), gateway('gpt-5.6-terra', 7, 0)], groups)
    expect(rows.map(([label]) => label)).toEqual(['后端分组乙', '后端分组·免费'])
    const [developer, free] = rows
    expect(developer![1][0]!.rateMultiplier).toBe(0.5)
    expect(free![1][0]!.zeroPrice).toBe(true)
    // Two rows, two identities: a shared key would let React reuse the wrong row.
    expect(developer![1][0]!.key).not.toBe(free![1][0]!.key)
  })

  it('takes the row rate from the group rather than the per-choice multiplier', () => {
    // The backend folds the account's override into the group rate, so a row
    // reading the raw choice rate would show the list price instead.
    const rows = modelGroupRows([gateway('gpt-5.6-terra', 4, 1)], groups)
    expect(rows[0]![1][0]!.rateMultiplier).toBe(0.5)
  })

  it('keeps catalog order inside a group', () => {
    const rows = modelGroupRows([gateway('gpt-5.5', 4, 0.5), gateway('gpt-5.6-terra', 4, 0.5)], groups)
    expect(rows.map(([label]) => label)).toEqual(['后端分组乙'])
    expect(rows[0]![1].map(row => row.model.id)).toEqual(['gpt-5.5', 'gpt-5.6-terra'])
  })

  it('heads rows the backend never grouped with their provider', () => {
    // logfare and Agnes rows carry no groupId, and their label is a display
    // string rather than a route key — the provider is the honest heading, and
    // the route key must still never leak into a heading.
    const rows = modelGroupRows([
      providerRow('logfare/flux-2-dev', 'logfare', 'logfare'),
      providerRow('mystery-1', 'mystery', 'model:weird:route'),
    ], groups)
    expect(rows.map(([label]) => label)).toEqual(['logfare', 'mystery'])
    expect(rows.map(([label]) => label).join(' ')).not.toContain('model:')
  })

  it('falls back to the choice group name when the group list is absent', () => {
    // A catalog cached before the backend published `groups[]` still carries the
    // per-choice group name; a nameless group must not borrow a route key.
    const model = { ...gateway('gpt-5.6-terra', 4, 0.5), choices: [{ routeKey: 'group:4:gpt-5.6-terra', label: 'group:4:gpt-5.6-terra', availability: 'available', compatibleEngines: [], groupId: 4, groupName: '后端分组乙', rateMultiplier: 0.5 }] }
    expect(modelGroupRows([model as never])[0]![0]).toBe('后端分组乙')
    const nameless = { ...model, choices: [{ routeKey: 'group:4:x', label: 'group:4:x', availability: 'available', compatibleEngines: [], groupId: 4 }] }
    expect(modelGroupRows([nameless as never])[0]![0]).toBe('freecodego-cloud')
  })

  it('labels an ungrouped model by its provider name when it has one', () => {
    expect(modelGroupLabel({ ...providerRow('whisper-large-v3-turbo', 'groq', 'Groq 免费语音转文本'), providerName: 'Groq' })).toBe('Groq')
    // With neither a group nor a provider name, the provider id is still the
    // honest label — reaching for the legacy choice label is what leaked keys.
    expect(modelGroupLabel(providerRow('mystery-1', 'mystery', 'model:weird:route') as never)).toBe('mystery')
  })
})

describe('headroom panel controls', () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    enabled: true, dedupEnabled: true, foldReads: false, codeSkeletonEnabled: true, compressions: 3,
    originalBytes: 2048, compressedBytes: 512, logCompressions: 2, jsonCompressions: 1,
    diffCompressions: 0, searchCompressions: 0, proseCompressions: 0, htmlCompressions: 0,
    tabularCompressions: 0, configCompressions: 0, losslessCompressions: 0, dedupCompressions: 0,
    codeSkeletonCompressions: 0,
    protectedCount: 0, ccrEntries: 1, ccrBytes: 400, retrievals: 0, retrieveMisses: 0,
    provenance: 'test', portVersion: 1, upstreamRevision: 'test', ...over,
  })
  // The update remote must resolve a RemoteResult: the panel chains `.then`
  // on it, so a bare `vi.fn()` would throw an unhandled rejection and poison
  // every later test in this file.
  const renderPanel = async (over: Record<string, unknown> = {}, update = vi.fn().mockImplementation((patch: Record<string, unknown>) => Promise.resolve({ ok: true as const, value: stats({ ...over, ...patch }) }))): Promise<typeof update> => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      headroomStatus={vi.fn().mockResolvedValue({ ok: true as const, value: stats(over) })}
      headroomSetEnabled={vi.fn().mockResolvedValue({ ok: true as const, value: stats(over) })}
      headroomUpdate={update}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('设置'))
    await screen.findByLabelText('文件读取无损折叠')
    await screen.findByLabelText('代码文件骨架化')
    return update
  }

  it('renders the read-fold switch from the value the Host reports', async () => {
    await renderPanel({ foldReads: false })
    expect((screen.getByLabelText('文件读取无损折叠') as HTMLInputElement).checked).toBe(false)
  })

  it('shows the read-fold switch as on once the Host reports it on', async () => {
    // The regression: status() omitted the field, the panel read `undefined`,
    // and the switch rendered off no matter what had been saved.
    await renderPanel({ foldReads: true })
    expect((screen.getByLabelText('文件读取无损折叠') as HTMLInputElement).checked).toBe(true)
  })

  it('writes the read-fold switch through the update remote', async () => {
    const update = await renderPanel({ foldReads: false })
    fireEvent.click(screen.getByLabelText('文件读取无损折叠'))
    await waitFor(() => { expect(update).toHaveBeenCalledWith({ foldReads: true }) })
  })

  it('renders the dedup switch from the reported value rather than assuming on', async () => {
    await renderPanel({ dedupEnabled: false })
    expect((screen.getByLabelText('跨回合去重') as HTMLInputElement).checked).toBe(false)
  })

  it('leads with four headline figures instead of a wall of zeroes', async () => {
    await renderPanel()
    // The four the reader can act on, all present without expanding anything.
    expect(screen.getByText('已压缩工具输出')).toBeTruthy()
    expect(screen.getByText('节省')).toBeTruthy()
    // `3` compressions and a 2 KB → 512 B saving: 75%.
    expect(screen.getByText('1.5 KB · 75%')).toBeTruthy()
  })

  it('collapses the per-compressor breakdown, naming only the kinds that fired', async () => {
    await renderPanel()
    // Two of ten compressors ran (log + json), so the summary says so. The
    // breakdown is behind a <details>, which is what keeps fourteen rows from
    // pushing the explanation off-screen.
    const summary = screen.getByText('压缩器明细（11 类中 2 类命中）')
    expect(summary).toBeTruthy()
    const details = summary.closest('details')
    expect(details?.open).toBe(false)
    // The idle chips are inside that collapsed disclosure, not loose on the page.
    expect(details?.textContent).toContain('表格')
  })

  it('marks the compressors that fired apart from the ones that never ran', async () => {
    await renderPanel()
    const chips = [...document.querySelectorAll('[class*="statChip"]')]
    const fired = chips.filter(chip => !/statChipIdle/.test(chip.className)).map(chip => chip.textContent)
    // Only log and json ran; everything else is de-emphasised.
    expect(fired.some(text => text?.startsWith('日志'))).toBe(true)
    expect(fired.some(text => text?.startsWith('JSON'))).toBe(true)
    expect(fired.some(text => text?.startsWith('表格'))).toBe(false)
  })

  it('renders the code-skeleton switch as on when the Host reports its default', async () => {
    // Unlike the read-fold knob this one ships on, so a panel that assumed off
    // would show the user a switch contradicting the running behaviour.
    await renderPanel()
    expect((screen.getByLabelText('代码文件骨架化') as HTMLInputElement).checked).toBe(true)
  })

  it('renders the code-skeleton switch as off once the user turned it off', async () => {
    await renderPanel({ codeSkeletonEnabled: false })
    expect((screen.getByLabelText('代码文件骨架化') as HTMLInputElement).checked).toBe(false)
  })

  it('writes the code-skeleton switch through the update remote', async () => {
    const update = await renderPanel({ codeSkeletonEnabled: true })
    fireEvent.click(screen.getByLabelText('代码文件骨架化'))
    await waitFor(() => { expect(update).toHaveBeenCalledWith({ codeSkeletonEnabled: false }) })
  })

  it('explains what the skeleton keeps, so the switch is not a blind lever', async () => {
    await renderPanel()
    // The description has to name the safety contract: retained lines stay
    // byte-exact, which is why Edit still matches after a skeleton is applied.
    const label = screen.getByText('代码文件骨架化（收益最大）')
    const row = label.closest('label')
    expect(row?.textContent).toContain('逐字节原文')
    expect(row?.textContent).toContain('headroom_retrieve')
  })

  it('lists the code skeleton among the compressors once it has fired', async () => {
    await renderPanel({ codeSkeletonCompressions: 4 })
    const chips = [...document.querySelectorAll('[class*="statChip"]')]
    const fired = chips.filter(chip => !/statChipIdle/.test(chip.className)).map(chip => chip.textContent)
    expect(fired.some(text => text?.startsWith('代码骨架'))).toBe(true)
  })

  it('says plainly when no compressor has fired yet', async () => {
    await renderPanel({ compressions: 0, logCompressions: 0, jsonCompressions: 0, originalBytes: 0, compressedBytes: 0, ccrEntries: 0, ccrBytes: 0 })
    expect(screen.getByText('压缩器明细（尚未压缩过任何输出）')).toBeTruthy()
  })
})

describe('team panel', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    teams: 1,
    members: 2,
    contextControl: true,
    roles: [
      { id: 'explorer', title: 'Explorer', purpose: 'Map the code before anyone edits.', notResponsibleFor: 'It does not implement.', capabilities: ['read'], sandbox: 'read-only', maxTurns: 6 },
      { id: 'implementer', title: 'Implementer', purpose: 'Complete one claimed task in its own worktree.', notResponsibleFor: 'It does not declare itself verified.', capabilities: ['read', 'write', 'execute'], sandbox: 'workspace-write', maxTurns: 30 },
    ],
    ...over,
  })
  const renderPanel = async (over: Record<string, unknown> = {}): Promise<void> => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      teamStatus={vi.fn().mockResolvedValue({ ok: true as const, value: status(over) })}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('设置'))
    await screen.findByText('多成员协作团队')
  }

  it('renders the live team counts the Host reports', async () => {
    await renderPanel()
    expect(screen.getByText('已开启团队')).toBeTruthy()
    expect(screen.getByText('活跃成员')).toBeTruthy()
  })

  it('lists every role with what it is not responsible for', async () => {
    // The duty boundary is the reason the table exists: an implementer that can
    // verify itself is the failure a reader has to be able to check.
    await renderPanel()
    const summary = screen.getByText('角色库（2 个，可用 .freecodego/team-roles.json 覆盖）')
    expect(summary).toBeTruthy()
    const details = summary.closest('details')
    expect(details?.textContent).toContain('Explorer')
    expect(details?.textContent).toContain('不负责：')
    expect(details?.textContent).toContain('workspace-write')
  })

  it('says a read-only role stays read-only, and that a probe gate exists', async () => {
    await renderPanel()
    const details = screen.getByText('团队是怎么保证不出错的？（四条硬规则）').closest('details')
    expect(details?.textContent).toContain('只读角色拿不到写和 Shell 工具')
    expect(details?.textContent).toContain('abort')
  })

  it('reports the panel as off when the Host disabled teams', async () => {
    await renderPanel({ enabled: false })
    // Scoped to this section: several other panels carry an off badge of their
    // own, so a global text query would pass for the wrong reason.
    const section = screen.getByText(/团队不是/u).closest('section')
    expect(section?.textContent).toContain('已关闭')
  })
})

describe('engineering verification readout', () => {
  const verification = (over: Record<string, unknown> = {}) => ({
    id: 'verify_1',
    checkedAt: 1,
    stages: [{ id: 'build', state: 'pass', durationMs: 1, summary: '' }],
    ...over,
  })
  const report = (over: Record<string, unknown> = {}) => ({
    id: 'council_1', sessionId: 's', projectId: 'p', state: 'completed', createdAt: 1,
    objective: 'o', plan: 'p', rounds: 1, quorum: 3, consensus: '', dissent: '', finalRecommendation: '',
    participants: [],
    ...over,
  })

  it('reads a verified verdict as completed and anything else as blocked', () => {
    // Green stages alone used to read as completed, which is the exact reading
    // the evidence contract corrects.
    expect(engineeringTeamState(report({ verification: verification({ verdict: 'verified' }) }) as never)).toBe('completed')
    expect(engineeringTeamState(report({ verification: verification({ verdict: 'unverified' }) }) as never)).toBe('blocked')
    expect(engineeringTeamState(report({ verification: verification({ verdict: 'failed' }) }) as never)).toBe('blocked')
  })

  it('falls back to the stage scan for runs recorded before the verdict existed', () => {
    expect(engineeringTeamState(report({ verification: verification() }) as never)).toBe('completed')
    expect(engineeringTeamState(report({ verification: verification({ stages: [{ id: 'build', state: 'refused', durationMs: 1, summary: '' }] }) }) as never)).toBe('blocked')
  })

  it('names the probes and the unmet reasons, not just the stage states', () => {
    const line = engineeringVerificationLine(verification({
      verdict: 'unverified',
      probes: [{ id: 'boundary', state: 'fail', expectation: 'fail', rationale: 'guard', held: false, summary: '' }],
      unmet: ['Probe "boundary" did not hold its expectation (guard).'],
    }), true)
    expect(line).toContain('build:pass')
    expect(line).toContain('unverified')
    expect(line).toContain('boundary:未成立')
    expect(line).toContain('did not hold')
  })

  it('says plainly when no probe ran, since that is why a green run is unverified', () => {
    const line = engineeringVerificationLine(verification({ verdict: 'unverified', probes: [] }), true)
    expect(line).toContain('无对抗性探针')
  })
})

describe('deferred tool panel controls', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    deferred: [{ name: 'engineering_memory_search', chars: 800 }, { name: 'freecodego_generate_image', chars: 400 }],
    deferredChars: 1200,
    deferredTokens: 300,
    immediateChars: 2048,
    activeAgents: 0,
    ...over,
  })
  // Same RemoteResult contract as the headroom remotes: the panel chains
  // `.then` on the result, so a bare `vi.fn()` rejects and poisons the file.
  const renderPanel = async (over: Record<string, unknown> = {}, setEnabled = vi.fn().mockImplementation((enabled: boolean) => Promise.resolve({ ok: true as const, value: status({ ...over, enabled }) }))): Promise<typeof setEnabled> => {
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      deferredToolsStatus={vi.fn().mockResolvedValue({ ok: true as const, value: status(over) })}
      deferredToolsSetEnabled={setEnabled}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('设置'))
    await screen.findByLabelText('按需加载工具定义')
    return setEnabled
  }

  it('renders the switch from the value the Host reports, not from a local default', async () => {
    await renderPanel({ enabled: false })
    expect((screen.getByLabelText('按需加载工具定义') as HTMLInputElement).checked).toBe(false)
  })

  it('shows the switch on when the Host reports the shipped default', async () => {
    // The knob ships on, so a panel that assumed off would contradict the
    // behaviour the user is actually getting.
    await renderPanel()
    expect((screen.getByLabelText('按需加载工具定义') as HTMLInputElement).checked).toBe(true)
  })

  it('writes the switch through its own remote rather than the headroom one', async () => {
    const setEnabled = await renderPanel()
    fireEvent.click(screen.getByLabelText('按需加载工具定义'))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledWith(false) })
  })

  it('says how much every request stops paying, which is the whole argument', async () => {
    await renderPanel({ deferred: [{ name: 'a', chars: 400 }, { name: 'b', chars: 400 }], deferredChars: 800, deferredTokens: 200 })
    expect(screen.getByText('按需加载')).toBeTruthy()
    expect(screen.getByText('~200')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('names the deferred tools behind a collapsed disclosure', async () => {
    await renderPanel()
    const summary = screen.getByText('按需加载的工具明细（2 个，1.2 KB）')
    expect(summary.closest('details')?.open).toBe(false)
    expect(summary.closest('details')?.textContent).toContain('engineering_memory_search')
  })

  it('explains why the tool list is kept out of the description', async () => {
    // The switch changes nothing about how a tool behaves, so the panel has to
    // carry the reasoning: a dynamic list here would void the cache prefix.
    await renderPanel()
    const summary = screen.getByText('为什么不把工具清单写进说明里？（缓存纪律）')
    const details = summary.closest('details')
    expect(details?.textContent).toContain('前缀缓存')
    expect(details?.textContent).toContain('UNKNOWN_TOOL')
  })

  it('reports a refused write instead of leaving the switch silently flipped', async () => {
    // The failure path used to have no `else` branch and a catch that returned
    // `undefined`: a refused write left the switch showing the value the Host
    // had just rejected, with nothing on screen to say so.
    const statusRemote = vi.fn().mockResolvedValue({ ok: true as const, value: status({ enabled: false }) })
    const setEnabled = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'DEFERRED_TOGGLE_REFUSED' } })
    render(<FreeCodeGoSettingsTab
      {...hostStandardProps}
      close={vi.fn()}
      useSessions={vi.fn() as never}
      useWorkspaces={vi.fn() as never}
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [] } })}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'backend-not-configured' as const } })}
      login={vi.fn()}
      logout={vi.fn()}
      deferredToolsStatus={statusRemote}
      deferredToolsSetEnabled={setEnabled}
      communityCatalog={vi.fn().mockResolvedValue({ ok: true as const, value: { plugins: [] } })}
      communityEnvironment={vi.fn().mockResolvedValue({ ok: true as const, value: { ready: false, platform: 'test', node: 'test', profile: 'test' } })}
      communityInstalled={vi.fn().mockResolvedValue({ ok: true as const, value: { installed: {}, activation: {} } })}
      communityInstall={vi.fn()}
      language="zh"
      useConnectionEpoch={bindSnapshotSelector(createSnapshotStore(0))}
      t={(key: string) => key as never}
    />)
    fireEvent.click(await screen.findByText('设置'))
    const toggle = await screen.findByLabelText('按需加载工具定义') as HTMLInputElement
    await waitFor(() => { expect(toggle.checked).toBe(false) })
    fireEvent.click(toggle)
    expect(await screen.findByText('开关未能保存：DEFERRED_TOGGLE_REFUSED')).toBeTruthy()
    // The Host still reports off, so the switch has to read off — the refusal is
    // reported and the real state is re-read, never the value the user asked for.
    await waitFor(() => { expect(statusRemote).toHaveBeenCalledTimes(2) })
    expect((screen.getByLabelText('按需加载工具定义') as HTMLInputElement).checked).toBe(false)
  })
})

describe('review finding severity', () => {
  it('maps both engine vocabularies onto real tones', () => {
    // Council findings say info/warning/blocker; advisor notes say
    // nit/concern/blocker. An earlier version knew neither vocabulary and
    // sent every value to `unknown`, so severity never coloured anything.
    expect(severityTone('blocker')).toBe('blocker')
    expect(severityTone('warning')).toBe('warning')
    expect(severityTone('info')).toBe('info')
    expect(severityTone('concern')).toBe('warning')
    expect(severityTone('nit')).toBe('info')
  })

  it('never returns unknown for a value either engine actually emits', () => {
    // The two closed sets, taken from engine-council SEVERITY_RANK and
    // AdvisorSeverity. Any of them falling through to `unknown` means the
    // finding renders without its severity colour.
    for (const value of ['info', 'warning', 'blocker', 'nit', 'concern']) {
      expect(severityTone(value), value).not.toBe('unknown')
    }
  })

  it('normalizes case and surrounding space from free-form engine output', () => {
    expect(severityTone(' BLOCKER ')).toBe('blocker')
    expect(severityTone('Warning')).toBe('warning')
  })

  it('falls back to unknown rather than guessing at an unrecognised word', () => {
    expect(severityTone('catastrophic')).toBe('unknown')
    expect(severityTone('')).toBe('unknown')
  })
})

describe('advisor standalone page layout', () => {
  const base = {
    enabled: true, mode: 'async', provider: 'opencode', model: 'big-pickle',
    routeReady: true, allowAgentControl: true, interruptCooldownTurns: 3,
    reviewTools: ['read', 'glob', 'grep'], activeSessions: 0, queuedReviews: 0,
    noteCount: 0, inputTokens: 0, outputTokens: 0, watchdogFiles: [],
  }
  const renderAdvisor = async () => {
    render(<AdvisorSettingsSection
      {...hostStandardProps}
      close={vi.fn()}
      advisorStatus={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorUpdate={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorModels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorNotes={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorReviewNow={vi.fn() as never}
      currentSessionId={() => undefined}
    />)
    await screen.findByText('审查模式')
  }

  it('pairs mode, model, and cooldown in one grid instead of stacked rows', async () => {
    await renderAdvisor()
    // Three fields of the same logical group now share one grid container.
    const grid = document.querySelector('[class*="advisorFormGrid"]')
    expect(grid).toBeTruthy()
    expect(grid!.querySelectorAll('select, input[type="number"], [class*="advisorModelTrigger"]').length).toBe(3)
  })

  it('keeps the model trigger a two-line button with the provider beneath', async () => {
    await renderAdvisor()
    const trigger = screen.getByText('big-pickle').closest('button')
    expect(trigger).toBeTruthy()
    expect(trigger?.querySelector('strong')?.textContent).toBe('big-pickle')
    expect(trigger!.querySelector('small')?.textContent).toContain('opencode')
  })

  it('moves the advisory-control switch into a card rather than an inline checkbox', async () => {
    await renderAdvisor()
    const card = document.querySelector('[aria-label="允许 Advisor 主动投递建议给 Agent"]')?.closest('label')
    expect(card?.className).toContain('toggleCard')
    expect(card?.textContent).toContain('关闭时仍会持久化审查建议')
  })

  it('sits the save action beside the evidence note in one footer row', async () => {
    await renderAdvisor()
    const foot = document.querySelector('[class*="advisorFoot"]')
    expect(foot).toBeTruthy()
    // The old layout floated the save button on its own; now the evidence
    // note and the one decision that finalises it share the row.
    expect(foot!.querySelector('[class*="advisorEvidence"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存 Advisor 配置' }).closest('[class*="advisorFoot"]')).toBeTruthy()
  })

  it('tells the user an all-zero panel is waiting, not broken', async () => {
    await renderAdvisor()
    expect(screen.getAllByText('本次已审查会话').length).toBeGreaterThan(0)
    // The status card and the notes panel each explain their own zero; the
    // status card's line is the one about automatic triggering.
    expect(screen.getAllByText(/尚未审查任何回合。Advisor 在每次主 Agent 回合结束时自动触发/).length).toBeGreaterThan(0)
  })
})

describe('DeviceSessionManager', () => {
  const sessions = (): FreeCodeGoDeviceSessions => ({
    currentDeviceId: 'device-2',
    sessions: [
      { deviceId: 'device-1', deviceName: 'Laptop', os: 'windows', arch: 'amd64', lastSeenAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', current: false, revoked: false },
      { deviceId: 'device-2', lastSeenAt: '2026-09-12T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', current: true, revoked: true },
    ],
  })

  it('loads sessions only when the manager is opened and hides revoked devices', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true as const, value: sessions() })
    render(<DeviceSessionManager load={load} language="zh" />)
    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '管理设备会话' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    // The revoked row is history: it must not appear as a device, and its badge
    // must not reappear as a live row.
    expect(await screen.findByText('Laptop')).toBeDefined()
    expect(screen.queryByText(/device-2（本机）/)).toBeNull()
    expect(screen.queryByText('已撤销')).toBeNull()
    expect(screen.getAllByRole('button', { name: '撤销' }).length).toBe(1)
  })

  it('folds the list back up with the same toggle that opened it', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true as const, value: sessions() })
    render(<DeviceSessionManager load={load} language="zh" />)
    fireEvent.click(screen.getByRole('button', { name: '管理设备会话' }))
    expect(await screen.findByText('Laptop')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '收起设备列表' }))
    expect(screen.queryByText('Laptop')).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    // Reopening shows the list again (from the state it already holds).
    fireEvent.click(screen.getByRole('button', { name: '管理设备会话' }))
    expect(screen.getByText('Laptop')).toBeDefined()
  })

  it('revokes one device and replaces the list with the refreshed result', async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: true as const, value: { sessions: [] } })
    render(<DeviceSessionManager load={async () => ({ ok: true as const, value: sessions() })} revoke={revoke} language="zh" />)
    fireEvent.click(screen.getByRole('button', { name: '管理设备会话' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(revoke).toHaveBeenCalledWith('device-1') })
    expect(await screen.findByText('没有可撤销的设备会话。')).toBeDefined()
  })

  it('requires a second click before revoking every session', async () => {
    const revokeAll = vi.fn().mockResolvedValue({ ok: true as const, value: 3 })
    render(<DeviceSessionManager load={async () => ({ ok: true as const, value: sessions() })} revokeAll={revokeAll} language="zh" />)
    fireEvent.click(screen.getByRole('button', { name: '管理设备会话' }))
    await screen.findByText('Laptop')
    fireEvent.click(screen.getByRole('button', { name: '撤销全部会话' }))
    // Revoking the current device's session signs the account out, so the first
    // click only arms the confirmation.
    expect(revokeAll).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认撤销全部？' }))
    await waitFor(() => { expect(revokeAll).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText(/已撤销 3 个会话/)).toBeDefined()
  })
})

/**
 * What the payment panel says when a click does not reach a payment page.
 *
 * These two answers decide whether a user retries blindly. The timeout wording
 * is pinned because a timeout on an order is not "the service is down": the
 * backend may already hold the order, so the only safe instruction is to look at
 * the pending list first.
 *
 * The other guarantee pinned here is what the message must *not* contain: the
 * backend's own detail string, which names internal routes, provider hosts and
 * parser failures. A customer cannot act on any of it, and it is the interface
 * we should not be publishing.
 */
describe('payment failure wording', () => {
  it('answers a timeout with the pending list, not with a blind retry', () => {
    const text = describePaymentError('The operation was aborted due to timeout')
    expect(text).toContain('待支付订单')
    expect(text).toMatch(/超时/)
    // The generic 5xx/network line would have said the service is merely
    // unavailable and invited an immediate retry, which is what created
    // duplicate pending orders.
    expect(text).not.toContain('支付服务暂时不可用')
  })

  it('does not mistake a provider timeout inside a 5xx for our own abort', () => {
    // The live case: the backend reached the payment provider, the provider
    // timed out, and the backend answered 503 with that cause in the body.
    // No order was created, so pointing the user at the pending list would send
    // them looking for something that does not exist.
    const detail = 'FreeCodeGo request /api/v1/payment/orders failed with HTTP 503: payment gateway error: easypay create: Post "https://example/mapi.php": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'
    const text = describePaymentError(detail)
    expect(text).toContain('支付通道暂时没有响应')
    expect(text).not.toContain('待支付订单')
    // ...and it is not blamed on a missing channel configuration either: the
    // channel exists, its upstream provider is the part that failed.
    expect(text).not.toContain('没有可用通道')
    // The mainland-only provider is why this happens, so the advice names the
    // network fix and offers the card channel as the way through.
    expect(text).toContain('关闭代理或 VPN')
    expect(text).toContain('Stripe')
    // Nothing internal crosses into the message: no route, no provider host, no
    // parser error, no request id.
    for (const leak of ['/api/v1/payment/orders', 'easypay', 'mapi.php', 'context deadline exceeded', 'request_id']) expect(text).not.toContain(leak)
    // A real "nothing configured for this payment type" still says so, and still
    // carries the same network advice instead of an operator's diagnosis.
    const missing = describePaymentError('NO_AVAILABLE_INSTANCE for payment type wxpay')
    expect(missing).toContain('暂时无法下单')
    expect(missing).toContain('关闭代理或 VPN')
    expect(missing).not.toContain('NO_AVAILABLE_INSTANCE')
    // The bare phrase a plain `timeout` match would have caught.
    expect(describePaymentError('gateway request timed out')).toContain('支付服务暂时不可用')
  })

  it('never echoes the backend detail into what the user reads', () => {
    // Every branch, not just the gateway one: the detail string is the same kind
    // of internal text whichever failure it describes.
    const details = [
      'HTTP 400 bad request: invalid return_url for order 99 (request_id=abc)',
      'HTTP 409 conflict: duplicate out_trade_no 202609140001',
      'HTTP 503 Service Unavailable',
      'INVALID_AMOUNT: amount out of range for instance cn-alipay-2',
    ]
    for (const detail of details) {
      const text = describePaymentError(detail)
      expect(text).toContain(' / ')
      expect(text).not.toContain(detail)
      expect(text).not.toMatch(/request_id|instance|out_trade_no/u)
    }
  })

  it('still reports a genuine service failure as one', () => {
    // No "gateway" in the detail: that word is claimed by the
    // no-available-instance branch, which is a different, channel-specific
    // failure and is answered differently.
    expect(describePaymentError('HTTP 503 Service Unavailable')).toContain('支付服务暂时不可用')
    expect(describePaymentError('HTTP 401 unauthorized')).toContain('登录状态已失效')
    // An empty detail is not a timeout and must keep its own default.
    expect(describePaymentError('   ')).toContain('订单请求失败')
  })
})

/** A limit line that says "no amount is allowed" above a working buy button is
 * worse than no line at all. */
/** An order created through a provider that echoes no currency still has to
 * print the amount that was charged. */
describe('order settlement currency', () => {
  const channels = [{ paymentType: 'alipay', currency: 'CNY', balanceRechargeMultiplier: 0.14 }, { paymentType: 'stripe', currency: 'USD', balanceRechargeMultiplier: 1 }]

  it('resolves the channel the order was created for', () => {
    // Alipay and WeChat return no currency, so this is the normal case for the
    // default payment method — and the pay amount is charged in CNY, not USD.
    expect(orderSettlementCurrency({ paymentType: 'alipay' }, channels)).toBe('CNY')
    expect(orderSettlementCurrency({ paymentType: ' Alipay ' }, channels)).toBe('CNY')
    expect(orderSettlementCurrency({ paymentType: 'stripe' }, channels)).toBe('USD')
  })

  it('prefers the order\u2019s own currency when the provider stated one', () => {
    expect(orderSettlementCurrency({ currency: 'HKD', paymentType: 'alipay' }, channels)).toBe('HKD')
  })

  it('stays unknown rather than guessing when nothing identifies it', () => {
    // No currency on the order, no payment type, or a type the channel table
    // does not list: the answer is "not stated". `formatMoney` renders that as
    // `—`/USD at the call site, but this helper must not manufacture a currency.
    expect(orderSettlementCurrency({}, channels)).toBeUndefined()
    expect(orderSettlementCurrency({ paymentType: 'paypal' }, channels)).toBeUndefined()
    expect(orderSettlementCurrency({ currency: '   ', paymentType: 'unknown' }, channels)).toBeUndefined()
    expect(orderSettlementCurrency({ paymentType: 'alipay' })).toBeUndefined()
  })
})

describe('which models cost money', () => {
  const row = (over: Partial<GatewayModelPrice> & Pick<GatewayModelPrice, 'modelId'>): GatewayModelPrice => ({ displayName: over.modelId, provider: 'x', source: 'gateway', groupName: 'OpenAi', rateMultiplier: 1, billingMode: 'token', currency: 'USD', ...over })

  it('sorts the billed models above the free ones', () => {
    const rows = [
      row({ modelId: 'free-a', source: 'opencode', inputPricePerMillion: 0, outputPricePerMillion: 0 }),
      row({ modelId: 'paid-a', inputPricePerMillion: 1, outputPricePerMillion: 2 }),
      row({ modelId: 'free-b', source: 'logfare', inputPricePerMillion: 0, outputPricePerMillion: 0 }),
    ]
    const { metered, free } = splitPricingRows(rows)
    expect(metered.map(price => price.modelId)).toEqual(['paid-a'])
    expect(free.map(price => price.modelId)).toEqual(['free-a', 'free-b'])
  })

  it('calls a row free only when every quoted price is zero', () => {
    expect(isFreePricingRow(row({ modelId: 'a', inputPricePerMillion: 0, outputPricePerMillion: 0 }))).toBe(true)
    expect(isFreePricingRow(row({ modelId: 'b', inputPricePerMillion: 0, outputPricePerMillion: 0.5 }))).toBe(false)
    // Per-request rows quote a single price, and it decides on its own.
    expect(isFreePricingRow(row({ modelId: 'c', billingMode: 'per-request', perRequestPrice: 0 }))).toBe(true)
    expect(isFreePricingRow(row({ modelId: 'd', billingMode: 'per-request', perRequestPrice: 0.02 }))).toBe(false)
    // Nothing quoted is *unknown*, not free: an unreadable price must not be
    // presented as "no charge" under a heading that promises exactly that.
    expect(isFreePricingRow(row({ modelId: 'e' }))).toBe(false)
  })

  it('reads an image row as free only when every tier it quotes is zero', () => {
    // A per-image tier is a quote like any other, so it decides the heading on
    // its own: every picture free is free, and one free tier beside a paid one
    // is not.
    expect(isFreePricingRow(row({ modelId: 'img-free', billingMode: 'image', imagePrices: [{ label: '1K', price: 0 }, { label: '2K', price: 0 }] }))).toBe(true)
    expect(isFreePricingRow(row({ modelId: 'img-paid', billingMode: 'image', imagePrices: [{ label: '1K', price: 0 }, { label: '2K', price: 0.06 }] }))).toBe(false)
    // No tiers is a price the backend did not quote, not a free picture.
    expect(isFreePricingRow(row({ modelId: 'img-silent', billingMode: 'image' }))).toBe(false)
  })

  it('ranks an image row by its cheapest picture, never by its token columns', () => {
    // The token columns of an image row are empty by construction, so summing
    // them made every image model look like the cheapest tariff on offer — and
    // an unquoted one look cheaper still.
    const rows = pricingRows([
      row({ modelId: 'gpt-image-2', groupName: '贵组', billingMode: 'image', imagePrices: [{ label: '1K', price: 0.12 }] }),
      row({ modelId: 'gpt-image-2', groupName: '便宜组', billingMode: 'image', imagePrices: [{ label: '1K', price: 0.03 }] }),
      row({ modelId: 'gpt-image-2', groupName: '未报价组', billingMode: 'image' }),
    ])
    expect(rows.map(price => price.groupName)).toEqual(['便宜组', '贵组', '未报价组'])
  })
})

describe('what the chosen payment method promises', () => {
  it('treats only the card channel as a card channel', () => {
    // The methods listed under the picker are the card brands, so they may only
    // appear for the channel that accepts them.
    expect(isCardChannel('stripe')).toBe(true)
    expect(isCardChannel(' Stripe ')).toBe(true)
    expect(isCardChannel('alipay')).toBe(false)
    expect(isCardChannel('wxpay')).toBe(false)
    expect(isCardChannel(undefined)).toBe(false)
    expect(CARD_CHANNEL_METHODS).toContain('Visa')
    expect(CARD_CHANNEL_METHODS).toContain('Apple Pay')
  })

  it('offers the receipt only where the backend actually documents a payment', () => {
    // The card channel is the one that can hand over a document: the backend
    // serves a receipt for a settled order and Stripe mails its own. Claiming it
    // on a QR channel, or claiming 发票 on any of them, would be a promise this
    // stack cannot keep — a Stripe PaymentIntent cannot raise an invoice, only a
    // Checkout Session can.
    expect(selectedChannelDescription({ paymentType: 'stripe', currency: 'USD' }, 'zh')).toContain('收据')
    expect(selectedChannelDescription({ paymentType: 'stripe', currency: 'USD' }, 'en')).toContain('receipt')
    expect(selectedChannelDescription({ paymentType: 'alipay', currency: 'CNY' }, 'zh')).not.toContain('收据')
    // ...and it must not promise an invoice anywhere in the picker.
    for (const type of ['stripe', 'alipay', 'wxpay']) {
      expect(selectedChannelDescription({ paymentType: type, currency: 'CNY' }, 'zh')).not.toContain('发票')
      expect(selectedChannelDescription({ paymentType: type, currency: 'CNY' }, 'en')).not.toContain('invoice')
    }
  })

  it('says nothing about a channel that is not chosen yet', () => {
    expect(selectedChannelDescription(undefined, 'zh')).toBe('')
  })
})

describe('payment channel limit line', () => {
  it('drops a range that cannot admit any amount', () => {
    // What the live backend publishes when it declares no bounds at all.
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY', singleMin: 0, singleMax: 0 }, 'zh')).toBe('')
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY' }, 'zh')).toBe('')
    // A zero-width range is not a range either.
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY', singleMin: 5, singleMax: 5 }, 'zh')).toBe('')
  })

  it('falls back to the desktop config without trusting its zeroes', () => {
    const channel = { paymentType: 'alipay', currency: 'CNY' }
    // The live deployment: account-level `min_amount: 1`, and `max_amount: 0`
    // spelling "no upper limit" — which must not print as a range ending at 0.
    expect(paymentLimitText(channel, 'zh', { minAmount: 1, maxAmount: 0 })).toBe('单笔 1–∞ CNY')
    expect(paymentLimitText(channel, 'zh', { minAmount: 1, maxAmount: 50000 })).toBe('单笔 1–50000 CNY')
    // The channel's own range still wins when it declares one.
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY', singleMin: 2, singleMax: 100 }, 'zh', { minAmount: 1, maxAmount: 50000 })).toBe('单笔 2–100 CNY')
    // And a config with nothing usable leaves the line off entirely.
    expect(paymentLimitText(channel, 'zh', { maxAmount: 0 })).toBe('')
  })

  it('keeps a range that means something, including a one-sided one', () => {
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY', singleMin: 1, singleMax: 5000 }, 'zh')).toBe('单笔 1–5000 CNY')
    expect(paymentLimitText({ paymentType: 'alipay', currency: 'CNY', singleMin: 2 }, 'en')).toBe('limit 2–∞ CNY')
    // A declared maximum with an undeclared minimum is still a real ceiling.
    expect(paymentLimitText({ paymentType: 'stripe', currency: 'USD', singleMax: 20 }, 'en')).toBe('limit 0–20 USD')
  })
})

describe('skill library page', () => {
  const snapshot = {
    mcpEnabled: false,
    skillEnabled: true,
    voiceInputEnabled: true,
    sessionDeleteEnabled: true,
    modelCategories: {},
    mcpServers: [],
    skillRoots: [],
    mcpTools: [],
    skills: [
      { name: 'code-review', description: '以固定点为基准做双轴评审。', source: 'custom', modelInvocable: true, userInvocable: true },
      // `disable-model-invocation` narrows the model's reach, not the user's:
      // the library used to drop exactly these rows.
      { name: 'ask-matt', description: 'Route to the Skill that fits.', source: 'custom', modelInvocable: false, userInvocable: true },
      { name: 'my-team-skill', description: 'Written by our team.', source: 'custom', modelInvocable: true, userInvocable: true },
    ],
  }
  const packs = [
    { id: 'starter' as const, label: '常用技能', enabled: true, count: 10 },
    { id: 'engineering' as const, label: '全部工程 Skills', enabled: true, count: 23 },
    { id: 'superpowers' as const, label: 'Superpowers 工作流包', enabled: false, count: 8 },
  ]
  const engineeringResult = (skillPacks: typeof packs) => ({ ok: true as const, value: { skillPacks } as never })
  // The Skill page and the MCP page share one injected prop set, so the Skill
  // half has to supply the MCP remotes it never reads.
  type SkillSectionProps = Parameters<typeof SkillSettingsSection>[0]
  const unsetCapability: Pick<SkillSectionProps, 'mcpSave' | 'mcpRemove' | 'capabilityMarketplace' | 'mcpPresetInstall'> = {
    mcpSave: vi.fn(), mcpRemove: vi.fn(), capabilityMarketplace: vi.fn(), mcpPresetInstall: vi.fn(),
  }

  const renderSkills = async (overrides: { readonly detail?: (...args: never[]) => unknown; readonly engineeringUpdate?: (...args: never[]) => unknown; readonly invocation?: (...args: never[]) => unknown; readonly inventory?: typeof snapshot } = {}) => {
    const capabilities = vi.fn().mockResolvedValue({ ok: true as const, value: overrides.inventory ?? snapshot })
    const engineeringStatus = vi.fn().mockResolvedValue(engineeringResult(packs))
    const engineeringSettingsUpdate = overrides.engineeringUpdate ?? vi.fn().mockResolvedValue(engineeringResult(packs.map(pack => ({ ...pack, enabled: true }))))
    const skillDetail = overrides.detail ?? vi.fn()
    const skillInvocationSet = overrides.invocation ?? vi.fn()
    render(<SkillSettingsSection
      {...hostStandardProps}
      {...unsetCapability}
      close={vi.fn()}
      capabilities={capabilities as never}
      skillRootSave={vi.fn() as never}
      skillRootRemove={vi.fn() as never}
      skillInvocationSet={skillInvocationSet as never}
      skillDetail={skillDetail as never}
      engineeringStatus={engineeringStatus as never}
      engineeringSettingsUpdate={engineeringSettingsUpdate as never}
      language="zh"
    />)
    await screen.findByText('ask-matt')
    return { capabilities, engineeringStatus, engineeringSettingsUpdate, skillDetail, skillInvocationSet }
  }

  it('lists every discovered Skill and says which ones the model may fire on its own', async () => {
    await renderSkills()

    // The manual-only row is the whole point: it is invocable by name, so
    // hiding it left the user unable to read the Skill they were told to call.
    expect(screen.getByText('ask-matt')).toBeTruthy()
    expect(screen.getByText('仅手动调用')).toBeTruthy()
    expect(screen.getAllByText('模型可自动调用').length).toBe(2)
    // A Skill outside the bundled catalog still says its text is English.
    expect(screen.getByText('my-team-skill').closest('button')?.textContent).toContain('英文原文')
  })

  it('opens a Skill body and its companion files instead of leaving the card inert', async () => {
    const body = {
      name: 'code-review',
      description: '以固定点为基准做双轴评审。',
      source: 'custom',
      modelInvocable: true,
      userInvocable: true,
      content: '# Code review',
      files: [{ path: 'axes.md', bytes: 9 }],
    }
    const detail = vi.fn(async (input: { readonly name: string; readonly file?: string }) => ({
      ok: true as const,
      value: input.file === undefined ? body : { ...body, file: { path: input.file, bytes: 9, content: 'the axes' } },
    }))
    await renderSkills({ detail })

    fireEvent.click(screen.getByRole('button', { name: '查看内容: code-review' }))

    const dialog = await screen.findByRole('dialog', { name: 'Skill 内容: code-review' })
    expect(dialog.textContent).toContain('# Code review')
    expect(within(dialog).getByText('SKILL.md 正文')).toBeTruthy()
    expect(await within(dialog).findByText('axes.md · 9 B')).toBeTruthy()

    fireEvent.click(within(dialog).getByText('axes.md · 9 B'))
    await waitFor(() => { expect(dialog.textContent).toContain('the axes') })
    expect(detail).toHaveBeenLastCalledWith({ name: 'code-review', file: 'axes.md' })

    // Both the header and the footer close the dialog.
    fireEvent.click(within(dialog).getAllByText('关闭')[0]!)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('hands a manual-only Skill to the model from its own row, and takes it back', async () => {
    // The Host answers with a fresh snapshot, which is what the page then has
    // to re-read: a switch that writes but never turns on is the whole bug.
    const skillInvocationSet = vi.fn(async (input: { readonly name: string; readonly modelInvocable?: boolean }) => ({
      ok: true as const,
      value: {
        ...snapshot,
        skillInvocationOverrides: input.modelInvocable === undefined ? {} : { [input.name]: input.modelInvocable },
        skills: snapshot.skills.map(skill => skill.name === input.name && input.modelInvocable !== undefined
          ? { ...skill, modelInvocable: input.modelInvocable }
          : skill),
      },
    }))
    await renderSkills({ invocation: skillInvocationSet })

    // A Skill the file marks manual-only starts with no way back to the file,
    // because there is no override yet.
    const toggle = screen.getByLabelText('允许模型自动调用: ask-matt') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByText('跟随文件')).toBeNull()

    fireEvent.click(toggle)

    await waitFor(() => { expect(skillInvocationSet).toHaveBeenCalledWith({ name: 'ask-matt', modelInvocable: true }) })
    await waitFor(() => { expect((screen.getByLabelText('允许模型自动调用: ask-matt') as HTMLInputElement).checked).toBe(true) })
    expect(screen.getAllByText('模型可自动调用').length).toBe(3)

    // Deleting the key is the only route back to the Skill's own declaration.
    fireEvent.click(await screen.findByText('跟随文件'))
    await waitFor(() => { expect(skillInvocationSet).toHaveBeenLastCalledWith({ name: 'ask-matt' }) })
    await waitFor(() => { expect((screen.getByLabelText('允许模型自动调用: ask-matt') as HTMLInputElement).checked).toBe(false) })
    await waitFor(() => { expect(screen.queryByText('跟随文件')).toBeNull() })
  })

  it('offers the same invocation switch inside the Skill dialog', async () => {
    const body = { name: 'ask-matt', description: 'Route to the Skill that fits.', source: 'custom', modelInvocable: false, userInvocable: true, content: '# ask-matt', files: [] }
    const skillInvocationSet = vi.fn(async (input: { readonly name: string; readonly modelInvocable?: boolean }) => ({
      ok: true as const,
      value: {
        ...snapshot,
        skillInvocationOverrides: input.modelInvocable === undefined ? {} : { [input.name]: input.modelInvocable },
        skills: snapshot.skills.map(skill => skill.name === input.name && input.modelInvocable !== undefined ? { ...skill, modelInvocable: input.modelInvocable } : skill),
      },
    }))
    await renderSkills({ detail: vi.fn(async () => ({ ok: true as const, value: body })), invocation: skillInvocationSet })

    fireEvent.click(screen.getByRole('button', { name: '查看内容: ask-matt' }))
    const dialog = await screen.findByRole('dialog', { name: 'Skill 内容: ask-matt' })
    const toggle = within(dialog).getByLabelText('允许模型自动调用: ask-matt') as HTMLInputElement

    fireEvent.click(toggle)

    await waitFor(() => { expect(skillInvocationSet).toHaveBeenCalledWith({ name: 'ask-matt', modelInvocable: true }) })
    // The dialog re-reads its row from the returned snapshot, so the chip
    // beside it has to change too.
    await waitFor(() => { expect(within(dialog).getByLabelText('允许模型自动调用: ask-matt')).toHaveProperty('checked', true) })
    expect(dialog.textContent).toContain('custom · 模型可自动调用')
  })

  it('shows what an alias Skill forwards to instead of leaving its body looking empty', async () => {
    const body = {
      name: 'grill-me',
      description: 'A relentless interview to sharpen a plan or design.',
      source: 'custom',
      modelInvocable: false,
      userInvocable: true,
      content: 'Call the Skill tool with "grilling".',
      files: [],
      forwarded: [{ name: 'grilling', description: 'Grill relentlessly.', content: '# the interview' }],
    }
    await renderSkills({
      inventory: { ...snapshot, skills: [body, ...snapshot.skills.map(({ name, description, source, modelInvocable, userInvocable }) => ({ name, description, source, modelInvocable, userInvocable }))] },
      detail: vi.fn(async () => ({ ok: true as const, value: body })),
    })

    fireEvent.click(screen.getByRole('button', { name: '查看内容: grill-me' }))
    const dialog = await screen.findByRole('dialog', { name: 'Skill 内容: grill-me' })

    expect(dialog.textContent).toContain('Call the Skill tool with "grilling".')
    await waitFor(() => { expect(dialog.textContent).toContain('# the interview') })
    expect(within(dialog).getByText('该技能转发到 `grilling` 的正文')).toBeTruthy()
    // The alias line is one sentence long, so the dialog has to say what the
    // Skill really runs rather than leaving the body tab looking empty. The
    // heading uses the catalog's Chinese description, not the raw one.
    expect(within(dialog).getByText('面向方案、决策或想法的追问原语：事实由 Agent 查，决策由用户定。')).toBeTruthy()
  })

  it('names the bundled packs that are off and mounts them in a single settings write', async () => {
    const { capabilities, engineeringSettingsUpdate } = await renderSkills()

    expect(screen.getByText('还有 8 个内置技能未启用（Superpowers 工作流包）')).toBeTruthy()
    const readsBefore = capabilities.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: '立即启用' }))

    // Two writes would both start from the same settings revision and the
    // second would undo the first, so every off pack travels in one patch.
    await waitFor(() => {
      expect(engineeringSettingsUpdate).toHaveBeenCalledWith({ engineeringEnabled: true, engineeringSuperpowersSkillsEnabled: true })
    })
    // The pack's provider just mounted, so the library has to be re-read.
    await waitFor(() => { expect(capabilities.mock.calls.length).toBeGreaterThan(readsBefore) })
  })

  it('drops the pack line once every bundled pack is on', async () => {
    const capabilities = vi.fn().mockResolvedValue({ ok: true as const, value: snapshot })
    render(<SkillSettingsSection
      {...hostStandardProps}
      {...unsetCapability}
      close={vi.fn()}
      capabilities={capabilities as never}
      skillRootSave={vi.fn() as never}
      skillRootRemove={vi.fn() as never}
      skillDetail={vi.fn() as never}
      engineeringStatus={vi.fn().mockResolvedValue(engineeringResult(packs.map(pack => ({ ...pack, enabled: true })))) as never}
      engineeringSettingsUpdate={vi.fn() as never}
      language="zh"
    />)
    await screen.findByText('ask-matt')

    expect(screen.queryByText('内置技能包')).toBeNull()
  })

  it('distils the current session into Skill drafts on demand and says where they went', async () => {
    const engineeringSkillDraft = vi.fn().mockResolvedValue({ ok: true as const, value: {
      drafts: [{ name: 'verify-migrations', sources: 4 }, { name: 'run-narrow-tests', sources: 3 }],
      directory: '/work/tree/.freecodego/skill-drafts',
    } })
    render(<SkillSettingsSection
      {...hostStandardProps}
      {...unsetCapability}
      close={vi.fn()}
      capabilities={vi.fn().mockResolvedValue({ ok: true as const, value: snapshot }) as never}
      skillRootSave={vi.fn() as never}
      skillRootRemove={vi.fn() as never}
      skillDetail={vi.fn() as never}
      engineeringStatus={vi.fn().mockResolvedValue(engineeringResult(packs)) as never}
      engineeringSettingsUpdate={vi.fn() as never}
      engineeringSkillDraft={engineeringSkillDraft as never}
      currentSessionId={() => 'session-7'}
      language="zh"
    />)
    await screen.findByText('ask-matt')
    fireEvent.click(screen.getByRole('button', { name: '提炼草稿' }))

    await waitFor(() => { expect(engineeringSkillDraft).toHaveBeenCalledWith('session-7') })
    expect(await screen.findByText('verify-migrations')).toBeTruthy()
    expect(screen.getByText('来自 4 条会话证据')).toBeTruthy()
    // The write target has to be on screen: the drafts are files the user reviews,
    // not something the plugin mounts on their behalf.
    expect(screen.getByText('草稿目录：/work/tree/.freecodego/skill-drafts')).toBeTruthy()
  })

  it('asks for a workspace-backed session instead of calling the Host with no id', async () => {
    const engineeringSkillDraft = vi.fn()
    render(<SkillSettingsSection
      {...hostStandardProps}
      {...unsetCapability}
      close={vi.fn()}
      capabilities={vi.fn().mockResolvedValue({ ok: true as const, value: snapshot }) as never}
      skillRootSave={vi.fn() as never}
      skillRootRemove={vi.fn() as never}
      skillDetail={vi.fn() as never}
      engineeringStatus={vi.fn().mockResolvedValue(engineeringResult(packs)) as never}
      engineeringSettingsUpdate={vi.fn() as never}
      engineeringSkillDraft={engineeringSkillDraft as never}
      currentSessionId={() => undefined}
      language="zh"
    />)
    await screen.findByText('ask-matt')
    fireEvent.click(screen.getByRole('button', { name: '提炼草稿' }))

    expect((await screen.findByRole('alert')).textContent).toContain('先打开一个绑定工作区的会话')
    expect(engineeringSkillDraft).not.toHaveBeenCalled()
  })

  it('reports why a draft run produced nothing rather than an empty list', async () => {
    const engineeringSkillDraft = vi.fn().mockResolvedValue({ ok: true as const, value: { drafts: [], reason: '本会话只有 2 个回合，不足以聚类。' } })
    render(<SkillSettingsSection
      {...hostStandardProps}
      {...unsetCapability}
      close={vi.fn()}
      capabilities={vi.fn().mockResolvedValue({ ok: true as const, value: snapshot }) as never}
      skillRootSave={vi.fn() as never}
      skillRootRemove={vi.fn() as never}
      skillDetail={vi.fn() as never}
      engineeringStatus={vi.fn().mockResolvedValue(engineeringResult(packs)) as never}
      engineeringSettingsUpdate={vi.fn() as never}
      engineeringSkillDraft={engineeringSkillDraft as never}
      currentSessionId={() => 'session-7'}
      language="zh"
    />)
    await screen.findByText('ask-matt')
    fireEvent.click(screen.getByRole('button', { name: '提炼草稿' }))

    expect((await screen.findByRole('status')).textContent).toContain('本会话只有 2 个回合，不足以聚类。')
  })
})

describe('AutomationSettingsPanel', () => {
  const settings = { hookChainsEnabled: true, hookChainsMaxDepth: 2, hookChainsCooldownMs: 30_000, scheduledTasksEnabled: true }

  it('renders the values the runtime reports rather than the schema defaults', async () => {
    // The defaults are all-on; this fixture says the opposite, so a panel that
    // painted its own defaults would be caught here.
    const off = { ...settings, hookChainsEnabled: false, scheduledTasksEnabled: false }
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: off })
    render(<AutomationSettingsPanel status={status as never} update={vi.fn() as never} language="en" />)

    await waitFor(() => { expect((screen.getByLabelText('Failure-recovery rules') as HTMLInputElement).checked).toBe(false) })
    expect((screen.getByLabelText('Calendar planning') as HTMLInputElement).checked).toBe(false)
  })

  it('sends one switch per patch and keeps the rest of the policy out of it', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: settings })
    const update = vi.fn().mockResolvedValue({ ok: true as const, value: { ...settings, hookChainsEnabled: false } })
    render(<AutomationSettingsPanel status={status as never} update={update as never} language="en" />)

    await waitFor(() => { expect((screen.getByLabelText('Failure-recovery rules') as HTMLInputElement).checked).toBe(true) })
    fireEvent.click(screen.getByLabelText('Failure-recovery rules'))

    await waitFor(() => { expect(update).toHaveBeenCalledWith({ hookChainsEnabled: false }) })
  })

  it('shows the cooldown in seconds and commits milliseconds', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: settings })
    const update = vi.fn().mockResolvedValue({ ok: true as const, value: { ...settings, hookChainsCooldownMs: 45_000 } })
    render(<AutomationSettingsPanel status={status as never} update={update as never} language="en" />)

    const field = await screen.findByLabelText('Recovery cooldown (seconds)') as HTMLInputElement
    expect(field.value).toBe('30')
    fireEvent.change(field, { target: { value: '45' } })

    await waitFor(() => { expect(update).toHaveBeenCalledWith({ hookChainsCooldownMs: 45_000 }) })
  })

  it('treats an emptied field as no input instead of as zero', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: settings })
    const update = vi.fn().mockResolvedValue({ ok: true as const, value: settings })
    render(<AutomationSettingsPanel status={status as never} update={update as never} language="en" />)

    const field = await screen.findByLabelText('Recovery cooldown (seconds)') as HTMLInputElement
    // `Number('')` is 0, so a panel without a guard here would silently switch
    // every cooldown off the moment the user selected the text to retype it.
    fireEvent.change(field, { target: { value: '' } })

    expect(update).not.toHaveBeenCalled()
  })

  it('reports a refusal and re-reads the value still in force', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: settings })
    const update = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'hookChainsMaxDepth must be <= 10' } })
    render(<AutomationSettingsPanel status={status as never} update={update as never} language="en" />)

    const field = await screen.findByLabelText('Deepest recovery chain') as HTMLInputElement
    const readsBefore = status.mock.calls.length
    fireEvent.change(field, { target: { value: '99' } })

    expect((await screen.findByRole('alert')).textContent).toContain('hookChainsMaxDepth must be <= 10')
    // The rejected value is not in force, so the panel must not keep showing it.
    await waitFor(() => { expect(status.mock.calls.length).toBeGreaterThan(readsBefore) })
  })
})

describe('SandboxModePanel', () => {
  const live = { sessionId: 'session-1', mode: 'workspace-write' as const, defaultMode: 'workspace-write' as const, live: true, workspaceRoot: '/work/tree' }

  it('renders nothing without a session to describe', () => {
    const { container } = render(<SandboxModePanel sessionId={undefined} status={vi.fn() as never} setMode={vi.fn() as never} language="en" />)
    expect(container.textContent).toBe('')
  })

  it('names the mode in force, the workspace it may write, and who chose it', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: live })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={vi.fn() as never} language="en" />)

    expect(await screen.findByText(/Workspace write \(current\)/u)).toBeTruthy()
    expect(screen.getByText(/writable root \/work\/tree/u)).toBeTruthy()
    expect(screen.getByText(/no choice of its own, so the default applies/u)).toBeTruthy()
    expect(status).toHaveBeenCalledWith('session-1')
  })

  it('switches the session to the chosen mode', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: live })
    const setMode = vi.fn().mockResolvedValue({ ok: true as const, value: { ...live, mode: 'read-only' as const, override: 'read-only' as const } })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={setMode as never} language="en" />)

    fireEvent.click(await screen.findByRole('button', { name: 'sandbox-mode-read-only' }))

    await waitFor(() => { expect(setMode).toHaveBeenCalledWith('session-1', 'read-only') })
    expect(await screen.findByText(/Read-only \(current\)/u)).toBeTruthy()
  })

  it('offers no switch for the mode already in force', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: live })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={vi.fn() as never} language="en" />)

    const current = await screen.findByRole('button', { name: 'sandbox-mode-workspace-write' }) as HTMLButtonElement
    expect(current.disabled).toBe(true)
    expect(current.textContent).toBe('In use')
  })

  it('refuses to switch a session that has already closed, and says why', async () => {
    // A closed session reports `mode: logged ?? defaultMode` with its durable
    // override alongside, so the fixture mirrors that shape rather than a
    // half-updated one.
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: { ...live, mode: 'read-only' as const, override: 'read-only' as const, live: false } })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={vi.fn() as never} language="en" />)

    // The durable last choice is what a closed session reports, so the panel
    // shows that rather than the deployment default.
    expect(await screen.findByText(/Read-only \(current\)/u)).toBeTruthy()
    for (const name of ['sandbox-mode-read-only', 'sandbox-mode-workspace-write', 'sandbox-mode-danger-full-access']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText(/can no longer be switched/u)).toBeTruthy()
  })

  it('reports a switch the Host refused', async () => {
    const status = vi.fn().mockResolvedValue({ ok: true as const, value: live })
    const setMode = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'session "session-1" is not live' } })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={setMode as never} language="en" />)

    fireEvent.click(await screen.findByRole('button', { name: 'sandbox-mode-danger-full-access' }))

    expect((await screen.findByRole('alert')).textContent).toContain('is not live')
  })

  it('leaves its empty state and says why when the status read fails', async () => {
    // The read used to be swallowed, so a broken Host looked exactly like a slow
    // one: the panel kept its empty state — no badge, no deployment default,
    // every switch greyed out — and never explained itself.
    const status = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'SANDBOX_STATUS_UNREADABLE' } })
    render(<SandboxModePanel sessionId="session-1" status={status as never} setMode={vi.fn() as never} language="en" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not read the sandbox status: SANDBOX_STATUS_UNREADABLE')
    // Nothing can be switched while the mode in force is unknown.
    for (const name of ['sandbox-mode-read-only', 'sandbox-mode-workspace-write', 'sandbox-mode-danger-full-access']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

describe('project memory search and recall preview', () => {
  const record = (id: string, trust: 'captured' | 'draft' | 'reviewed') => ({ id, title: `memory ${id}`, kind: 'decision' as const, trust, projectId: 'proj', createdAt: 1_700_000_000_000, detailTokens: 30 })
  const emptyRecall = { ok: true as const, value: { projectId: 'proj', tokenBudget: 2000, usedTokens: 0, records: [] } }
  // Typed against the panel's own prop surface, not `as never`: a stub that is
  // not a real prop would otherwise be caught only by the panel ignoring it.
  type MemoryPanelProps = Parameters<typeof EngineeringMemoryPanel>[0]
  const stubs: Pick<MemoryPanelProps, 'timeline' | 'get' | 'review' | 'remove' | 'purge' | 'exportReviewed' | 'backup' | 'retentionSweep' | 'consolidate' | 'manifest'> = {
    timeline: vi.fn(), get: vi.fn(), review: vi.fn(), remove: vi.fn(), purge: vi.fn(),
    exportReviewed: vi.fn(), backup: vi.fn(), retentionSweep: vi.fn(),
    consolidate: vi.fn(), manifest: vi.fn(),
  }

  it('searches the store through the Host instead of filtering the visible page', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured')] } })
    const search = vi.fn().mockResolvedValue({ ok: true as const, value: [record('b', 'reviewed')] })
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} search={search as never} recall={vi.fn().mockResolvedValue(emptyRecall) as never} {...stubs} />)

    expect(await screen.findByText('memory a')).toBeTruthy()
    const box = screen.getByLabelText('搜索项目记忆')
    fireEvent.change(box, { target: { value: 'tls' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    // Ranked server-side search can reach records the first page never held, so
    // the panel must answer with the Remote's set, not with a local filter.
    await waitFor(() => { expect(search).toHaveBeenCalledWith('session-1', 'tls', 20) })
    expect(await screen.findByText('memory b')).toBeTruthy()
    expect(screen.queryByText('memory a')).toBeNull()
    expect(screen.getByText(/命中 1 条/)).toBeTruthy()
  })

  it('treats a blank box as stop-filtering rather than a search for everything', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured')] } })
    const search = vi.fn()
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} search={search as never} recall={vi.fn().mockResolvedValue(emptyRecall) as never} {...stubs} />)

    await screen.findByText('memory a')
    fireEvent.change(screen.getByLabelText('搜索项目记忆'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    // An absent query means "no filter" to the Host, whose unfiltered page would
    // be indistinguishable from a search that matched everything.
    expect(search).not.toHaveBeenCalled()
  })

  it('previews the reviewed subset a session start would actually inject', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured'), record('b', 'draft')] } })
    const recall = vi.fn().mockResolvedValue({ ok: true as const, value: { projectId: 'proj', tokenBudget: 2000, usedTokens: 640, records: [record('c', 'reviewed')] } })
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} search={vi.fn() as never} recall={recall as never} {...stubs} />)

    expect(await screen.findByText('会话开始时注入的记忆')).toBeTruthy()
    // The list holds a captured and a draft record; neither reaches the model, so
    // the preview has to report the reviewed set and its budget separately.
    expect(screen.getByText(/1 条已审核记忆，占 640 \/ 2000 tokens/)).toBeTruthy()
    expect(screen.getByText('memory c')).toBeTruthy()
    expect(recall).toHaveBeenCalledWith('session-1')
  })

  it('says so when no reviewed memory will be injected', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured')] } })
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} search={vi.fn() as never} recall={vi.fn().mockResolvedValue(emptyRecall) as never} {...stubs} />)

    expect(await screen.findByText('当前没有已审核记忆，因此新会话不会注入任何项目知识。')).toBeTruthy()
  })

  it('keeps listing records when the Host predates the recall Remote', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured')] } })
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} search={vi.fn() as never} {...stubs} />)

    expect(await screen.findByText('memory a')).toBeTruthy()
    expect(screen.queryByText('会话开始时注入的记忆')).toBeNull()
  })

  it('hides the search box when the Host predates the search Remote', async () => {
    // A box whose button would call an absent function is worse than no box: the
    // click throws a TypeError out of an effect chain rather than doing nothing.
    const list = vi.fn().mockResolvedValue({ ok: true as const, value: { records: [record('a', 'captured')] } })
    render(<EngineeringMemoryPanel enabled={true} currentSessionId={() => 'session-1'} list={list as never} {...stubs} />)

    expect(await screen.findByText('memory a')).toBeTruthy()
    expect(screen.queryByLabelText('搜索项目记忆')).toBeNull()
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull()
  })
})

describe('EngineeringEvalPanel', () => {
  const report = (over: Record<string, unknown> = {}) => ({ version: 1 as const, suites: ['guards'] as const, cases: [], passed: 46, total: 46, score: 1, ok: true, checkedAt: 1_700_000_000_000, ...over })

  it('runs the plugin self-check on demand and reports the tally', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true as const, value: report() })
    render(<EngineeringEvalPanel run={run as never} />)

    expect(screen.queryByText('全部通过。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '运行自检' }))

    await waitFor(() => { expect(run).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('46/46 通过')).toBeTruthy()
    expect(screen.getByText(/全部通过。/)).toBeTruthy()
    // A second run must be reachable: the value of a self-check is checking again
    // after an update.
    expect(screen.getByRole('button', { name: '重新运行' })).toBeTruthy()
  })

  it('lists only the cases that missed their threshold, with both numbers', async () => {
    const failing = { id: 'guards-secrets', suite: 'guards' as const, claim: '密文文件名一律拒绝', passed: false, observed: 13, required: 14, detail: '13/14', failure: '漏掉 .env.production' }
    const passing = { id: 'guards-cmd', suite: 'guards' as const, claim: '危险命令一律拒绝', passed: true, observed: 20, required: 20, detail: '20/20' }
    const run = vi.fn().mockResolvedValue({ ok: true as const, value: report({ cases: [passing, failing], passed: 45, total: 46, score: 45 / 46, ok: false }) })
    render(<EngineeringEvalPanel run={run as never} />)
    fireEvent.click(screen.getByRole('button', { name: '运行自检' }))

    expect(await screen.findByText('密文文件名一律拒绝')).toBeTruthy()
    expect(screen.getByText(/实测 13 \/ 需要 14 · 漏掉 .env.production/)).toBeTruthy()
    expect(screen.getByText('45/46 通过')).toBeTruthy()
    // A passing case needs no row to say so; only the shortfall is actionable.
    expect(screen.queryByText('危险命令一律拒绝')).toBeNull()
  })

  it('reports why the self-check could not complete', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'runtime unavailable' } })
    render(<EngineeringEvalPanel run={run as never} />)
    fireEvent.click(screen.getByRole('button', { name: '运行自检' }))

    expect((await screen.findByRole('alert')).textContent).toContain('runtime unavailable')
    expect(screen.queryByText(/全部通过。/)).toBeNull()
  })
})

describe('advisor manual review', () => {
  const base = {
    enabled: true, mode: 'async', provider: 'opencode', model: 'big-pickle',
    routeReady: true, allowAgentControl: true, interruptCooldownTurns: 3,
    reviewTools: ['read', 'glob'], activeSessions: 0, queuedReviews: 0,
    noteCount: 0, inputTokens: 0, outputTokens: 0, watchdogFiles: [],
  }
  const renderAdvisor = (sessionId: string | undefined) => {
    const advisorReviewNow = vi.fn().mockResolvedValue({ ok: true as const, value: base })
    render(<AdvisorSettingsSection
      {...hostStandardProps}
      close={vi.fn()}
      advisorStatus={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorUpdate={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorModels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorNotes={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorReviewNow={advisorReviewNow as never}
      currentSessionId={() => sessionId}
    />)
    return advisorReviewNow
  }

  it('reviews the current session on demand', async () => {
    const review = renderAdvisor('session-1')
    await screen.findByText('审查模式')

    fireEvent.click(screen.getByRole('button', { name: '立即复核当前会话' }))

    await waitFor(() => { expect(review).toHaveBeenCalledWith('session-1') })
    expect(await screen.findByText(/已触发；建议会在复核完成后出现/)).toBeTruthy()
  })

  it('asks for an open session instead of calling the Host with no id', async () => {
    const review = renderAdvisor(undefined)
    await screen.findByText('审查模式')

    fireEvent.click(screen.getByRole('button', { name: '立即复核当前会话' }))

    expect(await screen.findByText('先在左侧打开一个会话，再手动复核。')).toBeTruthy()
    expect(review).not.toHaveBeenCalled()
  })

  it('reports a review the Host refused', async () => {
    const advisorReviewNow = vi.fn().mockResolvedValue({ ok: false as const, error: { message: 'advisor route is not ready' } })
    render(<AdvisorSettingsSection
      {...hostStandardProps}
      close={vi.fn()}
      advisorStatus={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorUpdate={vi.fn().mockResolvedValue({ ok: true as const, value: base })}
      advisorModels={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorNotes={vi.fn().mockResolvedValue({ ok: true as const, value: [] })}
      advisorReviewNow={advisorReviewNow as never}
      currentSessionId={() => 'session-1'}
    />)
    await screen.findByText('审查模式')
    fireEvent.click(screen.getByRole('button', { name: '立即复核当前会话' }))

    expect((await screen.findByRole('alert')).textContent).toContain('advisor route is not ready')
  })
})

describe('checkout quoting', () => {
  /** Digits only, so a case does not depend on the host's locale or symbol. */
  const digitsOf = (text: string): string => text.replace(/[^0-9]/gu, '')

  it('never raises an amount that is already a whole number of minor units', () => {
    // A property, not one fixture: the ceiling this replaced subtracted
    // `Number.EPSILON` from the scaled product, which is the gap at 1 and so
    // changed nothing at the magnitude of a real amount. About 4.6% of
    // two-decimal amounts were therefore quoted one minor unit high (2.20 as
    // 2.21), and a single fixture could have passed by luck.
    const inflated: number[] = []
    for (let cents = 1; cents <= 20_000; cents += 1) {
      const amount = cents / 100
      if (roundUpCurrency(amount, 'CNY') !== amount) inflated.push(amount)
    }
    expect(inflated).toEqual([])
  })

  it('still rounds a genuine fraction up to the currency precision', () => {
    // The whole point of the ceiling: a fraction of a minor unit may never be
    // dropped on the payer's side of the quote.
    expect(roundUpCurrency(2.201, 'CNY')).toBe(2.21)
    expect(roundUpCurrency(13.88888888888889, 'CNY')).toBe(13.89)
    expect(roundUpCurrency(0.0001, 'CNY')).toBe(0.01)
    expect(roundUpCurrency(35.7201, 'CNY')).toBe(35.73)
  })

  it('uses the currency own precision rather than a fixed two decimals', () => {
    // Yen has no minor unit and the Kuwaiti dinar has three; both are reachable
    // through the payment channel table the panel reads.
    expect(roundUpCurrency(1200, 'JPY')).toBe(1200)
    expect(roundUpCurrency(1200.4, 'JPY')).toBe(1201)
    expect(roundUpCurrency(2.011, 'KWD')).toBe(2.011)
    expect(roundUpCurrency(2.0114, 'KWD')).toBe(2.012)
  })

  it('quotes the sum of already-rounded fee parts as that sum', () => {
    // base 13.89 + 3% percentage fee 0.42 is 14.31 exactly at the currency's
    // precision, and 35.72 + 0.29 is 36.01: the number on the checkout button
    // has to be the total the breakdown states, not one minor unit above it.
    expect(roundUpCurrency(13.89 + 0.42, 'CNY')).toBe(14.31)
    expect(roundUpCurrency(35.72 + 0.29, 'CNY')).toBe(36.01)
  })

  it('prints an amount with the precision the quoting rounded it to', () => {
    // The formatter clamped two fraction digits while the ceiler above rounds to
    // the currency's own, so the dinar's third digit — the part the order really
    // charges — never reached the screen. Asserted on digits only, so the case
    // does not depend on the test host's locale or its currency symbol.
    expect(digitsOf(formatMoney(2.012, 'KWD'))).toBe('2012')
    // Guards for the currencies that do have two (and none): a clamp that is
    // correct for them must stay correct.
    expect(digitsOf(formatMoney(2.2, 'CNY'))).toBe('220')
    expect(digitsOf(formatMoney(1200, 'JPY'))).toBe('1200')
    expect(formatMoney(undefined, 'USD')).toBe('—')
  })

  it('prints a price whose currency this runtime cannot name instead of failing to render', () => {
    // `Intl` accepts only codes shaped like a currency — three ASCII letters —
    // and throws a `RangeError` on everything else, which is exactly the shape a
    // price feed produces when it sends a four-letter ticker or a symbol. Every
    // formatter here runs inside render, so the throw did not degrade one cell:
    // it took the whole payment panel down. The amount still has to be readable.
    for (const code of ['USDT', '￥', 'us dollars']) {
      expect(() => formatMoney(88.5, code)).not.toThrow()
      expect(digitsOf(formatMoney(88.5, code))).toBe('8850')
    }
    // The backend's own label rides along rather than a symbol this client would
    // have to invent: claiming USD for a plan priced in another currency is the
    // lie `orderSettlementCurrency` already refuses to tell.
    expect(formatMoney(88.5, 'USDT')).toContain('USDT')
    // An empty code has no label to print at all, and must not blank the amount.
    expect(digitsOf(formatMoney(12, ''))).toBe('1200')
  })

  it('reads a padded currency code as the currency it names', () => {
    // The channel table passes the backend's string through verbatim, so a code
    // with surrounding whitespace reached `Intl` as a malformed currency and threw
    // on the payment panel — even though it names a currency perfectly well.
    expect(digitsOf(formatMoney(2.2, ' CNY '))).toBe('220')
    expect(formatMoney(2.2, ' CNY ')).not.toContain('CNY')
    expect(roundUpCurrency(2.201, ' CNY ')).toBe(2.21)
  })

  it('refuses to quote in a currency whose smallest unit it cannot name', () => {
    // The display path falls back to the code as a label; the path that decides
    // what the payer is charged has no fallback, because guessing "two digits"
    // for an unnameable currency quotes an amount nobody can settle.
    expect(() => roundUpCurrency(2.201, 'USDT')).toThrow(/runtime can name/u)
    expect(() => roundUpCurrency(2.201, '')).toThrow(/currency is required/u)
  })
})

