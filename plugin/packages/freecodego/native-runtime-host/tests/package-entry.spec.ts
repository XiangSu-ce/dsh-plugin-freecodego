import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

describe('native runtime host package entry', () => {
  it('publishes the ESM file emitted by its tsdown configuration', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly main: string
      readonly exports: { readonly '.': { readonly default: string } }
      readonly files: readonly string[]
    }

    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.exports['.'].default).toBe('./lib/index.js')
    expect(manifest.files).toContain('lib/index.js')
  })
})
