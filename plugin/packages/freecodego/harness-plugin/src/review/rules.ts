/**
 * Review rules: which standard applies to which file, and where that standard
 * came from.
 *
 * The four layers
 * ---------------
 * A project must be able to say "our Java gets checked for null parameters"
 * without forking a tool, and an individual must be able to say "for this run,
 * also check for SQL injection" without editing the repository. So rules resolve
 * through layers, highest priority first:
 *
 * | Layer | Source |
 * | --- | --- |
 * | `custom` | an explicit rule file passed for this run |
 * | `project` | the repository's own rule file |
 * | `global` | the machine's user-level rule file |
 * | `system` | the standards shipped with this plugin |
 *
 * **The first matching layer wins, not the first matching pattern across all
 * layers.** That is OCR's rule and it is the one that makes a project override
 * work: a user-level `**\/*.ts` rule must not be silently merged into every
 * TypeScript file of a repository that has already decided what it wants.
 *
 * **A user rule replaces the shipped rule for that file unless it opts in.**
 * `mergeSystemRule` on an entry includes the shipped standard *as well*, which is
 * what a project wants when it is adding a check rather than replacing the
 * baseline. Without the opt-in, a project that adds one rule would lose every
 * baseline check and never be told.
 *
 * Provenance is carried on the answer, not recomputed
 * --------------------------------------------------
 * Every resolved rule reports its `source` and matched `pattern`, and grouping
 * keys on all three. Two files with identical rule *text* from different layers
 * stay in different groups so a group's reported provenance is true for every
 * file in it; merging them would make the group's `source` a half-truth.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/rules
 */

import { matchAnyGlob, matchesGlob } from './glob.ts'

/** Where a rule was resolved from, highest priority first. */
export type ReviewRuleSource = 'custom' | 'project' | 'global' | 'system'

/** Layer order, which is also priority order. */
export const REVIEW_RULE_LAYER_ORDER: readonly ReviewRuleSource[] = ['custom', 'project', 'global', 'system']

/** One path-pattern rule from one layer. */
export interface ReviewRuleEntry {
  /** The glob this entry applies to. */
  readonly path: string
  /** The standard to apply. */
  readonly rule: string
  /** Whether the shipped standard for this file is included as well. */
  readonly mergeSystemRule: boolean
}

/** One layer's rules, plus the standard for files no pattern matches. */
export interface ReviewRuleLayer {
  readonly source: ReviewRuleSource
  /** Rule text for files matching no entry in this layer. */
  readonly defaultRule?: string
  readonly entries: readonly ReviewRuleEntry[]
  /** Path patterns that remove files from review entirely, relative to this layer. */
  readonly exclude?: readonly string[]
}

/** Where one file's standard came from. */
export interface ResolvedReviewRule {
  readonly source: ReviewRuleSource
  /** The matched pattern, or `default` when the layer's fallback applied. */
  readonly pattern: string
  readonly rule: string
  /** The shipped standard included by a `mergeSystemRule` opt-in, when any. */
  readonly mergedRule?: string
}

/** Files sharing one resolved rule, which a reviewer is handed together. */
export interface ReviewRuleGroup {
  readonly id: number
  readonly source: ReviewRuleSource
  readonly pattern: string
  readonly rule: string
  /** Repository-relative paths in this group, in the order they were supplied. */
  readonly files: readonly string[]
}

/** The resolver a review engine asks about one file. */
export interface ReviewRuleResolver {
  /** Resolve one repository-relative path. */
  resolve(path: string): ResolvedReviewRule
  /** Whether any layer excludes this path from review. */
  isExcluded(path: string): boolean
  /** The layer that excluded the path, for a report's exclusion reason. */
  excludeSource(path: string): ReviewRuleSource | undefined
}

/**
 * Build a resolver over ordered layers.
 *
 * Layers are sorted by {@link REVIEW_RULE_LAYER_ORDER} rather than trusted in
 * caller order, because a caller that passes `global` before `project` would
 * invert the documented priority silently — the sort is what makes priority a
 * property of the layer name instead of of argument arrangement.
 */
