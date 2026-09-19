/**
 * Answer one Codex App Server request in the shape that method expects.
 *
 * Two separate jobs live here, and both were wrong before this module existed.
 *
 * ### 1. Which requests are approvals at all
 *
 * The worker used to treat *any* App Server request as a pending approval, so
 * every server→client method became a user prompt: `attestation/generate`,
 * `account/chatgptAuthTokens/refresh`, `mcpServer/elicitation/request`, and
 * `item/tool/call` all asked the user to "approve" something, and the user's
 * answer was then sent as that method's result. Those four are protocol
 * handshakes, not decisions a person can make — their responses require data
 * (`token`, `accessToken`, `action`, `contentItems`) that no approval outcome
 * carries. {@link isApprovalMethod} keeps them out of the prompt path; the worker
 * answers them with an explicit error instead, which is diagnosable, where a
 * meaningless result was not.
 *
 * ### 2. The response vocabulary
 *
 * The Host answers a pending native approval with one neutral outcome —
 * `{ type: 'approved' }` or `{ type: 'rejected' }` — because that is what the
 * in-process Claude session's permission callback consumes. The App Server has
 * no such vocabulary: every approval method declares its own response schema,
 * and each requires a `decision`/`permissions` field whose allowed values differ
 * per method:
 *
 * | method | response |
 * | --- | --- |
 * | `item/commandExecution/requestApproval` | `{ decision: 'accept' \| 'acceptForSession' \| 'decline' \| 'cancel' }` |
 * | `item/fileChange/requestApproval` | `{ decision: 'accept' \| 'acceptForSession' \| 'decline' \| 'cancel' }` |
 * | `applyPatchApproval`, `execCommandApproval` | `{ decision: 'approved' \| 'approved_for_session' \| { denied: … } \| 'abort' }` |
 * | `item/permissions/requestApproval` | `{ permissions: RequestPermissionProfile, scope?: 'turn' \| 'session' }` |
 *
 * A refusal is the object `{ denied: { rejection } }`, never the string
 * `'denied'`: the union declares no such string, so a bare `'denied'` matched
 * none of its variants and the App Server could not read the answer at all.
 * `rejection` is required, and the Host can supply it — a refusal its own guard
 * produced arrives as `{ type: 'rejected', message }` — so the model learns why
 * the call was refused instead of the answer being dropped.
 *
 * The worker used to forward the neutral object verbatim as the RPC result, so
 * the App Server received `{"type":"approved"}` where its own schema requires
 * `{"decision":"accept"}` — the user's answer was never expressed in a form the
 * protocol defines. The names and vocabularies above are read from the App
 * Server's published protocol schemas, not inferred.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/approval-response
 */

/** App Server approval methods whose decision vocabulary is accept/decline. */
const ACCEPT_DECLINE_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])

/** App Server approval methods whose decision vocabulary is approved/denied. */
const APPROVED_DENIED_METHODS = new Set(['applyPatchApproval', 'execCommandApproval'])

/** The permission-escalation request, whose response grants a profile rather than a decision. */
const PERMISSIONS_METHOD = 'item/permissions/requestApproval'

/**
 * Whether one App Server request is a decision the user can be asked for.
 *
 * The user-input request is handled as a question before this is consulted; the
 * four excluded methods are protocol handshakes whose responses need data this
 * transport has no way to produce.
 *
 * @param method - the App Server request method.
 * @returns true only for the methods an approval prompt can answer.
 */
export function isApprovalMethod(method: string): boolean {
  return ACCEPT_DECLINE_METHODS.has(method) || APPROVED_DENIED_METHODS.has(method) || method === PERMISSIONS_METHOD
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * A string that carries something, or `undefined`.
 *
 * Used for the optional text an outcome may carry: an empty string is an
 * absent message, not a message that says nothing.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Project the Host's neutral outcome onto the App Server's own response for one
 * approval method.
 *
 * Only `{ type: 'approved' }` counts as a grant. Every other value — a rejection,
 * a cancellation, an outcome the Host failed to produce — becomes the refusal
 * that lets the agent continue the turn, which is the App Server's own
 * documented meaning for `decline`/`denied`.
 *
 * A permission escalation has no refusal sentinel in its schema, so a refusal is
 * expressed as an empty profile: it grants nothing, which is exactly what the
 * App Server's own `RequestPermissionProfile` shape means when every field is
 * absent. An approval echoes back the profile that was *requested* — never more —
 * and scopes it to the turn, the narrowest the schema offers, because the Host's
 * `allowed-once` is a one-shot grant rather than a session setting.
 *
 * @param method - the App Server method the approval request arrived as.
 * @param response - the Host's neutral outcome.
 * @param params - the request params, which carry the requested permission profile.
 * @returns the response to send as the RPC result.
 */
export function approvalResponse(method: string, response: unknown, params?: unknown): unknown {
  const outcome = record(response)
  const approved = outcome.type === 'approved'
  if (ACCEPT_DECLINE_METHODS.has(method)) return { decision: approved ? 'accept' : 'decline' }
  if (APPROVED_DENIED_METHODS.has(method)) {
    if (approved) return { decision: 'approved' }
    // A refusal is an object, not the string `denied`: `ReviewDecision` declares
    // no such string, so the eight-variant union matched nothing and the App
    // Server could not read the answer at all. `rejection` is required, and the
    // Host can supply it -- a refusal its own guard produced arrives as
    // `{ type: 'rejected', message }` -- which is the model's only account of
    // why the call was refused.
    const rejection = nonEmptyString(outcome.message) ?? 'User denied this request'
    return { decision: { denied: { rejection } } }
  }
  if (method === PERMISSIONS_METHOD) {
    const requested = record(record(params).permissions)
    return approved
      ? { permissions: requested, scope: 'turn' }
      : { permissions: {} }
  }
  // Unreachable through the worker's approval path; kept so a future caller
  // cannot turn an unreadable method into a fabricated decision.
  return response
}
