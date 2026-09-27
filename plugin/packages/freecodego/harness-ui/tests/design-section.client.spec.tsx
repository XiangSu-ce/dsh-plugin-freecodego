// @vitest-environment jsdom
/**
 * The design page: one master switch plus a row per capability.
 *
 * What this pins is the half no Host test can see. The Host side of the pack is
 * well covered — `design-tools`/`design-registry`/`design-integration` drive the
 * real registry, the real Skills provider and the real tool service — and all of
 * that stays perfectly healthy if this page renders a row without a control, a
 * control that sends the wrong id, or a switch that shows what was asked for
 * rather than what was stored. The `remote-contract` sweep now reads section
 * faces from this page too, and its reach stops at the *presence* of a prop —
 * never at whether a control exists for it, which is what this file is for.
 *
 * Three things are therefore asserted by construction rather than by accident:
 *
 *  - the page iterates `features` instead of spelling out `hyperframes`, which
 *    the fixture proves by carrying a second, unavailable feature;
 *  - a write is followed by the status the Host *returned*, not by the value the
 *    user clicked — the fixture answers a request it refuses, which is the only
 *    shape that separates the two;
 *  - every locale key the union declares has a string, in both languages, so a
 *    new key cannot ship as an untranslated blank.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FreeCodeGoDesignFeatureState, FreeCodeGoDesignStatus,
} from '@deepseek-ai/dsh-freecodego-harness-plugin'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { DesignSection } from '../src/client/design-section.tsx'
import type { DesignSectionInjected, DesignSectionLocaleKey } from '../src/client/design-section.tsx'

afterEach(cleanup)

/**
 * Every locale key the section's own union declares.
 *
 * Written out so the fixture below and the shipped tables have to agree with a
 * list someone has to look at, rather than with each other.
 */
const LOCALE_CONTRACT: readonly DesignSectionLocaleKey[] = [
  'design', 'designIntro', 'designMasterOn', 'designMasterOff',
  'designTools', 'designLoading', 'designLoadFailed', 'designWriteFailed',
]

/** English strings, one per contract key. */
const LOCALE: Record<DesignSectionLocaleKey, string> = {
  design: 'Design',
  designIntro: 'Turn design capabilities on as you need them.',
  designMasterOn: 'Master switch on',
  designMasterOff: 'Master switch off',
  designTools: 'Tools provided',
  designLoading: 'Reading design capability status…',
  designLoadFailed: 'Could not read the design capability status.',
  designWriteFailed: 'The change was not saved; the status is unchanged.',
}

const t = (key: DesignSectionLocaleKey): string => LOCALE[key]

/**
 * Two features, so the page cannot pass by hardcoding today's single one.
 *
 * `hyperframes` is available and off; `not-installed` is unavailable, and the
 * detail string is what explains it. The unavailable row must stay listed and
 * must stay switchable-off-but-not-on — a row that disappears leaves the user
 * unable to tell a missing asset from a page that never offered it.
 */
function feature(overrides: Partial<FreeCodeGoDesignFeatureState> & Pick<FreeCodeGoDesignFeatureState, 'id'>): FreeCodeGoDesignFeatureState {
  const id = overrides.id
  return {
    label: id,
    summary: `${id} summary`,
    tools: [],
    enabled: false,
    available: true,
    detail: `${id} detail`,
    ...overrides,
  }
}

/** A status with both features present; the master switch off. */
function status(overrides: Partial<FreeCodeGoDesignStatus> = {}): FreeCodeGoDesignStatus {
  return {
    designEnabled: false,
    skillsReady: true,
    features: [
      feature({
        id: 'hyperframes',
        label: 'HyperFrames',
        summary: 'Turns a composition into a video.',
        tools: ['freecodego_design_lint', 'freecodego_design_render'],
        detail: 'Ready: 17 Skills, 502 files.',
      }),
      feature({
        id: 'not-installed',
        label: 'Missing pack',
        summary: 'Not present on this machine.',
        available: false,
        detail: 'Its asset root is missing, so the row cannot be turned on.',
      }),
    ],
    ...overrides,
  }
}

