/**
 * Structured-config elision — TypeScript port of Headroom's
 * `headroom/transforms/config_compressor.py` (Tiers 1+2; the TOML schema-fold
 * Tier 3 needs a full TOML parser and is not ported), © Headroom Maintainers,
 * Apache-2.0.
 *
 * Tier 1 is the lossless line/block folding from lossless-compaction; Tier 2
 * deletes whole-line comments (and blank lines) with the original stashed in
 * the CCR store. Safety first: YAML block scalars (`key: |`) and TOML
 * multi-line strings make `#` lines potential data, so elision is disabled.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/config-compressor
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'
import { compactLossless } from './lossless-compaction.ts'

const YAML_BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/m
const COMMENT_LINE_RE = /^\s*#/
const INI_COMMENT_LINE_RE = /^[#;]/

export type ConfigFlavor = 'yaml' | 'toml' | 'ini'

export interface ConfigResult {
  readonly output: string
  readonly applied: boolean
}

/** Strip whole-line comments (and blanks; INI keeps blanks — values may continue lines). */
function elideComments(text: string, flavor: ConfigFlavor): { readonly output: string; readonly elided: number } {
  const commentRe = flavor === 'ini' ? INI_COMMENT_LINE_RE : COMMENT_LINE_RE
  const out: string[] = []
  let elided = 0
  for (const line of text.split('\n')) {
    if (commentRe.test(line) || (flavor !== 'ini' && line.trim() === '')) {
      elided += 1
      continue
    }
    out.push(line)
  }
  return { output: out.join('\n'), elided }
}

/** Compress YAML/TOML/INI config text: comment elision + lossless folding. */
export function compressConfig(text: string, flavor: ConfigFlavor, store: CcrStore | undefined): ConfigResult {
  // Tier 1 — reversible repeated-line/block folding (always safe).
  const folded = compactLossless(text, 'config')
  let working = folded.output
  let footer = ''
  // Tier 2 — comment/blank elision, only when `#` cannot be data.
  const elisionSafe = flavor === 'ini' || (flavor === 'yaml' && !YAML_BLOCK_SCALAR_RE.test(text)) || (flavor === 'toml' && !text.includes('"""') && !text.includes("'''"))
  const key = computeKey(text)
  if (elisionSafe) {
    const { output, elided } = elideComments(working, flavor)
    if (elided > 0) {
      footer = `\n[${elided} comment/blank lines elided. Retrieve original: hash=${key}]`
      working = output
    }
  }
  const candidate = `${working}${footer}`
  if (Buffer.byteLength(candidate, 'utf8') >= Buffer.byteLength(text, 'utf8')) {
    return folded.applied ? { output: folded.output, applied: true } : { output: text, applied: false }
  }
  // Stashed only when the accepted rendering names the hash, which is the
  // elision path: it is the one that writes `hash=${key}` into `footer`. The
  // fold-only path accepts with no marker at all, so stashing there holds an
  // original under a hash nothing points at, and the store's capacity is
  // shared -- enough of those evict an original another result's live `hash=`
  // marker still points at, which is the outcome `CcrStore.put` documents as
  // unacceptable (`reclaimedTokens` aside, the model loses a retrieval it was
  // told it had). Stashing before the size test above is wrong for the same
  // reason: a declined call returns text carrying no marker either.
  if (footer !== '' && store !== undefined) store.put(key, text)
  return { output: candidate, applied: true }
}
