/**
 * The rule every lossy strategy owes the model: **adoptable ⇒ retrievable**.
 *
 * `runtime.ts` states the contract in its module header — "Every accepted lossy
 * compression stashes the original in the CCR store so the model can retrieve
 * full text via `headroom_retrieve`" — and it is the only thing that makes
 * dropping content safe. It has now been broken twice, in two different
 * strategies, by two different mistakes:
 *
 * 1. `log` gated the *stash* on one ratio and the *adoption* on another, so a
 *    rendering in the band between them shipped carrying `[N lines omitted]`
 *    with no `hash=` and nothing in the store (see `headroom-log-routing.spec.ts`).
 * 2. `html` stashed the original and marked the result on its JSON and tabular
 *    siblings but not on its own branch, so the delivered text named no hash
 *    while the store held an orphan entry.
 *
 * Both were single-branch fixes. This file is the cross-strategy guard that was
 * missing: it drives the real runtime through the real `tools/post-execute`
 * seam, captures the real `headroom_retrieve` tool, and for every fixture asks
 * the one question that catches both shapes — *if a lossy strategy took credit
 * for this result, does the text the model received name a hash that returns
 * the original, byte for byte?*
 *
 * Two deliberate non-assertions, so this file does not become wrong later:
 *
 * - **Lossless folds and cross-turn dedup are exempt.** They do not drop
 *   content: a fold is exactly invertible, and a dedup pointer names a block
 *   still present in the conversation. Demanding a hash of them would assert
 *   the opposite of the design, so they are not in {@link LOSSY_KINDS}.
 * - **A strategy that declines is not a failure.** Every fixture may be refused
 *   by the detector, the size gate or the compressor's own `applied` signal;
 *   the guard is about what happens *when* one engages. The non-vacuity check
 *   at the end is what keeps that exemption from swallowing the whole file.
 */

import { describe, expect, it } from 'vitest'
import { HEADROOM_SEAM_SETTINGS, headroomSeam, referencesIn } from './support/headroom-seam.ts'

/**
 * The counters that only move when a strategy really dropped content.
 *
 * Read off `status()`, which is also what the UI panel reads — so a counter
 * named here is one the user is told about.
 */
const LOSSY_KINDS = [
  'jsonCompressions',
  'diffCompressions',
  'searchCompressions',
  'logCompressions',
  'htmlCompressions',
  'tabularCompressions',
  'configCompressions',
  'proseCompressions',
] as const

/** The credential-free hash marker the runtime appends to a compressed result. */
const HASH_IN_TEXT = /hash=([a-f0-9]{24})/u


const lines = (count: number, make: (index: number) => string): string =>
  Array.from({ length: count }, (_value, index) => make(index)).join('\n')

