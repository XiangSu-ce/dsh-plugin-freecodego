import { describe, expect, it } from 'vitest'
import { allocateVisualHeights, getStackedSegmentVisualLayout } from '../src/client/stacked-bar-visuals.ts'

describe('stacked segment height allocation', () => {
  it('lifts a hairline segment to the floor and keeps the total height', () => {
    const heights = allocateVisualHeights([1000, 1], 0.1, 5)
    // The tiny model is promoted to the 5px floor; the tall one donates exactly
    // that many pixels, so the stack still fills its bar.
    expect(heights).not.toBeNull()
    expect(heights![1]).toBe(5)
    expect(heights!.reduce((sum, height) => sum + height, 0)).toBeCloseTo(100.1)
  })

  it('leaves comfortable segments untouched', () => {
    expect(allocateVisualHeights([8, 2], 10, 5)).toEqual([80, 20])
  })

  it('promotes every non-zero segment when the bar is too short for the floors', () => {
    expect(allocateVisualHeights([1, 1], 1, 5)).toEqual([5, 5])
  })

  it('refuses scales that cannot express a height', () => {
    expect(allocateVisualHeights([1, 2], 0, 5)).toBeNull()
    expect(allocateVisualHeights([1, 2], Number.NaN, 5)).toBeNull()
    expect(allocateVisualHeights([0, 0], 1, 5)).toBeNull()
  })
})

describe('stacked segment layout', () => {
  it('stacks segments bottom-up and marks only the top one', () => {
    const values = [8, 2]
    const options = { values, segmentHeight: 0, segmentY: 0, stackStart: 0, minHeight: 5 }
    const bottom = getStackedSegmentVisualLayout({ ...options, segmentIndex: 0, segmentHeight: 80, segmentY: 20 })
    const top = getStackedSegmentVisualLayout({ ...options, segmentIndex: 1, segmentHeight: 20, segmentY: 0, stackStart: 8 })
    expect(bottom).toEqual({ height: 80, isTop: false, y: 20 })
    expect(top).toEqual({ height: 20, isTop: true, y: 0 })
  })

  it('promotes a hairline top segment and shifts it to keep the stack flush', () => {
    const layout = getStackedSegmentVisualLayout({
      values: [1000, 1],
      segmentIndex: 1,
      segmentHeight: 0.0999,
      segmentY: 0,
      stackStart: 1000,
      minHeight: 5,
    })
    expect(layout?.height).toBe(5)
    expect(layout?.isTop).toBe(true)
    // y = 0 means the promoted segment grew downward into the bar instead of
    // overflowing it.
    expect(layout?.y).toBeCloseTo(0)
  })

  it('skips zero-valued or unmeasurable segments', () => {
    const base = { values: [1, 0], segmentHeight: 10, segmentY: 0, stackStart: 0 }
    expect(getStackedSegmentVisualLayout({ ...base, segmentIndex: 1 })).toBeNull()
    expect(getStackedSegmentVisualLayout({ ...base, segmentIndex: 0, segmentHeight: 0 })).toBeNull()
  })
})
