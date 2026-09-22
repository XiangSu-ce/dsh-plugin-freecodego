/**
 * The two persona tools: look up a roster, and dispatch a child under one.
 *
 * What makes this different from the Harness's own subagent tool
 * -------------------------------------------------------------
 * The Harness starts a child with a prompt. A persona adds a *contract*: named
 * inputs the caller must supply, named outputs the child owes back, and an
 * isolation decision. Those three are the reason a persona is a file rather than
 * a paragraph, so the tool's job is to enforce them rather than to pass them on:
 *
 * - a spawn missing a required input is **refused**, with the missing names —
 *   never started with a hole in its brief,
 * - a child that returns short of its required outputs is **reported**, and its
 *   work is kept (`persona/contract.ts` explains why the two halves differ),
 * - `default_isolation: worktree` puts the child in its own checkout **for
 *   real**, because a child is created *with* a working directory — unlike a
 *   running conversation, whose cwd the Harness will not revise.
 *
 * That last point is where this module and `worktree/tools.ts` meet: the session
 * worktree operations say they can isolate a session only at creation, and this
 * is the creation they meant.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/persona/tools
 */

import {
  checkSpawnInputs,
  checkSpawnOutputs,
  mergePersonaInstructions,
  type PersonaDefinition,
} from './contract.ts'
import type { PersonaRoster } from './files.ts'
import { resolvePersonaRuntime, type ResolvedPersonaRuntime, type SpawnOverrides } from './resolve.ts'
import { JSON_TOOL_OUTPUT, type ToolDefinitionShape } from '../tool-definition.ts'

/**
 * What discovery returned, as the list tool reports it.
 *
 * Re-exported from `./files.ts` rather than re-declared: the inspect report and
 * this tool must describe the same roster, and two structurally identical types
 * would drift the moment one gained a field.
 */
export type { PersonaRoster }

/** Why a spawn did not happen. */
export interface SpawnRefusal {
  readonly refused: string
  readonly missing?: readonly string[]
}

/** A child that is now running, as the start tool reports it. */
export interface SpawnedChild {
  readonly sessionId: string
  readonly persona: string
  readonly isolation: ResolvedPersonaRuntime['isolation']
  readonly isolationSource: ResolvedPersonaRuntime['isolationSource']
  readonly cwd: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** Required outputs the child owes back, checked when it finishes. */
  readonly expectedOutputs: readonly string[]
  readonly worktree?: { readonly path: string; readonly strategy: string; readonly fallbackReason?: string }
}

/** What the start tool needs, injected so the tool holds no state of its own. */
export interface PersonaToolDeps {
  /** The effective roster for a workspace. */
  readonly roster: (cwd: string) => Promise<PersonaRoster>
  /** The merged instruction text for a persona, including its `instructions_file`. */
  readonly instructions: (persona: PersonaDefinition) => Promise<string>
  /** Start the child and hand it the brief. */
  readonly spawn: (input: {
    readonly sessionId: string
    /** The agent that is delegating; a child is created through its context. */
    readonly parent: unknown
    readonly session: {
      readonly workspaceRoot: string
      readonly persona: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly cwd: string
      readonly brief: string
      readonly signal?: AbortSignal
    }
  }) => Promise<void>
  /** Create an isolated checkout for a *not yet created* session. */
  readonly isolate?: (input: { readonly workspaceRoot: string; readonly sessionId: string }) => Promise<{
    readonly path: string
    readonly strategy: string
    readonly fallbackReason?: string
  }>
  /** Agent-type defaults, when the composition declares any. */
  readonly defaults?: () => { readonly model?: string; readonly reasoningEffort?: string; readonly isolation?: 'none' | 'worktree' }
  readonly newSessionId: () => string
  /**
   * The calling session, or `undefined` outside an agent.
   *
   * Carries the agent as well as its cwd because a child is created through the
   * *parent's* context (`agents.create`); reading the cwd alone would leave the
   * spawn port with no way to reach the service, and a spawn port that cannot
   * spawn is the kind of wiring gap that only shows up in production.
   */
  readonly callerOf: (exec: unknown) => { readonly cwd: string; readonly agent: unknown } | undefined
}

