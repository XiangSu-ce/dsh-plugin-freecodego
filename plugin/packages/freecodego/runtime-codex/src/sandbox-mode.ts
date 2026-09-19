/**
 * The `thread/start` / `thread/resume` sandbox fields for one native session.
 *
 * The bug this module fixes
 * -------------------------
 * The Harness owns the session's file policy and the app surfaces a picker for
 * it (`freecodego`'s `sandboxModeSet`), but only one thing ever crossed into
 * Codex: `readOnly === true`, which is the *engineering council child* floor.
 * A user who selected `read-only`, `workspace-write`, or `danger-full-access`
 * had the mode applied to the Harness tools and ignored by the engine the model
 * was actually running on, so the two halves of one session disagreed and the
 * engine kept its own default.
 *
 * Why there is no translation table
 * ---------------------------------
 * The Codex App Server's `SandboxMode` enum is `read-only | workspace-write |
 * danger-full-access` — the Harness vocabulary verbatim (read from
 * `.tmp-codex-schema/v2/ThreadStartParams.json`). So the mode crosses as-is;
 * the only decision left is the approval policy beside it.
 *
 * Approval policy, and why two of the three modes leave it alone
 * -------------------------------------------------------------
 * - The council floor keeps `never`: a reviewer child is built to be unable to
 *   ask for anything, and that behaviour is deliberately unchanged.
 * - A *user-chosen* `read-only` gets `on-request`, not `never`. The Harness's own
 *   read-only sessions can escalate with an approval
 *   (`ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']`); `never`
 *   would make the engine's escalation request impossible to express, turning a
 *   deliberate policy into a dead end. Under `on-request` that request arrives
 *   on the plugin's approval seam and the user decides.
 * - `workspace-write` and `danger-full-access` pass no approval policy: the
 *   Harness's `ask | never` has no lossless counterpart in Codex's
 *   `untrusted | on-request | never`, and picking one would change how often
 *   users are prompted. The engine default plus the plugin's approval seam
 *   already govern, and this module only adds the file policy.
 *
 * Deliberately not modelled: network. The Harness states that network and
 * process visibility are outside its file-effect vocabulary, while Codex's
 * `read-only` sandbox does refuse network. That is stricter than the Harness
 * mode asks for; it is left as the engine's own containment rather than being
 * compensated for, and it is called out here so the difference is not a
 * surprise.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/sandbox-mode
 */

import {
  effectiveSandboxMode,
  type NativeSandboxMode,
  type NativeSessionSandboxFields,
} from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'

/** The subset of `AskForApproval` this runtime ever sends (the protocol also allows a granular object form). */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'

/** Fields spread into `thread/start` and `thread/resume`; empty when no policy crossed. */
export interface CodexThreadSandboxParams {
  readonly sandbox?: NativeSandboxMode
  readonly approvalPolicy?: CodexApprovalPolicy
}

/**
 * Map one session's wire fields onto the App Server's thread sandbox fields.
 *
 * @param fields - The `readOnly` floor and resolved `sandboxMode` from `session/create`.
 * @returns The fields to spread into the thread request, or `{}` when the
 * boundary carried no policy (the engine's own default then stands).
 */
export function codexThreadSandboxParams(fields: NativeSessionSandboxFields): CodexThreadSandboxParams {
  const mode = effectiveSandboxMode(fields)
  if (mode === undefined) return {}
  if (mode !== 'read-only') return { sandbox: mode }
  // `readOnly` is the council floor: a child that exists to review must not be
  // able to negotiate its way to a wider sandbox.
  return fields.readOnly === true
    ? { sandbox: 'read-only', approvalPolicy: 'never' }
    : { sandbox: 'read-only', approvalPolicy: 'on-request' }
}
