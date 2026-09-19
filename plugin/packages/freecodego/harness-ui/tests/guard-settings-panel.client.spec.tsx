// @vitest-environment jsdom
/**
 * The guard/quality switch panel.
 *
 * What this pins is the half a switch has that no Host test can see: a toggle
 * that exists in the contract but has no control is a switch the user cannot
 * reach, and the Host side of it looks perfectly healthy — the schema declares
 * it, `guardSettingsStatus` reports it, and `guardSettingsUpdate` accepts it.
 *
 * Three of the thirteen keys were exactly that. `assistantLoopGuardEnabled`,
 * `rehydrationArcEnabled` and `promptCompositionEnabled` are declared in the
 * settings schema, gated in the runtime, carried by
 * `FreeCodeGoGuardSettingsStatus`/`Update`, and named in the plugin's own
 * capability notes — while this panel rendered ten rows and silently omitted
 * them. `rehydrationArcEnabled` is the sharpest case: it defaults to `false`,
 * so the conversation-arc enhancement could not be turned on by any user
 * action at all.
 *
 * The key list below is the contract, written out so it has to be looked at in
 * both places rather than drifting one key at a time.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FreeCodeGoGuardSettingsStatus } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import { GuardSettingsPanel } from '../src/client/settings-tab.tsx'

afterEach(cleanup)

/**
 * Every key `guardSettingsUpdate` accepts, with the control this panel renders
 * for it. Keep in the order the Host's own update loop uses.
 */
const GUARD_CONTRACT: readonly (readonly [keyof FreeCodeGoGuardSettingsStatus, string])[] = [
  ['envReadGuardEnabled', 'Credential-file read protection'],
  ['doomLoopGuardEnabled', 'Doom-loop guard'],
  ['assistantLoopGuardEnabled', 'Assistant-output loop guard'],
  ['lspEnabled', 'LSP language services'],
  ['rehydrationEnabled', 'Post-compaction rehydration'],
  ['rehydrationArcEnabled', 'Conversation arc (goals and decisions)'],
  ['advisorMemoryDraftsEnabled', 'Advisor findings to memory'],
  ['commandPolicyEnabled', 'Command policy (refusals)'],
  ['planModeEnabled', 'Plan Mode (structural write refusal)'],
  ['cacheColdClearEnabled', 'Cache-cold clearing'],
  ['cacheBreakAttributionEnabled', 'Cache-break attribution'],
  ['contextBudgetEnabled', 'Model-visible context budget'],
  ['promptCompositionEnabled', 'Prompt composition breakdown'],
]

/** A status with every contract key present; every switch on except the opt-in arc. */
function status(overrides: Partial<FreeCodeGoGuardSettingsStatus> = {}): FreeCodeGoGuardSettingsStatus {
  const value: Record<string, boolean> = {}
  for (const [key] of GUARD_CONTRACT) value[key] = key !== 'rehydrationArcEnabled'
  return { ...value, ...overrides } as unknown as FreeCodeGoGuardSettingsStatus
}

type GuardPanelProps = Parameters<typeof GuardSettingsPanel>[0]

/** Render the panel against a Host that answers both Remotes. */
function setup(overrides: Partial<GuardPanelProps> = {}): GuardPanelProps {
  const props: GuardPanelProps = {
    status: vi.fn(async () => ({ ok: true as const, value: status() })),
    update: vi.fn(async (_patch: Parameters<NonNullable<GuardPanelProps['update']>>[0]) => ({ ok: true as const, value: status() })),
    language: 'en',
    ...overrides,
  }
  render(<GuardSettingsPanel {...props} />)
  return props
}

describe('GuardSettingsPanel', () => {
  it('renders one control for every switch the Host contract carries', async () => {
    setup()
    // Wait for the status to land, so `checked` reflects the Host rather than
    // the disabled placeholder the first paint draws.
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(GUARD_CONTRACT.length) })
    for (const [key, title] of GUARD_CONTRACT) {
      const control = screen.getByLabelText(title)
      expect(control, key).toBeTruthy()
      expect(control.getAttribute('type'), key).toBe('checkbox')
      // The value the Host reported, not a locally assumed default: the arc is
      // the one opt-in switch and must render unchecked.
      expect((control as HTMLInputElement).checked, key).toBe(key !== 'rehydrationArcEnabled')
    }
  })

  it('sends the exact key it toggled, and no other', async () => {
    const props = setup()
    const loop = await screen.findByLabelText('Assistant-output loop guard')
    fireEvent.click(loop)
    await waitFor(() => { expect(props.update).toHaveBeenCalledWith({ assistantLoopGuardEnabled: false }) })
    // The other two recovered switches are reachable too, and each sends only
    // its own key — a panel that sent a whole snapshot would overwrite a
    // setting the user changed in another window.
    fireEvent.click(screen.getByLabelText('Conversation arc (goals and decisions)'))
    await waitFor(() => { expect(props.update).toHaveBeenCalledWith({ rehydrationArcEnabled: true }) })
    fireEvent.click(screen.getByLabelText('Prompt composition breakdown'))
    await waitFor(() => { expect(props.update).toHaveBeenCalledWith({ promptCompositionEnabled: false }) })
  })

  it('leaves every control disabled when the Host declares no update Remote', async () => {
    setup({ update: undefined })
    await waitFor(() => { expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0) })
    for (const control of screen.getAllByRole('checkbox')) expect((control as HTMLInputElement).disabled).toBe(true)
  })
})
