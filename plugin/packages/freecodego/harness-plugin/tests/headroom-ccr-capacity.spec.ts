/**
 * A bounded store trades one retrieval for another — and only between promises
 * that are already dead.
 *
 * `CcrStore` keeps the *newest* `capacity` entries and drops the oldest
 * insertions, and that policy is correct for its job: the store cannot hold
 * everything a long session compresses. What the policy may not do is spend a
 * retrieval the model was promised. A delivered rendering puts a
 * `hash=`/`<<ccr:HASH…>>` marker into the conversation, and that marker is the
 * whole reason dropping the original was safe; if a later write evicts the entry
 * it names, the model holds a pointer to bytes that were never missing — the
 * failure `CcrStore.put`'s own documentation calls unacceptable, arriving from
 * the other direction.
 *
 * Three readings of the same rule, because each one alone is survivable by
 * accident:
 *
 * 1. **The refusal**, at the store: with every slot belonging to a delivered
 *    original there is no victim to take, so the write is refused and the
 *    caller's documented answer to `false` is to render its value verbatim.
 * 2. **The trade**, also at the store's scale: an entry *no* delivered marker
 *    names — a stash whose rendering was then declined — is still a legitimate
 *    victim, and the held original survives it. Without this half the rule could
 *    be satisfied by never evicting anything, which would make compression stop
 *    working rather than make it honest.
 * 3. **The session**, through the real runtime and the real `headroom_retrieve`
 *    tool: eight deliveries into a default store, after each one *every* marker
 *    ever delivered still resolves. This is the shape the accident actually took
 *    — generation 4 filled the store, generation 5's own writes evicted the
 *    originals generation 1's markers name, and the model's transcript filled up
 *    with retrievals that fail while the bytes had never been missing.
 *
 * The ceiling shows up in the session reading in **two** shapes, and the gate has to
 * accept either one as evidence that the rule was exercised. A whole-payload branch
 * whose write the store cannot back now declines only *its own* rendering and falls
 * through — a full store is a fact about the store, not about the payload — so the
 * generations past the ceiling still ship, as a smaller rendering whose write fit
 * (0.50 through the prose stage instead of 0.99 of table form with a marker nothing
 * can resolve). The refusal itself is counted by the branch (`ccrWriteRefusals`), and
 * it is the *only* counter that says the ceiling was what stopped a delivery: the
 * older reading — "a generation that names no hash" — was a synonym for it while a
 * refused JSON write ended the chain.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CcrStore, DEFAULT_CAPACITY, StagedCcrStore, computeKey } from '../src/headroom/ccr.ts'
import { headroomSeam, referencesIn } from './support/headroom-seam.ts'

/** Rows whose payload is past `opaqueMinBytes`, so each one becomes a stored opaque cell. */
const opaqueRows = (rows: number, generation: number): string => JSON.stringify(Array.from({ length: rows }, (_value, index) => ({
  id: index,
  level: index % 11 === 0 ? 'ERROR' : 'INFO',
  owner: `team_${index % 4}`,
  payload: Buffer.from(`gen-${generation}-chunk-${index}-`.repeat(20)).toString('base64'),
})), null, 1)

const ROWS_PER_DELIVERY = 200
/** Entries one delivery writes: one cell per row, plus the marker for the payload itself. */
const COST_PER_DELIVERY = ROWS_PER_DELIVERY + 1

