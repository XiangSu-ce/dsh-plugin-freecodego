import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureFreeCodeGoAgentPreset, freeCodeGoAgentPresetDirectory } from '../src/agent-preset-install.ts'

const directories: string[] = []
const previousHome = process.env.DSH_HOME

beforeEach(() => {
  // `delete`, not `= undefined`: assigning `undefined` to an environment
  // variable stores the literal string "undefined", so the harness resolved its
  // home to `<cwd>/undefined` and every run left that directory behind in the
  // repository. Same pattern as `agent-preset-drain.spec.ts`.
  delete process.env.DSH_HOME
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'freecodego-preset-home-'))
  directories.push(home)
  process.env.DSH_HOME = home
  return home
}

describe('FreeCodeGo agent preset install', () => {
  it('writes the bundled preset into the user roster', async () => {
    const home = await freshHome()
    expect(await ensureFreeCodeGoAgentPreset()).toBe(true)
    const composition = await readFile(join(home, '.agent-presets', 'freecodego', 'agent.cordis.yml'), 'utf8')
    const metadata = await readFile(join(home, '.agent-presets', 'freecodego', 'preset.yml'), 'utf8')
    expect(composition).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(metadata).toContain('name: Claude 模式')
    // Second run is a stable no-op.
    expect(await ensureFreeCodeGoAgentPreset()).toBe(true)
  })

  it('never overwrites a hand-edited local preset', async () => {
    await freshHome()
    await ensureFreeCodeGoAgentPreset()
    const target = join(freeCodeGoAgentPresetDirectory(), 'agent.cordis.yml')
    await writeFile(target, '# my personal customization\n- id: mine\n  name: example\n', 'utf8')
    await ensureFreeCodeGoAgentPreset()
    expect(await readFile(target, 'utf8')).toContain('my personal customization')
  })

  it('refreshes its own outdated copy on a plugin update', async () => {
    await freshHome()
    await ensureFreeCodeGoAgentPreset()
    const target = join(freeCodeGoAgentPresetDirectory(), 'agent.cordis.yml')
    // Simulate an older plugin version's file: still marker-owned, different content.
    await writeFile(target, '# freecodego-agent-preset-v0\n- id: old\n  name: example\n', 'utf8')
    await ensureFreeCodeGoAgentPreset()
    expect(await readFile(target, 'utf8')).toContain("name: '@deepseek-ai/dsh-persona'")
  })

  it('installs the bundled Augment Code preset alongside the Claude-style one', async () => {
    const home = await freshHome()
    expect(await ensureFreeCodeGoAgentPreset()).toBe(true)
    const composition = await readFile(join(home, '.agent-presets', 'augmentcode', 'agent.cordis.yml'), 'utf8')
    const metadata = await readFile(join(home, '.agent-presets', 'augmentcode', 'preset.yml'), 'utf8')
    expect(composition).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(metadata).toContain('name: Augment Code 模式')
    // The Augment persona carries the distilled behavior, not the Claude one.
    expect(composition).toContain('# Investigate before you plan')
    // Second run is a stable no-op.
    expect(await ensureFreeCodeGoAgentPreset()).toBe(true)
  })
})
