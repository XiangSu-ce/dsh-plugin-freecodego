/**
 * One collection pass, ten sections, one report.
 *
 * Why a composition layer rather than a fourth surface
 * ---------------------------------------------------
 * This plugin already answers "what is loaded?" three times: `engineering_doctor`,
 * `engineering_surface_report`, and whatever a user runs to look. Adding
 * `engineering_inspect` as a fourth independent collector would guarantee that
 * two of the four eventually disagree, and a user comparing two answers has no
 * way to tell which one is stale — worse than having only one.
 *
 * So the collectors live here and every surface reads them. `inspect` renders
 * all ten; `doctor` consumes the same objects; `surface_report` is the `rules`
 * section with a different header. The AGENTS.md rule against extracting
 * single-use helpers is not violated here, because there are three consumers.
 *
 * Two properties this module exists to guarantee
 * ----------------------------------------------
 * **A section can fail without the report failing.** A collector that throws —
 * an MCP server whose config is unreadable, an engine probe that hangs and
 * rejects — produces `unavailable` plus the reason, and the other eight sections
 * still render. A report whose first unreadable file blanks the whole thing is a
 * report nobody can use to diagnose the unreadable file.
 *
 * **Everything crossing a Remote boundary is `JsonValue`.** Not a record, not
 * `unknown`: the boundary type has no room for a class instance or a function,
 * and `generate-typert.mjs` refuses to build without it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/inspect/collect
 */

import type { ScanSelection } from '../scan-selection.ts'
import { tokensFromChars } from '../token-estimate.ts'
import type { JsonValue } from '../types.ts'

/**
 * Re-exported, not redefined.
 *
 * `JsonValue` is the boundary type for anything a Remote returns, and `types.ts`
 * is where every boundary type lives. A second definition here would mean two
 * shapes could cross the same edge, which is what the `generate-typert.mjs` gate
 * exists to prevent.
 */
export type { JsonValue }

/** The ten sections, in report order. */
export const INSPECT_SECTIONS = [
  { id: 'trust', title: 'Folder trust' },
  { id: 'sandbox', title: 'Sandbox' },
  { id: 'skills', title: 'Skills' },
  { id: 'hooks', title: 'Hooks' },
  { id: 'rules', title: 'Rules and project instructions' },
  { id: 'personas', title: 'Agents and personas' },
  { id: 'mcp', title: 'MCP servers' },
  { id: 'engines', title: 'Engines' },
  { id: 'scan', title: 'Scan selection' },
] as const

export type InspectSectionId = typeof INSPECT_SECTIONS[number]['id']

/** One section's data, or the reason it could not be produced. */
export interface InspectSection {
  readonly id: InspectSectionId
  readonly title: string
  readonly status: 'ok' | 'unavailable'
  readonly reason?: string
  readonly data: JsonValue
}

/** A collector: a section id and the function that produces its data. */
export interface InspectCollector {
  readonly id: InspectSectionId
  readonly collect: () => JsonValue | Promise<JsonValue>
}

/** The whole report. */
export interface InspectReport {
  readonly generatedAt: number
  readonly sections: readonly InspectSection[]
  /** Convenience roll-up, so a caller does not have to walk the sections twice. */
  readonly unavailable: readonly InspectSectionId[]
}

/**
 * Run every collector, isolating failures.
 * @param collectors - the collectors to run; missing sections are reported as
 *   unavailable rather than silently absent.
 * @param now - the report's timestamp.
 * @returns the report.
 */
export async function collectInspectReport(
  collectors: readonly InspectCollector[],
  now: number = Date.now(),
): Promise<InspectReport> {
  const byId = new Map(collectors.map(collector => [collector.id, collector]))
  const sections: InspectSection[] = []
  for (const declared of INSPECT_SECTIONS) {
    const collector = byId.get(declared.id)
    if (collector === undefined) {
      sections.push({ id: declared.id, title: declared.title, status: 'unavailable', reason: 'no collector was registered for this section', data: null })
      continue
    }
    try {
      const data = await collector.collect()
      sections.push({ id: declared.id, title: declared.title, status: 'ok', data })
    } catch (error) {
      sections.push({
        id: declared.id,
        title: declared.title,
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        data: null,
      })
    }
  }
  return {
    generatedAt: now,
    sections,
    unavailable: sections.filter(section => section.status === 'unavailable').map(section => section.id),
  }
}

