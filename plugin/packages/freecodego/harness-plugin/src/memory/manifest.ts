/**
 * `MEMORY.md`: a bounded index of absolute pointers.
 *
 * Two decisions make this a module rather than a template string.
 *
 * **Paths are absolute.** A relative pointer has to be resolved against a scope
 * root, and which root that is depends on where the index was found — project,
 * user, or plugin cache. A model reading a relative pointer has to reconstruct
 * that reasoning before it can open anything, and when it reconstructs it wrong
 * it does not report a broken path; it reports having found nothing. An absolute
 * path removes the question.
 *
 * **Overflow drops whole lines and says how many.** Truncating a description
 * would leave the index claiming to describe a record it no longer describes —
 * the reader cannot tell a short summary from a cut-off one. Dropping the line
 * loses the pointer, which is visible, and the count makes it actionable. This is
 * the same discipline the skill map already follows in this plugin.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/manifest
 */

/** The index's file name inside the memory home. */
export const MEMORY_MANIFEST_FILENAME = 'MEMORY.md'

/** Default character budget for the whole index. */
export const DEFAULT_MANIFEST_BUDGET_CHARS = 8_000

/** One record the index points at. */
export interface MemoryManifestEntry {
  /** Record name, which is how a reader refers to it. */
  readonly name: string
  /** Absolute path to the record file. */
  readonly path: string
  /** One-line description; never truncated. */
  readonly description: string
}

/** The rendered index and what had to be left out. */
export interface MemoryManifest {
  readonly markdown: string
  readonly included: number
  readonly omitted: number
  /** True when at least one entry was dropped for budget. */
  readonly truncated: boolean
}

/** The sentence that reports what the budget left out. */
function overflowNotice(omitted: number): string {
  return `\n${omitted} more record${omitted === 1 ? '' : 's'} did not fit this index; the files are still on disk at the paths above, and \`engineering_memory_search\` reaches the rest.\n`
}

/**
 * Render the pointer index under a character budget.
 *
 * The budget covers the *whole* index, the overflow notice included — the notice
 * used to be appended outside it, which broke the promise in the one case the
 * budget exists for. Its own length depends on how many entries were dropped,
 * which is only known after packing, so its worst case is reserved up front: the
 * count can never exceed the number of entries, so the reservation is exact.
 *
 * One budget cannot be met at all: one too small for the header alone. The header
 * is returned there regardless, because an index that says nothing would state
 * that there are no records — a wrong answer instead of a long one.
 * @param entries - the records to point at.
 * @param options - budget and clock.
 * @returns the markdown, plus how many entries were included and omitted.
 */
export function renderMemoryManifest(
  entries: readonly MemoryManifestEntry[],
  options: { readonly budgetChars?: number; readonly now?: number } = {},
): MemoryManifest {
  const budget = options.budgetChars ?? DEFAULT_MANIFEST_BUDGET_CHARS
  const now = options.now ?? Date.now()
  const header = [
    '# Memory index',
    '',
    'Pointers only; the content lives in the files these paths name.',
    `Generated ${new Date(now).toISOString()}.`,
    '',
  ].join('\n')

  const candidates = sortEntries(entries).map(entry => `- ${entry.name} — ${entry.description} — ${entry.path}`)
  const everything = candidates.reduce((total, line) => total + line.length + 1, header.length)
  const reserve = everything <= budget ? 0 : overflowNotice(candidates.length).length
  const packing = budget - reserve

  const lines: string[] = []
  let used = header.length
  let omitted = 0
  for (const line of candidates) {
    if (used + line.length + 1 > packing) {
      omitted += 1
      continue
    }
    lines.push(line)
    used += line.length + 1
  }

  const tail = omitted === 0 ? '' : overflowNotice(omitted)
  return {
    markdown: `${header}${lines.join('\n')}${lines.length === 0 ? '' : '\n'}${tail}`,
    included: lines.length,
    omitted,
    truncated: omitted > 0,
  }
}

/**
 * Order entries deterministically.
 *
 * Stable order is not cosmetic: an index that reshuffles on every write makes
 * every regeneration a diff, which destroys the only cheap signal a reader has
 * that the memory actually changed.
 * @param entries - the entries to order.
 * @returns a new array, sorted by name.
 */
function sortEntries(entries: readonly MemoryManifestEntry[]): readonly MemoryManifestEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name))
}
