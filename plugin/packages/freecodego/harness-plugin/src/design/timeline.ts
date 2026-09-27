/**
 * The read form of a composition's timeline: its compositions, tracks, and clips.
 *
 * This is what upstream's `timeline` verb listed, minus everything that writes.
 * Upstream's version also carries mutation verbs (`move`/`delete`/`split`) that
 * rewrite the composition source; those are deliberately absent here, because a
 * model that wants to change a composition has file tools that go through the
 * same review and checkpoint machinery everything else does. A parallel editing
 * surface would be a way around those guard rails, not through them. What the
 * design pack actually needs from `timeline` is the answer to "what is in this
 * project and when does it run", and that is decidable from the markup.
 *
 * The attributes read here are the clip contract the Skills describe
 * (`hyperframes-core`, `data-start` / `data-duration` / `data-track-index`), not
 * an invented shape. Everything that is *not* declared is reported as absent
 * rather than defaulted: a `data-start` the author omitted is not the same as a
 * `0`, and reporting it as zero would make the answer look complete while it was
 * partly invented.
 *
 * @module design/timeline
 */

import { readAttr } from './lint.ts'

/** One composition declared inside the file. */
export interface DesignTimelineComposition {
  /** `data-composition-id`, the id a host mounts it by. */
  readonly id: string
  /** `data-composition-src`, when this host mounts another file. */
  readonly source?: string
  /** `data-duration`, when the composition declares its own length. */
  readonly durationSeconds?: number
  readonly width?: number
  readonly height?: number
}

/** One timed element. */
export interface DesignTimelineClip {
  /** The element's tag name, lowercased. */
  readonly element: string
  /** The most specific selector available for it: `#id`, `.class`, or the tag. */
  readonly selector: string
  /** `data-track-index`, when declared. Absent means the clip is untracked. */
  readonly trackIndex?: number
  /** `data-start`, in seconds. */
  readonly startSeconds?: number
  /** `data-duration`, in seconds. */
  readonly durationSeconds?: number
  /** `data-media-start`, in seconds: where playback of the source media begins. */
  readonly mediaStartSeconds?: number
  /** `data-hidden` is present, so the clip is authored but not shown. */
  readonly hidden: boolean
}

/** One track, with its clips in source order. */
export interface DesignTimelineTrack {
  readonly trackIndex: number
  readonly clips: readonly DesignTimelineClip[]
}

/** What reading a composition produced. */
export interface DesignTimelineReport {
  readonly compositions: readonly DesignTimelineComposition[]
  /** Clips grouped by `data-track-index`, ordered by track index. */
  readonly tracks: readonly DesignTimelineTrack[]
  /** Clips with no `data-track-index`. Kept rather than dropped: a clip the
   *  reader cannot place is still a clip the author wrote. */
  readonly untracked: readonly DesignTimelineClip[]
  readonly totalClips: number
  /** Clips that are missing `data-start` or `data-duration`. */
  readonly clipsMissingTiming: number
  /** The latest end time among clips that declare both values. Absent when no
   *  clip does, which is a different answer from zero seconds. */
  readonly latestDeclaredEndSeconds?: number
}

/** A finite number, or undefined for anything else.
 *
 * An empty value is `undefined` rather than `0`: `Number('')` is `0`, so a bare
 * `data-start=""` would otherwise be reported as an author who asked for time
 * zero when what they wrote was no time at all.
 */
function toSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A positive integer, or undefined. */
function toInteger(value: string | undefined): number | undefined {
  const parsed = toSeconds(value)
  return parsed === undefined || !Number.isInteger(parsed) ? undefined : parsed
}

/**
 * The selector that reaches this element most directly.
 *
 * The `clip` marker is skipped when choosing a class, because every clip carries
 * it and `.clip` names all of them: a report whose every selector was `.clip`
 * would locate nothing, which is worse than falling back to the tag name.
 */
