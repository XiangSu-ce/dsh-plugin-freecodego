/**
 * The model-facing craft tool: OpenDesign's universal design rules, on request.
 *
 * Three actions, and the split is what makes the layer affordable. `list` answers
 * what exists and what each section costs; `get` returns the bodies a caller
 * chose, up to {@link CRAFT_SECTIONS_PER_CALL} at a time; `resolve` runs the
 * upstream composition rule — `requires` plus `applies`, minus `exemptions`, with
 * `suggested` offered — and reports every miss with its reason.
 *
 * Why a miss is an answer rather than a gap
 * -----------------------------------------
 * Upstream's runtime drops a section it cannot find, so an old bundle keeps
 * working; its repository lint fails on the same slug at authoring time. This
 * package has no authoring step to lint, which leaves this tool as the one place
 * a typo can be caught — and a typo that *looked* like a successful load is the
 * worst outcome available here, because the caller then believes a rule is in
 * force. So a requested slug with no file refuses the call and names what
 * exists, while a slug upstream has registered as planned is accepted and
 * reported as pending: the two are different facts and the answer says which.
 *
 * This module owns the *definition* and not a registration — the design page's
 * switch is what registers it, the same shape `uiux/tool.ts` and
 * `impeccable/tool.ts` have, so the page cannot say a capability is off while a
 * caller can still reach its tool.
 *
 * Nothing here reads the network, the workspace, or a browser: the layer is
 * package assets, which is why the row that offers it works on a machine with
 * none of those.
 *
 * @module craft/tool
 */

import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'
import {
  CRAFT_SECTIONS_PER_CALL,
  CRAFT_SLUG_PATTERN,
  readCraftCatalogue,
  readCraftSection,
  resolveCraftRequirements,
} from './sections.ts'

/** Registered tool name; prefixed so Harness deferral and Plan Mode classify it. */
export const CRAFT_TOOL_NAME = 'freecodego_design_craft'

/** Longest slug this tool accepts; a craft slug is a word or two. */
const MAX_SLUG_LENGTH = 64

/** Longest slug list accepted on any action, so a caller cannot ask for everything twice over. */
const MAX_SLUGS_PER_CALL = 12

/** The arguments, as the schema admits them. */
interface CraftToolArgs {
  readonly action?: unknown
  readonly sections?: unknown
  readonly requires?: unknown
  readonly applies?: unknown
  readonly suggested?: unknown
  readonly exemptions?: unknown
}

/** A refusal, shaped like the rest of this pack's refusals so callers read one vocabulary. */
interface CraftToolRefusal {
  readonly kind: 'refused'
  readonly action: string
  readonly reason: string
  readonly message: string
  readonly available?: readonly string[]
  readonly unknown?: readonly string[]
}

/** A slug list that passed validation, or the refusal that explains why it did not. */
type SlugListResult =
  | { readonly kind: 'ok'; readonly slugs: readonly string[] }
  | { readonly kind: 'refused'; readonly refusal: CraftToolRefusal }

function refusal(
  action: string,
  reason: string,
  message: string,
  extra: { readonly available?: readonly string[]; readonly unknown?: readonly string[] } = {},
): CraftToolRefusal {
  return { kind: 'refused', action, reason, message, ...extra }
}

/** Every shipped slug, for a refusal that has to say what exists. */
function availableSlugs(): readonly string[] {
  return readCraftCatalogue().sections.map(section => section.slug)
}

/**
 * Validate one slug list argument.
 *
 * The bounds are checked before the slugs are, so a caller that passed a
 * thousand entries is told about the shape of the call rather than about the
 * first entry that happened to be malformed.
 */
