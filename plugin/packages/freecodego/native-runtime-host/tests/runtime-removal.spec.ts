import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeRuntimeManager } from '../src/claude-runtime-manager.ts'
import { CodexRuntimeManager } from '../src/codex-runtime-manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('managed runtime removal', () => {
  it('removes every installed Codex runtime file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-codex-remove-'))
    roots.push(root)
    const runtimeDirectory = join(root, 'codex')
    mkdirSync(join(runtimeDirectory, 'artifacts', 'windows-x64'), { recursive: true })
    writeFileSync(join(runtimeDirectory, 'artifacts', 'windows-x64', 'residue.bin'), 'installed-codex')
    writeFileSync(join(runtimeDirectory, '.complete'), 'installed-codex')

    const manager = new CodexRuntimeManager({ rootDirectory: runtimeDirectory })
    await expect(manager.remove()).resolves.toMatchObject({ installed: false })
    expect(existsSync(runtimeDirectory)).toBe(false)
  })

  it('removes every installed Claude runtime file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-claude-remove-'))
    roots.push(root)
    const runtimeDirectory = join(root, 'claude')
    mkdirSync(join(runtimeDirectory, 'cli'), { recursive: true })
    writeFileSync(join(runtimeDirectory, 'cli', process.platform === 'win32' ? 'claude.exe' : 'claude'), 'installed-claude')
    writeFileSync(join(runtimeDirectory, 'claude-agent-sdk-runtime.json'), '{}')
    writeFileSync(join(runtimeDirectory, '.complete'), 'installed-claude')

    const manager = new ClaudeRuntimeManager({ rootDirectory: runtimeDirectory })
    await expect(manager.remove()).resolves.toMatchObject({ installed: false })
    expect(existsSync(runtimeDirectory)).toBe(false)
  })
})
