/**
 * The installer, and the four states it must never reach.
 *
 * A half-installed skill that looks whole. A failed upgrade that destroyed the
 * working version. A lockfile that names files that are not there. A skill
 * installed somewhere other than where it was asked for.
 *
 * Each of those has a test, and each test asserts the *state* afterwards rather
 * than the message, because the message is the part a future edit is free to
 * reword.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import {
  NODE_INSTALLER_FS,
  installSkill,
  removeSkill,
  validatePayloadFiles,
  validateSkillName,
  type InstallerFs,
  type SkillPayload,
} from '../src/skills/installer.ts'
import { parseLockfile } from '../src/skills/lockfile.ts'

const scratch = mkdtempSync(join(tmpdir(), 'skills-installer-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A fresh root per test, so one test's leftovers cannot pass another's assertions. */
function area(name: string): { root: string; state: string } {
  const base = join(scratch, name)
  mkdirSync(base, { recursive: true })
  return { root: join(base, 'skills'), state: join(base, 'state') }
}

function payload(name = 'example'): SkillPayload {
  return {
    name,
    files: [
      { path: 'SKILL.md', contents: `# ${name}\n\nUse the example tool.\n` },
      { path: 'scripts/run.sh', contents: 'echo hi\n' },
    ],
  }
}

const SOURCE = 'github:acme/skills/example@v1'
// Real commit ids, because the lockfile schema validates `resolvedCommit` as one:
// a value that could be a placeholder pins nothing, so the schema refuses it.
const OLD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const NEW = '9876543210fedcba9876543210fedcba98765432'

describe('screening', () => {
  test('a name that is not a single directory name is refused', () => {
    for (const name of ['..', '../evil', 'a/b', 'a\\b', '', '   ', '.']) {
      expect(validateSkillName(name).ok, `${JSON.stringify(name)} must be refused`).toBe(false)
    }
    expect(validateSkillName('code-reviewer').ok).toBe(true)
  })

  test('a file that would leave the skill root is refused, before anything is written', () => {
    expect(validatePayloadFiles([{ path: '../escape.md', contents: 'x' }]).ok).toBe(false)
    expect(validatePayloadFiles([{ path: '/etc/passwd', contents: 'x' }]).ok).toBe(false)
    expect(validatePayloadFiles([{ path: 'C:/windows/x', contents: 'x' }]).ok).toBe(false)
    expect(validatePayloadFiles([{ path: 'a//b.md', contents: 'x' }]).ok).toBe(false)
  })

  test('a backslash in a payload path is refused, not read as an ordinary character', async () => {
    // `split('/')` leaves `a\..\..\b` as one innocent-looking segment, and on
    // Windows `join` then resolves it out of the staging root. The refusal is what
    // makes the forward-slashed contract enforced rather than assumed.
    const escaped = validatePayloadFiles([{ path: 'a\\..\\..\\b.md', contents: 'x' }])
    expect(escaped.ok).toBe(false)
    expect(!escaped.ok && escaped.reason).toContain('backslash')
    expect(validatePayloadFiles([{ path: 'scripts\\run.sh', contents: 'x' }]).ok).toBe(false)
  })

  test('the same path twice is refused rather than silently keeping the last one', () => {
    const result = validatePayloadFiles([{ path: 'a.md', contents: '1' }, { path: 'a.md', contents: '2' }])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('twice')
  })

  test('a name the filesystem resolves to a device is refused', () => {
    // A write to `nul` succeeds and leaves nothing behind, so the digest recorded
    // for it describes a file the lockfile can never find again — a verification
    // failure no reinstall fixes.
    const device = validatePayloadFiles([{ path: 'nul', contents: 'x' }])
    expect(device.ok).toBe(false)
    expect(!device.ok && device.reason).toContain('device')
    // The extension does not save it: Windows resolves the name first.
    expect(validatePayloadFiles([{ path: 'docs/NUL.txt', contents: 'x' }]).ok).toBe(false)
    expect(validatePayloadFiles([{ path: 'assets/com1', contents: 'x' }]).ok).toBe(false)
    // A name that merely starts like one is an ordinary file.
    expect(validatePayloadFiles([{ path: 'null.md', contents: 'x' }]).ok).toBe(true)
    expect(validatePayloadFiles([{ path: 'console.md', contents: 'x' }]).ok).toBe(true)
  })

  test('an empty payload is refused: a skill with no files is a directory pretending', () => {
    expect(validatePayloadFiles([]).ok).toBe(false)
  })

  test('a source with no commit is pinned to a content id, not to a placeholder', async () => {
    // A local directory has no commit, and the lockfile demands one. Deriving it
    // from the content keeps the property the schema is protecting — the value
    // changes exactly when the content does.
    const { root, state } = area('content-id')
    const first = await installSkill({ payload: payload(), root, source: 'file:/tmp/example', stateDirectory: state })
    if ('refused' in first) throw new Error(first.refused)
    expect(first.skill.resolvedCommit).toMatch(/^[0-9a-f]{40}$/)
    const lock = parseLockfile(readFileSync(join(state, 'skill-lock.json'), 'utf8'))
    expect(lock.ok).toBe(true)

    const changed = await installSkill({
      payload: { name: 'example', files: [{ path: 'SKILL.md', contents: '# example, edited\n' }] },
      root,
      source: 'file:/tmp/example',
      stateDirectory: state,
    })
    if ('refused' in changed) throw new Error(changed.refused)
    expect(changed.skill.resolvedCommit).not.toBe(first.skill.resolvedCommit)
  })
})