type Props = Parameters<typeof DesignSection>[0]

/** Render the page against a Host that answers all three Remotes. */
function setup(overrides: Partial<Props> = {}): Props {
  const props: Props = {
    status: vi.fn(async () => ({ ok: true as const, value: status() })),
    setEnabled: vi.fn(async (enabled: boolean) => ({ ok: true as const, value: status({ designEnabled: enabled }) })),
    setFeatureEnabled: vi.fn(async (_id: string) => ({ ok: true as const, value: status() })),
    t,
    ...overrides,
  }
  render(<DesignSection {...props} />)
  return props
}

/** The master control is the first checkbox the page draws. */
function master(): HTMLInputElement {
  return screen.getAllByRole('checkbox')[0] as HTMLInputElement
}

describe('DesignSection', () => {
  it('draws one switch per feature the Host reports, plus the master', async () => {
    setup()
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(3) })
    // The second feature is the point: a page written against `hyperframes`
    // alone renders two controls here and this length assertion fails.
    expect(screen.getByText('HyperFrames')).toBeTruthy()
    expect(screen.getByText('Missing pack')).toBeTruthy()
  })

  it('renders the value the Host reported, not a locally assumed default', async () => {
    setup({
      status: vi.fn(async () => ({
        ok: true as const,
        value: status({ designEnabled: true, features: [
          feature({ id: 'hyperframes', label: 'HyperFrames', enabled: true }),
          feature({ id: 'not-installed', label: 'Missing pack', available: false }),
        ] }),
      })),
    })
    await waitFor(() => { expect(master().checked).toBe(true) })
    expect((screen.getByLabelText('HyperFrames') as HTMLInputElement).checked).toBe(true)
  })

  it('waits for the Host rather than drawing an off-looking page first', async () => {
    setup()
    // The placeholder is copy, not a switch row: a page that drew unchecked
    // controls before the answer arrived would show the user a state nobody
    // reported, and the master would flicker on every open.
    expect(screen.getByText(LOCALE.designLoading)).toBeTruthy()
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(3) })
  })

  it('turns the master switch on through its own Remote', async () => {
    const props = setup()
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(3) })
    fireEvent.click(master())
    await waitFor(() => { expect(props.setEnabled).toHaveBeenCalledWith(true) })
    // Enabling the pack is not a feature choice, so it must not go through the
    // per-feature call and must not restate the feature list.
    expect(props.setFeatureEnabled).not.toHaveBeenCalled()
  })

  it('sends the exact feature id it toggled, and no other payload', async () => {
    const props = setup()
    const row = await screen.findByLabelText('HyperFrames')
    fireEvent.click(row)
    await waitFor(() => { expect(props.setFeatureEnabled).toHaveBeenCalledWith('hyperframes', true) })
    // One call, one id: a page that sent the whole list would overwrite a
    // choice the user made in another window.
    expect((props.setFeatureEnabled as ReturnType<typeof vi.fn>).mock.calls).toStrictEqual([['hyperframes', true]])
    expect(props.setEnabled).not.toHaveBeenCalled()
  })

  it('adopts the status the write returned, not the value that was clicked', async () => {
    // The Host refuses: asked for `true`, answers `false`. Optimism and adoption
    // are indistinguishable when both are `true`, so the fixture answers the
    // opposite of the request.
    const props = setup({
      setEnabled: vi.fn(async () => ({ ok: true as const, value: status({ designEnabled: false }) })),
    })
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(3) })
    fireEvent.click(master())
    await waitFor(() => { expect(props.setEnabled).toHaveBeenCalled() })
    await waitFor(() => { expect(master().disabled).toBe(false) })
    expect(master().checked).toBe(false)
  })

  it('keeps an unavailable row listed and refuses to turn it on', async () => {
    const props = setup()
    const row = await screen.findByLabelText('Missing pack')
    expect((row as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(row)
    expect(props.setFeatureEnabled).not.toHaveBeenCalled()
    // The row explains itself instead of vanishing.
    expect(screen.getByText('Its asset root is missing, so the row cannot be turned on.')).toBeTruthy()
  })

  it('sends nothing while a write is in flight, even to a control that is clicked again', async () => {
    // A write that never answers leaves the page busy for the rest of the test.
    // The second click is the point: `busy` disables every switch, and the guard
    // in `Switch` is what makes that hold for a change event that arrives anyway.
    const pending = new Promise<RemoteResult<FreeCodeGoDesignStatus>>(() => {})
    const props = setup({
      setFeatureEnabled: vi.fn(() => pending),
    })
    const row = await screen.findByLabelText('HyperFrames')
    fireEvent.click(row)
    await waitFor(() => { expect(props.setFeatureEnabled).toHaveBeenCalledTimes(1) })
    expect((screen.getByLabelText('HyperFrames') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(master())
    fireEvent.click(screen.getByLabelText('HyperFrames'))
    expect((props.setFeatureEnabled as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(props.setEnabled).not.toHaveBeenCalled()
  })

  it('lists the tools a row adds, and omits the block when it adds none', async () => {
    setup()
    await waitFor(() => { expect(screen.getAllByRole('checkbox')).toHaveLength(3) })
    expect(screen.getByText('Tools provided')).toBeTruthy()
    expect(screen.getByText('freecodego_design_render')).toBeTruthy()
    // Exactly one heading for two features, because the second declares none.
    expect(screen.getAllByText('Tools provided')).toHaveLength(1)
  })

  it('reports a read failure as the reason, and a write failure without claiming success', async () => {
    const refused = setup({ status: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'read refused', {}) })) })
    await waitFor(() => { expect(screen.getByText(LOCALE.designLoadFailed)).toBeTruthy() })
    expect(refused.setEnabled).not.toHaveBeenCalled()
    cleanup()

    const props = setup({
      setFeatureEnabled: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'write refused', {}) })),
    })
    const row = await screen.findByLabelText('HyperFrames')
    fireEvent.click(row)
    await waitFor(() => { expect(screen.getByText(LOCALE.designWriteFailed)).toBeTruthy() })
    // The write was refused, so the switch must not have moved.
    expect((screen.getByLabelText('HyperFrames') as HTMLInputElement).checked).toBe(false)
    // And the page is usable afterwards rather than stuck busy.
    await waitFor(() => { expect((screen.getByLabelText('HyperFrames') as HTMLInputElement).disabled).toBe(false) })
    expect(props.setFeatureEnabled).toHaveBeenCalled()
  })

  it('does not throw when the Remote rejects instead of answering', async () => {
    setup({ status: vi.fn(async () => { throw new Error('link down') }) })
    await waitFor(() => { expect(screen.getByText(LOCALE.designLoadFailed)).toBeTruthy() })
  })

  it('carries a string in both languages for every key its union declares', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = await readFile(join(here, '..', 'src', 'client', 'index.ts'), 'utf8')
    const missing: string[] = []
    for (const key of LOCALE_CONTRACT) {
      const declared = source.match(new RegExp(`^\\s*${key}: '`, 'gmu')) ?? []
      // One per language table. Fewer means a blank cell in one language.
      if (declared.length < 2) missing.push(`${key} (${declared.length})`)
    }
    expect(missing).toStrictEqual([])
    // And the fixture cannot invent a key the component does not ask for.
    expect(LOCALE_CONTRACT).toHaveLength(Object.keys(LOCALE).length)
  })

  it('declares the locale and face contracts this page is registered against', () => {
    // A type-level restatement: if the union or the face gains a member, this
    // file stops compiling, which is the cheapest place to notice.
    const face: DesignSectionInjected = {
      status: async () => ({ ok: true as const, value: status() }),
      setEnabled: async () => ({ ok: true as const, value: status() }),
      setFeatureEnabled: async () => ({ ok: true as const, value: status() }),
      t,
    }
    expect(Object.keys(face).sort()).toStrictEqual(['setEnabled', 'setFeatureEnabled', 'status', 't'])
    render(<DesignSection {...face} />)
    expect(screen.getByText(LOCALE.designLoading)).toBeTruthy()
  })
})
