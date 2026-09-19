// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { EngineeringCheckpointPanel } from '../src/client/settings-tab.tsx'

afterEach(cleanup)

const checkpoint = (id: string, label: string, pinned = false) => ({
  id,
  label,
  createdAt: 1_700_000_000_000,
  entries: [{ file: 'src/a.ts', hash: 'abc', bytes: 10 }],
  ...(pinned ? { pinned: true } : {}),
})

const diff = (value: { readonly modified?: readonly string[]; readonly addedSince?: readonly string[]; readonly deletedSince?: readonly string[]; readonly missingBlobs?: number; readonly captureListTruncated?: boolean } = {}) => ({
  modified: value.modified ?? [],
  addedSince: value.addedSince ?? [],
  deletedSince: value.deletedSince ?? [],
  missingBlobs: value.missingBlobs ?? 0,
  captureListTruncated: value.captureListTruncated ?? false,
})

/** Render with the current session always available unless overridden. */
type CheckpointPanelProps = Parameters<typeof EngineeringCheckpointPanel>[0]
function setup(overrides: Partial<CheckpointPanelProps> = {}) {
  const props: CheckpointPanelProps = {
    enabled: true,
    currentSessionId: () => 'session-1',
    list: vi.fn(async () => ({ ok: true as const, value: [checkpoint('cp_1', 'auto: before write')] })),
    capture: vi.fn(async () => ({ ok: true as const, value: checkpoint('cp_2', 'manual checkpoint') })),
    diff: vi.fn(async () => ({ ok: true as const, value: diff() })),
    restore: vi.fn(async () => ({ ok: true as const, value: { restoredFiles: 3, deletedFiles: 1, missingBlobs: 0, captureListTruncated: false } })),
    remove: vi.fn(async () => ({ ok: true as const, value: { deleted: true as const } })),
    setPinned: vi.fn(async () => ({ ok: true as const, value: { pinned: true } })),
    ...overrides,
  }
  render(<EngineeringCheckpointPanel {...props} />)
  return props
}

