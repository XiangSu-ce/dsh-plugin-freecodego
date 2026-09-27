/**
 * Every packaging script in this package is a module, not a launcher.
 *
 * Why the shebang is gone
 * -----------------------
 * The Harness checkout reads every file under `packages/**` that starts with `#!`
 * as an application launcher, and accepts one only when it is named in
 * `EXECUTABLE_SOURCE_ALLOWLIST` inside `scripts/verify-application-entrypoints.ts`.
 * That file is restored from upstream — this repository does not track it — so a
 * path this package adds can never be classified there. The four vendoring passes
 * carried `#!/usr/bin/env node`, and the gate reported all four as "executable
 * source has no application/build/test classification".
 *
 * Dropping the line is the honest fix rather than a way around the rule. These
 * passes are not launchers: every caller runs them as `node scripts/<name>.mjs`
 * (their specs and the provenance notes name them by path), each one takes required
 * flags, and the package does not publish `scripts/` at all. Without the shebang
 * nothing claims they can be started on their own.
 *
 * This file is the pin. The shebang stays out, and the callers stay callers that
 * hand the path to `node`: a restored shebang is reported by the gate above, and a
 * caller that executed the file directly would break the moment it did.
 *
 * @module
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIRECTORY = join(PACKAGE_ROOT, 'scripts')
const TEST_DIRECTORY = join(PACKAGE_ROOT, 'tests')

/** The packaging scripts this pin covers, by file name. */
const SCRIPTS = readdirSync(SCRIPT_DIRECTORY).filter(name => name.endsWith('.mjs')).sort()

/** The specs that run a packaging script, by file name. */
const RUNNERS = readdirSync(TEST_DIRECTORY)
  .filter(name => name.startsWith('vendor-') && name.endsWith('.spec.ts'))
  .sort()

describe('packaging scripts are modules rather than launchers', () => {
  it('covers every script and every spec that runs one', () => {
    // Emptied globs are this file's only failure mode that looks like a pass:
    // without this, both assertions below would hold over nothing.
    expect(SCRIPTS).toEqual([
      'generate-typert.mjs',
      'vendor-craft.mjs',
      'vendor-design-skills.mjs',
      'vendor-impeccable.mjs',
      'vendor-taste-skills.mjs',
    ])
    expect(RUNNERS).toEqual([
      'vendor-craft.spec.ts',
      'vendor-design-skills.spec.ts',
      'vendor-impeccable.spec.ts',
      'vendor-taste-skills.spec.ts',
    ])
  })

  it('declares no shebang, so the launcher gate has nothing to classify', () => {
    for (const script of SCRIPTS) {
      const source = readFileSync(join(SCRIPT_DIRECTORY, script), 'utf8')
      expect(source.startsWith('#!'), script).toBe(false)
    }
  })

  it('is run by handing the path to node, which needs no shebang', () => {
    for (const spec of RUNNERS) {
      const source = readFileSync(join(TEST_DIRECTORY, spec), 'utf8')
      expect(source.includes('process.execPath'), spec).toBe(true)
    }
  })
})
