import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freeCodeGoDataHome, harnessHomeDirectory } from '../src/data-home.ts'
import { planModeRootDirectory } from '../src/plan-mode.ts'
import { teamRootDirectory } from '../src/team/state.ts'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const savedHome = process.env.DSH_HOME
const savedOverride = process.env.FREECODEGO_HOME

beforeEach(() => {
  delete process.env.DSH_HOME
  delete process.env.FREECODEGO_HOME
})

afterEach(() => {
  restore('DSH_HOME', savedHome)
  restore('FREECODEGO_HOME', savedOverride)
})

function restore(name: string, value: string | undefined): void {
  if (value !== undefined) { process.env[name] = value; return }
  // Unsetting an environment variable is `delete` or nothing: assigning
  // `undefined` would store the string "undefined" instead.
  // oxlint-disable-next-line no-dynamic-delete
  delete process.env[name]
}

describe('freeCodeGoDataHome', () => {
  it('falls back to ~/.dsh when the Host sets no home', () => {
    expect(harnessHomeDirectory()).toBe(join(homedir(), '.dsh'))
    expect(freeCodeGoDataHome()).toBe(join(homedir(), '.dsh'))
  })

  it('follows DSH_HOME, which is the Host-owned home', () => {
    process.env.DSH_HOME = join('C:', 'harness-home')
    expect(freeCodeGoDataHome()).toBe(join('C:', 'harness-home'))
  })

  it('lets FREECODEGO_HOME win over DSH_HOME', () => {
    process.env.DSH_HOME = join('C:', 'harness-home')
    process.env.FREECODEGO_HOME = join('C:', 'freecodego-data')
    expect(freeCodeGoDataHome()).toBe(join('C:', 'freecodego-data'))
  })

  it('expands a tilde override the way the harness expands its own home', () => {
    process.env.DSH_HOME = join('C:', 'harness-home')
    // Without the expansion the plugin writes its memory, checkpoints and teams
    // into a literal `~` directory under the process cwd, so the same machine
    // finds different data depending on where the harness was launched.
    process.env.FREECODEGO_HOME = '~/freecodego-data'
    expect(freeCodeGoDataHome()).toBe(join(homedir(), 'freecodego-data'))
  })

  it('ignores a blank or whitespace-only override instead of resolving to the cwd', () => {
    process.env.DSH_HOME = join('C:', 'harness-home')
    for (const blank of ['', '   ', '\t']) {
      process.env.FREECODEGO_HOME = blank
      expect(freeCodeGoDataHome()).toBe(join('C:', 'harness-home'))
    }
  })

  it('redirects plugin-private directories, and only those', () => {
    process.env.DSH_HOME = join('C:', 'harness-home')
    const override = join('C:', 'freecodego-data')
    process.env.FREECODEGO_HOME = override

    expect(planModeRootDirectory()).toBe(join(override, 'freecodego', 'engineering', 'plan-mode'))
    expect(teamRootDirectory()).toBe(join(override, 'freecodego', 'engineering', 'teams'))
  })
})

/**
 * Drift guard: a module that re-derives the home by hand would silently ignore
 * FREECODEGO_HOME (plugin-private state landing in two places), and a module
 * that builds its own `~/.dsh` fallback would disagree with the harness about
 * where a configured home points. Reading the sources is the only way to see
 * either.
 *
 * The allowlist is deliberately three files:
 * - `data-home.ts` owns the one resolution (and delegates it to the harness).
 * - `runtime-assets.ts` reads the raw variable to decide whether to mirror a
 *   shim into the *running* Desktop's home; an unset home means there is
 *   nothing to mirror, so a fallback here would be wrong, not just duplicated.
 * - `engineering-eval.ts` sets the variable from a fixture to prove a redirect
 *   reaches the preset directory.
 */
const HOST_OWNED_READERS = new Set([
  'data-home.ts',
  'engineering-eval.ts',
  'runtime-assets.ts',
])

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { found.push(...await sourceFiles(path)); continue }
    if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

describe('home resolution has one owner', () => {
  it('keeps DSH_HOME reads inside the host-owned allowlist', async () => {
    const offenders: string[] = []
    for (const path of await sourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, path).replaceAll('\\', '/')
      if (!(await readFile(path, 'utf8')).includes('process.env.DSH_HOME')) continue
      if (!HOST_OWNED_READERS.has(name)) offenders.push(name)
    }
    expect(offenders).toStrictEqual([])
  })

  it('lets no module build its own ~/.dsh fallback', async () => {
    // The fallback is the harness's to own: `dsh-home-paths` knows the directory
    // name and the tilde rules, and a hand-rolled copy disagreed with it in two
    // ways before this guard existed (no `~` expansion, no normalization).
    const offenders: string[] = []
    for (const path of await sourceFiles(sourceRoot)) {
      const source = await readFile(path, 'utf8')
      // Any construction of the home directory name, not just the exact literal
      // the old copies used — a renamed constant would be the same defect.
      if (!/['"]\.dsh['"]/u.test(source)) continue
      const name = relative(sourceRoot, path).replaceAll('\\', '/')
      if (name === 'data-home.ts') continue
      offenders.push(name)
    }
    expect(offenders).toStrictEqual([])
  })

  it('resolves a configured home the way the harness does', () => {
    // The delegation is the point of this module: a `~` prefix must expand and
    // the result must be absolute, which the hand-rolled copies did neither of.
    process.env.DSH_HOME = '~/harness-home'
    expect(harnessHomeDirectory()).toBe(join(homedir(), 'harness-home'))
    process.env.DSH_HOME = 'relative-home'
    expect(harnessHomeDirectory()).toBe(resolve('relative-home'))
  })
})
