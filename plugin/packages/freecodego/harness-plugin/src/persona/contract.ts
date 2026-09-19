/**
 * Personas as files, with a contract that can actually be checked.
 *
 * What is *not* here, and why
 * --------------------------
 * Persona mechanics already exist twice over: `dsh-subagent` carries persona
 * per child, and `preset/persona` is a scope-only settings row that overrides
 * the deployment persona through `ctx.systemPrompt`. Adding a third mechanism
 * would give the same word three meanings. So this module does only the three
 * things nothing else does:
 *
 * - **discovery and precedence** across inline, project, user and bundled
 *   sources (`./discovery.ts`),
 * - **a declarative I/O contract** that can refuse a spawn (here),
 * - **`default_isolation`**, resolved into the worktree machinery from G5
 *   (`./resolve.ts`).
 *
 * The asymmetry in the contract is the whole point
 * -----------------------------------------------
 * A missing *required input* refuses the spawn. A missing *required output*
 * only warns. That is not an oversight in strictness: an orchestrator that
 * dispatches a child with a hole in its brief has produced work that cannot be
 * right, and discovering that from the child's confused output is expensive. An
 * orchestrator whose child returns nine of ten requested artifacts has produced
 * something usable — refusing it would throw away real work to punish
 * incompleteness, so the shortfall is reported and the result is kept.
 *
 * One deliberate narrowing: a persona may not change the tool set. Tools belong
 * to an agent *type* (what a child is allowed to touch), and letting a persona
 * widen or narrow them would create a second, weaker gate on the same question
 * — the shape of design that produces "I set it and it did not apply".
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/persona/contract
 */

/** Where a persona was found, in increasing order of precedence. */
export const PERSONA_SOURCES = ['bundled', 'user', 'project', 'inline'] as const

export type PersonaSource = typeof PERSONA_SOURCES[number]

/**
 * The same sources, highest precedence first.
 *
 * This is the direction resolution walks, and it is derived rather than written
 * again. The loop in `discovery.ts` used to spell the four names out in reverse,
 * which left the precedence rule stated in three places — this comment, that
 * loop, and that module's header — with only one of them executable and nothing
 * tying the other two to it. Reading the order off the declaration means a change
 * to the rule reaches the loop that applies it.
 */
export const PERSONA_SOURCE_PRECEDENCE: readonly PersonaSource[] = [...PERSONA_SOURCES].reverse()

/** Whether a child runs in the parent's checkout or in its own worktree. */
export type PersonaIsolation = 'none' | 'worktree'

/** One declared input or output of a persona. */
export interface PersonaIoField {
  readonly name: string
  /** Free-form type label, carried through to the child's brief. */
  readonly ioType: string
  /** `true` means the caller must supply it (input) or produce it (output). */
  readonly required: boolean
  readonly description?: string
}

/** A discovered persona, normalized. */
export interface PersonaDefinition {
  /** File name without extension, or the inline key. */
  readonly name: string
  readonly description: string
  readonly instructions: string
  /** Read at spawn time and appended after `instructions`. */
  readonly instructionsFile?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly defaultIsolation?: PersonaIsolation
  readonly inputs: readonly PersonaIoField[]
  readonly outputs: readonly PersonaIoField[]
  readonly source: PersonaSource
}

/** Why a persona file was refused rather than partially understood. */
export interface PersonaIssue {
  readonly path: string
  readonly reason: string
}

/** Field names a persona may declare. Anything else is refused. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'instructions',
  'instructions_file',
  'model',
  'reasoning_effort',
  'default_isolation',
  'inputs',
  'outputs',
])

/** A persona name has to be usable as a file name and as a lookup key. */
const PERSONA_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Fields whose declared value has to be a string, checked as a group below. */
const STRING_FIELDS: readonly string[] = ['name', 'description', 'instructions', 'instructions_file', 'model', 'reasoning_effort']

/** Field names one entry of `inputs` or `outputs` may declare. */
const IO_FIELD_KEYS: ReadonlySet<string> = new Set(['name', 'io_type', 'required', 'description'])

/** How a rejected value is described back to its author. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'number') return 'a number'
  if (typeof value === 'boolean') return 'a boolean'
  if (typeof value === 'object') return 'a table'
  return `a ${typeof value}`
}

/**
 * Refuse a declared scalar that is not a string.
 *
 * The same rule as an unknown field, for the same reason: dropping a mistyped
 * value is how a persona ends up looking configured while doing nothing. An empty
 * string is *not* refused — it declares nothing, which is what the line's absence
 * means — so only the wrong type is a refusal.
 * @param raw - the parsed record.
 * @param path - document path, for diagnostics.
 * @returns the issue, or undefined when every declared scalar is a string.
 */