function slugList(action: string, name: string, value: unknown): SlugListResult {
  if (value === undefined) return { kind: 'ok', slugs: [] }
  if (!Array.isArray(value)) {
    return { kind: 'refused', refusal: refusal(action, 'invalid-arguments', `${name} must be an array of craft section slugs.`) }
  }
  if (value.length > MAX_SLUGS_PER_CALL) {
    return {
      kind: 'refused',
      refusal: refusal(action, 'too-many-slugs', `${name} lists ${String(value.length)} slugs; at most ${String(MAX_SLUGS_PER_CALL)} are accepted on one call.`),
    }
  }
  const slugs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { kind: 'refused', refusal: refusal(action, 'invalid-arguments', `every entry of ${name} must be a string.`) }
    }
    const slug = entry.trim().toLowerCase()
    if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
      return { kind: 'refused', refusal: refusal(action, 'invalid-arguments', `${name} carries an entry that is empty or longer than ${String(MAX_SLUG_LENGTH)} characters.`) }
    }
    if (!CRAFT_SLUG_PATTERN.test(slug)) {
      return { kind: 'refused', refusal: refusal(action, 'malformed-slug', `${name} carries ${JSON.stringify(entry)}, which cannot name a section: a slug is lower-case letters, digits and inner hyphens.`, { available: availableSlugs() }) }
    }
    slugs.push(slug)
  }
  return { kind: 'ok', slugs }
}

/** The catalogue: what exists, what it costs, and what upstream has planned. */
function runList(): unknown {
  const catalogue = readCraftCatalogue()
  return {
    kind: 'catalogue',
    sections: catalogue.sections,
    forwardReferences: catalogue.forwardReferences,
    bytes: catalogue.bytes,
    tokens: catalogue.tokens,
    note: `Each section is paid for on its own; \`get\` returns at most ${String(CRAFT_SECTIONS_PER_CALL)} bodies per call. A slug under forwardReferences is registered upstream and not shipped here yet.`,
  }
}

/** One or more section bodies, or a refusal naming every slug that resolved to nothing. */
function runGet(sections: readonly string[]): unknown {
  const action = 'get'
  if (sections.length === 0) {
    return refusal(action, 'empty-sections', 'Name the sections to read, or call action "list" to see what exists.', { available: availableSlugs() })
  }
  if (sections.length > CRAFT_SECTIONS_PER_CALL) {
    return refusal(
      action,
      'too-many-sections',
      `One call returns at most ${String(CRAFT_SECTIONS_PER_CALL)} sections; these bodies are long, and the catalogue reports each one's size so the choice can be made deliberately.`,
      { available: sections },
    )
  }

  const found: unknown[] = []
  const pending: { slug: string; note: string }[] = []
  const unknown: string[] = []
  for (const slug of sections) {
    const lookup = readCraftSection(slug)
    if (lookup.kind === 'found') {
      found.push({ ...lookup.section, text: lookup.text })
      continue
    }
    if (lookup.kind === 'planned') {
      pending.push({ slug, note: 'Registered upstream as a planned forward reference; no section ships under this slug yet.' })
      continue
    }
    unknown.push(slug)
  }

  // A partially answered call is the failure this refusal exists to prevent: the
  // caller reads the bodies it got and has nothing telling it that the rule it
  // asked for by name is not among them.
  if (unknown.length > 0) {
    return refusal(action, 'unknown-section', `No craft section ships under ${unknown.map(slug => JSON.stringify(slug)).join(', ')}.`, {
      available: availableSlugs(),
      unknown,
    })
  }
  if (found.length === 0) {
    return {
      kind: 'sections',
      sections: [],
      pending,
      note: 'Nothing was read: every slug named is a forward reference rather than a shipped section.',
    }
  }
  return { kind: 'sections', sections: found, pending }
}

/** The composition upstream's loader performs, answered instead of acted on. */
function runResolve(input: CraftToolArgs): unknown {
  const action = 'resolve'
  const lists: Record<string, readonly string[]> = {}
  for (const name of ['requires', 'applies', 'suggested', 'exemptions'] as const) {
    const parsed = slugList(action, name, input[name])
    if (parsed.kind === 'refused') return parsed.refusal
    lists[name] = parsed.slugs
  }
  const plan = resolveCraftRequirements({
    requires: lists.requires,
    applies: lists.applies,
    suggested: lists.suggested,
    exemptions: lists.exemptions,
  })
  const describe = (slug: string) => {
    const lookup = readCraftSection(slug)
    return lookup.kind === 'found' ? lookup.section : { slug }
  }
  return {
    kind: 'plan',
    // The answer carries both the slugs and what each one costs, because a caller
    // that composes a plan is about to pay for it in the next call.
    load: plan.load.map(describe),
    advisory: plan.advisory.map(describe),
    exempted: plan.exempted,
    misses: plan.misses,
    note: 'load is what a run would inject; advisory is offered by a design system but not forced; exempted is removed by a brand that breaks the rule on purpose.',
  }
}

