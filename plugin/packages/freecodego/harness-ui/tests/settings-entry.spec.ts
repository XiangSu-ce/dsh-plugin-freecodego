/**
 * The settings panel must address the entry the profile declares.
 *
 * The panel read and wrote one hardcoded string through the Host's settings Remote, and
 * that string used to be a *namespace*: `freecodego-harness`. The service stopped
 * publishing namespaces — a plugin's `Config` is its settings document now, and the wire
 * API addresses the profile **entry id** — so the old spelling matched nothing. The
 * failure is the quiet kind this suite exists for: `describe()` answered every read with
 * the empty document, so the panel rendered defaults, and every write was refused by the
 * service rather than by the panel. `settings.update` throws for an unknown entry, but the
 * panel's read path swallows errors into fallbacks, so nothing surfaced.
 *
 * The two strings cannot be derived from each other — one is a TypeScript constant in the
 * client bundle, the other a YAML row of the bundle's own patch — so they are compared here
 * instead of being remembered in two places. Read as text on purpose: importing the client
 * entry would pull the whole browser bundle into a Node test for the sake of one string.
 *
 * The row that counts is the one in `bundle-latest/cordis.patch.yml`, because that is the
 * layer the deployment actually composes: the plugin used to be mounted with `ctx.plugin()`
 * from the bundle's `apply`, so it inherited the bundle's entry (`freecodego`, no schema) and
 * every write was refused while every read came back empty. `harness-plugin/cordis.patch.yml`
 * declared this same id and was read by nobody — which is why this test passed throughout.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The client module that addresses the settings service. */
const CLIENT_ENTRY = join(PACKAGE_ROOT, 'src/client/index.ts')
/** The patch declaring this plugin's entry, id and all. */
const BUNDLE_PATCH = join(PACKAGE_ROOT, '..', 'bundle-latest/cordis.patch.yml')

describe('the settings entry the panel addresses', () => {
  const client = readFileSync(CLIENT_ENTRY, 'utf8')
  const patch = readFileSync(BUNDLE_PATCH, 'utf8')

  it('is the id the bundle patch declares, not the old namespace', () => {
    const declared = /const SETTINGS_ENTRY = '([^']+)'/u.exec(client)?.[1]
    expect(declared).toBeDefined()
    // The row the Loader mounts this plugin as, which is also the row the
    // settings service appends its override to.
    const row = new RegExp(`- id: ${declared}\\b`, 'u')
    expect(row.test(patch)).toBe(true)
  })

  it('is a row that loads a module default-exporting the plugin, not the bundle', () => {
    // The row resolves through the bundle's `exports` map, and an entry plugin is the
    // module's default export. `freecodego` itself default-exports nothing: it exports
    // `apply`, which is why a row naming it would mount the bundle's composition instead
    // of a configurable plugin.
    const declared = /const SETTINGS_ENTRY = '([^']+)'/u.exec(client)?.[1] ?? ''
    const row = patch.slice(patch.indexOf(`- id: ${declared}`))
    expect(row.startsWith(`- id: ${declared}\n      name: 'freecodego/harness-plugin'`)).toBe(true)
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, '..', 'bundle-latest/package.json'), 'utf8')) as {
      readonly exports?: Readonly<Record<string, string>>
    }
    expect(manifest.exports?.['./harness-plugin']).toBe('./dist/harness-plugin.js')
  })

  it('is used by both the read and the write, so a rename cannot fix one side', () => {
    // A literal left behind in either call would address an entry nothing declares.
    expect(client).not.toContain("'freecodego-harness'")
    expect(client.match(/SETTINGS_ENTRY/gu)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
