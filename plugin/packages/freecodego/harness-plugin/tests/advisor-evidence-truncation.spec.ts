/**
 * The review tools have to say when their answer is partial.
 *
 * The Advisor hands a reviewer model three read-only tools and tells it, in the
 * system prompt, "Do not claim facts without evidence" (`advisor.ts`, the review
 * loop's `system` string). Every one of those tools is bounded — a read stops at
 * 8000 characters, a glob at 160 files, a grep at 60 matches, and the workspace
 * walk itself at 640 files or seven directory levels — and until this suite
 * existed not one of those bounds appeared in the text the reviewer received.
 *
 * The consequence is not a slow tool, it is a wrong verdict: `grep` over a
 * workspace whose match lives one directory too deep answers "(no matches)", the
 * reviewer reads that as a fact it was given, and reports the absence as a
 * finding. "Nothing calls this" and "I did not look there" have to be different
 * sentences, because only one of them is evidence.
 *
 * Each test below drives the real `AdvisorEvidenceCache`, so what is asserted is
 * the text a reviewer would actually be handed.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdvisorEvidenceCache } from '../src/advisor.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-advisor-evidence-'))
  directories.push(directory)
  return directory
}

const call = (name: string, args: Record<string, unknown>): never =>
  ({ type: 'tool-call', id: `c-${name}-${JSON.stringify(args)}`, name, arguments: JSON.stringify(args) }) as never

const run = (cache: AdvisorEvidenceCache, cwd: string, name: string, args: Record<string, unknown>) =>
  cache.execute(cwd, call(name, args), new AbortController().signal)

describe('advisor evidence completeness', () => {
  it('names the characters a truncated read left out', async () => {
    const directory = await workspace()
    // Comfortably past the 8000-character read bound, in plain prose so nothing
    // the credential screens do can change the length. The sentinel is on the last
    // line and appears nowhere else: a repeating marker would sit inside the first
    // 8000 characters too and prove nothing about where the cut fell.
    const filler = 'The retry policy is described in this sentence and nowhere else.\n'.repeat(400)
    await writeFile(join(directory, 'notes.md'), `${filler}SENTINEL PAST THE READ CUT\n`, 'utf8')
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_read', { path: 'notes.md' })

    expect(result.ok).toBe(true)
    // Without this clause the reviewer holds 8000 of ~22000 characters and has no
    // way to know the file continues — which is exactly the state in which it
    // would answer "the policy is described nowhere else" as a fact.
    expect(result.text).toContain('truncated: showing the first 8000 of')
    expect(result.text).not.toContain('SENTINEL PAST THE READ CUT')
    // The three tools have to name the same file the same way, or the reviewer
    // cannot carry a path from `glob` into `read`. Asserted against the other
    // tool's label rather than a literal, so it holds wherever the workspace sits.
    const globbed = await run(cache, directory, 'freecodego_advisor_glob', { pattern: 'notes.md' })
    expect(result.text.split('\n')[0]).toBe(globbed.text.split('\n')[0])
  })

  it('says nothing about truncation when the read fitted', async () => {
    const directory = await workspace()
    await writeFile(join(directory, 'small.md'), 'A short note.\n', 'utf8')
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_read', { path: 'small.md' })

    // The other half of the contract: a complete answer must not carry a warning,
    // or the reviewer learns to ignore the warning.
    expect(result.text).toContain('A short note.')
    expect(result.text).not.toContain('truncated')
  })

  it('names the matching files a glob left out', async () => {
    const directory = await workspace()
    // One past the 160-file bound, all matching, and well under the walk's own
    // 640-file ceiling so this test is about the glob bound alone.
    await Promise.all(Array.from({ length: 165 }, (_, index) =>
      writeFile(join(directory, `mod-${String(index).padStart(3, '0')}.ts`), 'export {}\n', 'utf8')))
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_glob', { pattern: '*.ts' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('5 more matching files not shown')
  })

  it('names the match limit a grep stopped at', async () => {
    const directory = await workspace()
    // 80 matching lines in one file: past the 60-match bound, so the tool stops
    // mid-file and would otherwise look like it had found everything there was.
    await writeFile(join(directory, 'big.ts'), `${Array.from({ length: 80 }, () => 'const needle = 1').join('\n')}\n`, 'utf8')
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_grep', { query: 'needle' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('stopped at the 60-match limit')
  })

  it('does not answer "no matches" from a walk that never reached the file', async () => {
    const directory = await workspace()
    // Eight levels down: the walk descends into depth 7 and no further, so this
    // file is invisible to every review tool. That is a deliberate bound — what
    // this test pins is that the bound is *reported*, not that it is lifted.
    const deep = join(directory, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'hidden.ts'), 'const unreachableToken = 1\n', 'utf8')
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_grep', { query: 'unreachableToken' })

    expect(result.ok).toBe(true)
    // The finding really is absent from the walk...
    expect(result.text).toContain('(no matches)')
    // ...and the reviewer is told the workspace was only partly looked at, so the
    // absence is a limit of the tool rather than a fact about the code.
    expect(result.text).toContain('did not descend past 7 directory levels')
    expect(result.text).toContain('more may exist')
  })

  it('reports the walk ceiling as well as the match ceiling when both apply', async () => {
    const directory = await workspace()
    // Past the walk's 640-file ceiling *and* past the 60-match ceiling, so both
    // clauses have to appear: they are different facts about the same answer.
    await Promise.all(Array.from({ length: 700 }, (_, index) =>
      writeFile(join(directory, `f-${String(index).padStart(4, '0')}.ts`), 'const shared = 1\n', 'utf8')))
    const cache = new AdvisorEvidenceCache()

    const result = await run(cache, directory, 'freecodego_advisor_grep', { query: 'shared' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('stopped at the 60-match limit')
    expect(result.text).toContain('640-file ceiling')
  })
})
