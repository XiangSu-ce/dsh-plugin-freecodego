/**
 * Headroom's originals belong to the Harness's spill store, not to this plugin.
 *
 * `headroom_retrieve` answers from an in-memory, idle-expiring, capacity-bounded
 * store, and its refusal was written as a tombstone — *"no longer stored (expired
 * or evicted)… re-run the original tool"*. That is the ported design and it is a
 * fair trade on its own. Composed with the Harness it stops being one: this
 * composition mounts `dsh-spill` + `dsh-spill-local`, whose whole job is to keep
 * oversized text on disk behind a locator the model reads or greps, and the
 * Harness's own policy cannot take the archive's place for the payloads Headroom
 * compresses — it skips `read` results outright (the read → spill → read-again
 * loop) and it only bounds what the waterfall accepted, so a payload Headroom
 * brought *under* its cap is never spilled by it at all.
 *
 * So the graph here is the one the fix claims, measured end to end through the
 * shipped seam and the shipped tool:
 *
 *   compression → original parked via `ctx.spillStore.saveText()`
 *              → the delivered text names where it went
 *              → `headroom_retrieve` still answers for a hash whose in-memory
 *                entry is gone, and names the artifact when it cannot read it
 *
 * The degrade direction is pinned too, because it is what every other headroom
 * gate runs on: with no backend mounted, the delivered text is exactly what it
 * was before this existed — the marker, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { ARCHIVE_NOTICE_SHARE, ArchivingCcrStore, DEFAULT_ARCHIVE_MIN_BYTES, SpillArchive, attachArchiveNotices } from '../src/headroom/ccr-spill.ts'
import { computeKey } from '../src/headroom/ccr.ts'
import type { SpillWriter } from '../src/result-spill.ts'
import { HEADROOM_SEAM_SETTINGS, headroomSeam } from './support/headroom-seam.ts'

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * A spill backend, in the two halves the plugin touches.
 *
 * `saveText` mirrors `spill-local`: the locator it returns carries an opaque
 * component derived from nothing the caller supplied, which is the property that
 * makes the archive's notice load-bearing rather than decorative — a restart
 * cannot derive this path from the hash.
 */
class FakeSpillStore implements SpillWriter {
  readonly saves: { readonly sessionId: string; readonly source: { readonly toolName: string; readonly callId: string; readonly label: string }; readonly suggestedName: string; readonly content: string }[] = []
  private readonly artifacts = new Map<string, string>()
  private counter = 0