/** One fixture per lossy strategy, each past the 1 200-character size gate. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ['json', JSON.stringify(Array.from({ length: 220 }, (_value, index) => ({
    id: index,
    status: index % 9 === 0 ? 'degraded' : 'ok',
    region: 'us-east-1',
    owner: `team_${index % 4}`,
    note: `record number ${index}`,
  })), null, 1)],
  ['diff', ['alpha.ts', 'beta.ts', 'gamma.ts'].map(name => [
    `--- a/${name}\t2026-01-01 00:00:00.000000000 +0000`,
    `+++ b/${name}\t2026-01-02 00:00:00.000000000 +0000`,
    '@@ -1,18 +1,18 @@',
    ...Array.from({ length: 8 }, (_value, index) => ` context line ${index} of ${name}`),
    `-old value in ${name}`,
    `+new value in ${name}`,
    ...Array.from({ length: 8 }, (_value, index) => ` trailing context ${index} of ${name}`),
  ].join('\n')).join('\n')],
  ['search', lines(120, index => `src/headroom/runtime.ts:${100 + index}:const value${index} = compute(${index}) // keep`)],
  ['log', lines(140, index => `2026-09-19T09:${String(index % 60).padStart(2, '0')}:01.000Z ${index % 11 === 0 ? 'ERROR' : 'INFO'} worker[${index}] task ${'x'.repeat(50)} id=${index}`)],
  ['html', '<!DOCTYPE html><html><head><title>Report</title><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="a.css"><link rel="icon" href="f.ico"><style>body{color:red}</style></head><body><div class="nav"><ul><li>Home</li><li>About</li><li>Contact</li><li>Blog</li><li>Careers</li><li>Docs</li></ul></div><footer><small>copyright notice</small></footer><aside><div>sidebar widget content</div></aside><div class="breadcrumbs"><a href="/">root</a><a href="/docs">docs</a><a href="/docs/guide">guide</a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=4">4</a><a href="?page=5">5</a></div><script>var x=1;function y(){return 2}</script><style>.a{color:red}.b{margin:0}</style><main>' + '<h2>Section</h2><p>Substantive paragraph with the actual content the reader needs.</p>'.repeat(10) + '</main></body></html>'],
  ['tabular', ['| identifier_string | current_status_value | assigned_owner_name |', '|---|---|---|', ...Array.from({ length: 60 }, (_value, index) => `| user_${index} | ${index % 7 === 0 ? 'degraded' : 'active'} | owner_${index % 5} |`)].join('\n')],
  ['config', ['# generated by the toolchain, do not edit', ...Array.from({ length: 70 }, (_value, index) => `# annotation ${index} for reviewers of this configuration stanza`), 'title = "demo"', '[server]', 'port = 8080', 'host = "localhost"'].join('\n')],
  ['prose', lines(40, index => `Paragraph ${index} explains in detail how the deployment pipeline reassembles the artifacts after the cache miss, and then records what the operator should check before the next release window closes.`)],
  // Opaque cells: rows whose payload is far past `opaqueMinBytes`, so the tabular
  // compaction replaces each one with a `<<ccr:HASH,KIND,SIZE>>` marker. This is
  // the fixture that makes the inline spelling appear in a delivered result.
  ['json-opaque', JSON.stringify(Array.from({ length: 200 }, (_value, index) => ({
    id: index,
    level: index % 11 === 0 ? 'ERROR' : 'INFO',
    owner: `team_${index % 4}`,
    payload: Buffer.from(`chunk-${index}-`.repeat(20)).toString('base64'),
  })), null, 1)],
]

describe('headroom retrievability: adoptable implies retrievable', () => {
  it('names a hash that returns the original whenever a lossy strategy took credit', async () => {
    const failures: string[] = []
    const engaged: string[] = []

    for (const [label, text] of FIXTURES) {
      const runtime = headroomSeam()
      const before = runtime.status()
      const delivered = await runtime.run(text)
      const after = runtime.status()
      const credited = LOSSY_KINDS.filter(kind => (after[kind] as number) > (before[kind] as number))

      if (credited.length === 0) continue
      engaged.push(`${label}[${credited.map(kind => kind.replace('Compressions', '')).join(',')}]`)

      // A counter that moved while the model received the input unchanged is a
      // panel reporting a saving nobody got; it is the same class of lie as a
      // hash that does not resolve, so it is checked here rather than trusted.
      if (delivered === text) {
        failures.push(`${label}: credited ${credited.join(',')} but the delivered text is byte-identical to the input`)
        continue
      }

      const hash = HASH_IN_TEXT.exec(delivered)?.[1]
      if (hash === undefined) {
        failures.push(`${label}: credited ${credited.join(',')} and changed the text, but the delivered text names no hash — the omitted content is unreachable`)
        continue
      }

      let retrieved: unknown
      try {
        retrieved = await runtime.retrieve(hash)
      } catch (error) {
        failures.push(`${label}: headroom_retrieve threw for hash=${hash}: ${(error as Error).message}`)
        continue
      }
      if (retrieved !== text) {
        failures.push(`${label}: hash=${hash} returned ${typeof retrieved} of ${String(retrieved).length} chars instead of the ${text.length}-char original`)
        continue
      }
      // A retrieve that resolves but is not counted is a miss the panel would
      // keep showing as "never asked", so the counters are part of the contract.
      if (after.retrievals + 1 !== runtime.status().retrievals) {
        failures.push(`${label}: retrieving ${hash} did not advance the retrieval counter`)
      }
      if (runtime.status().retrieveMisses !== after.retrieveMisses) {
        failures.push(`${label}: retrieving ${hash} was recorded as a miss`)
      }
    }

    // Without this the whole file passes vacuously the day a detector change
    // makes every fixture decline — the guard would still be green and would
    // still catch nothing.
    expect(engaged.length, `only ${engaged.length} of ${FIXTURES.length} fixtures reached a lossy strategy: ${engaged.join(' ')}`).toBeGreaterThanOrEqual(6)
    expect(failures, `\n${failures.join('\n')}\n(engaged: ${engaged.join(' ')})\n`).toEqual([])
  })
})

/**
 * The same delivery, read for the two directions the hash check cannot see.
 *
 * The check above reads the **first** `hash=` marker of each result, which is the
 * suffix the runtime appends for the whole payload. A delivery can be perfectly
 * correct by that reading and still be broken twice over:
 *
 * - the crusher's **inline** markers (`<<ccr:HASH,KIND,SIZE>>` for an opaque cell,
 *   `<<ccr:HASH N_rows_offloaded>>` for dropped rows) are never looked at, so an
 *   opaque cell naming an entry that was never written — or was evicted — is a
 *   retrieval the model is told it has and cannot make;
 * - nothing checks the other direction at all. An entry no marker names takes a
 *   slot from a retrieval the model was promised the next time the store fills up,
 *   which is the outcome `CcrStore.put` documents as unacceptable and the reason
 *   the orphan half exists.
 *
 * `ccrEntries` is read off `status()` rather than from the store, so the count
 * compared here is the one the settings panel shows the user.
 */
