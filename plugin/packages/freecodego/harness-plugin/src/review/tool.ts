/**
 * The review tools.
 *
 * Four doors onto one engine, each answering a different question:
 *
 * | Tool | Question |
 * | --- | --- |
 * | `engineering_code_review` | review this change |
 * | `engineering_review_rules` | what *would* be reviewed, and under which rule (no model call) |
 * | `engineering_review_status` | what is running now |
 * | `engineering_review_report` | show me the last result again, in another format |
 *
 * Why `engineering_review_rules` is a tool and not a flag
 * ------------------------------------------------------
 * It is the whole deterministic half of the pipeline with no model call, and it
 * is what a caller needs when it wants to do the reviewing *itself* — the upstream
 * delegation mode. Exposing it separately also gives a cheap way to answer "did my
 * exclude pattern work?" without spending a review's budget to find out.
 *
 * Why every tool returns text rather than an object
 * -----------------------------------------------
 * The three formats differ in *who reads them*: `text` for a person, `json` for
 * another agent, `sarif` for a scanning integration. A single structured return
 * would force every consumer through the same rendering, so the format is an
 * argument and the answer is already rendered.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/tool
 */

import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'
import type { ReviewFilePort } from './reviewer.ts'
import { renderReviewJson, renderReviewSarif, renderReviewText, type ReviewReport } from './report.ts'
import type { ReviewRunPort, ReviewRunSnapshot } from './runs.ts'
import type { ReviewTargetMode, ReviewTargetRequest } from './targets.ts'

/** The formats a report can be rendered in. */
export type ReviewOutputFormat = 'text' | 'json' | 'sarif'

/** One tool answer. */
export interface ReviewToolAnswer {
  readonly summary: string
  readonly unavailable?: readonly string[]
}

/** Inputs `engineering_code_review` accepts. */
export interface CodeReviewArgs {
  readonly mode?: string
  readonly from?: string
  readonly to?: string
  readonly commit?: string
  readonly background?: string
  readonly exclude?: readonly string[]
  readonly format?: string
  readonly maxFiles?: number
}

/** Inputs the preview tool accepts. */
export interface ReviewRulesArgs {
  readonly mode?: string
  readonly from?: string
  readonly to?: string
  readonly commit?: string
  readonly exclude?: readonly string[]
  readonly maxFiles?: number
}

/** Render a report in the requested format. */
export function renderReport(report: ReviewReport, format: ReviewOutputFormat): string {
  if (format === 'json') return renderReviewJson(report)
  if (format === 'sarif') return renderReviewSarif(report)
  return renderReviewText(report)
}

/**
 * How the tools reach a run port.
 *
 * One port per workspace, resolved on demand, because a review's rules are read
 * from the workspace it is about — caching one port for the plugin would make
 * every session inherit the rule files of whichever session ran first.
 */
export interface ReviewToolAccess {
  /** The run port for one workspace, assembled on first use. */
  forWorkspace(workspace: string): Promise<ReviewRunPort>
  /**
   * A deeper per-file reviewer for this call, when the deployment offers one.
   *
   * Resolved per call and not stored with the workspace's port, because it is
   * built from the agent that asked: a subagent reviewer opens a child in that
   * agent's session, and the workspace's port is shared by every session in it.
   * Returning `undefined` means "review with the installed reviewer", which is
   * what a deployment without this hook — and the preview, status and report
   * tools — always get.
   */
  deepReviewer?(agent: ReviewToolAgent | undefined): ReviewFilePort | undefined
}

