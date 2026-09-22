/**
 * Grouping: which changed files should be read together.
 *
 * Why grouping exists at all
 * -------------------------
 * A reviewer handed forty unrelated files reviews the first three well and the
 * rest superficially. Grouping by semantic relatedness — a module and its test, a
 * producer and its consumer, two i18n variants — is what lets a reviewer hold the
 * whole contract of a change in one context. It is also what makes a cross-file
 * finding possible at all: "the interface gained a parameter and no caller was
 * updated" cannot be seen by a reviewer looking at one file.
 *
 * The model proposes; validation decides
 * --------------------------------------
 * The grouping prompt's own rules (every index exactly once, at most N per
 * group) are checked here rather than trusted, and a proposal that fails any of
 * them is **rejected wholesale** in favour of the deterministic grouping below.
 * Repairing a bad proposal would be worse than replacing it: a group that lost a
 * file to a dropped index is a file the run then reports as unreviewed, and the
 * reason would be a bug in the parser rather than a fact about the change.
 *
 * The fallback is deliberately dull — same rule group, then same directory — and
 * it is labelled `fallback` in the result, because a run whose grouping degraded
 * must not present itself as having grouped semantically.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/grouping
 */

import { extractJsonValue, type ReviewModelPort } from './model.ts'
import { REVIEW_GROUPING_SYSTEM, REVIEW_MAX_GROUP_FILES } from './prompts.ts'
import type { ReviewRuleGroup } from './rules.ts'
import type { ReviewableFile } from './targets.ts'

/** One batch of files a reviewer reads in one context. */
export interface ReviewGroup {
  /** 1-based, matching how a report names groups. */
  readonly id: number
  readonly files: readonly ReviewableFile[]
  /** Rule-group ids every file shares; more than one means the batch mixes rules. */
  readonly ruleGroupIds: readonly number[]
  /** Total changed lines, which the plan threshold is measured against. */
  readonly changedLines: number
}

/** How a grouping was produced. */
export type GroupingSource = 'model' | 'fallback'

/** A grouping outcome. */
export interface GroupedChanges {
  readonly groups: readonly ReviewGroup[]
  readonly source: GroupingSource
  /** Present when the model's proposal was rejected, naming why. */
  readonly note?: string
}

