/**
 * The audit exists to catch one specific failure — a summary that reproduces
 * text the archive never contained — so the tests are pairs: the same summary
 * with a faithful quotation and with an invented one, differing only in whether
 * the quoted text is in the archive.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_SECTIONS, archiveTextFrom, auditCompactionFidelity, summarySkeleton } from '../src/compaction-fidelity.ts'

const ARCHIVE = [
  'I ran the build and it failed.',
  'npm ERR! code EBADENGINE\nnpm ERR! engine Unsupported engine\nnpm ERR! required: {"node":">=22"}',
  'The failure is in src/client/token-usage-dashboard.tsx, around line 333.',
]

const audit = (summary: string, archive: readonly string[] = ARCHIVE, options?: Parameters<typeof auditCompactionFidelity>[1]) =>
  auditCompactionFidelity({ summary, archive }, options)

describe('compaction fidelity', () => {
  it('accepts a summary whose quoted block is in the replaced history', () => {
    const summary = 'The build failed with:\n\n```\nnpm ERR! code EBADENGINE\nnpm ERR! engine Unsupported engine\n```\n'
    const verdict = audit(summary)
    expect(verdict.quotesChecked).toBe(1)
    expect(verdict.quotesVerified).toBe(1)
    expect(verdict.misses).toEqual([])
    expect(verdict.accepted).toBe(true)
  })

  it('rejects a summary whose quoted block was never in the history', () => {
    // The one case this module exists for: the block looks exactly like the
    // others and no downstream reader can ever tell it was invented.
    const summary = 'The build failed with:\n\n```\nnpm ERR! code ENOTFOUND\nnpm ERR! registry unreachable\n```\n'
    const verdict = audit(summary)
    expect(verdict.accepted).toBe(false)
    expect(verdict.misses.map(miss => miss.kind)).toEqual(['quote-not-in-archive'])
    expect(verdict.misses[0]?.text).toContain('ENOTFOUND')
  })

  it('ignores spacing inside a quotation, which a summariser reflows', () => {
    // The archive wrote `{"node":">=22"}`; a faithful summary adds a space
    // after the colon. Rejecting that would reject correct summaries.
    const verdict = audit('The log said "The failure  is in src/client/token-usage-dashboard.tsx" and stopped.')
    expect(verdict.quotesChecked).toBe(1)
    expect(verdict.quotesVerified).toBe(1)
    expect(verdict.accepted).toBe(true)
  })

  it('does not treat a short quotation as a claim of verbatim reproduction', () => {
    // `it said "no"` is emphasis; the archive is not a transcript of every word.
    const verdict = audit('The tool said "no" and stopped.')
    expect(verdict.quotesChecked).toBe(0)
    expect(verdict.accepted).toBe(true)
  })

  it('counts a long quotation as a claim', () => {
    const verdict = audit('The tool said "this is a long sentence the archive never contained at all" and stopped.')
    expect(verdict.quotesChecked).toBe(1)
    expect(verdict.accepted).toBe(false)
  })

  it('accepts a path the history mentions, including a file:line reference', () => {
    const verdict = audit('The bug is in `src/client/token-usage-dashboard.tsx:333`.')
    expect(verdict.referencesChecked).toBe(2)
    expect(verdict.referencesVerified).toBe(2)
    expect(verdict.accepted).toBe(true)
  })

  it('scores a fabricated path instead of condemning a summary for one', () => {
    // Four real citations and one invented one is a summary worth keeping and
    // worth flagging; one bad reference alone is below the default threshold.
    const summary = 'Touched src/client/token-usage-dashboard.tsx, src/client/a.ts, src/client/b.ts, src/client/c.ts and src/client/never-existed.ts.'
    const archive = [...ARCHIVE, 'src/client/a.ts', 'src/client/b.ts', 'src/client/c.ts']
    const verdict = audit(summary, archive)
    expect(verdict.referencesChecked).toBe(5)
    expect(verdict.referencesVerified).toBe(4)
    expect(verdict.accepted).toBe(true)
    expect(verdict.misses.map(miss => miss.kind)).toEqual(['reference-not-in-archive'])
  })

  it('rejects a summary whose references are mostly unaccounted for', () => {
    const summary = 'Touched src/a.ts, src/b.ts, src/c.ts, src/d.ts and src/e.ts.'
    const verdict = audit(summary, ['nothing relevant here'])
    expect(verdict.referencesVerified).toBe(0)
    expect(verdict.accepted).toBe(false)
    expect(verdict.note).toContain('0 of 5')
  })

  it('rejects a quotation it cannot check rather than assuming it is faithful', () => {
    const summary = 'The build failed with:\n\n```\nnpm ERR! code EBADENGINE\n```\n'
    const verdict = audit(summary, [])
    expect(verdict.accepted).toBe(false)
    expect(verdict.misses.map(miss => miss.kind)).toEqual(['empty-archive'])
    expect(verdict.note).toContain('could not be found')
  })

  it('accepts a summary that makes no verbatim claim, and says so', () => {
    // Faithfulness is not the question for prose; accuracy is, and this module
    // does not pretend to answer it.
    const verdict = audit('Reworked the dashboard time axis and fixed the daily buckets.')
    expect(verdict.accepted).toBe(true)
    expect(verdict.quotesChecked).toBe(0)
    expect(verdict.referencesChecked).toBe(0)
    expect(verdict.note).toContain('No verbatim claim')
  })

  it('reads a quotation out of a fence once, not once per quoting mark', () => {
    // The fence body contains pairs of quotes; counting them again would double
    // the claims and make a single fabricated block look like two.
    const verdict = audit('Output:\n\n```\nassert "a long enough quoted sentence here" failed\n```\n')
    expect(verdict.quotesChecked).toBe(1)
    // Counted once: the miss names the whole block, not the quotes inside it.
    expect(verdict.misses).toHaveLength(1)
    expect(verdict.misses[0]?.text).toContain('assert "a long enough')
  })

  it('bounds the text it reports, so one huge block cannot flood a log', () => {
    const verdict = audit(`\`\`\`\n${'x'.repeat(5_000)}\n\`\`\``)
    expect(verdict.misses[0]?.text.length).toBe(200)
  })

  it('still rejects a quotation the archive does not contain, spacing aside', () => {
    // The tolerance is whitespace only: a different word stays a different word.
    const verdict = audit('```\nrequired: {"node": ">=24"}\n```\n')
    expect(verdict.accepted).toBe(false)
    expect(verdict.misses[0]?.kind).toBe('quote-not-in-archive')
  })

  it('reads the archive as text, so a multi-line quotation can match', () => {
    // `JSON.stringify` would hand the audit an escaped `\n`, and the summary's
    // real newline would look like an invention.
    const event = { content: [{ type: 'text', text: 'line one\nline two' }] }
    const archive = archiveTextFrom(event)
    expect(archive).toContain('line one\nline two')
    const summary = 'Output:\n\n```\nline one\nline two\n```\n'
    const verdict = auditCompactionFidelity({ summary, archive })
    expect(verdict.accepted).toBe(true)
  })

  it('walks a nested event graph but stops at a bounded depth', () => {
    let deep: unknown = 'bottom'
    for (let index = 0; index < 20; index += 1) deep = { next: deep }
    expect(archiveTextFrom(deep)).toEqual([])
    expect(archiveTextFrom({ a: { b: { c: 'shallow' } } })).toEqual(['shallow'])
  })

  it('honours a raised quote threshold for a caller that wants fewer claims', () => {
    // A 26-character quotation is a claim by default and not one at 80.
    const summary = 'The log said "this quotation is twenty-six long" somewhere.'
    expect(audit(summary).quotesChecked).toBe(1)
    expect(audit(summary, ARCHIVE, { minQuoteChars: 80 }).quotesChecked).toBe(0)
  })

  it('honours a lowered quote threshold too, not only a raised one', () => {
    // The option moves the bound in both directions. A pattern with the default
    // baked into it would ignore this call and report the count it would have
    // reported anyway, which is the one failure an option cannot be tested for
    // from the outside.
    const summary = 'The log said "twelve chars" and stopped.'
    expect(audit(summary).quotesChecked).toBe(0)
    const lowered = audit(summary, ARCHIVE, { minQuoteChars: 5 })
    expect(lowered.quotesChecked).toBe(1)
    expect(lowered.accepted).toBe(false)
  })

  it('survives a quote threshold that is not a whole number', () => {
    // The bound is pasted into a repetition count, and `{30.5,}` is not a repetition:
    // `new RegExp` refuses it in unicode mode, so a fractional bound used to throw out
    // of the audit — during the compaction it was supposed to audit. Rounded *up*:
    // this module's stated asymmetry is that a false reject costs a real compaction,
    // so a caller's bound is never quietly lowered to catch more claims than it asked
    // for. Ignored when it is not a number at all, for the same reason.
    const summary = 'The log said "this quotation is thirty chars" and stopped.'
    const quotation = 'this quotation is thirty chars'
    expect(quotation.length).toBe(30)
    expect(audit(summary, ARCHIVE, { minQuoteChars: 29.5 }).quotesChecked).toBe(1)
    expect(audit(summary, ARCHIVE, { minQuoteChars: 30.5 }).quotesChecked).toBe(0)
    expect(() => audit(summary, ARCHIVE, { minQuoteChars: Number.NaN })).not.toThrow()
    expect(audit(summary, ARCHIVE, { minQuoteChars: Number.NaN }).quotesChecked).toBe(1)
    expect(() => audit(summary, ARCHIVE, { minQuoteChars: Number.POSITIVE_INFINITY })).not.toThrow()
  })

  it('names the dropped fields beside the faithfulness sentence', () => {
    // A faithful, incomplete summary: the quotation is in the archive and the
    // field that said what work was left is gone. One word for both findings would
    // name neither, and the reader who hears only "faithful" reads the omission as
    // the `(none)` the summariser was told to write.
    const summary = [
      '## Primary Request and Intent',
      '- fix the build failure in src/client/token-usage-dashboard.tsx',
      '',
      '## Next Step',
      '- re-run the build',
    ].join('\n')
    const verdict = audit(summary)
    expect(verdict.accepted).toBe(true)
    expect(verdict.sectionsPresent).toEqual(['Primary Request and Intent', 'Next Step'])
    expect(verdict.sectionsMissing).toContain('Pending Jobs')
    expect(verdict.note).toContain('Every quoted span')
    expect(verdict.note).toContain('dropped 6 of the checkpoint')
    expect(verdict.note).toContain('Pending Jobs')
  })

  it('ignores a non-finite reference rate rather than rejecting everything', () => {
    // `>=` against NaN is false for every input, the empty comparison included, so a
    // NaN rate rejected a summary that cites nothing — the one case the note calls out
    // as having nothing to check. A verdict and its own sentence must not disagree.
    const quiet = 'The build failed early, before any of that.'
    const verdict = audit(quiet, ARCHIVE, { minReferenceHitRate: Number.NaN })
    expect(verdict.referencesChecked).toBe(0)
    expect(verdict.accepted).toBe(true)
    expect(verdict.note).toContain('No verbatim claim to check')
  })
})

describe('the checkpoint skeleton', () => {
  const STRUCTURED = [
    '## Primary Request and Intent',
    '- ship the fix',
    '## Key Technical Concepts',
    '- (none)',
    '## Files and Code',
    '- src/a.ts',
    '## Errors and Fixes',
    '- (none)',
    '## Pending Jobs',
    '- (none)',
    '## Current Work',
    '- the audit',
    '## Next Step',
    '- run the suite',
    '## Critical Context',
    '- (none)',
  ].join('\n')

  it('reports every field of the contract as present in a structured summary', () => {
    const skeleton = summarySkeleton(STRUCTURED)
    expect(skeleton.missing).toEqual([])
    expect(skeleton.present).toEqual(COMPACTION_SUMMARY_SECTIONS)
  })

  it('reads an empty field as declared, because (none) is how the contract writes one', () => {
    // The distinction the whole check rests on: `(none)` is a claim about the
    // session, an absent heading is a claim about the summariser.
    expect(summarySkeleton('## Pending Jobs\n- (none)').present).toContain('Pending Jobs')
    expect(summarySkeleton('## Pending Jobs').present).toContain('Pending Jobs')
    expect(summarySkeleton('## Files\n- src/a.ts').missing).toContain('Pending Jobs')
  })

  it('matches the contract on names rather than on presentation', () => {
    // A summariser that writes the field at another depth, in another case, or with
    // the trailing colon prose convention adds has not dropped it.
    expect(summarySkeleton('### next step:\n- run it').present).toContain('Next Step')
    expect(summarySkeleton('##   Current   Work  ##\n- the audit').present).toContain('Current Work')
    // A field named inside a sentence is not a heading, so it does not count.
    expect(summarySkeleton('The Next Step section was omitted.').present).toEqual([])
    // An extra heading is the model adding a field, not losing one.
    expect(summarySkeleton(`${STRUCTURED}\n## Extra\n- more`).missing).toEqual([])
  })

  it('quotes a structure the pinned Harness actually asks for', () => {
    // The mirror, asserted rather than trusted: this module checks summaries against
    // a contract the Harness owns, so a Harness line that changes the structure has to
    // fail a probe here instead of leaving the audit checking a shape nothing emits.
    // Read as source text because the instruction is a module-private constant of a
    // package this one does not depend on at runtime.
    const source = readFileSync(fileURLToPath(new URL('../../../compaction/compaction-basic/src/summarizer.ts', import.meta.url)), 'utf8')
    const listed = [...source.matchAll(/^\s*'## (.+)',$/gmu)].map(match => match[1])
    expect(listed).toEqual([...COMPACTION_SUMMARY_SECTIONS])
    // And the rule that gives the skeleton its meaning: an empty section is written
    // out, never dropped. Without it a missing heading would be no finding at all.
    expect(source).toContain('never drop a section')
    expect(source).toContain('Write "(none)" for an empty section')
  })
})