/** The report as a boundary-safe value. */
export function inspectReportToJson(report: InspectReport): JsonValue {
  return {
    generatedAt: report.generatedAt,
    unavailable: report.unavailable.map(id => id),
    sections: report.sections.map(section => ({
      id: section.id,
      title: section.title,
      status: section.status,
      ...(section.reason === undefined ? {} : { reason: section.reason }),
      data: section.data,
    })),
  }
}

/**
 * Render the report for a human.
 * @param report - the report to render.
 * @returns one line per section plus a count of what was unavailable.
 */
export function renderInspectReport(report: InspectReport): string {
  const lines = [`Inspect report (${new Date(report.generatedAt).toISOString()})`, '']
  for (const section of report.sections) {
    const mark = section.status === 'ok' ? '·' : '!'
    lines.push(`${mark} ${section.title}`)
    if (section.status !== 'ok') {
      lines.push(`    unavailable: ${section.reason ?? 'no reason given'}`)
      continue
    }
    lines.push(`    ${summarizeJson(section.data)}`)
  }
  if (report.unavailable.length > 0) {
    lines.push('', `${report.unavailable.length} section(s) could not be collected.`)
  }
  return lines.join('\n')
}

/** One line describing a section's payload. */
function summarizeJson(value: JsonValue): string {
  if (Array.isArray(value)) return `${value.length} entr${value.length === 1 ? 'y' : 'ies'}`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    const counts = keys
      .filter(key => typeof (value as Record<string, JsonValue>)[key] === 'number')
      .map(key => `${key}=${String((value as Record<string, JsonValue>)[key])}`)
    return counts.length > 0 ? counts.join(' ') : `${keys.length} field(s)`
  }
  return String(value)
}

/** One rule source the plugin discovered, and its size. */
export interface RuleSource {
  /** Absolute path, or a synthetic label for generated rules. */
  readonly path: string
  readonly source: 'project' | 'user' | 'plugin' | 'bundled'
  readonly text: string
}

/**
 * The `rules` section, including token counts.
 *
 * The counts go through `tokensFromChars` — the same entry point
 * `prompt-composition` uses — so `inspect` and the context breakdown cannot
 * report different sizes for the same file. That shared function is the whole
 * reason A4 exists, and this is where the two surfaces would otherwise diverge.
 * @param sources - the discovered rule sources.
 * @param options - a total token budget to compare against.
 * @returns the section payload.
 */
export function collectRulesSection(sources: readonly RuleSource[], options: { readonly budgetTokens?: number } = {}): JsonValue {
  let total = 0
  const entries = sources.map((source) => {
    const tokens = tokensFromChars(source.text.length)
    total += tokens
    return { path: source.path, source: source.source, chars: source.text.length, tokens }
  })
  return {
    entries,
    count: entries.length,
    totalTokens: total,
    ...(options.budgetTokens === undefined
      ? {}
      : { budgetTokens: options.budgetTokens, overBudget: total > options.budgetTokens }),
  }
}

/** One skill, as the `skills` section reports it. */
export interface InspectSkillEntry {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly invocation: string
  /** Names this skill collides with, when G6's collision report has any. */
  readonly collidesWith?: readonly string[]
}

/**
 * The `skills` section.
 * @param skills - the registered skills.
 * @returns the section payload.
 */
export function collectSkillsSection(skills: readonly InspectSkillEntry[]): JsonValue {
  return {
    count: skills.length,
    entries: [...skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        invocation: skill.invocation,
        ...(skill.collidesWith === undefined ? {} : { collidesWith: [...skill.collidesWith] }),
      })),
  }
}