function wrongTypeIssue(raw: Record<string, unknown>, path: string): PersonaIssue | undefined {
  for (const field of STRING_FIELDS) {
    const value = raw[field]
    if (value === undefined || typeof value === 'string') continue
    return { path, reason: `"${field}" must be a string, not ${describeValue(value)}` }
  }
  return undefined
}

/**
 * Turn one raw record into a persona, or say why it cannot be one.
 *
 * Unknown fields are refused rather than ignored. A typo like
 * `default_isolaton` would otherwise produce a persona that looks configured
 * and silently runs without isolation — the failure mode this whole plan calls
 * "never silently degrade".
 * @param raw - the parsed record.
 * @param fallbackName - name to use when the record does not carry one (the file name).
 * @param source - where the record came from.
 * @param path - document path, for diagnostics.
 * @returns the persona, or an issue explaining the refusal.
 */
export function normalizePersona(
  raw: Record<string, unknown>,
  fallbackName: string,
  source: PersonaSource,
  path: string,
): { readonly persona: PersonaDefinition } | { readonly issue: PersonaIssue } {
  const unknown = Object.keys(raw).filter(key => !KNOWN_FIELDS.has(key))
  if (unknown.length > 0) {
    return { issue: { path, reason: `unknown field(s) ${unknown.map(key => `"${key}"`).join(', ')} — a typo here would silently do nothing` } }
  }
  const wrongType = wrongTypeIssue(raw, path)
  if (wrongType !== undefined) return { issue: wrongType }

  const declaredName = raw.name
  const name = typeof declaredName === 'string' && declaredName !== '' ? declaredName : fallbackName
  if (!PERSONA_NAME_PATTERN.test(name)) {
    return { issue: { path, reason: `"${name}" is not a usable persona name (lowercase letters, digits, dot, dash, underscore; at most 63 characters)` } }
  }

  const instructions = requireString(raw.instructions)
  const instructionsFile = optionalString(raw.instructions_file)
  if (instructions === undefined && instructionsFile === undefined) {
    return { issue: { path, reason: 'a persona needs `instructions` or `instructions_file`' } }
  }

  const isolation = raw.default_isolation
  if (isolation !== undefined && isolation !== 'none' && isolation !== 'worktree') {
    return { issue: { path, reason: 'default_isolation must be "none" or "worktree"' } }
  }

  const inputs = parseIoFields(raw.inputs, path, 'inputs')
  if ('issue' in inputs) return inputs
  const outputs = parseIoFields(raw.outputs, path, 'outputs')
  if ('issue' in outputs) return outputs

  const description = optionalString(raw.description) ?? firstParagraph(instructions ?? readInstructionsPlaceholder(instructionsFile))
  const model = optionalString(raw.model)
  const reasoningEffort = optionalString(raw.reasoning_effort)
  return {
    persona: {
      name,
      description,
      instructions: instructions ?? '',
      ...(instructionsFile === undefined ? {} : { instructionsFile }),
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(isolation === undefined ? {} : { defaultIsolation: isolation }),
      inputs: inputs.fields,
      outputs: outputs.fields,
      source,
    },
  }
}

/** The description of a persona whose instructions live in a separate file. */
function readInstructionsPlaceholder(instructionsFile: string | undefined): string {
  return instructionsFile === undefined ? '' : `(instructions from ${instructionsFile})`
}

/** First non-empty paragraph, used when no description was declared. */
function firstParagraph(text: string): string {
  const paragraph = text.split(/\r?\n\s*\r?\n/).map(part => part.trim()).find(part => part !== '')
  return paragraph ?? ''
}

/** Read an optional string field, rejecting the wrong type loudly. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a required string field. */
function requireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Parse a persona's `inputs` or `outputs` array.
 * @param value - the raw array, or undefined.
 * @param path - document path, for diagnostics.
 * @param field - which of the two arrays this is.
 * @returns the fields, or an issue.
 */
