/**
 * Project the Harness's answer onto the Codex App Server's own response for
 * `item/tool/requestUserInput`.
 *
 * The gap this closes
 * -------------------
 * `approval-response.ts` translates the Host's neutral outcome into each
 * approval method's own response vocabulary, and its module doc records why:
 * forwarding the neutral object verbatim sends a shape the App Server's schema
 * does not define. The *question* path was left forwarding verbatim, and the two
 * shapes are not the same one:
 *
 * | owner | shape |
 * | --- | --- |
 * | Host (`userQuestions.ask`) | `{ answers: [ { id, selected: string[], custom?: string } ] }` |
 * | App Server (`ToolRequestUserInputResponse`) | `{ answers: { <questionId>: { answers: string[] } } }` |
 *
 * The Host's is an array of per-question records because that is what the shared
 * `AskUserQuestionAnswer` type declares and what the in-app composer produces.
 * The App Server's is an object keyed by question id, each value an array of
 * answer strings. Sending the array where the object is expected is a
 * deserialization failure in the App Server, so a user's answer to a Codex
 * `request_user_input` never reached the model — the same failure the approval
 * path had, one method over. The names above are read from the App Server's
 * published protocol schemas (`ToolRequestUserInputParams.json` /
 * `ToolRequestUserInputResponse.json`), not inferred.
 *
 * How the two fields become one array
 * -----------------------------------
 * `AskUserQuestionAnswerItem` carries the checked labels in `selected` and the
 * free-text "Other" answer in `custom`, and the composer's rule is that a
 * *single-select* custom answer replaces the selection while a multi-select one
 * keeps both (`QuestionComposer.submitDrafts`). The App Server's answer is one
 * flat `string[]`, so the projection concatenates `selected` then `custom`: a
 * single-select custom answer arrives as `[custom]`, a multi-select one as the
 * labels plus the free text, and neither field is ever dropped. A skipped
 * question arrives as an empty array, which is what "answered with nothing"
 * means on both sides.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/question-response
 */

/** One question's answer, as the App Server declares it. */
export interface CodexQuestionAnswer {
  /** The selected labels, followed by any free-text answer. */
  readonly answers: readonly string[]
}

/** The App Server's response payload: answers keyed by question id. */
export interface CodexQuestionResponse {
  readonly answers: Record<string, CodexQuestionAnswer>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Project one Host answer onto the App Server's response for
 * `item/tool/requestUserInput`.
 *
 * A value that is not the Host's answer shape — a rejection, a cancellation, the
 * `{ answers: [] }` the Host sends when its question service failed — becomes an
 * empty `answers` object. That is the one response the schema accepts for "no
 * answers", and it is the App Server's own meaning for a question the user did
 * not answer, rather than a shape it cannot read.
 *
 * Two entries for one question id cannot be represented in an object, so their
 * answers are concatenated in arrival order instead of one silently winning;
 * losing a user's typed answer is the one outcome worth avoiding here.
 *
 * @param answer - the Host's `AskUserQuestionAnswer`, or anything else.
 * @returns a payload matching `ToolRequestUserInputResponse`.
 */
export function questionResponse(answer: unknown): CodexQuestionResponse {
  const entries = record(answer).answers
  const answers: Record<string, CodexQuestionAnswer> = {}
  if (!Array.isArray(entries)) return { answers }
  for (const entry of entries) {
    const item = record(entry)
    const id = typeof item.id === 'string' ? item.id : ''
    if (id === '') continue
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((value): value is string => typeof value === 'string')
      : []
    const custom = typeof item.custom === 'string' && item.custom !== '' ? [item.custom] : []
    const collected = [...selected, ...custom]
    // An entry the composer marked answered but with nothing in it still has to
    // exist: the App Server keys its own questions off this map.
    answers[id] = { answers: [...(answers[id]?.answers ?? []), ...collected] }
  }
  return { answers }
}