/**
 * The `hooks` section: how many handlers each event has, and from where.
 * @param handlers - the merged handler set from G7.
 * @returns the section payload.
 */
export function collectHooksSection(
  handlers: readonly { readonly event: string; readonly sources: readonly string[] }[],
  warnings: readonly string[] = [],
): JsonValue {
  const byEvent = new Map<string, { count: number; sources: Set<string> }>()
  for (const handler of handlers) {
    const bucket = byEvent.get(handler.event) ?? { count: 0, sources: new Set<string>() }
    bucket.count += 1
    for (const source of handler.sources) bucket.sources.add(source)
    byEvent.set(handler.event, bucket)
  }
  return {
    total: handlers.length,
    events: [...byEvent.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([event, bucket]) => ({ event, handlers: bucket.count, sources: [...bucket.sources].sort() })),
    warnings: [...warnings],
  }
}

/**
 * The `scan` section: what a scan of this workspace would cover, and what it
 * would leave out.
 *
 * The denominator is the substance here. A list of files a scan would look at is
 * a convenience; the same list presented as *the set that must be accounted for*
 * is what makes a silent skip impossible to hide, which is why the count is named
 * `denominator` rather than `files`. Every exclusion carries the reason it was
 * made, so "why is my file not in the scan" is answered by the report instead of
 * by re-running the selection.
 *
 * Selection is a pure function of the changed paths, so this section shows the
 * answer a run would act on rather than a second opinion about it. What it cannot
 * show is what a run *did*: nothing in this plugin records a per-file scan
 * outcome yet, so there is no "accounted for" column to report. Naming the
 * denominator is the half of that ledger this section can honestly hold.
 * @param input - the sealed selection, or nothing when git could not answer.
 * @returns the section payload.
 */
export function collectScanSection(input: {
  readonly workspace: string | undefined
  /**
   * The repository root the paths are relative to.
   *
   * Reported because the paths alone do not say: they are repository-root-relative,
   * which is what git emits, and a reader who assumes they are workspace-relative
   * will look for the right file in the wrong directory.
   */
  readonly repository?: string
  /** Absent when the workspace is not a repository, or git could not answer. */
  readonly selection?: ScanSelection
  /** Why there is no selection, when there is none. */
  readonly unavailable?: string
}): JsonValue {
  if (input.selection === undefined) {
    // Stated as an answer rather than rendered as an empty scan: "no files" and
    // "we could not tell which files" are the same JSON if the difference is not
    // written down, and only one of them is a reason to relax.
    return {
      available: false,
      workspace: input.workspace ?? null,
      repository: input.repository ?? null,
      reason: input.unavailable ?? 'the workspace is not a git repository, or git could not answer',
    }
  }
  const { selection } = input
  const selected = selection.decisions.filter(decision => decision.exclusion === 'none')
  return {
    available: true,
    workspace: input.workspace ?? null,
    repository: input.repository ?? null,
    denominator: selection.selected.length,
    selected: [...selection.selected],
    excludedCount: selection.excluded.length,
    counts: { ...selection.counts },
    maxFileBytes: selection.maxFileBytes,
    // Named rather than counted: the answer to "is anything here priced at a size
    // we do not actually know" is *which* files, because a count is something a
    // reader can do nothing with.
    sizeUnchecked: selected.filter(decision => decision.sizeUnchecked === true).map(decision => decision.path),
    // A file whose size was unchecked contributes 0 to both totals below and is
    // named in `sizeUnchecked`, so the totals are a floor rather than a claim.
    selectedBytes: selected.reduce((total, decision) => total + (decision.bytes ?? 0), 0),
    selectedTokens: selected.reduce((total, decision) => total + (decision.tokens ?? 0), 0),
    excluded: selection.excluded.map(decision => ({
      path: decision.path,
      exclusion: decision.exclusion,
      ...(decision.pattern === undefined ? {} : { pattern: decision.pattern }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    })),
  }
}