  async saveText(input: {
    readonly owner: { readonly sessionId: string }
    readonly source: { readonly kind: 'tool'; readonly toolName: string; readonly callId: string; readonly label: string }
    readonly suggestedName: string
    readonly content: string
  }): Promise<{ readonly locator: string; readonly bytes: number; readonly retrievalHint: string }> {
    this.counter += 1
    const locator = `/dsh-home/spill/${input.owner.sessionId}/artifact-${this.counter}-${input.suggestedName}`
    this.artifacts.set(locator, input.content)
    this.saves.push({
      sessionId: input.owner.sessionId,
      source: input.source,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return { locator, bytes: bytes(input.content), retrievalHint: 'Read or grep this path.' }
  }

  /** What the backend would serve a reader of this locator. */
  read(locator: string): Promise<string> {
    const content = this.artifacts.get(locator)
    return content === undefined ? Promise.reject(new Error(`no artifact at ${locator}`)) : Promise.resolve(content)
  }
}

/** A log fixture far past both the size gate and the archive floor. */
const logFixture = Array.from({ length: 400 }, (_value, index) =>
  `2026-09-20T10:${String(index % 60).padStart(2, '0')}:01.000Z ${index % 13 === 0 ? 'ERROR' : 'INFO'} worker[${index}] ${'x'.repeat(60)} id=${index}`).join('\n')

const HASH_IN_TEXT = /hash=([a-f0-9]{24})/u

/**
 * A store whose entries expire as soon as one tick passes, so "the in-memory
 * entry is gone" is exercised rather than assumed.
 *
 * The bounds are `CcrStore`'s own, not a test hook into its internals: an idle
 * window of 1 ms and no absolute lifetime is exactly what a session an hour old
 * looks like to the shipped defaults.
 */
const expiringStore = (archive: SpillArchive) => new ArchivingCcrStore(archive, { idleTtlMs: 1, maxLifetimeMultiplier: 0 })

describe('headroom originals are archived in the Harness spill store', () => {
  it('parks the original through ctx.spillStore and names it in the delivered text', async () => {
    const store = new FakeSpillStore()
    const seam = headroomSeam(HEADROOM_SEAM_SETTINGS, { spillStore: store, readArtifact: locator => store.read(locator), sessionId: 'session-42' })

    const delivered = await seam.run(logFixture)

    // The compression really happened, so the assertions below are about a
    // delivery rather than about the seam handing the input back.
    expect(delivered).not.toBe(logFixture)
    expect(bytes(delivered)).toBeLessThan(bytes(logFixture))
    const hash = HASH_IN_TEXT.exec(delivered)?.[1]
    expect(hash).toBeDefined()

    // The copy the backend holds is the *original*, byte for byte — not the
    // rendering the model received, which is what a wrong hook point would park.
    expect(store.saves).toHaveLength(1)
    const save = store.saves[0]!
    expect(save.content).toBe(logFixture)
    expect(save.suggestedName).toBe(`headroom-${hash}.txt`)
    expect(save.sessionId).toBe('session-42')
    expect(save.source).toEqual({ kind: 'tool', toolName: 'bash', callId: 'call-headroom-seam', label: 'headroom-original' })

    // The locator reaches the transcript, which is the only thing a restart
    // replays: without this line the durable copy is unreachable to the model.
    expect(delivered).toContain(`[Full original archived at ${`/dsh-home/spill/session-42/artifact-1-headroom-${hash}.txt`}. Read or grep this path.]`)
  })

  it('answers headroom_retrieve from the archive after the in-memory entry is gone', async () => {
    const store = new FakeSpillStore()
    const seam = headroomSeam(HEADROOM_SEAM_SETTINGS, {
      spillStore: store,
      readArtifact: locator => store.read(locator),
      store: expiringStore,
    })

    const delivered = await seam.run(logFixture)
    const hash = HASH_IN_TEXT.exec(delivered)?.[1]!
    const missesBefore = seam.status().retrieveMisses
    // The idle window is 1 ms; waiting past it is what expires the entry, so the
    // next lookup is the one the tombstone used to answer.
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(await seam.retrieve(hash)).toBe(logFixture)
    // A retrieval that succeeded is not a miss: the counter exists to show the
    // promise decaying, and this is the opposite of decay.
    expect(seam.status().retrieveMisses).toBe(missesBefore)
  })

  it('names the artifact, instead of claiming the bytes are gone, when it cannot read it back', async () => {
    const store = new FakeSpillStore()
    const seam = headroomSeam(HEADROOM_SEAM_SETTINGS, {
      spillStore: store,
      // A backend whose locator is a URI, or whose artifact is on another host:
      // the plugin can name it and read it either way, but not always read it.
      readArtifact: () => Promise.reject(new Error('not a local path')),
      store: expiringStore,
    })

    const delivered = await seam.run(logFixture)
    const hash = HASH_IN_TEXT.exec(delivered)?.[1]!
    const locator = `/dsh-home/spill/${'session-headroom-seam'}/artifact-1-headroom-${hash}.txt`
    await new Promise(resolve => setTimeout(resolve, 5))

    await expect(seam.retrieve(hash)).rejects.toThrow(new RegExp(locator.replaceAll('/', '\\/').replaceAll('.', '\\.'), 'u'))
    expect(seam.status().retrieveMisses).toBe(1)
  })

  it('changes nothing where the composition mounts no backend', async () => {
    const noBackend = headroomSeam()
    const delivered = await noBackend.run(logFixture)

    expect(delivered).not.toBe(logFixture)
    expect(HASH_IN_TEXT.test(delivered)).toBe(true)
    // No notice, because there is no durable copy to name. This is the shape
    // every other headroom gate reads, and the reason none of them moved.
    expect(delivered).not.toContain('Full original archived at')
    const hash = HASH_IN_TEXT.exec(delivered)?.[1]!
    expect(await noBackend.retrieve(hash)).toBe(logFixture)
  })
})

describe('the archive itself', () => {
  const payload = 'y'.repeat(DEFAULT_ARCHIVE_MIN_BYTES)

  it('archives a payload once, refuses nothing when the backend fails, and stays quiet below the floor', async () => {
    const store = new FakeSpillStore()
    const archive = new SpillArchive({
      store: () => store,
      logger: { warn: () => undefined, debug: () => undefined },
      readArtifact: locator => store.read(locator),
    })
    archive.setOwner({ sessionId: 'session-1' as never, toolName: 'bash', callId: 'call-1' })

    // Below the floor: the loss of a small entry costs one re-read, and a file
    // per compression would otherwise grow with the session.
    archive.record('a'.repeat(24), 'too small to be worth a file')
    await archive.settle()
    expect(store.saves).toHaveLength(0)

    archive.record(computeKey(payload), payload)
    archive.record(computeKey(payload), payload)
    await archive.settle()
    // Content-addressed: the same payload arriving again is the same artifact.
    expect(store.saves).toHaveLength(1)
    expect(archive.archivedCount).toBe(1)
    expect(await archive.recover(computeKey(payload))).toBe(payload)

    const failing = new SpillArchive({
      store: () => ({ saveText: () => Promise.reject(new Error('ENOSPC')) }),
      logger: { warn: () => undefined },
      readArtifact: () => Promise.reject(new Error('unreadable')),
    })
    failing.setOwner({ sessionId: 'session-1' as never, toolName: 'bash', callId: 'call-1' })
    failing.record('b'.repeat(24), payload)
    // Never throws at the caller: an archive failure leaves the in-memory entry
    // as the only copy, which is what the composition had before this existed.
    await expect(failing.settle()).resolves.toBeUndefined()
    expect(failing.failureCount).toBe(1)
    expect(await failing.recover('b'.repeat(24))).toBeUndefined()

    // A write with no owner is not archived at all: the backend groups artifacts
    // by session, so there is nothing to group it under.
    const ownerless = new SpillArchive({ store: () => store, logger: { warn: () => undefined, debug: () => undefined } })
    ownerless.record('c'.repeat(24), payload)
    await ownerless.settle()
    expect(ownerless.archivedCount).toBe(0)
  })

  it('spends at most a twentieth of a compression saving on the notice it appends', async () => {
    const store = new FakeSpillStore()
    const archive = new SpillArchive({ store: () => store, readArtifact: locator => store.read(locator) })
    archive.setOwner({ sessionId: 'session-1' as never, toolName: 'bash', callId: 'call-1' })
    const hash = computeKey(payload)
    archive.record(hash, payload)
    await archive.settle()
    const locator = await archive.locatorFor(hash)
    expect(locator).toBeDefined()
    const notice = `\n[Full original archived at ${locator}. Read or grep this path.]`

    // Exactly a twentieth: the notice ships, and the rendering still ships
    // smaller than the block it replaced by the whole rest of the saving.
    const rendering = `summary\nhash=${hash}`
    const affordable = bytes(notice) * ARCHIVE_NOTICE_SHARE
    expect(await attachArchiveNotices(archive, rendering, affordable)).toBe(`${rendering}${notice}`)

    // One byte less: the rendering is delivered exactly as the branch rendered
    // it, because the notice may not move a delivery back across the acceptance
    // bar the branch already measured it against.
    expect(await attachArchiveNotices(archive, rendering, affordable - 1)).toBe(rendering)

    // A rendering that names no archived original, and one whose originals are
    // all the same artifact, both keep the notice count at one line per artifact.
    expect(await attachArchiveNotices(archive, 'no references at all', 1_000_000)).toBe('no references at all')
    const twice = `hash=${hash}\n<<ccr:${hash},cell,99>>`
    expect((await attachArchiveNotices(archive, twice, 1_000_000)).match(/Full original archived at/gu)).toHaveLength(1)

    // An unknown hash is not a notice: the floor, a refusal and a failed save all
    // leave markers the archive has nothing to say about, and saying nothing is
    // what keeps the marker's own promise honest.
    expect(await attachArchiveNotices(archive, `hash=${'d'.repeat(24)}`, 1_000_000)).toBe(`hash=${'d'.repeat(24)}`)
  })
})
