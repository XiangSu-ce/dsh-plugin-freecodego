/**
 * Cross-turn verbatim dedup — TypeScript port of Headroom's
 * `headroom/transforms/cross_turn_dedup.py`, © Headroom Maintainers,
 * Apache-2.0.
 *
 * Later tool outputs that repeat a >= 3-line, >= 40-char verbatim run from an
 * earlier output collapse into a single compact pointer line. The referenced
 * text physically exists in the earlier (still uncompressed) output, so the
 * pointer needs no `hash=` retrieval token — recovery happens in-context.
 *
 * Only byte-identical runs are folded (the line-number-shift `+d` variant of
 * the original is not ported); earlier outputs that were themselves compressed
 * are not indexed, since their lines no longer appear verbatim in context.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/cross-turn-dedup
 */

const MIN_LINES = 3
const MAX_LINES_PER_OUTPUT = 2_000
const ANCHOR_MAX = 20
const ANCHOR_KEEP = 17

/** Trivial lines cannot anchor a pointer (model reconstruction aid). */
function isTrivial(line: string): boolean {
  const t = line.trim()
  if (t.length < 4) return true
  return /^(return|pass|else:|try:|except:|finally:|break|continue|\}\);|\}\)|\]|\)|"""|'''|\.\.\.)$/.test(t)
}

interface Anchor {
  readonly turn: number
  readonly anchor: string
}

export interface DedupResult {
  readonly output: string
  readonly applied: boolean
}

export class CrossTurnDedup {
  /** 3-line-gram -> anchor of the earliest output containing it. */
  private readonly grams = new Map<string, Anchor>()
  private turn = 0

  /**
   * Fold verbatim runs of `text` against remembered earlier outputs. Runs are
   * scanned greedily from the top; non-overlapping matches only.
   *
   * `applied` means the fold is an *improvement*, not merely that a run matched:
   * a pointer costs ~60 bytes no matter how short the run it replaces, so folding
   * three five-character lines would grow the text. Both callers read `applied`
   * as "use this instead", so the size check belongs here rather than in each of
   * them.
   */
  fold(text: string): DedupResult {
    const lines = text.split('\n')
    if (lines.length < MIN_LINES) return { output: text, applied: false }
    const out: string[] = []
    let i = 0
    let applied = false
    while (i < lines.length) {
      const hit = this.grams.get(lines.slice(i, i + MIN_LINES).join('\n'))
      if (hit !== undefined && !lines.slice(i, i + MIN_LINES).some(isTrivial)) {
        // Extend the match forward while consecutive grams originate from the
        // same earlier turn — one pointer for the whole repeated run.
        let end = i + MIN_LINES
        while (end + MIN_LINES <= lines.length) {
          const next = this.grams.get(lines.slice(end, end + MIN_LINES).join('\n'))
          if (next === undefined || next.turn !== hit.turn) break
          end += 1
        }
        const span = lines.slice(i, end)
        const anchorLine = span.find(l => l.trim().length > 0) ?? span[0]
        if (anchorLine === undefined) {
          out.push(lines[i]!)
          i += 1
          continue
        }
        const trimmed = anchorLine.trim()
        const anchor = trimmed.length > ANCHOR_MAX ? `${trimmed.slice(0, ANCHOR_KEEP)}...` : trimmed
        out.push(`[↑${end - i}L same as earlier tool result: '${anchor}']`)
        applied = true
        i = end
        continue
      }
      out.push(lines[i]!)
      i += 1
    }
    if (!applied) return { output: text, applied: false }
    const folded = out.join('\n')
    return folded.length < text.length ? { output: folded, applied: true } : { output: text, applied: false }
  }

  /**
   * Index an output that stays verbatim in context (never compressed). Only
   * the first 3-line-gram occurrence position is stored — keep-earliest.
   */
  remember(text: string): void {
    this.turn += 1
    const lines = text.split('\n').slice(0, MAX_LINES_PER_OUTPUT)
    const seen = new Set<string>()
    for (let i = 0; i + MIN_LINES <= lines.length; i += 1) {
      const gram = lines.slice(i, i + MIN_LINES)
      if (gram.some(isTrivial)) continue
      const key = gram.join('\n')
      if (seen.has(key) || this.grams.has(key)) continue
      seen.add(key)
      const anchor = gram.find(l => l.trim().length > 0) ?? gram[0]
      if (anchor === undefined) continue
      this.grams.set(key, { turn: this.turn, anchor: anchor.trim() })
    }
    if (this.grams.size > 12_000) {
      // Bounded memory: evict the oldest quarter by turn number instead of
      // clearing everything — a full clear would silently drop all dedup
      // coverage for the next outputs, and Map iteration is insertion-ordered
      // so the oldest grams (small turn numbers) come first.
      const limit = this.grams.size - 9_000
      let evicted = 0
      for (const key of this.grams.keys()) {
        if (evicted >= limit) break
        this.grams.delete(key)
        evicted += 1
      }
    }
  }
}
