/**
 * The plugin's only token-estimation entry point.
 *
 * The host owns the fixed-density heuristic in
 * `@deepseek-ai/dsh-token-meter/src/estimate.ts`, and its module header states that
 * both the meter service and the pure context-breakdown projection must price
 * identical content to identical numbers. The plugin's prompt-composition
 * surface also prices content, so it has to share that density — otherwise the
 * same prompt reports one number in `engineering_surface_report` and a
 * different one in the harness's own context breakdown.
 *
 * Every other site in the plugin that needs "roughly how many tokens is this
 * text" imports from here — `action-review`, `cache-cold`,
 * `claude-protocol-bridge`, `deferred-tools`, `engineering-memory`,
 * `engineering-repo-map`, `headroom/smart-crusher` and `prompt-composition` all
 * priced text locally before this module existed, at four slightly different
 * rules. `tests/token-estimate.spec.ts` enforces that no
 * other source file divides a character count by four again.
 *
 * Two functions, because the plugin has two kinds of caller:
 *
 * - {@link tokensFromChars} for the plain "so many characters of text" callers.
 *   They have no block structure to price, so applying the host's
 *   `estimateContent` would add `BLOCK_OVERHEAD` that the input never had and
 *   silently inflate every displayed number.
 * - {@link estimateContent} for callers that really do hold content blocks.
 *
 * The `4` below is deliberately local rather than imported: the host does not
 * export `CHARS_PER_TOKEN`, and the plan rules out adding an export. Instead
 * `tests/token-estimate.spec.ts` pins the invariant that actually matters —
 * that this function and the host heuristic agree on the same text — so a
 * density change upstream fails a test here rather than drifting unnoticed.
 *
 * @module freecodego/token-estimate
 */

/*
 * Reached through the package's public `./estimate` export. The root specifier
 * is deliberately avoided: it does not re-export `estimateContent`, and the
 * density constant this file depends on lives beside the heuristic rather than
 * behind the meter service.
 *
 * `./estimate` rather than the token-meter package's own `src/estimate.ts`: the
 * `./src/*` export is a development-only alias for internal imports inside that
 * package, and its published `files` list ships `lib/**` alone. A bundle that
 * imports through `./src/*` loads in this workspace and fails in every packaged
 * runtime -- the Desktop application rejected the whole bundle for exactly that
 * specifier, which took every row it mounts down with it. `./estimate` maps to the
 * same heuristic under `lib/types/estimate.js`, which is what the published
 * package actually carries.
 */
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

/** Characters per token under the host's fixed-density heuristic. */
const CHARS_PER_TOKEN = 4

/**
 * Price a plain character count at the host's density.
 * @param chars - number of characters to price.
 * @returns the estimate in tokens; 0 for non-positive counts.
 */
export function tokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Price content blocks through the host heuristic (includes block overhead). */
export { estimateContent }