export function createReviewRuleResolver(layers: readonly ReviewRuleLayer[]): ReviewRuleResolver {
  const ordered = [...layers].sort(
    (left, right) => REVIEW_RULE_LAYER_ORDER.indexOf(left.source) - REVIEW_RULE_LAYER_ORDER.indexOf(right.source),
  )
  const systemLayer = ordered.find(layer => layer.source === 'system')

  const systemAnswer = (path: string): ResolvedReviewRule | undefined => {
    if (systemLayer === undefined) return undefined
    const entry = systemLayer.entries.find(candidate => matchesGlob(candidate.path, path))
    if (entry !== undefined) return { source: 'system', pattern: entry.path, rule: entry.rule }
    if (systemLayer.defaultRule !== undefined && systemLayer.defaultRule.trim() !== '') {
      return { source: 'system', pattern: 'default', rule: systemLayer.defaultRule }
    }
    return undefined
  }

  const excludeSource = (path: string): ReviewRuleSource | undefined => {
    for (const layer of ordered) {
      if (layer.exclude === undefined) continue
      if (matchAnyGlob(layer.exclude, path)) return layer.source
    }
    return undefined
  }

  return {
    isExcluded(path: string): boolean {
      return excludeSource(path) !== undefined
    },
    excludeSource,
    resolve(path: string): ResolvedReviewRule {
      for (const layer of ordered) {
        const entry = layer.entries.find(candidate => matchesGlob(candidate.path, path))
        if (entry === undefined) continue
        const answer: ResolvedReviewRule = { source: layer.source, pattern: entry.path, rule: entry.rule }
        if (!entry.mergeSystemRule || layer.source === 'system') return answer
        const system = systemAnswer(path)
        if (system === undefined || system.rule === entry.rule) return answer
        return { ...answer, mergedRule: system.rule }
      }
      return systemAnswer(path) ?? { source: 'system', pattern: 'default', rule: '' }
    },
  }
}

/**
 * Group paths by their resolved rule.
 *
 * The key is `source\0pattern\0rule`, so the group's reported provenance is true
 * for every file in it. Group ids are 1-based, matching what a report prints.
 */
export function groupByRule(resolver: ReviewRuleResolver, paths: readonly string[]): ReviewRuleGroup[] {
  const index = new Map<string, number>()
  // Built mutable and returned readonly: a group's file list is assembled one
  // path at a time here, and copying it once at the end would be the same work
  // done twice for a type annotation's benefit.
  const groups: { id: number; source: ReviewRuleSource; pattern: string; rule: string; files: string[] }[] = []
  for (const path of paths) {
    const resolved = resolver.resolve(path)
    const effective = resolved.mergedRule === undefined ? resolved.rule : `${resolved.rule}\n${resolved.mergedRule}`
    const key = `${resolved.source}\u0000${resolved.pattern}\u0000${effective}`
    let position = index.get(key)
    if (position === undefined) {
      position = groups.length
      index.set(key, position)
      groups.push({
        id: position + 1,
        source: resolved.source,
        pattern: resolved.pattern,
        rule: effective,
        files: [],
      })
    }
    groups[position]?.files.push(path)
  }
  return groups
}

/** The shipped standard, applied to files no other layer describes. */
export const SYSTEM_REVIEW_RULE = `Review the change, not the file. Report a problem only where the diff introduces it or makes it reachable.
Judge behaviour from the code, not from names, comments, or the author's stated intent.
Check, in this order: correctness and edge cases; security and trust boundaries; resource and concurrency behaviour; error handling and failure paths; then interface, naming, and consistency with the surrounding code.
Prefer one precise finding with evidence over several speculative ones. If the context is missing, read it rather than assuming it.
Do not report style the project's formatter already enforces, and do not report deleted code.`

