/**
 * The plan's structure.
 *
 * What the five sections buy
 * --------------------------
 * A plan is read by a human deciding whether to let an agent act, and by a model
 * deciding what to do next. Both go wrong on the same missing thing: a plan that
 * says what will be done but not what was already there to reuse, or not how the
 * result will be checked. The sections are the checklist that makes those omissions
 * visible, and their names are the vocabulary the review overlay, the rework
 * message and the tests all share.
 *
 * Why the check only warns
 * ------------------------
 * Because it cannot tell. A one-line plan for a one-line change is a *good* plan
 * whose `Reuse` section is legitimately empty, and a tool that refused it would
 * push authors to pad every plan until the check stopped complaining — which is the
 * failure mode where a form teaches its own filler. Blocking is reserved for things
 * that are certainly wrong; a missing heading is not one of them.
 *
 * The report distinguishes absent from empty for the same reason. A missing
 * `Verification` heading means the author did not consider it; a present but empty
 * one means they considered it and had nothing to add, and those are different
 * messages to receive.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plan/plan-sections
 */

/** The five section headings, in the order a plan should read. */
export const PLAN_SECTIONS = ['Context', 'Approach', 'Files', 'Reuse', 'Verification'] as const

/** One plan section heading, drawn from {@link PLAN_SECTIONS}. */
export type PlanSectionName = (typeof PLAN_SECTIONS)[number]

/** What one inspection found. */
export interface PlanSectionReport {
  /** Sections with a heading, in the order they appear in the document. */
  readonly present: readonly PlanSectionName[]
  /** Sections without a heading, in canonical order. */
  readonly missing: readonly PlanSectionName[]
  /** Sections whose heading was followed by no content. */
  readonly blank: readonly PlanSectionName[]
  /** One line per gap, for the review surface; empty when the plan is complete. */
  readonly warnings: readonly string[]
  /** Whether there is no plan text at all — an empty plan is approvable, but not silently. */
  readonly empty: boolean
}

/** A level-two heading, its trimmed text, and where its body starts. */
interface Heading {
  readonly text: string
  readonly bodyStart: number
}

/** Every level-two heading in a document, in order. */
function headings(text: string): readonly Heading[] {
  const found: Heading[] = []
  // Only level two: a `###` is a detail *inside* a section, and treating one as a
  // section boundary would invent headings the author never wrote.
  const pattern = /^##[ \t]+(.+)$/gmu
  for (const match of text.matchAll(pattern)) {
    found.push({ text: match[1]!.trim(), bodyStart: match.index + match[0].length })
  }
  return found
}

/**
 * Inspect a plan's structure.
 * @param text - the plan text, or `undefined` when there is none.
 * @returns which sections are present, blank, and missing, with the warnings to show.
 */
export function inspectPlanSections(text: string | undefined): PlanSectionReport {
  if (text === undefined || text.trim() === '') {
    return {
      present: [],
      missing: [...PLAN_SECTIONS],
      blank: [],
      // The empty case gets one warning about being empty rather than five about
      // missing headings: the user has one thing to do, not five.
      warnings: ['the plan is empty'],
      empty: true,
    }
  }
  const found = headings(text)
  const present: PlanSectionName[] = []
  const blank: PlanSectionName[] = []
  for (let index = 0; index < found.length; index++) {
    const heading = found[index]!
    const known = PLAN_SECTIONS.find(section => section.toLowerCase() === heading.text.toLowerCase())
    // A heading that is not one of the five is the author's own structure, not a
    // mistake, so it is simply not counted either way.
    if (known === undefined) continue
    if (!present.includes(known)) present.push(known)
    const end = found[index + 1]?.bodyStart ?? text.length
    const body = text.slice(heading.bodyStart, end)
    // Only the text between this heading and the next, so a populated section
    // cannot make an empty one look filled.
    //
    // Guarded like `present` above: a heading written twice would otherwise name the
    // section twice in a warning that a human reads as two problems.
    if (body.replace(/^##[^\n]*$/gmu, '').trim() === '' && !blank.includes(known)) blank.push(known)
  }
  const missing = PLAN_SECTIONS.filter(section => !present.includes(section))
  const warnings: string[] = []
  if (missing.length > 0) warnings.push(`no ${missing.join(' / ')} section`)
  if (blank.length > 0) warnings.push(`${blank.join(' / ')} is present but empty`)
  return { present, missing, blank, warnings, empty: false }
}
