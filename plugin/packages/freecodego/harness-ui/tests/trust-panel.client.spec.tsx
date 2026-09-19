// @vitest-environment jsdom
/**
 * The folder-trust panel.
 *
 * What matters here is not that the state renders, but that the gesture sends
 * exactly the root the Host reported. A panel that derived a repository root of
 * its own would revoke a directory the grant never named — and the failure would
 * be silent, because a revoke of the wrong root still writes a record.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FreeCodeGoTrustReason } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import { TrustPanel } from '../src/client/settings-tab.tsx'

afterEach(cleanup)

type TrustPanelProps = Parameters<typeof TrustPanel>[0]

/** A status whose decision and root are overridable. */
function status(overrides: Partial<{ trusted: boolean; reason: FreeCodeGoTrustReason; currentRoot: string | undefined; enabled: boolean; entries: readonly { readonly root: string; readonly grantedAt: string }[] }> = {}) {
  const trusted = overrides.trusted ?? false
  const currentRoot = 'currentRoot' in overrides ? overrides.currentRoot : '/w/repo'
  return {
    enabled: overrides.enabled ?? true,
    recordPath: '/home/user/.dsh/state/freecodego/trusted-folders.json',
    entries: overrides.entries ?? (trusted ? [{ root: '/w/repo', grantedAt: '2026-09-17T00:00:00.000Z' }] : []),
    ...(currentRoot === undefined ? {} : { currentRoot }),
    current: { trusted, reason: overrides.reason ?? (trusted ? 'granted' : 'no-record') },
  }
}

function setup(overrides: Partial<TrustPanelProps> = {}): TrustPanelProps {
  const props: TrustPanelProps = {
    status: vi.fn(async () => ({ ok: true as const, value: status() })),
    // The directory parameter is asserted, so it has to be accepted: a mock that
    // ignored it would prove nothing about what the panel sent.
    grant: vi.fn(async (_directory: string) => ({ ok: true as const, value: status({ trusted: true }) })),
    revoke: vi.fn(async (_directory: string) => ({ ok: true as const, value: status() })),
    language: 'en',
    ...overrides,
  }
  render(<TrustPanel {...props} />)
  return props
}

describe('TrustPanel', () => {
  it('offers to trust the workspace the Host reported', async () => {
    const props = setup()
    // It says why the current answer is what it is, so a repository that stopped
    // loading its servers is not indistinguishable from one that never had any.
    expect((await screen.findByText(/does not name this repository/u)).textContent).toBeTruthy()
    const button = screen.getByLabelText('trust-current-toggle')
    expect(button.textContent).toContain('Trust this repository')
    fireEvent.click(button)
    await waitFor(() => { expect(props.grant).toHaveBeenCalledWith('/w/repo') })
  })

  it('revokes by the root the Host resolved, not a path the panel derived', async () => {
    const props = setup({
      status: vi.fn(async () => ({ ok: true as const, value: status({ trusted: true }) })),
      revoke: vi.fn(async (_directory: string) => ({ ok: true as const, value: status({ trusted: true }) })),
    })
    const toggle = await screen.findByLabelText('trust-current-toggle')
    expect(toggle.textContent).toContain('Revoke trust')
    fireEvent.click(toggle)
    await waitFor(() => { expect(props.revoke).toHaveBeenCalledWith('/w/repo') })
    expect(props.grant).not.toHaveBeenCalled()
  })

  it('revokes one recorded entry by the root the record stored', async () => {
    // A record naming a different checkout must be revocable from here too: the
    // list is the only place that root is visible.
    const props = setup({
      status: vi.fn(async () => ({
        ok: true as const,
        value: status({ trusted: true, entries: [{ root: '/w/repo', grantedAt: '2026-09-17T00:00:00.000Z' }, { root: '/w/other', grantedAt: '2026-09-16T00:00:00.000Z' }] }),
      })),
      revoke: vi.fn(async (_directory: string) => ({ ok: true as const, value: status({ trusted: true }) })),
    })
    fireEvent.click(await screen.findByLabelText('trust-revoke-/w/other'))
    await waitFor(() => { expect(props.revoke).toHaveBeenCalledWith('/w/other') })
  })

  it('surfaces a failed change instead of pretending it applied', async () => {
    const props = setup({
      grant: vi.fn(async (_directory: string) => { throw new RemoteError('gateway/internal', 'not a git repository', {}) }),
    })
    fireEvent.click(await screen.findByLabelText('trust-current-toggle'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(props.grant).toHaveBeenCalledTimes(1)
    // The status is refreshed from the Host rather than optimistically flipped.
    expect(screen.getByLabelText('trust-current-toggle').textContent).toContain('Trust this repository')
  })

  it('reports a disabled gate rather than a per-repository answer, and cannot be toggled', async () => {
    setup({ status: vi.fn(async () => ({ ok: true as const, value: status({ enabled: false, reason: 'global-disabled' }) })) })
    expect((await screen.findByText('Gate off')).textContent).toBeTruthy()
    expect(screen.queryByLabelText('trust-current-toggle')).toBeNull()
  })

  it('renders nothing when the Host does not declare the Remote', () => {
    const { container } = render(<TrustPanel language="zh" />)
    expect(container.textContent).toBe('')
  })

  it('replaces the Loading badge with a failure and the reason when the read fails', async () => {
    // The badge is driven by `snapshot`, and the read used to be swallowed: a
    // failed read left it saying "Loading" forever, which is indistinguishable
    // from a Host that is merely slow.
    setup({ status: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'TRUST_STATUS_UNREADABLE', {}) })) })

    expect(await screen.findByText('Read failed')).toBeTruthy()
    expect(screen.queryByText('Loading')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the trust status: TRUST_STATUS_UNREADABLE')
  })

  it('reports a failed project-configuration read without hiding the trust answer', async () => {
    // The two reads answer different questions, so one failing must not blank
    // the other: trust is still readable and still shown.
    setup({
      status: vi.fn(async () => ({ ok: true as const, value: status({ trusted: true }) })),
      projectConfig: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'PROJECT_CONFIG_UNREADABLE', {}) })),
    })

    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the project configuration: PROJECT_CONFIG_UNREADABLE')
    expect(screen.getByText('Trusted')).toBeTruthy()
  })
})
