/**
 * The asset families this package reads have to be the families it publishes.
 *
 * `files` in `package.json` is the whole of what an npm install receives, and it
 * is read by nothing at runtime — which is how a package whose *code* works
 * perfectly can install without the data the code reads. That is not a
 * hypothetical here: `assets/design/**` was added to the tree across four
 * features (the HyperFrames pack, the Taste pack, the craft rulebooks, the React
 * Bits Skill) while `files` went on naming `engineering`, `uiux` and `presets`
 * only. Every one of those features would have installed with its Skills absent
 * and its rows reporting "内置 Skill 资源在此构建中缺失" — on a machine where the
 * desktop bundle, which copies assets itself, looked perfect.
 *
 * So the rule is stated where it can be checked: **a family on disk must be a
 * family in `files`**, and the reverse, because a glob for a directory that no
 * longer exists ships nothing and says nothing. Both directions are cheap, and
 * neither can be satisfied by editing the check.
 *
 * @module
 */

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)

/** One entry of the manifest's `files` list. */
function fileEntries(manifest: unknown): readonly string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const files = (manifest as { files?: unknown }).files
  return Array.isArray(files) ? files.filter((entry): entry is string => typeof entry === 'string') : []
}

/** The asset families on disk: `assets/<name>/`, in directory order. */
function assetFamilies(): readonly string[] {
  return readdirSync(new URL('assets/', packageRoot), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

describe('the published package carries the assets it reads', () => {
  it('names every asset family on disk', async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'))
    const entries = fileEntries(manifest)
    const published = entries
      .map(entry => /^assets\/([^/]+)\//u.exec(entry)?.[1])
      .filter((family): family is string => family !== undefined)
    const unpublished = assetFamilies().filter(family => !published.includes(family))
    expect(unpublished, `\nasset families an install would not receive: ${unpublished.join(', ')}\n`).toEqual([])
  })

  it('names no asset family that is not there', async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'))
    const present = assetFamilies()
    const phantom = fileEntries(manifest)
      .map(entry => /^assets\/([^/]+)(?:\/|$)/u.exec(entry)?.[1])
      .filter((family): family is string => family !== undefined && !present.includes(family))
    expect(phantom, `\nfile globs for assets that do not exist: ${phantom.join(', ')}\n`).toEqual([])
  })

  it('reads a package that actually has asset families, so the two cases are not vacuous', async () => {
    const families = assetFamilies()
    expect(families.length).toBeGreaterThanOrEqual(3)
    // The one the audit found missing, named so that removing it fails here
    // rather than in a user's install.
    expect(families).toContain('design')
  })
})
