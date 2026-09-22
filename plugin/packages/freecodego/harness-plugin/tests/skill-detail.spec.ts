import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSkillCompanionFiles, readSkillCompanionFile, skillCompanionDirectory, skillForwardTargets, skillResourceLocation } from '../src/skill-detail.ts'

describe('Skill alias forwards', () => {
  it('reads the names a one-line alias body forwards to', () => {
    expect(skillForwardTargets('Call the Skill tool with "grilling".')).toEqual(['grilling'])
    expect(skillForwardTargets('Call the Skill tool twice, for "grilling" and "domain-modeling".')).toEqual(['grilling', 'domain-modeling'])
    // Front matter is stripped by the provider, but a blank line is not.
    expect(skillForwardTargets('\nCall the Skill tool with "grilling".\n')).toEqual(['grilling'])
    expect(skillForwardTargets('Call the Skill tool with "grilling" and "grilling".')).toEqual(['grilling'])
  })

  it('leaves a body that does any work of its own alone', () => {
    // Every one of these is a Skill with its own prompt. Printing another
    // Skill's body under one of them would misdescribe what runs.
    expect(skillForwardTargets('Review the diff on both axes.')).toEqual([])
    expect(skillForwardTargets('Call the Skill tool to load a plan first.\n\nThen scan the codebase.')).toEqual([])
    expect(skillForwardTargets('First read the docs.\nCall the Skill tool with "grilling".')).toEqual([])
    expect(skillForwardTargets('')).toEqual([])
    // A shingle-quoted or unquoted name is not the grammar the aliases use.
    expect(skillForwardTargets("Call the Skill tool with 'grilling'.")).toEqual([])
    expect(skillForwardTargets('Call the Skill tool with grilling.')).toEqual([])
  })
})