describe('headroom retrievability: every reference, and no entry without one', () => {
  it('resolves every marker the delivered text names, and leaves nothing unnamed', async () => {
    const failures: string[] = []
    let inline = 0

    for (const [label, text] of FIXTURES) {
      const runtime = headroomSeam()
      const delivered = await runtime.run(text)
      const named = referencesIn(delivered)
      inline += (delivered.match(/<<ccr:/gu) ?? []).length

      for (const hash of named) {
        try {
          await runtime.retrieve(hash)
        } catch (error) {
          failures.push(`${label}: the delivered text names ${hash} and the shipped tool cannot resolve it — ${(error as Error).message}`)
        }
      }

      const entries = runtime.status().ccrEntries
      if (entries !== named.length) {
        failures.push(`${label}: the store holds ${entries} entr(y/ies) while the delivered text names ${named.length} hash(es)`)
      }
    }

    // Without this the inline half passes vacuously the day no fixture produces an
    // opaque cell — the guard would be green and would be reading nothing.
    expect(inline, 'no delivered result carried a <<ccr:…>> reference, so the inline spelling is untested').toBeGreaterThan(0)
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })

  it('leaves nothing in CCR when the settings refuse what a compressor accepted', async () => {
    // Every compressor measures its own savings ratio, and the runtime measures the
    // accepted text again against `headroomMinSavingsRatio` — a *second* judge, and
    // one the user moves. Whoever stashes at the first and is refused by the second
    // leaves an entry no delivered marker names, which is reachable from the
    // settings panel rather than from a fixture: at 0.5 the prose branch shipped the
    // input while holding its original, and the tabular branch did the same at every
    // ratio here, because a table refused on re-measure had already written its
    // opaque cells.
    //
    // Mutation: this is the shape the fix in `runtime.ts` answers — a compressor
    // called with the live store instead of a stage fails on `tabular @0.5`.
    const failures: string[] = []
    for (const ratio of [0.5, 0.7, 0.8]) {
      for (const [label, text] of FIXTURES) {
        const runtime = headroomSeam({ ...HEADROOM_SEAM_SETTINGS, headroomMinSavingsRatio: ratio })
        const delivered = await runtime.run(text)
        const named = referencesIn(delivered)
        const entries = runtime.status().ccrEntries
        if (entries !== named.length) {
          failures.push(`${label} @${ratio}: the store holds ${entries} entr(y/ies) while the delivered text names ${named.length} hash(es)`)
        }
      }
    }
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })
})