describe('a successful install', () => {
  test('writes the files, records them, and leaves no staging directory behind', async () => {
    const { root, state } = area('ok')
    const outcome = await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'a1b2c3d', stateDirectory: state })
    expect('refused' in outcome).toBe(false)
    if ('refused' in outcome) return
    expect(outcome.locked).toBe(true)
    expect(readFileSync(join(root, 'example', 'SKILL.md'), 'utf8')).toContain('# example')
    expect(readFileSync(join(root, 'example', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    expect(readdirSync(root).filter(entry => entry.startsWith('.freecodego-'))).toEqual([])

    const lock = parseLockfile(readFileSync(join(state, 'skill-lock.json'), 'utf8'))
    expect(lock.ok).toBe(true)
    expect(lock.ok && lock.lockfile.skills.example?.resolvedCommit).toBe('a1b2c3d')
    // Digests cover every file, so verification can catch a hand-edit. Stored in
    // byte order (`SKILL.md` before `scripts/...`), not locale order, because the
    // payload digest is written in one process and compared in another.
    expect(lock.ok && lock.lockfile.skills.example?.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  })

  test('an upgrade replaces the files and reports the commit it replaced', async () => {
    const { root, state } = area('upgrade')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: OLD, stateDirectory: state })
    const second = await installSkill({
      payload: { name: 'example', files: [{ path: 'SKILL.md', contents: '# example v2\n' }] },
      root,
      source: SOURCE,
      resolvedCommit: NEW,
      stateDirectory: state,
    })
    if ('refused' in second) throw new Error(second.refused)
    expect(second.replacedCommit).toBe(OLD)
    expect(readFileSync(join(root, 'example', 'SKILL.md'), 'utf8')).toBe('# example v2\n')
    // The file the new version dropped is gone: an upgrade is not a merge.
    expect(existsSync(join(root, 'example', 'scripts', 'run.sh'))).toBe(false)
    expect(readdirSync(root).filter(entry => entry.startsWith('.freecodego-'))).toEqual([])
  })
})

