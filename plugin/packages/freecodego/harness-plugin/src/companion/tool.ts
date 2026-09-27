/**
 * The model-facing companion tool: what the character's face should say.
 *
 * The companion is an SVG character the client draws beside the composer, and its face is
 * derived from the session — a ladder reads the Session list, the jobs, and the event log
 * and decides which state is drawn (`harness-ui`'s `companion/arbiter.ts`). This tool is
 * the one way the model itself can ask for an expression on top of that.
 *
 * Why the tool writes nothing
 * ---------------------------
 * A call is already a session fact: it lands in the event window with its name and its
 * arguments, where the client's own feed reads it (`companion/activity.ts`). So this
 * module has no host service, no session handle, and no side effect — it validates what it
 * was asked for and says what will happen. That has three consequences worth stating,
 * because each of them would otherwise be a defect to find later:
 *
 * - there is no second channel that can fall out of step with the first;
 * - a face costs no durable event, only the call the model was going to make anyway;
 * - and the request is **visible in the transcript** as it happens, which is the property
 *   that makes an unexplained grin on the character diagnosable rather than mysterious.
 *
 * What it deliberately does not do
 * --------------------------------
 * It cannot change what the companion *says*. Its label and accessible status text are
 * derived from the session and stay that way, which is why the vocabulary here is
 * emotional and the copy says so: a model that could set the label could report a status
 * the session is not in, and a reader would have no way to tell the two apart.
 *
 * The names are declared here because they are the model-facing contract (this is the
 * schema the model is shown); the outlines they are drawn with are the client's business
 * (`companion/eyes/faces.ts`). A spec in that package reads {@link COMPANION_FACES} and
 * fails if the two lists ever drift.
 *
 * @module companion/tool
 */

import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'

/** Registered tool name; prefixed so Harness deferral and Plan Mode classify it. */
export const COMPANION_FACE_TOOL_NAME = 'freecodego_companion_face'

/**
 * The expressions the model may ask for, in the order the description offers them.
 *
 * Shorter than the client's outline vocabulary on purpose, and every name maps to a shape
 * that vocabulary already draws: a name the character has no face for would be a request
 * that silently does nothing. `neutral` is first because it is the one that *undoes* a
 * mood, which is what a caller reaches for when the moment has passed.
 */
export const COMPANION_FACES = [
  'neutral',
  'happy',
  'delighted',
  'sad',
  'focused',
  'sleepy',
  'surprised',
] as const

/** One expression a caller may ask for. */
export type CompanionFace = (typeof COMPANION_FACES)[number]

/**
 * Whether a value is one of {@link COMPANION_FACES}.
 *
 * The schema's `enum` is what a well-behaved caller is held to; this is what a caller that
 * ignored it is held to, and the difference matters because the alternative answer to a
 * typo is a face that quietly does not change.
 * @param value - any value a call carried.
 * @returns whether it names an expression.
 */
export function isCompanionFace(value: unknown): value is CompanionFace {
  return typeof value === 'string' && COMPANION_FACES.some(face => face === value)
}

/** The arguments, as the schema admits them. */
interface CompanionFaceArgs {
  readonly face?: unknown
}

/** What a call answers with, in the vocabulary this pack's other tools refuse in. */
function runCompanionFace(args: CompanionFaceArgs): unknown {
  if (!isCompanionFace(args.face)) {
    return {
      kind: 'refused',
      reason: 'unknown-face',
      message: `\`face\` must be one of ${COMPANION_FACES.map(face => JSON.stringify(face)).join(', ')}.`,
      available: COMPANION_FACES,
    }
  }
  return {
    kind: 'face',
    face: args.face,
    note: `The companion is wearing ${JSON.stringify(args.face)} for a few seconds. This changes its face only — its label and status text still describe what the session is doing — and the previous expression returns when the hold expires.`,
  }
}

/**
 * The tool definition this package registers.
 *
 * A definition rather than a registration, like the rest of this package's tools: the
 * plugin's own registration site is what decides when a tool lands, so a definition that
 * registered itself could be reachable from a build that never armed it.
 * @returns the definition, named {@link COMPANION_FACE_TOOL_NAME}.
 */
export function companionFaceToolDefinition(): ToolDefinitionShape {
  return toolDefinition({
    name: COMPANION_FACE_TOOL_NAME,
    description: 'Ask the companion character — the small figure drawn beside the composer — to wear an expression: neutral, happy, delighted, sad, focused, sleepy or surprised. Call it once when a step of work ends in a way worth seeing — something landed, an attempt failed, the result was not what anyone expected, a long stretch of attention is starting, a task is a slog — rather than once per message. It changes the character\'s face and nothing else: the text beside it is derived from the session, so this is not a status channel and must not be used to report progress. The expression holds for a few seconds and then the face goes back to whatever the session is doing; call it again with "neutral" to end one early. No side effects: nothing is read, written, run or fetched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['face'],
      properties: {
        face: {
          type: 'string',
          enum: [...COMPANION_FACES],
          description: 'The expression to wear: neutral | happy | delighted | sad | focused | sleepy | surprised.',
        },
      },
    },
    output: JSON_TOOL_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args: CompanionFaceArgs) => runCompanionFace(args),
    presentCall: (args: CompanionFaceArgs) => ({
      card: 'generic',
      title: `Companion face: ${typeof args.face === 'string' ? args.face : ''}`,
    }),
  })
}