/** Dispatch one call, validating the arguments the schema cannot express. */
function runCraft(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return refusal('', 'invalid-arguments', 'Provide a JSON object with an action of "list", "get" or "resolve".')
  }
  const args = input as CraftToolArgs
  const action = args.action
  if (action !== 'list' && action !== 'get' && action !== 'resolve') {
    // Not `String(action)`: a caller that passed an object would be told its action
    // was `[object Object]`, which reads like a name the tool recognises.
    return refusal(typeof action === 'string' ? action : '', 'unknown-action', 'action must be one of "list", "get" or "resolve".')
  }
  if (action === 'list') return runList()
  if (action === 'resolve') return runResolve(args)
  const parsed = slugList(action, 'sections', args.sections)
  if (parsed.kind === 'refused') return parsed.refusal
  return runGet(parsed.slugs)
}

/**
 * The tool definition this package ships, built on demand.
 *
 * The definition rather than a registration: the design pack registers tools by
 * name and reports the names that registered, so `design/features.ts` lists
 * {@link CRAFT_TOOL_NAME} and `design/tools.ts` supplies this builder under that
 * same name. One name, one builder — a literal at each site is a row that can
 * advertise a tool this build never registered.
 *
 * @returns the definition, named {@link CRAFT_TOOL_NAME}.
 */
export function craftToolDefinition(): ToolDefinitionShape {
  return toolDefinition({
    name: CRAFT_TOOL_NAME,
    description: 'Read the bundled craft layer: eleven brand-agnostic rulebooks on typography, colour, animation discipline, accessibility, form validation, the laws of UX, RTL, state coverage and anti-AI-slop that apply on top of whatever design system is in use. action "list" returns every section with its size and the slugs upstream has registered as planned; "get" returns up to four bodies by slug; "resolve" runs the composition rule — requires plus applies, minus exemptions, with suggested offered as advisory — and reports each miss as planned, unshipped or malformed rather than dropping it. The rules assume a DESIGN.md-style token contract (--bg, --surface, --fg, --muted, --border, --accent) and say so where they rely on it; where a section cites paths from the upstream repository (apps/daemon/src/lint-artifact.ts, design-systems/), those name where upstream auto-checks the rule and do not exist in this workspace. Read-only: package assets only, no network, no browser, and neither reads nor writes the project workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'resolve'], description: 'list — what exists; get — read sections; resolve — compose a requirement set.' },
        sections: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_SLUG_LENGTH },
          maxItems: CRAFT_SECTIONS_PER_CALL,
          description: `Slugs to read, at most ${String(CRAFT_SECTIONS_PER_CALL)}. Required by "get".`,
        },
        requires: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_SLUG_LENGTH },
          maxItems: MAX_SLUGS_PER_CALL,
          description: 'For "resolve": sections the task or Skill demands.',
        },
        applies: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_SLUG_LENGTH },
          maxItems: MAX_SLUGS_PER_CALL,
          description: 'For "resolve": sections the active design system forces.',
        },
        suggested: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_SLUG_LENGTH },
          maxItems: MAX_SLUGS_PER_CALL,
          description: 'For "resolve": sections the active design system offers without forcing.',
        },
        exemptions: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_SLUG_LENGTH },
          maxItems: MAX_SLUGS_PER_CALL,
          description: 'For "resolve": sections the active design system exempts itself from.',
        },
      },
    },
    output: JSON_TOOL_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args: CraftToolArgs) => runCraft(args),
    presentCall: (args: CraftToolArgs) => ({
      card: 'generic',
      title: `Design craft: ${typeof args.action === 'string' ? args.action : ''}`,
    }),
  })
}