describe('failures leave the previous state intact', () => {
  /** A filesystem that fails on the Nth rename, so the rollback path is reachable. */
  function failing(failOnRename: number): InstallerFs {
    let renames = 0
    return {
      ...NODE_INSTALLER_FS,
      rename: async (from, to) => {
        renames += 1
        if (renames === failOnRename) throw new Error('simulated rename failure')
        await NODE_INSTALLER_FS.rename(from, to)
      },
    }
  }

  test('a write failure installs nothing and leaves no staging tree', async () => {
    const { root, state } = area('write-failure')
    const failing: InstallerFs = {
      ...NODE_INSTALLER_FS,
      writeFile: async (path, contents) => {
        if (path.endsWith('run.sh')) throw new Error('disk full')
        await NODE_INSTALLER_FS.writeFile(path, contents)
      },
    }
    const outcome = await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'abcdef0', stateDirectory: state }, failing)
    expect('refused' in outcome).toBe(true)
    expect(existsSync(join(root, 'example'))).toBe(false)
    expect(existsSync(join(state, 'skill-lock.json'))).toBe(false)
    expect(readdirSync(root).filter(entry => entry.startsWith('.freecodego-'))).toEqual([])
  })

  test('a promotion failure restores the previous version rather than leaving a hole', async () => {
    const { root, state } = area('promote-failure')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: OLD, stateDirectory: state })
    // Rename 1 moves the old version aside; rename 2 is the promotion.
    const outcome = await installSkill(
      { payload: { name: 'example', files: [{ path: 'SKILL.md', contents: '# v2\n' }] }, root, source: SOURCE, resolvedCommit: NEW, stateDirectory: state },
      failing(2),
    )
    expect('refused' in outcome).toBe(true)
    if (!('refused' in outcome)) return
    expect(outcome.refused).toContain('previous version was restored')
    // The old skill is back, complete, and still recorded as its old self.
    expect(readFileSync(join(root, 'example', 'SKILL.md'), 'utf8')).toContain('# example')
    expect(readFileSync(join(root, 'example', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    const lock = parseLockfile(readFileSync(join(state, 'skill-lock.json'), 'utf8'))
    expect(lock.ok && lock.lockfile.skills.example?.resolvedCommit).toBe(OLD)
  })

  test('a lockfile that cannot be written is reported, because the files are already in place', async () => {
    // Not a refusal: the skill is installed. Saying only "installed" would make
    // the next verification report a skill nobody recorded.
    const { root, state } = area('lock-failure')
    // The document goes to a sibling temp file and is renamed into place, so the
    // failure is injected on the *destination* rather than by matching the final
    // name: matching the name is what a `writeFile`-in-place implementation looked
    // like, and a test written against that shape stops exercising anything once
    // the write becomes a rename.
    const failing: InstallerFs = {
      ...NODE_INSTALLER_FS,
      rename: async (from, to) => {
        if (to.endsWith('skill-lock.json')) throw new Error('read-only state directory')
        await NODE_INSTALLER_FS.rename(from, to)
      },
    }
    const outcome = await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'abcdef0', stateDirectory: state }, failing)
    if ('refused' in outcome) throw new Error(`expected an install, got: ${outcome.refused}`)
    expect(outcome.locked).toBe(false)
    expect(outcome.lockfileWarning).toContain('could not be recorded')
    expect(outcome.lockfileWarning).toContain(join(root, 'example'))
    expect(existsSync(join(root, 'example', 'SKILL.md'))).toBe(true)
  })

  test('the state document is never written in place, so a torn write cannot brick it', async () => {
    // The failure this pins: `readLockfile` *refuses* a malformed lockfile rather
    // than treating it as empty, so one truncated write would refuse every later
    // install and removal until a human deleted the file. The observable property
    // is that the final path is only ever reached by a rename, and that a failed
    // rename leaves the previous document byte-for-byte intact.
    const { root, state } = area('atomic-state')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: OLD, stateDirectory: state })
    const lockfilePath = join(state, 'skill-lock.json')
    const before = readFileSync(lockfilePath, 'utf8')

    const written: string[] = []
    const failing: InstallerFs = {
      ...NODE_INSTALLER_FS,
      writeFile: async (path, contents) => {
        written.push(path)
        await NODE_INSTALLER_FS.writeFile(path, contents)
      },
      rename: async (from, to) => {
        if (to.endsWith('skill-lock.json')) throw new Error('simulated crash before the rename')
        await NODE_INSTALLER_FS.rename(from, to)
      },
    }
    const outcome = await installSkill(
      { payload: { name: 'example', files: [{ path: 'SKILL.md', contents: '# v2\n' }] }, root, source: SOURCE, resolvedCommit: NEW, stateDirectory: state },
      failing,
    )
    if ('refused' in outcome) throw new Error(`expected an install, got: ${outcome.refused}`)
    expect(outcome.locked).toBe(false)
    // Never the destination itself — only a temp sibling.
    expect(written.filter(path => path === lockfilePath)).toEqual([])
    expect(written.some(path => path.startsWith(`${lockfilePath}.`) && path.endsWith('.tmp'))).toBe(true)
    // The document the next session reads is the one from before, not a mixture.
    expect(readFileSync(lockfilePath, 'utf8')).toBe(before)
    expect(parseLockfile(before).ok).toBe(true)
    // And the failed attempt does not leave its temp file behind.
    expect(readdirSync(state).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  test('a destination that cannot be moved aside is refused before the promotion', async () => {
    const { root, state } = area('busy-destination')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: OLD, stateDirectory: state })
    const failing: InstallerFs = {
      ...NODE_INSTALLER_FS,
      rename: async () => { throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' }) },
    }
    const outcome = await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: NEW, stateDirectory: state }, failing)
    expect('refused' in outcome).toBe(true)
    if (!('refused' in outcome)) return
    expect(outcome.refused).toContain('could not be moved aside')
    expect(readFileSync(join(root, 'example', 'SKILL.md'), 'utf8')).toContain('# example')
    expect(readdirSync(root).filter(entry => entry.startsWith('.freecodego-'))).toEqual([])
  })

  test('a lockfile from a newer schema is refused rather than overwritten', async () => {
    const { root, state } = area('future-lockfile')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'skill-lock.json'), JSON.stringify({ version: 99, skills: {} }))
    const before = readFileSync(join(state, 'skill-lock.json'), 'utf8')
    const outcome = await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'abcdef0', stateDirectory: state })
    expect('refused' in outcome).toBe(true)
    if (!('refused' in outcome)) return
    expect(outcome.refused).toContain('cannot be used')
    expect(readFileSync(join(state, 'skill-lock.json'), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'example'))).toBe(false)
  })
})

