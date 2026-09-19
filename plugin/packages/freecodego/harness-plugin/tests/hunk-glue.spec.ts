/**
 * What the hunk recording pass decides, and what it refuses — including on disk.
 *
 * `hunkPrepare` returns the count of files whose pre-image it captured, and that
 * count is what the first suite asserts. The first version of this spec asserted
 * "no hunks were recorded" instead, which every one of these refusals also
 * answers — a test that passes for the wrong reason. The counts make each guard
 * distinguishable, and they cover one branch that could not be reached any other
 * way: a file that does not exist yet is captured as *empty*, which is what makes a
 * creation revertible to "it was not there" instead of being skipped.
 *
 * The second suite covers the half this file used to leave out: the glue against
 * real files. That omission came with a rationale that was wrong — it claimed a
 * spec importing `node:fs` trips `no-unsafe-*` on every call because
 * `tsconfig.host.json` excludes `packages/freecodego/**​/tests/**`. The exclusion is
 * real and deliberate (a third check unit, `tsconfig.freecodego-contracts.json` +
 * `build:freecodego`, typechecks those tests), but the lint consequence was
 * measured with `lib/` unbuilt, and the budget's own notes say counts move with the
 * build output. Measured with it: `team-worktree.spec.ts` imports five node
 * builtins and carries **zero** lint-budget entries. So the reason to test here was
 * never a trade; it was an untested path, which is now tested.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'

/** A registry whose host answers only the tool service. */
function registry(): FreeCodeGoEngineeringRegistry {
  const ctx = {
    on: vi.fn(),
    effect: vi.fn(),
    get: (name: string) => (name === 'tools' ? { register: () => ({ dispose: () => undefined }) } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Context
  return new FreeCodeGoEngineeringRegistry(ctx, undefined)
}

/** The tool name the seam matches, and a file this package certainly ships. */
const WRITE_TOOL = 'write_file'
const EXISTING_FILE = { path: 'package.json' }
/** A name no checkout has, so the read is a real `ENOENT` rather than a mock. */
const ABSENT_FILE = { path: 'freecodego-hunk-probe-does-not-exist.ts' }

describe('the hunk recording pass', () => {
  it('captures the pre-image of the file a write tool names', async () => {
    expect(await registry().hunkPrepare('call-1', WRITE_TOOL, EXISTING_FILE, '.')).toBe(1)
  })

  it('captures a file that does not exist yet, as empty', async () => {
    // This is the creation case: without it, the call that brought the file into
    // being is the one call with no journal entry.
    expect(await registry().hunkPrepare('call-2', WRITE_TOOL, ABSENT_FILE, '.')).toBe(1)
  })

  it('prepares nothing for a tool that cannot write', async () => {
    expect(await registry().hunkPrepare('call-3', 'read_file', EXISTING_FILE, '.')).toBe(0)
    expect(await registry().hunkPrepare('call-4', 'grep', { path: 'package.json' }, '.')).toBe(0)
  })

  it('prepares nothing for arguments that name no file at all', async () => {
    expect(await registry().hunkPrepare('call-5', WRITE_TOOL, { command: 'rm -rf /' }, '.')).toBe(0)
  })

  it('prepares nothing for a path outside the workspace', async () => {
    // The pre-image read is the leak this prevents: a journal the model can query
    // must not hold the contents of a file outside the workspace.
    expect(await registry().hunkPrepare('call-6', WRITE_TOOL, { path: '../../id_rsa' }, '.')).toBe(0)
    expect(await registry().hunkPrepare('call-7', WRITE_TOOL, { path: '/etc/shadow' }, '.')).toBe(0)
  })

  it('prepares nothing without a call id or a workspace to anchor it to', async () => {
    const engineering = registry()
    expect(await engineering.hunkPrepare('', WRITE_TOOL, EXISTING_FILE, '.')).toBe(0)
    expect(await engineering.hunkPrepare('call-8', WRITE_TOOL, EXISTING_FILE, undefined)).toBe(0)
    expect(await engineering.hunkPrepare('call-9', WRITE_TOOL, EXISTING_FILE, '  ')).toBe(0)
  })

  it('records nothing when the call did not in fact change the file', async () => {
    // The false-positive guard: a write that wrote the same bytes is not a hunk, and
    // a journal that claimed one would offer a revert that does nothing.
    const engineering = registry()
    await engineering.hunkPrepare('call-10', WRITE_TOOL, EXISTING_FILE, '.')
    expect(await engineering.hunkRecord('call-10', '.')).toEqual([])
    expect(engineering.hunkJournal('.')).toEqual([])
  })

  it('consumes the pre-image, so one call is recorded once', async () => {
    // Recording twice would double every offset this call owns and let one revert
    // undo the same edit twice.
    const engineering = registry()
    await engineering.hunkPrepare('call-11', WRITE_TOOL, EXISTING_FILE, '.')
    await engineering.hunkRecord('call-11', '.')
    // The claim is that the second record has nothing left to diff; the observable
    // is that preparing again is required for it to have anything at all.
    expect(await engineering.hunkPrepare('call-11', WRITE_TOOL, EXISTING_FILE, '.')).toBe(1)
    expect(await engineering.hunkRecord('call-11', '.')).toEqual([])
  })

  it('answers nothing for a call that was never prepared', async () => {
    expect(await registry().hunkRecord('call-12', '.')).toEqual([])
  })

  it('records nothing when a call is reported into a workspace it was not prepared in', async () => {
    // Stated for what it is: this pins that a mismatched report is empty and quiet.
    // The guard's actual consequence — no cross-workspace attribution — is invisible
    // here, because an unchanged file answers `[]` either way; it would take a file
    // that changed, which the suite below can now supply. What it does pin is that no
    // fault escapes: the seam swallows one, so a throw would be silent lost
    // attribution rather than a visible error.
    const engineering = registry()
    await engineering.hunkPrepare('call-13', WRITE_TOOL, EXISTING_FILE, '.')
    expect(await engineering.hunkRecord('call-13', './packages')).toEqual([])
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** A real workspace, so the reads and writes under test are real too. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-hunk-glue-'))
  directories.push(root)
  return root
}

describe('the recording and revert pass against real files', () => {
  it('records the region a write changed and puts the file back on disk', async () => {
    const cwd = await workspace()
    const file = join(cwd, 'a.ts')
    await writeFile(file, 'a\nb\nc\n', 'utf8')
    const engineering = registry()
    expect(await engineering.hunkPrepare('call-1', WRITE_TOOL, { path: 'a.ts' }, cwd)).toBe(1)
    await writeFile(file, 'a\nB\nc\n', 'utf8')

    const recorded = await engineering.hunkRecord('call-1', cwd)
    expect(recorded.map(hunk => [hunk.file, hunk.offset, hunk.removed, hunk.added])).toEqual([
      ['a.ts', 1, ['b'], ['B']],
    ])
    const reverted = await engineering.hunkRevert(cwd, recorded[0]?.id ?? '')
    expect(reverted).toMatchObject({ ok: true, relocated: false })
    // The point of the whole module: the bytes on disk are the pre-image again, and
    // the attribution that produced them came from the file's real contents.
    expect(await readFile(file, 'utf8')).toBe('a\nb\nc\n')
  })

  it('reverts one file of a two-file call through the glue, leaving the other file alone', async () => {
    const cwd = await workspace()
    const one = join(cwd, 'a.ts')
    const two = join(cwd, 'b.ts')
    await writeFile(one, 'x\n', 'utf8')
    await writeFile(two, 'x\n', 'utf8')
    const engineering = registry()
    expect(await engineering.hunkPrepare('call-2', 'multiedit', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }, cwd)).toBe(2)
    await writeFile(one, 'X\n', 'utf8')
    await writeFile(two, 'X\n', 'utf8')
    expect(await engineering.hunkRecord('call-2', cwd)).toHaveLength(2)

    // Identical contents in both files is the worst case for a revert that is scoped
    // to the call instead of to the file: the other file's pre-image is a valid
    // splice here, so a wrong scope cannot be caught by a mismatch.
    const outcome = await engineering.hunkRevertCall(cwd, 'call-2', 'a.ts')
    expect(outcome).toMatchObject({ ok: true, hunks: 1 })
    expect(await readFile(one, 'utf8')).toBe('x\n')
    expect(await readFile(two, 'utf8')).toBe('X\n')
    expect(engineering.hunkJournal(cwd).filter(hunk => hunk.file === 'b.ts')).toHaveLength(1)
  })

  it('reverts the file the name resolves to, not a file that merely looks like it', async () => {
    // The listing filters by the journal's spelling of a name, because a listing that
    // reports nothing for a file the revert then edits is the one answer that makes
    // the pair unusable. The revert has to resolve that same spelling: the tracker
    // looks the hunk up under `a.ts` whatever name it is handed, so a path built from
    // ` a.ts` reads a different file and splices `a.ts`'s pre-image into it — the
    // right bytes in the wrong file, with the file the call actually touched left
    // holding the edit. Found at its recorded offset or relocated by content, the
    // splice succeeds either way, which is why nothing downstream refuses it.
    const cwd = await workspace()
    const real = join(cwd, 'a.ts')
    const lookAlike = join(cwd, ' a.ts')
    await writeFile(real, 'a\nb\nc\n', 'utf8')
    // Deliberately holds the post-image, so a revert that lands here has somewhere
    // to land and cannot be caught by a mismatch.
    await writeFile(lookAlike, 'x\na\nB\nc\n', 'utf8')
    const engineering = registry()
    await engineering.hunkPrepare('call-1', WRITE_TOOL, { path: 'a.ts' }, cwd)
    await writeFile(real, 'a\nB\nc\n', 'utf8')
    const [hunk] = await engineering.hunkRecord('call-1', cwd)
    expect(hunk?.file).toBe('a.ts')

    const outcome = await engineering.hunkRevertCall(cwd, 'call-1', ' a.ts')
    expect(outcome).toMatchObject({ ok: true })
    expect(await readFile(real, 'utf8')).toBe('a\nb\nc\n')
    expect(await readFile(lookAlike, 'utf8')).toBe('x\na\nB\nc\n')
  })

  it('refuses a revert for a file that is gone rather than throwing', async () => {
    const cwd = await workspace()
    const file = join(cwd, 'a.ts')
    await writeFile(file, 'a\nb\n', 'utf8')
    const engineering = registry()
    await engineering.hunkPrepare('call-3', WRITE_TOOL, { path: 'a.ts' }, cwd)
    await writeFile(file, 'a\nB\n', 'utf8')
    const [hunk] = await engineering.hunkRecord('call-3', cwd)
    await rm(file)

    const reverted = await engineering.hunkRevert(cwd, hunk?.id ?? '')
    expect(reverted).toMatchObject({ ok: false, reason: 'drifted' })
    // Narrowed to the variant that carries a detail: the refusal union's other
    // members say why in their own fields, and reading `detail` off the union is
    // the mistake this expression exists to avoid making.
    expect(!reverted.ok && reverted.reason === 'drifted' ? reverted.detail : '').toContain('gone')
  })

  it('forgets the hunks of a call that deleted its file', async () => {
    // A revert into a file that is not there is not a revert, so the journal must not
    // keep offering one.
    const cwd = await workspace()
    const file = join(cwd, 'a.ts')
    await writeFile(file, 'a\nb\n', 'utf8')
    const engineering = registry()
    await engineering.hunkPrepare('call-4', WRITE_TOOL, { path: 'a.ts' }, cwd)
    await writeFile(file, 'a\nB\n', 'utf8')
    expect(await engineering.hunkRecord('call-4', cwd)).toHaveLength(1)

    await engineering.hunkPrepare('call-5', WRITE_TOOL, { path: 'a.ts' }, cwd)
    await rm(file)
    expect(await engineering.hunkRecord('call-5', cwd)).toEqual([])
    expect(engineering.hunkJournal(cwd)).toEqual([])
  })

  it('gives a file over the size cap no hunk, because reading it is the expensive part', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')
    expect(await registry().hunkPrepare('call-6', WRITE_TOOL, { path: 'big.txt' }, cwd)).toBe(0)
  })

  it('gives a file holding a NUL byte no hunk, because a diff of it is noise', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'binary.bin'), 'a\u0000b', 'utf8')
    expect(await registry().hunkPrepare('call-7', WRITE_TOOL, { path: 'binary.bin' }, cwd)).toBe(0)
  })

  it('captures nothing for a path that exists but is not a file', async () => {
    // What this pins is the `isFile()` arm of the read helper: a directory named like
    // the target is skipped, so no pre-image is taken and no creation is recorded.
    // The *other* arm — a read that fails for a reason other than `ENOENT`, which
    // must also skip rather than be mistaken for a creation — is deliberately not
    // claimed here: producing it portably needs a permission denial, and a suite that
    // runs as root does not have one. Naming the uncovered arm is the point.
    const cwd = await workspace()
    await mkdir(join(cwd, 'looks-like-a-file.ts'), { recursive: true })
    expect(await registry().hunkPrepare('call-8', WRITE_TOOL, { path: 'looks-like-a-file.ts' }, cwd)).toBe(0)
  })
})
