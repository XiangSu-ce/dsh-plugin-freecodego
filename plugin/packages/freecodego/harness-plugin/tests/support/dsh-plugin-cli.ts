/**
 * A minimal model of the `dsh plugin` CLI's profile package operations.
 *
 * The community marketplace no longer edits a profile manifest itself: `add`,
 * `remove`, the dependency entry, and the `dsh.profile.bundles` line that
 * activates a bundle are one operation owned by the CLI. A spec that wants to
 * assert what an install or an uninstall leaves behind therefore has to model
 * that operation — otherwise it either spawns the real `dsh` (which no test
 * should) or asserts against a manifest nothing ever edits.
 *
 * The model mirrors the CLI's `reconcile` in `packages/boot/plugin-manager`:
 * `add` records the dependency and mounts the package as a profile layer only
 * when the *installed* package declares `dsh.bundle`; `remove` drops the
 * dependency and the bundle line. It also asserts the profile the CLI is named
 * is the profile the spec inspects, because a mismatch means the CLI just
 * reconciled a manifest nobody screened.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { vi } from 'vitest'

export interface ProfileManifestJson {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export type DshPluginRunner = (profile: string, args: readonly string[]) => Promise<{ readonly code: number; readonly detail: string }>

export interface DshPluginCliModel {
  /** Every `add`/`remove` the plugin issued, as `<verb> <argument>`, in order. */
  readonly verbs: () => readonly string[]
  /** Every argv the plugin handed the CLI, in order. */
  readonly calls: () => readonly (readonly string[])[]
}

export async function readProfileManifest(directory: string): Promise<ProfileManifestJson> {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as ProfileManifestJson
}

export async function writeProfileManifest(directory: string, manifest: ProfileManifestJson): Promise<void> {
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
}

const bundlesOf = (manifest: ProfileManifestJson): readonly string[] => manifest.dsh?.profile?.bundles ?? []

/**
 * Install the model on a mocked runner.
 * @param runDsh - the mocked `runDsh` the plugin under test reaches.
 * @param directory - the profile directory the spec currently inspects.
 * @returns the recorded verbs and calls.
 */
export function modelDshPluginCli(runDsh: DshPluginRunner, directory: () => string): DshPluginCliModel {
  const calls: string[][] = []
  vi.mocked(runDsh).mockImplementation(async (profile: string, args: readonly string[]) => {
    calls.push([...args])
    const target = directory()
    if (basename(target) !== profile) throw new Error(`dsh plugin was named profile "${profile}" while the plugin inspected "${target}"`)
    const manifest = await readProfileManifest(target)
    manifest.dependencies = manifest.dependencies ?? {}
    if (args[0] === 'add') {
      const name = args[1]!
      manifest.dependencies[name] = '1.0.0'
      const installed = JSON.parse(await readFile(join(target, 'node_modules', name, 'package.json'), 'utf8')) as { dsh?: { bundle?: unknown } }
      if (installed.dsh?.bundle !== undefined && !bundlesOf(manifest).includes(name)) {
        manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundlesOf(manifest), name] } }
      }
    } else if (args[0] === 'remove') {
      for (const name of args.slice(1)) {
        delete manifest.dependencies[name]
        manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundlesOf(manifest).filter(bundle => bundle !== name) } }
      }
    } else {
      throw new Error(`the modelled dsh plugin does not implement "${String(args[0])}"`)
    }
    await writeProfileManifest(target, manifest)
    return { code: 0, detail: '' }
  })
  return {
    verbs: () => calls.map(argv => `${argv[0] ?? ''} ${argv[1] ?? ''}`.trim()),
    calls: () => calls,
  }
}
