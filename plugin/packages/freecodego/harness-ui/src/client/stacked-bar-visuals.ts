/**
 * Stacked-bar visual layout.
 *
 * Ported from the MIT-licensed `workbuddy-switch` project
 * (`src/lib/stacked-bar-visuals.ts`, Copyright (c) 2026 wb-switch), which drives
 * its credit-trend chart. The chart stacks one segment per model, and token
 * counts span six orders of magnitude — without a floor the small models
 * collapse into invisible hairlines. `allocateVisualHeights` therefore gives
 * every non-zero segment at least `minHeight` pixels and pays for it by
 * shrinking the segments that have height to spare. The allocation conserves
 * the bar's total height, so the stack still fills it exactly and no rounding
 * seam opens between two segments.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-ui/stacked-bar-visuals
 */

export type StackedSegmentVisualLayout = {
  readonly height: number
  readonly isTop: boolean
  readonly y: number
}

/** Per-segment pixel heights that keep every non-zero segment visible.
/**
 * Returns null when the scale is unusable (no room, or no positive value).
 * @param values - the segment values, in stack order.
 * @param pixelsPerValue - the bar's pixels per unit of value.
 * @param minHeight - the pixel floor every non-zero segment keeps.
 * @returns the per-segment pixel heights, or `null` when the scale is unusable.
 */
export function allocateVisualHeights(values: readonly number[], pixelsPerValue: number, minHeight: number): number[] | null {
  if (!Number.isFinite(pixelsPerValue) || pixelsPerValue <= 0) return null
  const rawHeights = values.map(value => Math.max(0, value * pixelsPerValue))
  const nonZero = rawHeights.filter(height => height > 0)
  if (nonZero.length === 0) return null

  const heights = [...rawHeights]
  const minTotal = nonZero.length * minHeight
  const rawTotal = rawHeights.reduce((sum, height) => sum + height, 0)
  // Everything is tiny: promote each non-zero segment to the floor and let the
  // bar clip what no longer fits.
  if (rawTotal < minTotal) return heights.map(height => (height > 0 ? minHeight : 0))

  let deficit = 0
  let donorExcess = 0
  for (const height of heights) {
    if (height > 0 && height < minHeight) deficit += minHeight - height
    if (height > minHeight) donorExcess += height - minHeight
  }
  if (deficit <= 0 || donorExcess <= 0) return heights

  // Shrink the tall segments proportionally to their spare height so the total
  // stays exactly where it was.
  return heights.map((height) => {
    if (height <= 0) return 0
    if (height < minHeight) return minHeight
    return height - (deficit * (height - minHeight)) / donorExcess
  })
}

/** Position of one stacked segment inside its bar. `segmentY`/`segmentHeight`
 *  describe the bar's own box and `stackStart` the value already stacked below
/**
 * it, so the caller can pass the geometry it measured.
 * @returns the segment's box, or `null` when the segment has nothing to draw.
 * @param options - the stack values and the measured bar geometry for this segment.
 */
export function getStackedSegmentVisualLayout(options: {
  readonly values: readonly number[]
  readonly segmentIndex: number
  readonly segmentHeight: number
  readonly segmentY: number
  readonly stackStart: number
  readonly minHeight?: number
}): StackedSegmentVisualLayout | null {
  const { values, segmentIndex, segmentHeight, segmentY, stackStart, minHeight = 5 } = options
  const safeValues = values.map(value => (Number.isFinite(value) && value > 0 ? value : 0))
  const segmentValue = safeValues[segmentIndex] ?? 0
  if (segmentValue <= 0 || segmentHeight <= 0 || segmentIndex < 0) return null

  const pixelsPerValue = segmentHeight / segmentValue
  const heights = allocateVisualHeights(safeValues, pixelsPerValue, minHeight)
  if (heights === null) return null

  const baseline = segmentY + segmentHeight + Math.max(0, stackStart) * pixelsPerValue
  const offsetBelow = heights.slice(0, segmentIndex).reduce((sum, height) => sum + height, 0)
  const height = heights[segmentIndex] ?? 0
  const topIndex = safeValues.reduce((result, value, index) => (value > 0 ? index : result), -1)

  return { height, isTop: segmentIndex === topIndex, y: baseline - offsetBelow - height }
}