describe('removal', () => {
  test('removes the directory and its entry, in that order', async () => {
    const { root, state } = area('remove')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'abcdef0', stateDirectory: state })
    const outcome = await removeSkill({ name: 'example', root, stateDirectory: state })
    expect(outcome.removed).toBe(true)
    expect(existsSync(join(root, 'example'))).toBe(false)
    const lock = parseLockfile(readFileSync(join(state, 'skill-lock.json'), 'utf8'))
    expect(lock.ok && lock.lockfile.skills.example).toBeUndefined()
  })

  test('a skill on disk but not in the lockfile is still removed, and says so', async () => {
    const { root, state } = area('remove-unrecorded')
    mkdirSync(join(root, 'handmade'), { recursive: true })
    const outcome = await removeSkill({ name: 'handmade', root, stateDirectory: state })
    expect(outcome.removed).toBe(true)
    expect(outcome.detail).toContain('was not in the lockfile')
  })

  test('a lockfile that still names a removed skill is reported rather than hidden', async () => {
    const { root, state } = area('remove-lock-failure')
    await installSkill({ payload: payload(), root, source: SOURCE, resolvedCommit: 'abcdef0', stateDirectory: state })
    const failing: InstallerFs = {
      ...NODE_INSTALLER_FS,
      writeFile: async () => { throw new Error('state is read-only') },
    }
    const outcome = await removeSkill({ name: 'example', root, stateDirectory: state }, failing)
    expect(outcome.removed).toBe(true)
    expect(outcome.detail).toContain('still names it')
  })
})
