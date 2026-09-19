/**
 * The repository lint workflow this fork promises, as a tracked gate.
 *
 * Why this spec exists separately from `scripts/oxlint-contract.spec.ts`
 * ---------------------------------------------------------------------
 * That spec states upstream's contract, and one of its assertions pins the
 * exact text of `lint:fix:contracts-ready` — the two-command chain that ends in
 * a **type-aware** whole-tree `--fix`. This fork cannot honour that command: the
 * type-aware fixer removes `!` and `as` assertions this repository's own
 * `tsconfig.base.json` requires (`noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`), so running it took a clean `tsc -b` to
 * hundreds of errors — 401 files rewritten, then restored byte-identically.
 *
 * `package.json` is tracked in this fork; `scripts/oxlint-contract.spec.ts` is
 * ignored by the root `.gitignore` and exists only in a synced checkout. So the
 * disagreement cannot be settled by editing that spec: the divergence has to be
 * pinned where a clone can see it. That is this file.
 *
 * @module scripts/freecodego-lint-workflow
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..')

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>
}

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson
const scripts = packageJson.scripts ?? {}

/** Every `tsx scripts/run-oxlint.ts …` invocation inside one npm script body, in order. */
function oxlintInvocations(script: string | undefined): readonly string[] {
  if (script === undefined) return []
  return script.split('&&').map(part => part.trim()).filter(part => part.includes('scripts/run-oxlint.ts'))
}

describe('freecodego lint workflow', () => {
  it('runs the whole-tree fixer without the type-aware rules that delete required assertions', () => {
    const invocations = oxlintInvocations(scripts['lint:fix:contracts-ready'])
    // Both halves of the chain, not just the last one: the fixture half is where
    // an empty `--config` would go unnoticed.
    expect(invocations.length).toBe(2)
    for (const invocation of invocations) {
      expect(invocation).toContain('--config .oxlintrc.staged.json')
    }
  })

  it('keeps the type-aware fixer reachable only through its own explicit entry', () => {
    // The dangerous command must stay available — it is the right one on a tree
    // that actually conforms — but it must not be what `lint:fix` means.
    expect(scripts['lint:fix:typeaware']).toBe('npm run build:lib:host && tsx scripts/run-oxlint.ts . --fix')
    expect(scripts['lint:fix:contracts-ready']).not.toContain('tsx scripts/run-oxlint.ts . --fix')
  })

  it('leaves the read-only lint entry point type-aware', () => {
    // Reporting is not rewriting: `npm run lint` must still apply every rule.
    expect(scripts['lint:contracts-ready']).toBe('tsx scripts/run-oxlint.ts .')
  })
})