/** The verdict on a model's grouping proposal. */
export type GroupingVerdict =
  | { readonly ok: true; readonly indices: readonly (readonly number[])[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate a grouping proposal.
 *
 * `indices` must be arrays of zero-based file indices. Every index in
 * `[0, fileCount)` must appear exactly once across all groups; a group may hold
 * at most `maxGroupSize`; an empty group is refused because it produces a
 * reviewer with nothing to read.
 */
export function validateGrouping(
  raw: unknown,
  fileCount: number,
  maxGroupSize: number = REVIEW_MAX_GROUP_FILES,
): GroupingVerdict {
  if (!Array.isArray(raw)) return { ok: false, reason: 'the proposal is not an array' }

  const groups: number[][] = []
  const seen = new Set<number>()
  for (let position = 0; position < raw.length; position += 1) {
    const entry = raw[position]
    const files = Array.isArray(entry)
      ? entry
      : (typeof entry === 'object' && entry !== null && Array.isArray((entry as { files?: unknown }).files)
          ? (entry as { files: unknown[] }).files
          : undefined)
    if (files === undefined) return { ok: false, reason: `group ${position} has no "files" array` }
    if (files.length === 0) return { ok: false, reason: `group ${position} is empty` }
    if (files.length > maxGroupSize) {
      return { ok: false, reason: `group ${position} holds ${files.length} files, above the ${maxGroupSize} ceiling` }
    }
    const indices: number[] = []
    for (const value of files) {
      const index = typeof value === 'number' ? value : Number(value)
      if (!Number.isInteger(index) || index < 0 || index >= fileCount) {
        return { ok: false, reason: `group ${position} references file index ${String(value)}, which is not in [0, ${fileCount})` }
      }
      if (seen.has(index)) return { ok: false, reason: `file index ${index} appears in more than one group` }
      seen.add(index)
      indices.push(index)
    }
    groups.push(indices)
  }

  if (seen.size !== fileCount) {
    const missing = [...Array(fileCount).keys()].filter(index => !seen.has(index))
    return { ok: false, reason: `the proposal omits file index(es) ${missing.join(', ')}` }
  }
  return { ok: true, indices: groups }
}

/** Group a list of files deterministically, by rule group then directory. */
export function fallbackGrouping(
  files: readonly ReviewableFile[],
  ruleGroups: readonly ReviewRuleGroup[],
  maxGroupSize: number = REVIEW_MAX_GROUP_FILES,
): ReviewGroup[] {
  const ruleOf = new Map<string, number>()
  for (const group of ruleGroups) {
    for (const path of group.files) ruleOf.set(path, group.id)
  }

  const buckets = new Map<string, ReviewableFile[]>()
  const order: string[] = []
  for (const file of files) {
    const ruleId = ruleOf.get(file.path) ?? 0
    const key = `${ruleId}\u0000${directoryOf(file.path)}`
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    ;(buckets.get(key) as ReviewableFile[]).push(file)
  }

  const out: ReviewGroup[] = []
  for (const key of order) {
    const bucket = buckets.get(key) as ReviewableFile[]
    for (let start = 0; start < bucket.length; start += maxGroupSize) {
      out.push(buildGroup(out.length + 1, bucket.slice(start, start + maxGroupSize), ruleOf))
    }
  }
  return out
}

/**
 * Ask the model to group the change set, falling back deterministically.
 *
 * A model failure (a rejection, unparseable output, or an invalid proposal) is
 * never fatal: the review continues with the dull grouping and the result says
 * so, because a review that refuses to run because grouping failed is strictly
 * worse than an ordinarily-grouped one.
 */
export async function groupChanges(
  model: ReviewModelPort,
  files: readonly ReviewableFile[],
  ruleGroups: readonly ReviewRuleGroup[],
  options: { readonly signal?: AbortSignal; readonly maxGroupSize?: number } = {},
): Promise<{ readonly grouped: GroupedChanges; readonly spent: { inputTokens: number; outputTokens: number } }> {
  const maxGroupSize = options.maxGroupSize ?? REVIEW_MAX_GROUP_FILES
  const fallback = fallbackGrouping(files, ruleGroups, maxGroupSize)
  if (files.length <= 1) {
    return { grouped: { groups: fallback, source: 'fallback' }, spent: { inputTokens: 0, outputTokens: 0 } }
  }

  try {
    const result = await model.generate({
      system: REVIEW_GROUPING_SYSTEM.replace('{{max_group_size}}', String(maxGroupSize)),
      user: renderGroupingUser(files),
      maxOutputTokens: 2_048,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const verdict = validateGrouping(extractJsonValue(result.text), files.length, maxGroupSize)
    if (!verdict.ok) {
      return {
        grouped: { groups: fallback, source: 'fallback', note: `grouping proposal rejected: ${verdict.reason}` },
        spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      }
    }
    const ruleOf = new Map<string, number>()
    for (const group of ruleGroups) {
      for (const path of group.files) ruleOf.set(path, group.id)
    }
    return {
      grouped: {
        groups: verdict.indices.map((indices, position) =>
          buildGroup(position + 1, indices.map(index => files[index] as ReviewableFile), ruleOf)),
        source: 'model',
      },
      spent: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    }
  } catch (error) {
    return {
      grouped: {
        groups: fallback,
        source: 'fallback',
        note: `grouping call failed, using the deterministic grouping: ${(error as Error).message}`,
      },
      spent: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

/** Build one group with its shared rule ids and changed-line total. */
function buildGroup(id: number, files: readonly ReviewableFile[], ruleOf: ReadonlyMap<string, number>): ReviewGroup {
  const ruleIds = new Set<number>()
  let changedLines = 0
  for (const file of files) {
    const ruleId = ruleOf.get(file.path)
    if (ruleId !== undefined) ruleIds.add(ruleId)
    changedLines += file.added + file.deleted
  }
  return { id, files, ruleGroupIds: [...ruleIds].sort((a, b) => a - b), changedLines }
}

/** The user message listing the change set for the grouping call. */
function renderGroupingUser(files: readonly ReviewableFile[]): string {
  const lines = files.map((file, index) => {
    const delta = `(+${file.added}/-${file.deleted})`
    const status = file.untracked ? 'UNTRACKED' : file.status.toUpperCase()
    return `[${index}] ${status.padEnd(9)} ${file.path} ${delta}`
  })
  return `Group these changed files:\n\n${lines.join('\n')}`
}

/** The directory part of a path, or `.` for a file at the repository root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}