describe('CCR capacity: an eviction may not spend a retrieval the model was promised', () => {
  it('refuses the write that would evict a delivered original, and takes a dead one when it exists', () => {
    /** A delivery, written the way every compressor writes: through a stage, committed on ship. */
    const deliver = (store: CcrStore, payload: string): boolean => {
      const stage = new StagedCcrStore(store)
      if (stage.put(computeKey(payload), payload) !== true) return false
      stage.commit()
      return true
    }

    const store = new CcrStore(2)
    const first = 'the original whose marker the model is holding'
    const second = 'a second original the model is holding'
    expect(deliver(store, first)).toBe(true)
    expect(deliver(store, second)).toBe(true)
    expect(store.size).toBe(2)

    // Full, and both slots belong to originals the model can see markers for. Making
    // room would delete one of them, so the write is refused — the model is better
    // served by a cell that stays verbatim than by a pointer to nothing.
    expect(deliver(store, 'a third original with nowhere to go'), 'the store must refuse rather than evict a held original').toBe(false)
    expect(store.canAccept(1), 'the store must be able to say so before a caller renders').toBe(false)
    expect(store.get(computeKey(first))).toBe(first)
    expect(store.get(computeKey(second))).toBe(second)

    // The other half, and the reason the rule is not "never evict": an entry no
    // delivered marker names is a dead promise, and it is the one to spend. This is
    // the shape the `html` and skeleton paths create when they write and the
    // delivery is then declined, and it is what keeps compression working as the
    // store fills.
    const trading = new CcrStore(2)
    const neverDelivered = 'stashed for a rendering that was then declined'
    trading.put(computeKey(neverDelivered), neverDelivered)
    expect(deliver(trading, first)).toBe(true)
    expect(deliver(trading, 'a third original'), 'a dead entry must be taken instead of a held one').toBe(true)
    expect(trading.get(computeKey(first))).toBe(first)
    expect(trading.get(computeKey(neverDelivered)), 'the dead entry is the victim').toBeUndefined()
  })

  it('keeps every marker of every delivery resolvable while the store fills up', async () => {
    const runtime = headroomSeam()
    const failures: string[] = []
    /** Every marker the model has been given, in the order it received them. */
    const held: { readonly generation: number; readonly hash: string }[] = []
    let named = 0
    let unbacked = 0
    let refusedWrites = 0
    let peak = 0

    for (let generation = 0; generation < 8; generation += 1) {
      const input = opaqueRows(ROWS_PER_DELIVERY, generation)
      const shipped = await runtime.run(input)
      const status = runtime.status()
      peak = Math.max(peak, status.ccrEntries)
      refusedWrites = Math.max(refusedWrites, status.ccrWriteRefusals)

      const references = referencesIn(shipped)
      if (references.length === 0) {
        unbacked += 1
        // A delivery that could not be stashed has to be the input, byte for byte.
        // The alternative — a shortened rendering whose dropped content nothing
        // points back at — is unrecoverable, which is worse than not compressing.
        if (shipped !== input) failures.push(`generation ${generation}: shipped ${shipped.length} chars that name no hash, for a ${input.length}-char input`)
        continue
      }
      named += 1
      for (const hash of references) held.push({ generation, hash })

      // The question, asked after every delivery rather than only at the end: the
      // model's whole transcript is still resolvable, through the tool it actually
      // calls. A miss here is a retrieval the model was promised and cannot make.
      const dangling: string[] = []
      for (const entry of held) {
        try {
          await runtime.retrieve(entry.hash)
        } catch {
          dangling.push(`generation ${entry.generation} lost ${entry.hash}`)
        }
      }
      if (dangling.length > 0) {
        failures.push(`after generation ${generation}: ${dangling.length} of ${held.length} held markers no longer resolve — ${dangling.slice(0, 3).join(', ')}${dangling.length > 3 ? `, …(+${dangling.length - 3})` : ''}`)
      }
      // A generation that *did* reach the ceiling with its own writes must say so:
      // the count is the branch's refusal, not a count of the payloads that ended up
      // unlike their input. Asserted per generation because the alternative —
      // reading it only at the end — passes on a run where one write was refused and
      // seven generations never touched the ceiling at all.
      if (generation >= 4) {
        expect(refusedWrites, `generation ${generation} shipped unbacked (${unbacked} generations so far) with no refused write reported`).toBeGreaterThan(0)
      }
    }

    // Reported before the preconditions below, on purpose: when the rule is broken
    // the sentence that matters is the one naming the markers the model lost, not
    // the one saying the store never filled up.
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])

    // Without these the file is green the day the fixtures stop filling the store:
    // the ceiling has to have been reached, and reaching it has to have been the
    // thing that stopped a delivery. `ccrWriteRefusals` is that reading — the
    // branch whose write the store could not back — and it is asserted per
    // generation above as well, because a run where the ceiling is touched once and
    // never again would satisfy this line alone.
    expect(peak, `the store only reached ${peak} of ${DEFAULT_CAPACITY} entries`).toBeGreaterThan(DEFAULT_CAPACITY - COST_PER_DELIVERY)
    expect(refusedWrites, 'no write was refused, so the ceiling was never what stopped a delivery').toBeGreaterThan(0)
    expect(named, 'no delivery named a hash, so nothing was held').toBeGreaterThanOrEqual(3)
  })

  it('declines a delivery the full store cannot back instead of marking it retrievable', async () => {
    // The HTML branch is the one lossy path that writes the store directly rather
    // than through a stage, so its refusal is a line of its own — and a full store
    // is the only way to reach it. The rule it has to keep is the same one: a
    // rendering may not carry a marker the store cannot honour, so a refused write
    // means the extraction is declined and the input ships unchanged.
    const runtime = headroomSeam()
    for (let generation = 0; generation < 4; generation += 1) await runtime.run(opaqueRows(ROWS_PER_DELIVERY, generation))
    // Filled to the ceiling and not one slot short: four full deliveries, then one
    // row fewer than a delivery costs, so the store ends up holding exactly
    // `DEFAULT_CAPACITY` promises and a single write more has nowhere to go.
    await runtime.run(opaqueRows(DEFAULT_CAPACITY - 4 * COST_PER_DELIVERY - 1, 4))
    expect(runtime.status().ccrEntries, 'the store must be full of promises before this reads anything').toBe(DEFAULT_CAPACITY)

    const html = '<!DOCTYPE html><html><head><title>Report</title><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="a.css"><link rel="icon" href="f.ico"><style>body{color:red}</style></head><body><div class="nav"><ul><li>Home</li><li>About</li><li>Contact</li><li>Blog</li><li>Careers</li><li>Docs</li></ul></div><footer><small>copyright notice</small></footer><aside><div>sidebar widget content</div></aside><div class="breadcrumbs"><a href="/">root</a><a href="/docs">docs</a><a href="/docs/guide">guide</a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=4">4</a><a href="?page=5">5</a></div><script>var x=1;function y(){return 2}</script><style>.a{color:red}.b{margin:0}</style><main>' + '<h2>Section</h2><p>Substantive paragraph with the actual content the reader needs.</p>'.repeat(10) + '</main></body></html>'
    const shipped = await runtime.run(html)

    const failures: string[] = []
    for (const hash of referencesIn(shipped)) {
      try {
        await runtime.retrieve(hash)
      } catch {
        failures.push(`shipped a marker the store cannot back: ${hash}`)
      }
    }
    expect(runtime.status().ccrEntries, 'a refused write must leave the store alone').toBe(DEFAULT_CAPACITY)
    expect(shipped, 'a delivery that could not be stashed must be the input, byte for byte').toBe(html)
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })
})