function parseIoFields(
  value: unknown,
  path: string,
  field: 'inputs' | 'outputs',
): { readonly fields: readonly PersonaIoField[] } | { readonly issue: PersonaIssue } {
  if (value === undefined) return { fields: [] }
  if (!Array.isArray(value)) return { issue: { path, reason: `${field} must be an array` } }
  const fields: PersonaIoField[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { issue: { path, reason: `every entry of ${field} must be an object` } }
    }
    const record = entry as Record<string, unknown>
    // The top-level rule, one level down and for the same reason: `requried` is a
    // typo that leaves the field optional, so the refusal this contract exists to
    // produce would silently not happen.
    const unknownKeys = Object.keys(record).filter(key => !IO_FIELD_KEYS.has(key))
    if (unknownKeys.length > 0) {
      return { issue: { path, reason: `an entry of ${field} has unknown field(s) ${unknownKeys.map(key => `"${key}"`).join(', ')} — a typo here would silently do nothing` } }
    }
    const name = requireString(record.name)
    if (name === undefined) return { issue: { path, reason: `an entry of ${field} has no name` } }
    if (seen.has(name)) return { issue: { path, reason: `${field} declares "${name}" twice` } }
    seen.add(name)
    const ioType = requireString(record.io_type)
    if (ioType === undefined) return { issue: { path, reason: `${field}.${name} has no io_type` } }
    const required = record.required
    if (required !== undefined && typeof required !== 'boolean') {
      return { issue: { path, reason: `${field}.${name}.required must be true or false` } }
    }
    const description = optionalString(record.description)
    fields.push({
      name,
      ioType,
      required: required === true,
      ...(description === undefined ? {} : { description }),
    })
  }
  return { fields }
}

/** The verdict on whether a spawn may proceed. */
export type SpawnInputVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly PersonaIoField[]; readonly message: string }

/**
 * Check the inputs a caller supplied against the persona's contract.
 *
 * Refusal, not a warning — see the module header for why the input and output
 * halves of this contract are deliberately asymmetrical.
 * @param persona - the persona being spawned.
 * @param provided - the input names the caller supplied.
 * @returns whether the spawn may proceed, and what is missing when it may not.
 */
export function checkSpawnInputs(persona: PersonaDefinition, provided: readonly string[]): SpawnInputVerdict {
  const supplied = new Set(provided)
  const missing = persona.inputs.filter(field => field.required && !supplied.has(field.name))
  if (missing.length === 0) return { ok: true }
  const list = missing.map(field => `"${field.name}" (${field.ioType})`).join(', ')
  return {
    ok: false,
    missing,
    message: `persona "${persona.name}" requires input ${list}; nothing was started. Supply it, or mark the field optional if the child can work without it.`,
  }
}

/**
 * Check the outputs a child produced against the persona's contract.
 *
 * A warning rather than a refusal: a child that returned most of what it was
 * asked for produced usable work, and discarding it would punish incompleteness
 * by destroying the part that succeeded.
 * @param persona - the persona that ran.
 * @param produced - the output names the child reported.
 * @returns the missing required outputs, and a message when there are any.
 */
export function checkSpawnOutputs(
  persona: PersonaDefinition,
  produced: readonly string[],
): { readonly missing: readonly PersonaIoField[]; readonly message?: string } {
  const returned = new Set(produced)
  const missing = persona.outputs.filter(field => field.required && !returned.has(field.name))
  if (missing.length === 0) return { missing }
  const list = missing.map(field => `"${field.name}" (${field.ioType})`).join(', ')
  return {
    missing,
    message: `persona "${persona.name}" was asked for ${list} and returned none of them; the rest of its result was kept.`,
  }
}

/**
 * Merge a persona's instructions with its `instructions_file` contents.
 *
 * The file comes *after* the inline instructions, so a shared persona file can
 * carry the house style and a project can append the local exception without
 * having to copy the style in.
 * @param persona - the persona.
 * @param fileContents - the file's text, when it has one and it could be read.
 * @returns the merged instruction text.
 */
export function mergePersonaInstructions(persona: PersonaDefinition, fileContents: string | undefined): string {
  if (persona.instructionsFile === undefined) return persona.instructions
  if (fileContents === undefined) {
    // Reported rather than swallowed: instructions that were supposed to load
    // and did not is exactly the silent degradation this plan forbids.
    return `${persona.instructions}\n\n[freecodego] the persona's instructions_file "${persona.instructionsFile}" could not be read; the child ran with the inline instructions only.`.trim()
  }
  return [persona.instructions, fileContents].filter(part => part.trim() !== '').join('\n\n')
}