function selectorOf(tag: string, element: string): string {
  const id = readAttr(tag, 'id')
  if (id !== undefined && id !== '') return `#${id}`
  const className = (readAttr(tag, 'class') ?? '')
    .trim()
    .split(/\s+/u)
    .filter(part => part !== '' && part !== 'clip')[0]
  return className === undefined ? element : `.${className}`
}

/** True when a `class` attribute carries the clip marker as a whole word. */
function isClip(tag: string): boolean {
  const className = readAttr(tag, 'class')
  return className !== undefined && /(?:^|\s)clip(?:\s|$)/u.test(className.trim())
}

/** True when the element carries `data-hidden`, written either way.
 *
 * Both spellings occur in the Skills' own examples, and a bare `data-hidden` — no
 * `=` — is valid HTML that means exactly what `data-hidden="true"` means. Missing
 * it would report a hidden clip as visible, which is the opposite of what the
 * author wrote.
 */
function isHidden(tag: string): boolean {
  return readAttr(tag, 'data-hidden') !== undefined || /\bdata-hidden\b/u.test(tag)
}

/**
 * Read a composition's timeline.
 *
 * @param html - the composition source.
 * @returns the compositions, the tracks, and what timing was not declared.
 */
export function catalogTimeline(html: string): DesignTimelineReport {
  const compositions: DesignTimelineComposition[] = []
  const clips: DesignTimelineClip[] = []

  // One pass over start tags. The attribute pattern tolerates `>` inside a quoted
  // value, because a composition that puts a `>` in an attribute is still valid
  // markup and a simpler pattern would end the tag early and lose the attributes
  // after it.
  for (const match of html.matchAll(/<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/giu)) {
    const tag = match[0]
    const element = (match[1] ?? '').toLowerCase()

    const compositionId = readAttr(tag, 'data-composition-id')
    if (compositionId !== undefined && compositionId !== '') {
      const source = readAttr(tag, 'data-composition-src')
      const duration = toSeconds(readAttr(tag, 'data-duration'))
      const width = toInteger(readAttr(tag, 'data-width'))
      const height = toInteger(readAttr(tag, 'data-height'))
      compositions.push({
        id: compositionId,
        ...source === undefined || source === '' ? {} : { source },
        ...duration === undefined ? {} : { durationSeconds: duration },
        ...width === undefined ? {} : { width },
        ...height === undefined ? {} : { height },
      })
    }

    if (!isClip(tag)) continue
    const trackIndex = toInteger(readAttr(tag, 'data-track-index'))
    const start = toSeconds(readAttr(tag, 'data-start'))
    const duration = toSeconds(readAttr(tag, 'data-duration'))
    const mediaStart = toSeconds(readAttr(tag, 'data-media-start'))
    clips.push({
      element,
      selector: selectorOf(tag, element),
      ...trackIndex === undefined ? {} : { trackIndex },
      ...start === undefined ? {} : { startSeconds: start },
      ...duration === undefined ? {} : { durationSeconds: duration },
      ...mediaStart === undefined ? {} : { mediaStartSeconds: mediaStart },
      hidden: isHidden(tag),
    })
  }

  const byTrack = new Map<number, DesignTimelineClip[]>()
  const untracked: DesignTimelineClip[] = []
  for (const clip of clips) {
    if (clip.trackIndex === undefined) { untracked.push(clip); continue }
    const existing = byTrack.get(clip.trackIndex)
    if (existing === undefined) byTrack.set(clip.trackIndex, [clip])
    else existing.push(clip)
  }

  const ends = clips
    .filter(clip => clip.startSeconds !== undefined && clip.durationSeconds !== undefined)
    .map(clip => (clip.startSeconds as number) + (clip.durationSeconds as number))

  return {
    compositions,
    tracks: [...byTrack.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([trackIndex, trackClips]) => ({ trackIndex, clips: trackClips })),
    untracked,
    totalClips: clips.length,
    clipsMissingTiming: clips.filter(clip => clip.startSeconds === undefined || clip.durationSeconds === undefined).length,
    ...ends.length === 0 ? {} : { latestDeclaredEndSeconds: Math.round(Math.max(...ends) * 1_000) / 1_000 },
  }
}
