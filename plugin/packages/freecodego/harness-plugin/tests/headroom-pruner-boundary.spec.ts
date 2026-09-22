/**
 * The boundary between Headroom and the Harness's own tool-result pruner.
 *
 * Two features shrink tool results, and until this file existed nothing said how
 * they divide the work — so the questions a reader had to answer from reading both
 * packages were: is one of them dead configuration, does either mangle the other's
 * output, and what happens to output neither takes.
 *
 * The answer is a seam ordering plus a population split, and every part of it is
 * read from the other package's *source* rather than from a second copy of its
 * numbers (`cache-cold.spec.ts` does the same for `PRUNE_MARKER`, and for the same
 * reason: a copy that stops matching is a guard that stops guarding). Absent
 * upstream source — a tree synced without `packages/` — there is nothing to
 * compare against, so those cases return instead of failing.
 *
 * 1. **Order.** Delivery precedes compaction. `tools/post-execute` runs while a
 *    call is answered; `pruneSession` runs only from `compaction-basic`'s trigger
 *    handling. So this runtime shrinks first and the pruner measures its rendering.
 * 2. **It is a floor, not a rival.** Headroom's threshold never bounds what the
 *    pruner may find: a payload delivered at 0.5 of 100 KB is still 50 KB. What
 *    makes that safe is where the retrieval reference lives — the last line, which
 *    is inside the tail the pruner keeps.
 * 3. **The populations are complementary.** The runtime protects read tools and
 *    short failed output; the pruner is size-only, so it is what eventually takes
 *    exactly those payloads.
 * 4. **Neither forges the other's marker.** A headroom rendering must never carry
 *    the pruner's marker, or `cache-cold` would treat this plugin's rendering as a
 *    result the Harness owns.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { headroomSeam } from './support/headroom-seam.ts'
import { HARNESS_PRUNE_MARKER } from '../src/cache-cold.ts'
import { DEFAULT_EXCLUDE_TOOLS } from '../src/headroom/runtime.ts'

const PRUNER = resolve(import.meta.dirname, '../../../compaction/compaction-tool-result-pruner/src')
const COMPACTION_BASIC = resolve(import.meta.dirname, '../../../compaction/compaction-basic/src/index.ts')
const COMPOSITION = resolve(import.meta.dirname, '../../../bundle/base/cordis.patch.yml')
const HEADROOM_SRC = resolve(import.meta.dirname, '../src/headroom')

/** Read a file when the upstream tree is present, or `undefined` when it is not. */
function upstream(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** One tool result's text, over every budget in play. */
const ORDINARY = Array.from(
  { length: 120 },
  (_, index) => `The ${index}th paragraph explains why this particular decision was taken, in ordinary words that repeat no structure at all.`,
).join('\n')

/** A traceback: two distinct strong error indicators, so the gate sees it as one. */
const FAILURE = `Traceback (most recent call last):\n${Array.from({ length: 60 }, (_, index) => `  File "/w/pkg/module_${index}.py", line ${index}, in run\n    fatal: the exception escaped here`).join('\n')}\nError: the process exited with a failure\n`

/** A JSON document the crusher's branch takes, sized so its rendering stays large. */
const BIG_JSON = `[${Array.from({ length: 400 }, (_, index) => `{"id":${index},"sentence":"${ORDINARY.slice(0, 180)} number ${index}"}`).join(',\n')}]`

describe('who shrinks what', () => {
  it('keeps a read result byte-identical, and compresses the same bytes from a shell', async () => {
    // The protection is the reason the pruner is not redundant: this runtime
    // refuses a read tool outright, whatever its size, because the model patches
    // bytes against it. The same payload through `bash` proves the refusal is the
    // protection rather than the fixture being too small or too shapeless.
    const seam = headroomSeam()
    const throughRead = await seam.run(ORDINARY, { toolName: 'read' })
    expect(throughRead).toBe(ORDINARY)
    const throughBash = await seam.run(ORDINARY)
    expect(throughBash).not.toBe(ORDINARY)
    expect(throughBash.length).toBeLessThan(ORDINARY.length)
    // And the tool really is on the protected list rather than leaving the
    // pipeline through some other branch.
    expect(DEFAULT_EXCLUDE_TOOLS).toContain('read')
  })

  it('keeps a short failed result verbatim, where the same text succeeding compresses', async () => {
    // A traceback is what the model recovers with, so it stays exact. The pair is
    // the point: `isError` alone decides this, and a guard that had merely been
    // dropped would show up here as two identical renderings.
    const seam = headroomSeam()
    const failed = await seam.run(FAILURE, { isError: true })
    expect(failed).toBe(FAILURE)
    const succeeded = await seam.run(FAILURE)
    expect(succeeded).not.toBe(FAILURE)
  })

  it('delivers a payload the pruner still has work to do on', async () => {
    // Not a compatibility detail but the reason the pruner is live configuration:
    // this runtime has no floor above its threshold, so a large result arrives at
    // the surface still over the pruner's 8192. Read through the pruner's own
    // composition rather than a literal, so a changed budget is a failing case.
    const composition = upstream(COMPOSITION)
    if (composition === undefined) return
    const threshold = Number(/thresholdChars:\s*(\d+)/u.exec(composition)?.[1])
    expect(threshold).toBeGreaterThan(0)
    const rendered = await headroomSeam().run(BIG_JSON)
    expect(rendered.length).toBeLessThan(BIG_JSON.length)
    expect(rendered.length).toBeGreaterThan(threshold)
  })

  it('writes its retrieval reference into the tail the pruner keeps', async () => {
    // The composition's whole safety argument. The pruner removes a middle span
    // and keeps head + marker + tail, so a reference anywhere but the tail would be
    // deleted by the pass that follows this one — the model would be handed a
    // shortened rendering with no way back and nothing saying so. Measured against
    // the pruner's configured `tailChars`, and against the rendering this runtime
    // actually ships.
    const composition = upstream(COMPOSITION)
    if (composition === undefined) return
    const tailChars = Number(/tailChars:\s*(\d+)/u.exec(composition)?.[1])
    expect(tailChars).toBeGreaterThan(0)
    const rendered = await headroomSeam().run(BIG_JSON)
    const referenceLine = rendered.slice(rendered.lastIndexOf('\n[') + 1)
    expect(referenceLine).toMatch(/hash=[a-f0-9]{24}/u)
    expect(referenceLine.length).toBeLessThan(tailChars)
    // The pruner keeps whole lines from that tail rather than trimming the payload:
    // `points.slice(tailStart)` is the retained region on its own source.
    const pruner = upstream(resolve(PRUNER, 'index.ts'))
    if (pruner === undefined) return
    expect(pruner).toContain('points.slice(tailStart)')
  })

  it('is matched by a pruner that judges size alone', () => {
    // The complementarity claim, pinned where it is decided. The pruner's
    // `pruneContent` reads the budget and the blocks and nothing else: if it ever
    // grew a tool name or an `isError` check, the two gates would start overlapping
    // and this file's first two cases would no longer describe the composition.
    const pruner = upstream(resolve(PRUNER, 'index.ts'))
    if (pruner === undefined) return
    const start = pruner.indexOf('pruneContent(blocks')
    const body = pruner.slice(start, pruner.indexOf('/**', start))
    expect(body).toContain('if (totalChars <= this.config.thresholdChars) return null')
    expect(body).not.toContain('isError')
    expect(body).not.toMatch(/toolName\s*===/u)
  })

  it('runs the pruner from a compaction pass, which is what orders the two', () => {
    // Order is not a policy anyone can choose freely — it follows from where each
    // one hooks. If the pruner were ever called at delivery time this file's
    // ordering claim would be false rather than merely stale, so it is read from
    // the caller.
    const compaction = upstream(COMPACTION_BASIC)
    if (compaction === undefined) return
    expect(compaction).toContain('prune.pruneSession(agent.session)')
    expect(compaction).toContain("trigger === 'context-overflow'")
    expect(compaction).not.toContain("ctx.on('tools/post-execute'")
  })

  it('never writes the marker that means the Harness owns a result', () => {
    // `cache-cold` reads that marker to decide a result is the Harness's, so a
    // compression that emitted it would make this plugin's own rendering
    // untouchable — and would show the model a marker with no Harness pass behind
    // it. The compressors do not know the string today; this is what says so.
    for (const entry of readdirSync(HEADROOM_SRC)) {
      if (!entry.endsWith('.ts')) continue
      expect(readFileSync(resolve(HEADROOM_SRC, entry), 'utf8')).not.toContain(HARNESS_PRUNE_MARKER)
    }
  })
})
