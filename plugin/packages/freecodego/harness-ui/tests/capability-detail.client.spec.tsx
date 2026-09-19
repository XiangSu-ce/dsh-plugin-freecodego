// @vitest-environment jsdom
/**
 * The in-plugin Skill detail dialog. Its chips each start a Host read, and the
 * reads can answer out of order, so what the dialog displays must follow the
 * last click rather than the last response.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillDetailModal, type SkillDetailContent } from '../src/client/capability-detail.tsx'

afterEach(cleanup)

const skill = { name: 'wizard', description: 'Scaffold a project', source: 'starter', modelInvocable: true, userInvocable: true }

/** A deferred Host read, resolved by the test. */
function deferred(): { promise: Promise<SkillDetailContent>; resolve: (value: SkillDetailContent) => void } {
  let resolve!: (value: SkillDetailContent) => void
  const promise = new Promise<SkillDetailContent>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('Skill detail dialog: companion file reads', () => {
  it('shows the last-clicked file even when an earlier read answers later', async () => {
    const first = deferred()
    const second = deferred()
    const load = vi.fn((file?: string) => {
      if (file === 'a.md') return first.promise
      if (file === 'b.md') return second.promise
      return Promise.resolve({ content: 'Skill body', files: [{ path: 'a.md', bytes: 11 }, { path: 'b.md', bytes: 22 }] })
    })
    const { container, getByText } = render(<SkillDetailModal skill={skill} language="en" load={load} onClose={() => {}} />)
    await waitFor(() => { expect(container.querySelector('pre')?.textContent).toBe('Skill body') })

    fireEvent.click(getByText(/a\.md/))
    fireEvent.click(getByText(/b\.md/))
    // The later click answers first...
    second.resolve({ content: 'Skill body', files: [], file: { path: 'b.md', bytes: 22, content: 'b body' } })
    await waitFor(() => { expect(container.querySelector('pre')?.textContent).toBe('b body') })

    // ...and the earlier one must not replace it: the user asked for b.md last.
    first.resolve({ content: 'Skill body', files: [], file: { path: 'a.md', bytes: 11, content: 'a body' } })
    await waitFor(() => { expect(load).toHaveBeenCalledWith('a.md') })
    expect(container.querySelector('pre')?.textContent).toBe('b body')
  })
})
