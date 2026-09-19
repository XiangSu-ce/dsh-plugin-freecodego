/**
 * Adaptive compression sizing via information saturation detection.
 *
 * TypeScript port of Headroom's `adaptive_sizer` (both the Python original and
 * the Rust `crates/headroom-core/src/transforms/adaptive_sizer.rs`).
 *
 * Copyright (c) Headroom Maintainers, Apache-2.0 — algorithm reimplemented in
 * TypeScript for the FreeCodeGo Harness plugin; see NOTICE in the Headroom
 * panel of the settings UI.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/adaptive-sizer
 */

import { deflateRawSync } from 'node:zlib'

/** True for CJK ideographs, kana, and Hangul (code-point ranges kept identical to the Rust port). */
function isCjkChar(c: string): boolean {
  const code = c.codePointAt(0) ?? 0
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
}

/** 32-bit finalizer (splitmix-style avalanche). */
function mix32(z: number): number {
  let v = z | 0
  v = Math.imul(v ^ (v >>> 16), 0x21f0_aaad)
  v = Math.imul(v ^ (v >>> 15), 0x735a_2d97)
  return (v ^ (v >>> 15)) | 0
}

/**
 * 64-bit SimHash fingerprint split into two 32-bit halves.
 *
 * Per-gram hashing uses a char-code mixing function instead of the original's
 * MD5: simhash feeds only in-process dedup/clustering decisions, so it needs
 * distribution quality rather than a specific digest. MD5's per-gram Hash
 * object dominated the port's latency (~1µs × one call per character 4-gram);
 * the mixing function is two imuls per gram.
 */
export interface Simhash { readonly hi: number; readonly lo: number }

/** 32-bit population count (bit-parallel SWAR). */
function popcount32(x: number): number {
  let v = x | 0
  v = v - ((v >>> 1) & 0x5555_5555)
  v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333)
  v = (v + (v >>> 4)) & 0x0f0f_0f0f
  return (Math.imul(v, 0x0101_0101) >>> 24)
}

/** 64-bit SimHash fingerprint of a text string: each char 4-gram hashed and bit-voted. */
export function simhash(text: string): Simhash {
  const lower = text.toLowerCase()
  const n = lower.length
  const iterCount = n <= 3 ? 1 : n - 3
  // votes[0..31] track bit j of the low word; votes[32..63] bit (j-32) of the high word.
  const votes = new Array<number>(64).fill(0)
  for (let i = 0; i < iterCount; i += 1) {
    // Pack up to 4 UTF-16 chars of the gram into two 32-bit words, then avalanche.
    let hi = 0
    let lo = 0
    for (let k = 0; k < 4; k += 1) {
      const c = i + k < n ? lower.charCodeAt(i + k) : 0
      if (k < 2) hi = ((hi << 16) >>> 0) + c
      else lo = ((lo << 16) >>> 0) + c
    }
    hi = mix32(hi)
    lo = mix32(lo ^ hi)
    for (let j = 0; j < 32; j += 1) votes[j]! += ((lo >>> j) & 1) === 1 ? 1 : -1
    for (let j = 0; j < 32; j += 1) votes[32 + j]! += ((hi >>> j) & 1) === 1 ? 1 : -1
  }
  let fpHi = 0
  let fpLo = 0
  for (let j = 0; j < 32; j += 1) {
    if (votes[j]! > 0) fpLo |= (1 << j)
    if (votes[32 + j]! > 0) fpHi |= (1 << j)
  }
  return { hi: fpHi, lo: fpLo }
}

/** Hamming distance between two 64-bit SimHash fingerprints. */
export function hammingDistance(a: Simhash, b: Simhash): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo)
}

/** Count distinct content groups via SimHash + greedy clustering. */
export function countUniqueSimhash(items: readonly string[], threshold: number): number {
  if (items.length === 0) return 0
  // The greedy clustering pass is O(n × clusters) and degenerates to O(n²) on
  // diverse inputs. For large sets an evenly-spaced sample keeps the pass
  // bounded while preserving the diversity-ratio estimate the caller needs;
  // exact clustering stays for small sets where the ≤3-uniqueness check
  // decides directly.
  const CLUSTER_SAMPLE_CAP = 256
  const sampled = items.length <= CLUSTER_SAMPLE_CAP
    ? items
    : Array.from({ length: CLUSTER_SAMPLE_CAP }, (_, i) => items[Math.floor(i * items.length / CLUSTER_SAMPLE_CAP)]!)
  const fingerprints = sampled.map(simhash)
  const clusters: Simhash[] = []
  for (const fp of fingerprints) {
    if (!clusters.some(rep => hammingDistance(fp, rep) <= threshold)) clusters.push(fp)
  }
  if (sampled === items) return clusters.length
  // Scale the sample's distinct-count estimate back to the population.
  return Math.round(clusters.length * items.length / CLUSTER_SAMPLE_CAP)
}