/** The slice of an agent the deeper reviewer is built from. */
export interface ReviewToolAgent {
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/**
 * The full tool set.
 *
 * `cwd` comes from the executing agent's session rather than from the arguments,
 * for the same reason the inspect tool reads it there: a review is about *this*
 * workspace, and a path argument would let a model review a directory the session
 * is not in.
 */
export function reviewToolDefinitions(access: ReviewToolAccess): ToolDefinitionShape[] {
  return [
    toolDefinition({
      name: 'engineering_code_review',
      description: 'Review a change set and report line-level findings with severity, category, and a suggested fix where one exists. Reviews staged, unstaged AND untracked changes by default (mode "workspace"); pass mode "range" with from/to for a branch comparison, or mode "commit" with a commit for a single commit. Every changed file is accounted for: files skipped as binary, oversized, excluded by a rule, or not reached because of the run budget are reported with their reason. Use it before declaring work finished, when asked to review a branch or commit, or when you want an independent second reading of your own change. Pass a short "background" describing the intent of the change to improve review quality. Pass format "json" or "sarif" for machine-readable output.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['workspace', 'range', 'commit'], description: 'What to review. Defaults to workspace.' },
          from: { type: 'string', description: 'Range mode: the source ref.' },
          to: { type: 'string', description: 'Range mode: the target ref; defaults to HEAD.' },
          commit: { type: 'string', description: 'Commit mode: the commit to review against its first parent.' },
          background: { type: 'string', description: 'Business context for the change, which improves review quality.' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Additional gitignore-style patterns to exclude, on top of the rule layers. A brace list counts as one pattern: **/*.{gen,min}.ts drops both.' },
          format: { type: 'string', enum: ['text', 'json', 'sarif'], description: 'Output format. Defaults to text.' },
          maxFiles: { type: 'number', description: 'Ceiling on how many files this run will attempt.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: CodeReviewArgs, exec?: ReviewToolExec) => {
        const cwd = cwdOf(exec)
        const request = requestFrom(args, cwd)
        const format = asFormat(args.format)
        const port = await access.forWorkspace(cwd)
        const reviewer = access.deepReviewer?.(exec?.agent)
        const result = await port.review({
          request,
          ...(args.background === undefined ? {} : { background: args.background }),
          ...(args.maxFiles === undefined ? {} : { maxFiles: args.maxFiles }),
          ...(reviewer === undefined ? {} : { reviewer }),
        })
        return {
          summary: renderReport(result.report, format),
          ...(result.notes.length === 0 ? {} : { unavailable: result.notes }),
        }
      },
      presentCall: (args: CodeReviewArgs) => ({ card: 'generic', title: `Review ${args?.mode ?? 'workspace'} change` }),
    }),

    toolDefinition({
      name: 'engineering_review_rules',
      description: 'Show what a review would cover, and which review rule applies to each file, without calling a model. Use it to confirm an exclude pattern or a rule file is being picked up, to see why a file is not in the review denominator, or to obtain the file list and rule text in order to perform the review yourself.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['workspace', 'range', 'commit'], description: 'What to preview. Defaults to workspace.' },
          from: { type: 'string', description: 'Range mode: the source ref.' },
          to: { type: 'string', description: 'Range mode: the target ref; defaults to HEAD.' },
          commit: { type: 'string', description: 'Commit mode: the commit to preview.' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Additional gitignore-style patterns to exclude. A brace list counts as one pattern: **/*.{gen,min}.ts drops both.' },
          maxFiles: { type: 'number', description: 'Ceiling on how many files to list.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: ReviewRulesArgs, exec?: ReviewToolExec) => {
        const port = await access.forWorkspace(cwdOf(exec))
        const preview = await port.preview(
          requestFrom(args, cwdOf(exec)),
          args.maxFiles === undefined ? {} : { maxFiles: args.maxFiles },
        )
        return { summary: renderPreview(preview) }
      },
      presentCall: () => ({ card: 'generic', title: 'Preview review coverage' }),
    }),

    toolDefinition({
      name: 'engineering_review_status',
      description: 'Report the review that is running, or the most recent one: its phase, how many files were reviewed, failed and skipped, and how many findings it produced. Use it after starting a long review, or to see what the last review covered.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_TOOL_OUTPUT,
      execute: async (_args: unknown, exec?: ReviewToolExec) => {
        const port = await access.forWorkspace(cwdOf(exec))
        const snapshots = port.list()
        if (snapshots.length === 0) return { summary: 'No review has run in this workspace yet.' }
        return { summary: snapshots.map(renderSnapshot).join('\n') }
      },
      presentCall: () => ({ card: 'generic', title: 'Review status' }),
    }),

    toolDefinition({
      name: 'engineering_review_report',
      description: 'Re-render the most recent review (or a named one by id) in a chosen format. Use it to get the JSON or SARIF form of a review that was already run, rather than running it again.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The run id from a previous review or from engineering_review_status. Defaults to the most recent run.' },
          format: { type: 'string', enum: ['text', 'json', 'sarif'], description: 'Output format. Defaults to text.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: { readonly id?: string; readonly format?: string }, exec?: ReviewToolExec) => {
        const port = await access.forWorkspace(cwdOf(exec))
        const report = port.report(args?.id)
        if (report === undefined) return { summary: `No report is available${args?.id === undefined ? '' : ` for run ${args.id}`}.`, unavailable: ['no report'] }
        return { summary: renderReport(report, asFormat(args?.format)) }
      },
      presentCall: () => ({ card: 'generic', title: 'Show review report' }),
    }),
  ]
}

/** The slice of the execution context the review tools read. */
interface ReviewToolExec {
  readonly agent?: ReviewToolAgent
}

/** The session's working directory, or the process's when the caller has none. */
function cwdOf(exec: ReviewToolExec | undefined): string {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** Build a target request from either tool's arguments. */
function requestFrom(
  args: { readonly mode?: string; readonly from?: string; readonly to?: string; readonly commit?: string; readonly exclude?: readonly string[] },
  cwd: string,
): ReviewTargetRequest {
  const mode = asMode(args.mode)
  return {
    mode,
    cwd,
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.to === undefined ? {} : { to: args.to }),
    ...(args.commit === undefined ? {} : { commit: args.commit }),
    ...(args.exclude === undefined || args.exclude.length === 0 ? {} : { exclude: args.exclude }),
  }
}

/** Coerce an unknown mode, defaulting to a workspace review. */
function asMode(value: unknown): ReviewTargetMode {
  return value === 'range' || value === 'commit' ? value : 'workspace'
}

/** Coerce an unknown format, defaulting to text. */
function asFormat(value: unknown): ReviewOutputFormat {
  return value === 'json' || value === 'sarif' ? value : 'text'
}

/** Render one run snapshot as a line. */
function renderSnapshot(snapshot: ReviewRunSnapshot): string {
  const state = snapshot.state ?? snapshot.phase
  const finished = snapshot.finishedAt === undefined ? '' : `, finished in ${snapshot.finishedAt - snapshot.startedAt}ms`
  const error = snapshot.error === undefined ? '' : ` — ${snapshot.error}`
  return `- \`${snapshot.id}\` ${snapshot.mode} ${state}${finished}: ${snapshot.reviewed}/${snapshot.files} reviewed, ${snapshot.findings} finding(s), ${snapshot.skipped} skipped, ${snapshot.failed} failed${error}`
}

/** Render the deterministic preview as a readable report. */
function renderPreview(preview: { readonly target: { readonly mode: string; readonly mergeBase?: string; readonly files: readonly { readonly path: string; readonly added: number; readonly deleted: number; readonly untracked: boolean }[]; readonly excluded: readonly { readonly path: string; readonly reason: string; readonly detail: string }[] }; readonly ruleGroups: readonly { readonly id: number; readonly source: string; readonly pattern: string; readonly files: readonly string[] }[] }): string {
  const lines: string[] = []
  lines.push(`# Review preview — ${preview.target.mode}`)
  if (preview.target.mergeBase !== undefined) lines.push(`Merge base: \`${preview.target.mergeBase}\``)
  lines.push('')
  lines.push(`Files that would be reviewed: ${preview.target.files.length}`)
  for (const file of preview.target.files) {
    lines.push(`- ${file.untracked ? 'UNTRACKED' : ''} \`${file.path}\` (+${file.added}/-${file.deleted})`.replace('  ', ' '))
  }
  lines.push('')
  lines.push(`Excluded: ${preview.target.excluded.length}`)
  for (const entry of preview.target.excluded) {
    lines.push(`- \`${entry.path}\` — ${entry.reason}: ${entry.detail}`)
  }
  lines.push('')
  lines.push(`Rule groups: ${preview.ruleGroups.length}`)
  for (const group of preview.ruleGroups) {
    lines.push(`- group ${group.id} [${group.source}, pattern ${group.pattern}] — ${group.files.length} file(s): ${group.files.join(', ')}`)
  }
  return lines.join('\n')
}