describe('EngineeringCheckpointPanel', () => {
  it('lists this workspace checkpoints newest-first as the Host returns them', async () => {
    setup({ list: vi.fn(async () => ({ ok: true as const, value: [checkpoint('cp_2', 'newest'), checkpoint('cp_1', 'older')] })) })
    expect(await screen.findByText('newest')).toBeTruthy()
    expect(screen.getByText('older')).toBeTruthy()
  })

  it('shows the diff before offering a restore, and never restores on selection alone', async () => {
    const props = setup({ diff: vi.fn(async () => ({ ok: true as const, value: diff({ modified: ['src/a.ts'], addedSince: ['src/b.ts'], deletedSince: ['src/c.ts'] }) })) })
    fireEvent.click(await screen.findByRole('button', { name: /auto: before write/ }))
    await waitFor(() => { expect(screen.getByText('改 src/a.ts')).toBeTruthy() })
    expect(screen.getByText('增 src/b.ts')).toBeTruthy()
    expect(screen.getByText('删 src/c.ts')).toBeTruthy()
    // Selecting is a preview only: no destructive call may have happened yet.
    expect(props.restore).not.toHaveBeenCalled()
    expect(props.diff).toHaveBeenCalledWith('session-1', { id: 'cp_1' })
  })

  it('restores only after the user confirms the destructive step', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const props = setup()
    fireEvent.click(await screen.findByRole('button', { name: /auto: before write/ }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复到此检查点' }))
    await waitFor(() => { expect(props.restore).toHaveBeenCalledWith('session-1', { id: 'cp_1' }) })
    expect(confirm).toHaveBeenCalled()
    expect(await screen.findByText(/已恢复 3 个文件/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('does not restore when the user cancels the confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const props = setup()
    fireEvent.click(await screen.findByRole('button', { name: /auto: before write/ }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复到此检查点' }))
    await waitFor(() => { expect(props.diff).toHaveBeenCalled() })
    expect(props.restore).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('captures a labelled checkpoint and clears the label input', async () => {
    const props = setup()
    const input = await screen.findByLabelText('检查点名称')
    fireEvent.change(input, { target: { value: 'known good' } })
    fireEvent.click(screen.getByRole('button', { name: '创建检查点' }))
    await waitFor(() => { expect(props.capture).toHaveBeenCalledWith('session-1', { label: 'known good' }) })
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('falls back to a default label when the name is left blank', async () => {
    const props = setup()
    fireEvent.click(await screen.findByRole('button', { name: '创建检查点' }))
    await waitFor(() => { expect(props.capture).toHaveBeenCalledWith('session-1', { label: 'manual checkpoint' }) })
  })

  it('pins a checkpoint so retention cannot evict it', async () => {
    const props = setup()
    fireEvent.click(await screen.findByRole('button', { name: '置顶' }))
    await waitFor(() => { expect(props.setPinned).toHaveBeenCalledWith('session-1', { id: 'cp_1', pinned: true }) })
  })

  it('offers unpin for a checkpoint that is already pinned', async () => {
    const props = setup({ list: vi.fn(async () => ({ ok: true as const, value: [checkpoint('cp_1', 'pinned one', true)] })) })
    const button = await screen.findByRole('button', { name: '取消置顶' })
    fireEvent.click(button)
    await waitFor(() => { expect(props.setPinned).toHaveBeenCalledWith('session-1', { id: 'cp_1', pinned: false }) })
  })

  it('asks for a workspace conversation instead of listing when none is open', async () => {
    const props = setup({ currentSessionId: () => undefined })
    expect(await screen.findByText('打开工作区对话后查看检查点')).toBeTruthy()
    expect(props.list).not.toHaveBeenCalled()
  })

  it('explains that checkpoints are disabled rather than showing an empty list', async () => {
    const props = setup({ enabled: false })
    expect(await screen.findByText('工作区检查点未启用')).toBeTruthy()
    expect(props.list).not.toHaveBeenCalled()
  })

  it('surfaces a Host failure as an alert without losing the panel', async () => {
    // A real RemoteFailure, not a bare `{ message }`: the panel reads `message`,
    // but a fixture that is not the wire shape stops proving the panel handles it.
    setup({ list: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'checkpoint store is not open', {}) })) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/checkpoint store is not open/)).toBeTruthy()
  })

  it('says it is showing only the first 40 files instead of letting the cap read as the list', async () => {
    // The summary line counts every file, so a bare `slice(0, 40)` on the chips
    // made the two halves of the panel disagree: the user saw "60 modified" and
    // 40 rows with nothing to explain the difference.
    const modified = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`)
    setup({ diff: vi.fn(async () => ({ ok: true as const, value: diff({ modified }) })) })
    fireEvent.click(await screen.findByRole('button', { name: /auto: before write/ }))

    await waitFor(() => { expect(screen.getByText('改 src/f0.ts')).toBeTruthy() })
    expect(screen.getByText('改 src/f39.ts')).toBeTruthy()
    expect(screen.queryByText('改 src/f40.ts')).toBeNull()
    expect(screen.getByText('仅显示前 40 个，共 60 个（另有 20 个未列出）。')).toBeTruthy()
    // The full count is still what the summary claims.
    expect(screen.getByText(/修改：60 个/)).toBeTruthy()
  })

  it('does not print a truncation note when the list fits under the cap', async () => {
    setup({ diff: vi.fn(async () => ({ ok: true as const, value: diff({ modified: ['src/a.ts'] }) })) })
    fireEvent.click(await screen.findByRole('button', { name: /auto: before write/ }))

    await waitFor(() => { expect(screen.getByText('改 src/a.ts')).toBeTruthy() })
    expect(screen.queryByText(/仅显示前/)).toBeNull()
  })
})
