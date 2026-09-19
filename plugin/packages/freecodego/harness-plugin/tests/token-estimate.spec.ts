/**
 * A4 — one token-density truth source.
 *
 * The point of this file is not that `tokensFromChars` computes anything
 * interesting. It is that the plugin's number and the host's number are the
 * same number, and that they stay the same number after upstream changes it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { estimateContent, tokensFromChars } from '../src/token-estimate.ts'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Every `.ts` file under `src`, recursively. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

describe('tokensFromChars', () => {
  test('prices at four characters per token, rounding up', () => {
    expect(tokensFromChars(0)).toBe(0)
    expect(tokensFromChars(1)).toBe(1)
    expect(tokensFromChars(4)).toBe(1)
    expect(tokensFromChars(5)).toBe(2)
    expect(tokensFromChars(400)).toBe(100)
  })

  test('never reports a negative count', () => {
    expect(tokensFromChars(-100)).toBe(0)
  })

  test('treats a non-finite count as zero rather than NaN', () => {
    // A NaN would propagate into a report as `NaN` and render as text; zero is
    // wrong but visibly wrong.
    expect(tokensFromChars(Number.NaN)).toBe(0)
    expect(tokensFromChars(Number.POSITIVE_INFINITY)).toBe(0)
    expect(tokensFromChars(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('density agreement with the host heuristic', () => {
  // Deterministic pseudo-random text so a failure is reproducible, mixing
  // lengths across and inside the 4-character boundary.
  const samples = Array.from({ length: 64 }, (_unused, index) => {
    const length = (index * 37) % 211
    return 'x'.repeat(length)
  })

  test('matches estimateContent minus its per-block structural overhead', () => {
    // The one exact correspondence between the two surfaces: for a single text
    // block, the host price is ceil(len / charsPerToken) + overhead. Subtracting
    // the overhead the caller does not have leaves the plugin's figure. If the
    // host changes its density, this is the test that says so.
    const hostOverhead = estimateContent([{ type: 'text', text: '' }])
    for (const text of samples) {
      const host = estimateContent([{ type: 'text', text }])
      expect(tokensFromChars(text.length)).toBe(host - hostOverhead)
    }
  })

  test('agrees for a realistic multi-line document', () => {
    const document = Array.from({ length: 40 }, (_unused, index) => `line ${index}: ${'word '.repeat(index)}`).join('\n')
    const host = estimateContent([{ type: 'text', text: document }])
    const hostOverhead = estimateContent([{ type: 'text', text: '' }])
    expect(tokensFromChars(document.length)).toBe(host - hostOverhead)
  })
})

/**
 * Reduce a source file to its arithmetic.
 *
 * Comments and string literals are removed first, and that is the difference
 * between a gate worth having and one that fails on prose: this plugin says
 * "bytes / 4" in user-facing text on purpose, and a scan that counts those would
 * have to be silenced with exclusions until it stopped meaning anything.
 * @param source - raw file contents.
 * @returns the same source with comments and literals blanked out.
 */
function arithmeticOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/gm, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('the plugin has exactly one divisor', () => {
  test('no other source file divides a character count by four', () => {
    // The invariant is grep-provable, so it is proved by grep. A future caller
    // that needs tokens must import `tokensFromChars`; writing `/ 4` locally is
    // how the two densities diverge again.
    const offenders = sourceFiles(SRC)
      .filter(file => !file.endsWith('token-estimate.ts'))
      .filter(file => /[A-Za-z0-9_\])]\s*\/\s*4\b/.test(arithmeticOnly(readFileSync(file, 'utf8'))))
      .map(file => file.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })

  test('prompt-composition delegates instead of reimplementing', () => {
    const source = readFileSync(join(SRC, 'prompt-composition.ts'), 'utf8')
    expect(source).toContain("from './token-estimate.ts'")
    expect(source).not.toMatch(/Math\.round\(\s*chars\s*\/\s*4\s*\)/)
  })
})