/** Cumulative unique word-bigram coverage curve; CJK items use char bigrams. */
export function computeUniqueBigramCurve(items: readonly string[]): readonly number[] {
  const seen = new Set<string>()
  const curve: number[] = []
  for (const item of items) {
    const words = item.toLowerCase().split(/\s+/u).filter(Boolean)
    if (words.length >= 2) {
      for (let j = 0; j < words.length - 1; j += 1) seen.add(`${words[j]!}\u0000${words[j + 1]!}`)
    } else if (words.length === 1) {
      const chars = Array.from(words[0]!)
      if (chars.length >= 2 && chars.some(isCjkChar)) {
        for (let j = 0; j < chars.length - 1; j += 1) seen.add(`${chars[j]!}\u0000${chars[j + 1]!}`)
      } else {
        seen.add(`${words[0]!}\u0000`)
      }
    } else {
      seen.add('\u0000')
    }
    curve.push(seen.size)
  }
  return curve
}

/** Find the knee in a monotonically-increasing curve (Kneedle). Returns a 1-based keep count. */
export function findKnee(curve: readonly number[]): number | undefined {
  const n = curve.length
  if (n < 3) return undefined
  const yMin = curve[0]!
  const yMax = curve[n - 1]!
  if (Math.abs(yMax - yMin) < Number.EPSILON) return 1
  const xRange = n - 1
  const yRange = yMax - yMin
  let maxDiff = -1
  let kneeIdx: number | undefined
  for (let i = 0; i < n; i += 1) {
    const diff = (curve[i]! - yMin) / yRange - i / xRange
    if (diff > maxDiff) {
      maxDiff = diff
      kneeIdx = i
    }
  }
  if (maxDiff < 0.05) return undefined
  return kneeIdx! + 1
}

function zlibCompressedLen(text: string): number {
  return deflateRawSync(Buffer.from(text, 'utf8'), { level: 1 }).length
}

/** zlib-ratio sanity check: if the kept subset compresses far better than the full set, bump k by 20%. */
export function validateWithZlib(items: readonly string[], k: number, maxK: number, tolerance = 0.15): number {
  if (k >= items.length || k >= maxK) return k
  const fullText = items.join('\n')
  const subsetText = items.slice(0, k).join('\n')
  if (Buffer.byteLength(fullText, 'utf8') < 200) return k
  const fullRatio = zlibCompressedLen(fullText) / Buffer.byteLength(fullText, 'utf8')
  const subsetRatio = zlibCompressedLen(subsetText) / Buffer.byteLength(subsetText, 'utf8')
  if (Math.abs(fullRatio - subsetRatio) > tolerance) {
    return Math.min(Math.floor(k * 1.2), maxK)
  }
  return k
}

/**
 * Compute the optimal number of items to keep via information saturation.
 * @param items - string representations in importance order.
 * @param bias - multiplier on the knee point (>1 keeps more).
 * @param minK - lower bound on the return value.
 * @param maxK - upper bound; omitted means "up to items.length".
 */
export function computeOptimalK(items: readonly string[], bias: number, minK: number, maxK?: number): number {
  const n = items.length
  const effectiveMax = maxK ?? n
  if (n <= 8) return n
  const uniqueCount = countUniqueSimhash(items, 3)
  if (uniqueCount <= 3) return Math.min(Math.max(minK, uniqueCount), effectiveMax)
  const curve = computeUniqueBigramCurve(items)
  const diversityRatio = uniqueCount / n
  let knee = findKnee(curve)
  if (knee === undefined) {
    knee = Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio)))
  } else if (diversityRatio > 0.7) {
    knee = Math.max(knee, Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio))))
  }
  let k = Math.max(minK, Math.floor(knee * bias))
  k = Math.min(k, effectiveMax)
  k = validateWithZlib(items, k, effectiveMax)
  return Math.max(minK, Math.min(k, effectiveMax))
}