describe('Skill companion files', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'freecodego-skill-detail-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('lists the files beside SKILL.md without repeating the body the Skill service already sends', async () => {
    await writeFile(join(directory, 'SKILL.md'), '# body')
    await writeFile(join(directory, 'DESIGN-IT-TWICE.md'), 'twice')
    await mkdir(join(directory, 'agents'))
    await writeFile(join(directory, 'agents', 'brief.md'), 'brief')

    const files = await listSkillCompanionFiles(directory)

    // Sorted locale-aware, the way the dialog reads them aloud: nested paths
    // sort among their siblings rather than all landing after the root files.
    expect(files.map(file => file.path)).toEqual(['agents/brief.md', 'DESIGN-IT-TWICE.md'])
    expect(files.find(file => file.path === 'agents/brief.md')?.bytes).toBe(5)
  })

  it('reads one listed file and refuses a path the listing did not carry', async () => {
    await writeFile(join(directory, 'LOGIC.md'), 'the real payload')
    const files = await listSkillCompanionFiles(directory)

    await expect(readSkillCompanionFile({ directory, files, path: 'LOGIC.md' })).resolves.toEqual({
      path: 'LOGIC.md',
      bytes: 16,
      content: 'the real payload',
    })
    await expect(readSkillCompanionFile({ directory, files, path: 'SKILL.md' })).rejects.toThrow(/not a file in this Skill directory/)
    await expect(readSkillCompanionFile({ directory, files, path: 'nowhere.txt' })).rejects.toThrow(/not a file in this Skill directory/)
  })

  it('refuses a listing entry that resolves outside the Skill directory', async () => {
    const escaped = resolve(directory, '..', 'outside.txt')
    await writeFile(escaped, 'secret')
    try {
      // A listing that claims `..` cannot come from readdir, so this stands in
      // for a compromised or hand-built listing: the containment check has to
      // reject it on its own rather than trusting the entry.
      await expect(readSkillCompanionFile({
        directory,
        files: [{ path: '../outside.txt', bytes: 6 }],
        path: '../outside.txt',
      })).rejects.toThrow(/outside this Skill directory/)
    } finally {
      await rm(escaped, { force: true })
    }
  })

  it('refuses a listed symlink whose target leaves the Skill directory', async (context) => {
    // The walk does not follow links (`readdir` reports a link as a link, not a
    // file), so a listing this module built never carries one. This stands in
    // for the hand-built listing the containment check exists to re-prove on its
    // own — and `resolve()` is lexical, so it agreed the path was inside while
    // the link pointed at a key outside.
    const outside = await mkdtemp(join(tmpdir(), 'freecodego-skill-outside-'))
    try {
      await writeFile(join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL')
      try {
        await symlink(join(outside, 'id_rsa'), join(directory, 'notes.md'))
      } catch {
        // Creating a symlink needs a privilege Windows does not grant by default.
        context.skip()
        return
      }
      const files = await listSkillCompanionFiles(directory)
      // The genuine listing proves the point: the link is not a companion file.
      expect(files.map(file => file.path)).toEqual([])
      await expect(readSkillCompanionFile({ directory, files: [{ path: 'notes.md', bytes: 20 }], path: 'notes.md' }))
        .rejects.toThrow(/outside this Skill directory/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to inline a binary sibling instead of decoding it as mojibake', async () => {
    await writeFile(join(directory, 'template.sh'), 'echo ok')
    await writeFile(join(directory, 'shot.png'), Buffer.from([0x89, 0x50, 0x00, 0x4e]))
    const files = await listSkillCompanionFiles(directory)

    await expect(readSkillCompanionFile({ directory, files, path: 'shot.png' })).rejects.toThrow(/not a text file/)
  })

  it('reports no directory when the provider never gave the Skill a path', async () => {
    expect(skillCompanionDirectory(undefined)).toBeUndefined()
    expect(skillCompanionDirectory('   ')).toBeUndefined()
    expect(skillCompanionDirectory(join(directory, 'SKILL.md'))).toBe(resolve(directory))
    await expect(listSkillCompanionFiles(undefined)).resolves.toEqual([])
  })
})

describe('where a Skill says its resources are', () => {
  const assets = join(tmpdir(), 'freecodego-skill-assets')

  it('prefers the base the provider declared over the path it did not give', () => {
    // The bundled `dsh-badge` skill is exactly this: an asset directory declared
    // as its resource base, and no `SKILL.md` path at all. Inferring the
    // directory from the absent path reported a Skill that has files as empty.
    expect(skillResourceLocation({ resourceBase: { kind: 'directory', path: assets } })).toEqual({
      kind: 'directory',
      directory: resolve(assets),
      provenance: "the resource base this Skill's provider declared",
    })
  })

  it('falls back to the reported SKILL.md path only when no base was declared', () => {
    expect(skillResourceLocation({ path: join(assets, 'SKILL.md') })).toEqual({
      kind: 'directory',
      directory: resolve(assets),
      provenance: "the SKILL.md path this Skill's provider reported",
    })
    expect(skillResourceLocation({})).toEqual({ kind: 'unavailable', reason: expect.stringContaining('reports no directory') })
  })

  it('reports a base this build cannot read instead of reading the local disk', () => {
    // "These resources are served from a URL" and "these resources are in this
    // directory" are different facts; answering the second while doing the first
    // is how a dialog shows a file that is not the one the model was told about.
    expect(skillResourceLocation({ path: join(assets, 'SKILL.md'), resourceBase: { kind: 'url', url: 'https://skills.example.test/badge/' } }))
      .toEqual({ kind: 'unavailable', reason: 'this Skill\'s resources are served from https://skills.example.test/badge/, not from a local directory' })
    expect(skillResourceLocation({ path: join(assets, 'SKILL.md'), resourceBase: { kind: 'opaque', description: 'the provider resolves these itself' } }))
      .toEqual({ kind: 'unavailable', reason: 'the provider resolves these itself' })
    // A `kind` from a newer Harness is refused, never downgraded to a local read.
    expect(skillResourceLocation({ path: join(assets, 'SKILL.md'), resourceBase: { kind: 'git-tree', ref: 'HEAD' } }))
      .toEqual({ kind: 'unavailable', reason: expect.stringContaining('"git-tree" resource base') })
    // A declared base that is empty is not a base either.
    expect(skillResourceLocation({ resourceBase: { kind: 'directory', path: '  ' } })).toEqual({ kind: 'unavailable', reason: expect.stringContaining('"directory" resource base') })
  })
})
