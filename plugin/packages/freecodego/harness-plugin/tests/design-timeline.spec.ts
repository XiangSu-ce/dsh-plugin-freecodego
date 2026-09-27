/**
 * The timeline reader: what a composition contains, and when it runs.
 *
 * The cases here are the ones where a plausible implementation answers
 * confidently and wrongly: a `data-start` that was never written reported as
 * `0`, a clip with no `data-track-index` dropped because there was no track to
 * put it in, an empty attribute read as an author asking for time zero, and
 * tracks emitted in file order rather than track order. Each of those produces a
 * report that looks complete and is partly invented, which is the failure this
 * module exists to avoid.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { catalogTimeline } from '../src/design/timeline.ts'

/** A composition with two tracks, a sub-composition host, and one loose clip. */
const COMPOSITION = [
  '<!doctype html>',
  '<html><body>',
  '<div id="root" data-composition-id="root" data-width="1280" data-height="720" data-duration="12">',
  '  <div class="clip bg" data-start="0" data-duration="12" data-track-index="0"></div>',
  '  <div class="clip" id="title" data-start="1.5" data-duration="3" data-track-index="2"></div>',
  '  <div class="clip" data-start="4" data-duration="2.5" data-track-index="0"></div>',
  '  <div class="clip loose" data-start="2"></div>',
  '  <div data-composition-src="scenes/outro.html" data-composition-id="outro" class="clip"',
  '       data-track-index="1" data-start="9" data-duration="3"></div>',
  '  <div class="clip" data-start="6" data-duration="1" data-media-start="2" data-track-index="1" data-hidden></div>',
  '</div>',
  '</body></html>',
].join('\n')

describe('catalogTimeline', () => {
  it('reads the composition roots and their declared geometry', () => {
    const report = catalogTimeline(COMPOSITION)
    expect(report.compositions.map(composition => composition.id)).toEqual(['root', 'outro'])
    expect(report.compositions[0]).toMatchObject({ id: 'root', width: 1280, height: 720, durationSeconds: 12 })
    // A host that mounts another file says so: the reader can follow it, and a
    // report that omitted the source would describe a scene with no file behind it.
    expect(report.compositions[1]).toMatchObject({ id: 'outro', source: 'scenes/outro.html' })
  })

  it('groups clips by track, in track order and source order within a track', () => {
    const report = catalogTimeline(COMPOSITION)
    expect(report.tracks.map(track => track.trackIndex)).toEqual([0, 1, 2])
    expect(report.tracks[0]?.clips.map(clip => clip.startSeconds)).toEqual([0, 4])
    expect(report.tracks[2]?.clips.map(clip => clip.selector)).toEqual(['#title'])
  })

  it('keeps a clip with no track index instead of dropping it', () => {
    const report = catalogTimeline(COMPOSITION)
    expect(report.untracked.map(clip => clip.selector)).toEqual(['.loose'])
    // Placed, unplaced, and both: the total is the same number either way, which
    // is what makes dropping one visible as a disagreement rather than as a
    // slightly smaller report.
    expect(report.totalClips).toBe(report.tracks.reduce((sum, track) => sum + track.clips.length, 0) + 1)
  })

  it('reports absent timing as absent rather than as zero', () => {
    const report = catalogTimeline('<div class="clip" data-start="0.5"></div>')
    expect(report.totalClips).toBe(1)
    expect(report.clipsMissingTiming).toBe(1)
    // Nothing declares both values, so there is no latest end to report — and
    // `0` would be a different, confident, wrong answer.
    expect(report.latestDeclaredEndSeconds).toBeUndefined()
  })

  it('takes the latest declared end from the clips that declare both values', () => {
    const report = catalogTimeline(COMPOSITION)
    // 4 + 2.5 and 9 + 3 are both candidates; the loose clip has no duration and
    // cannot contribute.
    expect(report.latestDeclaredEndSeconds).toBe(12)
  })

  it('reads an empty or non-numeric value as undeclared, not as zero', () => {
    const report = catalogTimeline('<div class="clip" data-start="" data-duration="auto" data-track-index="x"></div>')
    // Destructured rather than indexed with an assertion: `noUncheckedIndexedAccess`
    // makes the element optional, and optional chaining says that without a cast
    // that one lint rule would then call unnecessary.
    const [clip] = report.untracked
    expect(clip?.startSeconds).toBeUndefined()
    expect(clip?.durationSeconds).toBeUndefined()
    expect(clip?.trackIndex).toBeUndefined()
    expect(report.clipsMissingTiming).toBe(1)
  })

  it('reads data-hidden in both spellings, and data-media-start', () => {
    const report = catalogTimeline(COMPOSITION)
    const hidden = report.tracks[1]?.clips.find(clip => clip.hidden)
    expect(hidden?.mediaStartSeconds).toBe(2)
    // The bare-attribute spelling, which is valid HTML and which a `=`-only
    // reader would report as visible.
    const bare = catalogTimeline('<div class="clip" data-hidden data-start="0" data-duration="1"></div>')
    expect(bare.tracks).toEqual([])
    expect(bare.totalClips).toBe(1)
  })

  it('prefers the most specific selector available', () => {
    const report = catalogTimeline([
      '<div id="a" class="clip one two" data-start="0" data-duration="1" data-track-index="0"></div>',
      '<div class="clip one two" data-start="0" data-duration="1" data-track-index="0"></div>',
      '<section class="clip outro" data-start="0" data-duration="1" data-track-index="0"></section>',
    ].join('\n'))
    expect(report.tracks[0]?.clips.map(clip => clip.selector)).toEqual(['#a', '.one', '.outro'])
    expect(report.tracks[0]?.clips.map(clip => clip.element)).toEqual(['div', 'div', 'section'])
  })

  it('ignores a clip marker that is only part of a longer class name', () => {
    // `clip-path` and `clips` are not the contract; matching on a substring would
    // report every element that clips its overflow as a timed clip.
    const report = catalogTimeline('<div class="clips" data-start="0" data-duration="1"></div><div class="clip-path"></div>')
    expect(report.totalClips).toBe(0)
  })

  it('answers an empty document with empty lists rather than throwing', () => {
    const report = catalogTimeline('')
    expect(report).toEqual({
      compositions: [],
      tracks: [],
      untracked: [],
      totalClips: 0,
      clipsMissingTiming: 0,
    })
  })
})