/**
 * The output contracts of children that are still running.
 *
 * Kept here rather than in the spawn tool so the end-of-run check can find it: a
 * child ends in a different event than the call that started it, and a contract
 * that lives in the tool's closure is one nothing can check afterwards.
 */
export class PersonaRuns {
  private readonly pending = new Map<string, { readonly persona: string; readonly outputs: readonly string[]; readonly parent?: unknown }>()

  /**
   * Remember what a child owes back, and who should hear about a shortfall.
   * @param sessionId - the child's session id.
   * @param persona - the persona it was started under.
   * @param outputs - the required output names.
   * @param parent - the agent that delegated, so a shortfall can be reported to
   *   it. Optional because a caller may have no way to reach the parent.
   */
  expect(sessionId: string, persona: string, outputs: readonly string[], parent?: unknown): void {
    if (outputs.length > 0) {
      this.pending.set(sessionId, { persona, outputs, ...(parent === undefined ? {} : { parent }) })
    }
  }

  /** Forget a child without checking it — for a child that never started. 
   * @param sessionId - the Harness session this operation acts on.
   */
  forget(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /**
   * Check a finished child's outputs and stop expecting them.
   *
   * Takes the names the child reported rather than its text: deciding what a
   * child's prose "contains" would need the model to judge its own output, and a
   * contract checked by the party being checked is not a contract.
   * @param sessionId - the child that ended.
   * @param produced - the output names it reported.
   * @returns the shortfall, if any, and the sentence to report.
   */
  complete(sessionId: string, produced: readonly string[]): { readonly persona: string; readonly missing: readonly string[]; readonly message?: string; readonly parent?: unknown } | undefined {
    const expected = this.pending.get(sessionId)
    if (expected === undefined) return undefined
    this.pending.delete(sessionId)
    const returned = new Set(produced)
    const missing = expected.outputs.filter(name => !returned.has(name))
    const parent = expected.parent === undefined ? {} : { parent: expected.parent }
    if (missing.length === 0) return { persona: expected.persona, missing, ...parent }
    return {
      persona: expected.persona,
      missing,
      ...parent,
      message: `persona "${expected.persona}" was asked for ${missing.map(name => `"${name}"`).join(', ')} and returned none of them; the rest of its result was kept.`,
    }
  }

  /**
   * The required outputs a child owes, or `undefined` when it owes none.
   *
   * Exposed so the end-of-run check can search the child's message for those
   * names. The alternative — a second map of the same facts in the caller — is
   * two owners of one contract, and they would disagree the first time either
   * changed.
   * @param sessionId - the child's session id.
   * @returns the names, or undefined when this child has no contract.
   */
  expectedFor(sessionId: string): readonly string[] | undefined {
    return this.pending.get(sessionId)?.outputs
  }

  /** How many children are still outstanding, for a status report. */
  get outstanding(): number {
    return this.pending.size
  }
}

/**
 * The persona tools.
 * @param deps - roster discovery, instruction loading, spawning and isolation.
 * @param runs - the outstanding output contracts (shared with the end-of-run hook).
 * @returns the definitions: list, then start.
 */
export function personaToolDefinitions(deps: PersonaToolDeps, runs: PersonaRuns): readonly ToolDefinitionShape[] {
  return [
    {
      name: 'engineering_persona_list',
      description: 'List the personas this workspace resolves, with their source (inline, project, user, bundled), their declared inputs and outputs, and their model and isolation defaults. Also reports personas shadowed by a more specific source, and every file that was refused — a persona file with a misspelled field is refused rather than half-applied, so a persona that seems to do nothing appears here.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          json: { type: 'boolean', description: 'Return the roster as structured JSON instead of a readable list.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: { readonly json?: boolean }, exec: unknown) => {
        const caller = deps.callerOf(exec)
        if (caller === undefined) return { error: 'Personas are resolved per workspace, and this call has no session behind it.' }
        const roster = await deps.roster(caller.cwd)
        if (args?.json === true) {
          return {
            personas: roster.personas.map(persona => ({
              name: persona.name,
              source: persona.source,
              description: persona.description,
              model: persona.model ?? null,
              reasoningEffort: persona.reasoningEffort ?? null,
              defaultIsolation: persona.defaultIsolation ?? null,
              inputs: persona.inputs,
              outputs: persona.outputs,
              instructionsFile: persona.instructionsFile ?? null,
            })),
            shadowed: roster.shadowed,
            issues: roster.issues,
          }
        }
        return { summary: renderRoster(roster), count: roster.personas.length }
      },
      presentCall: () => ({ card: 'generic', title: 'Personas' }),
    },
    {
      name: 'engineering_subagent_start',
      description: 'Start a child agent under a persona. The persona\'s required inputs must be supplied or the child is not started; its required outputs are checked when the child finishes, and a shortfall is reported rather than the work being discarded. A persona with default_isolation "worktree" gives the child its own checkout under .freecodego/worktrees, which is a real working-directory change because the child is created with it. Use engineering_persona_list first to see what a persona requires.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['persona', 'task'],
        properties: {
          persona: { type: 'string', description: 'Persona name, as engineering_persona_list reports it.' },
          task: { type: 'string', description: 'What the child is to do, in full. The persona supplies how; this supplies what.' },
          inputs: { type: 'object', additionalProperties: true, description: 'Declared inputs by name. Every required input must appear here or the spawn is refused.' },
          isolation: { type: 'string', enum: ['none', 'worktree'], description: 'Override the persona\'s isolation for this child only.' },
          model: { type: 'string', description: 'Override the persona\'s model for this child only.' },
          reasoning_effort: { type: 'string', description: 'Override the persona\'s reasoning effort for this child only.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: {
        readonly persona?: string
        readonly task?: string
        readonly inputs?: Record<string, unknown>
        readonly isolation?: 'none' | 'worktree'
        readonly model?: string
        readonly reasoning_effort?: string
      }, exec: unknown): Promise<Record<string, unknown> | SpawnRefusal> => {
        const caller = deps.callerOf(exec)
        if (caller === undefined) return { refused: 'a child is started from a session, and this call has no session behind it' }
        if (typeof args?.persona !== 'string' || args.persona === '') return { refused: 'a persona name is required; engineering_persona_list shows the roster' }
        if (typeof args.task !== 'string' || args.task.trim() === '') return { refused: 'a task is required: the persona says how the child works, not what it works on' }

        const roster = await deps.roster(caller.cwd)
        const persona = roster.personas.find(candidate => candidate.name === args.persona)
        if (persona === undefined) {
          const near = roster.personas.map(candidate => candidate.name).filter(name => name.includes(args.persona as string)).slice(0, 5)
          return {
            refused: `no persona named "${args.persona}" resolves in this workspace${near.length === 0 ? '' : `; did you mean ${near.map(name => `"${name}"`).join(' or ')}?`}`,
          }
        }

        const supplied = Object.keys(args.inputs ?? {})
        const verdict = checkSpawnInputs(persona, supplied)
        if (!verdict.ok) return { refused: verdict.message, missing: verdict.missing.map(field => field.name) }

        const overrides: SpawnOverrides = {
          ...(args.isolation === undefined ? {} : { isolation: args.isolation }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
        }
        const runtime = resolvePersonaRuntime(persona, overrides, deps.defaults?.() ?? {})
        const sessionId = deps.newSessionId()

        let isolated: SpawnedChild['worktree']
        if (runtime.isolation === 'worktree') {
          if (deps.isolate === undefined) {
            // Refused rather than run unisolated: a caller that asked for
            // isolation and silently got the shared tree would edit the parent's
            // files believing it was in its own checkout.
            return { refused: 'this composition cannot create a worktree, so the child was not started; ask for isolation "none" to accept the shared checkout' }
          }
          isolated = await deps.isolate({ workspaceRoot: caller.cwd, sessionId })
        }

        const instructions = await deps.instructions(persona)
        const brief = composeChildBrief({ persona, instructions, task: args.task, inputs: args.inputs ?? {} })
        await deps.spawn({
          sessionId,
          parent: caller.agent,
          session: {
            workspaceRoot: caller.cwd,
            persona: persona.name,
            cwd: isolated?.path ?? caller.cwd,
            brief,
            ...(runtime.model === undefined ? {} : { model: runtime.model }),
            ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
            ...(exec === undefined ? {} : { signal: (exec as { readonly signal?: AbortSignal }).signal }),
          },
        })
        runs.expect(sessionId, persona.name, persona.outputs.filter(field => field.required).map(field => field.name), caller.agent)

        const started: SpawnedChild = {
          sessionId,
          persona: persona.name,
          isolation: runtime.isolation,
          isolationSource: runtime.isolationSource,
          cwd: isolated?.path ?? caller.cwd,
          ...(runtime.model === undefined ? {} : { model: runtime.model }),
          ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
          expectedOutputs: persona.outputs.filter(field => field.required).map(field => field.name),
          ...(isolated === undefined ? {} : { worktree: isolated }),
        }
        return {
          ...started,
          note: runtime.isolation === 'worktree'
            ? `The child was created with ${started.cwd} as its working directory, so its file and shell calls run there for real.`
            : 'The child runs in the parent\'s checkout; its writes are visible to the parent immediately.',
        }
      },
      presentCall: (args: { readonly persona?: string }) => ({ card: 'generic', title: `Start a ${args?.persona ?? 'persona'} child` }),
    },
  ]
}

/**
 * The brief a child receives.
 *
 * The persona's instructions come first and the task last, because the task is
 * the one part the child must act on now; a long persona text after it would put
 * several paragraphs between the instruction and the work. The declared inputs
 * are rendered as a labeled block rather than prose, so the child can tell what
 * was supplied from what the instructions merely describe.
 * @param input - the persona, its merged instructions, the task, and the inputs.
 * @returns the brief text.
 */
export function composeChildBrief(input: {
  readonly persona: PersonaDefinition
  readonly instructions: string
  readonly task: string
  readonly inputs: Readonly<Record<string, unknown>>
}): string {
  const parts: string[] = []
  parts.push(`[freecodego persona: ${input.persona.name}]`)
  if (input.instructions.trim() !== '') parts.push(input.instructions.trim())
  const declared = input.persona.inputs
  const lines = declared.map((field) => {
    const value = input.inputs[field.name]
    const rendered = value === undefined ? '(not supplied)' : typeof value === 'string' ? value : JSON.stringify(value)
    return `- ${field.name} (${field.ioType})${field.required ? '' : ' [optional]'}: ${rendered}`
  })
  const extra = Object.keys(input.inputs).filter(name => !declared.some(field => field.name === name))
  if (lines.length > 0 || extra.length > 0) {
    parts.push([
      'Declared inputs:',
      ...lines,
      // Undeclared inputs are passed through and named, not dropped: the caller
      // sent them on purpose, and silently discarding what someone wrote is the
      // failure this whole contract exists to avoid.
      ...extra.map(name => `- ${name} (undeclared): ${typeof input.inputs[name] === 'string' ? String(input.inputs[name]) : JSON.stringify(input.inputs[name])}`),
    ].join('\n'))
  }
  if (input.persona.outputs.length > 0) {
    // "Declared", and every optional field marked, for the reason the inputs block
    // marks them: the heading is a claim about the lines under it. Calling this block
    // "Required" told a child that an optional artifact was mandatory, and the check
    // that runs when the child returns only looks at the required half — so the one
    // place the child could have learned the difference was here.
    parts.push(['Declared outputs:', ...input.persona.outputs.map(field => `- ${field.name} (${field.ioType})${field.required ? '' : ' [optional]'}${field.description === undefined ? '' : `: ${field.description}`}`)].join('\n'))
  }
  parts.push(`Task:\n${input.task.trim()}`)
  return parts.join('\n\n')
}

/** The roster as text, for the list tool's readable half.
 * @param roster - the resolved roster to render.
 * @returns the readable roster text.
 */
export function renderRoster(roster: PersonaRoster): string {
  if (roster.personas.length === 0) {
    return [
      'No personas resolve in this workspace.',
      'A persona is a .toml file under .freecodego/personas/ (project) or the freecodego data home (user), or an inline entry.',
      ...roster.issues.map(issue => `Refused: ${issue.path} — ${issue.reason}`),
    ].join('\n')
  }
  const lines = [...roster.personas]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((persona) => {
      const bits = [`${persona.name} [${persona.source}]`]
      if (persona.description !== '') bits.push(`  ${persona.description}`)
      const requiredIn = persona.inputs.filter(field => field.required).map(field => field.name)
      if (requiredIn.length > 0) bits.push(`  requires: ${requiredIn.join(', ')}`)
      const requiredOut = persona.outputs.filter(field => field.required).map(field => field.name)
      if (requiredOut.length > 0) bits.push(`  returns: ${requiredOut.join(', ')}`)
      if (persona.defaultIsolation !== undefined) bits.push(`  isolation: ${persona.defaultIsolation}`)
      return bits.join('\n')
    })
  const tails: string[] = []
  if (roster.shadowed.length > 0) {
    tails.push(...roster.shadowed.map(entry => `Shadowed: ${entry.name} exists in ${entry.sources.join(' and ')}; ${entry.sources[0]} wins.`))
  }
  if (roster.issues.length > 0) {
    tails.push(...roster.issues.map(issue => `Refused: ${issue.path} — ${issue.reason}`))
  }
  return [...lines, ...tails].join('\n')
}

/** Merge a persona's instructions with its file, reported rather than silent.
 * @param persona - the persona whose instructions to load.
 * @param read - reads the instructions file, returning `undefined` when missing.
 * @returns the merged instruction text.
 */
export async function loadPersonaInstructions(
  persona: PersonaDefinition,
  read: (path: string) => Promise<string | undefined>,
): Promise<string> {
  if (persona.instructionsFile === undefined) return persona.instructions
  return mergePersonaInstructions(persona, await read(persona.instructionsFile))
}

/** Re-exported so a caller wiring this module does not import two files. */
export { checkSpawnOutputs }

/**
 * Which of a child's required outputs its final message names.
 *
 * A **name search, not a verification**, and the distinction is the point: the
 * contract asks a child to report named artifacts, and reading its prose to
 * decide whether the artifacts exist is not something this plugin can do. So the
 * answer is used for a warning about *absence* — a name that does not appear at
 * all is worth asking the child about — and never as evidence that an output was
 * produced. A caller that needs proof asks the child to write the artifact.
 * @param blocks - the child's final assistant content.
 * @param expected - the required output names.
 * @returns the names that appear in the text.
 */
export function namedOutputsIn(blocks: unknown, expected: readonly string[]): readonly string[] {
  const text = contentText(blocks)
  if (text === '') return []
  const haystack = text.toLowerCase()
  return expected.filter(name => haystack.includes(name.toLowerCase()))
}

/** Flatten assistant content blocks into text, ignoring anything that is not text. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      if (typeof block === 'string') return block
      if (block !== null && typeof block === 'object') {
        const text = (block as { readonly text?: unknown }).text
        if (typeof text === 'string') return text
      }
      return ''
    })
    .join('\n')
}
