/**
 * Finding the rule files a review resolves against.
 *
 * Why discovery is a module
 * ------------------------
 * The layers are read from four places that a *repository* can write: a file
 * passed for this run, one of several project files, and the user's own file.
 * Two properties therefore have to be true and neither is free:
 *
 * - **An unreadable or malformed file is reported, never ignored.** A project
 *   that believes its review standard is being applied, while the file has a
 *   trailing comma, is worse off than one that never wrote a rule file: the rules
 *   it thinks are enforced are silently absent. Each malformed file produces a
 *   warning that names it.
 * - **Only the first project file counts.** Several documented locations are
 *   tried in order, and the first that exists becomes *the* project layer. Merging
 *   two would make the effective standard a document nobody wrote and nobody can
 *   predict from either file.
 *
 * The user-level file is read from the home directory, so it is the one layer a
 * repository cannot author — which is what makes it the layer a user can trust to
 * mean what it says.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/config
 */

import {
  GLOBAL_REVIEW_RULE_PATH,
  PROJECT_REVIEW_RULE_PATHS,
  SYSTEM_REVIEW_RULE,
  parseReviewRuleDocument,
  type ReviewRuleLayer,
  type ReviewRuleResolver,
} from './rules.ts'
import { createReviewRuleResolver } from './rules.ts'

/** How this module reads a file it did not open itself. */
export type ReviewRuleFileReader = (path: string) => Promise<string | undefined>

/** What a load found. */
export interface LoadedReviewRules {
  readonly resolver: ReviewRuleResolver
  readonly layers: readonly ReviewRuleLayer[]
  /** One entry per file that existed but could not be used, naming the file and why. */
  readonly warnings: readonly string[]
  /** The rule file paths that were actually read, for a report or a UI. */
  readonly sources: readonly string[]
}

/** Inputs to rule loading. */
export interface LoadReviewRulesInput {
  readonly workspace: string
  readonly home?: string
  /** An explicit rule file for this run; highest priority when it exists. */
  readonly customPath?: string
  /** The excluded patterns from the caller, which form their own layer. */
  readonly exclude?: readonly string[]
  readonly readFile: ReviewRuleFileReader
  readonly joinPath: (left: string, right: string) => string
}

/**
 * Load every rule layer that exists.
 *
 * The system layer is always present, so a resolver built here can always answer
 * — `resolve` never has to return an empty rule for a file nobody wrote about.
 */
export async function loadReviewRules(input: LoadReviewRulesInput): Promise<LoadedReviewRules> {
  const warnings: string[] = []
  const sources: string[] = []

  const custom = input.customPath === undefined
    ? undefined
    : await readLayer(input, input.customPath, 'custom', warnings, sources)
  const project = await firstProjectLayer(input, warnings, sources)
  const global = input.home === undefined
    ? undefined
    : await readLayer(input, input.joinPath(input.home, GLOBAL_REVIEW_RULE_PATH), 'global', warnings, sources)

  const layers: ReviewRuleLayer[] = []
  if (custom !== undefined) layers.push(custom)
  if (project !== undefined) layers.push(project)
  if (global !== undefined) layers.push(global)
  layers.push({
    source: 'system',
    defaultRule: SYSTEM_REVIEW_RULE,
    entries: [],
    ...(input.exclude === undefined || input.exclude.length === 0 ? {} : { exclude: input.exclude }),
  })

  return { resolver: createReviewRuleResolver(layers), layers, warnings, sources }
}

/** Read the first project rule file that exists. */
async function firstProjectLayer(
  input: LoadReviewRulesInput,
  warnings: string[],
  sources: string[],
): Promise<ReviewRuleLayer | undefined> {
  for (const relative of PROJECT_REVIEW_RULE_PATHS) {
    const path = input.joinPath(input.workspace, relative)
    const layer = await readLayer(input, path, 'project', warnings, sources)
    if (layer !== undefined) return layer
  }
  return undefined
}

/** Read one rule file into a layer, or undefined when it does not exist. */
async function readLayer(
  input: LoadReviewRulesInput,
  path: string,
  source: ReviewRuleLayer['source'],
  warnings: string[],
  sources: string[],
): Promise<ReviewRuleLayer | undefined> {
  const text = await input.readFile(path)
  if (text === undefined) return undefined

  const parsed = parseReviewRuleDocument(text)
  if (!parsed.ok) {
    // The file exists and is unusable. Reported rather than skipped: the
    // difference between "no rule file" and "a rule file that does not parse" is
    // the difference between a project with no standard and a project being
    // silently reviewed against the wrong one.
    warnings.push(`${path}: ${parsed.reason}`)
    return undefined
  }
  sources.push(path)
  // The file's own exclusions travel with its rules, so they can only ever apply
  // where the file does: a `custom` file passed for one run cannot take effect as a
  // project-wide filter, and a *malformed* `exclude` fails the whole document above
  // rather than leaving the rules in force and the exclusions gone.
  return {
    source,
    entries: parsed.entries,
    ...(parsed.exclude.length === 0 ? {} : { exclude: parsed.exclude }),
  }
}