/** Where a project's rules live, checked in this order by the loader. */
export const PROJECT_REVIEW_RULE_PATHS: readonly string[] = [
  '.opencodereview/rule.json',
  '.dsh/review.json',
  '.freecodego/review.json',
]

/** The machine-level rule file, relative to the user's home directory. */
export const GLOBAL_REVIEW_RULE_PATH = '.opencodereview/rule.json'

/** One entry of a rule document, before validation. */
export interface ReviewRuleDocumentEntry {
  readonly path: string
  readonly rule: string
  readonly mergeSystemRule: boolean
}

/** The result of reading a rule document. */
export type ReviewRuleDocumentVerdict =
  | {
    readonly ok: true
    readonly entries: readonly ReviewRuleDocumentEntry[]
    /** Paths this layer removes from review entirely. Empty when the file states none. */
    readonly exclude: readonly string[]
  }
  | { readonly ok: false; readonly reason: string }

/**
 * Read a `.opencodereview/rule.json`-shaped document.
 *
 * Both snake_case (`merge_system_rule`, as the documented format writes it) and
 * camelCase are accepted, because a rule file that is silently ignored over a key
 * spelling is a standard the project believes is being applied and is not.
 *
 * `exclude` is honored: it is how a project says "do not review generated or
 * vendored paths", and a document whose `rules` apply while its `exclude` is
 * dropped is a review that reports findings the project already decided it does
 * not want — while looking, to the person who wrote the file, exactly like a
 * review that honored it. `include` is recognized and deliberately without
 * effect: upstream it only outweighs that project's *extension and path* deny
 * lists, and this pipeline reviews every changed file, so there is nothing for it
 * to outweigh. If this pipeline ever grows such a deny list, this is where to read
 * the field from.
 */
export function parseReviewRuleDocument(text: string): ReviewRuleDocumentVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `rule file is not valid JSON: ${(error as Error).message}` }
  }

  const container = Array.isArray(parsed)
    ? { rules: parsed }
    : (typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined)
  if (container === undefined) return { ok: false, reason: 'rule file must be an object or an array of rule entries' }

  const excludeVerdict = readPatternList(container.exclude, 'exclude')
  if (!excludeVerdict.ok) return excludeVerdict
  const exclude = excludeVerdict.patterns

  const rawRules = container.rules
  if (rawRules === undefined) return { ok: true, entries: [], exclude }
  if (!Array.isArray(rawRules)) return { ok: false, reason: '"rules" must be an array' }

  const entries: ReviewRuleDocumentEntry[] = []
  for (let position = 0; position < rawRules.length; position += 1) {
    const candidate = rawRules[position]
    if (typeof candidate !== 'object' || candidate === null) {
      return { ok: false, reason: `rules[${position}] must be an object` }
    }
    const record = candidate as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    const rule = typeof record.rule === 'string' ? record.rule.trim() : ''
    if (path === '') return { ok: false, reason: `rules[${position}].path is required` }
    if (rule === '') return { ok: false, reason: `rules[${position}].rule is required` }
    entries.push({
      path,
      rule,
      mergeSystemRule: record.merge_system_rule === true || record.mergeSystemRule === true,
    })
  }
  return { ok: true, entries, exclude }
}

/**
 * Read one optional list of glob patterns.
 *
 * A non-array is refused rather than skipped, and so is an entry that is not a
 * string: a project that wrote a bare glob string where a list belongs believes its
 * generated files are not being reviewed, and telling it otherwise is the entire
 * point of validating here.
 */
function readPatternList(
  value: unknown,
  key: string,
): { readonly ok: true; readonly patterns: readonly string[] } | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true, patterns: [] }
  if (!Array.isArray(value)) return { ok: false, reason: `"${key}" must be an array of glob patterns` }
  const patterns: string[] = []
  for (let position = 0; position < value.length; position += 1) {
    const entry = value[position]
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, reason: `${key}[${position}] must be a non-empty glob pattern` }
    }
    patterns.push(entry.trim())
  }
  return { ok: true, patterns }
}
