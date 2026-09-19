/**
 * Isolation reporting: never conflate "we asked for it" with "it is in effect".
 *
 * Why
 * ---
 * A read-only team member that can still write is worse than no read-only role,
 * because the caller plans around a restriction that is not there. Codex's
 * `network-proxy` refuses to bind non-loopback unless explicitly allowed, and
 * claudecode's Rust port reports isolation as three separate facts —
 * `requested`, `supported`, `active` — plus a `fallback_reason` and separate
 * namespace/network/filesystem sub-states. That shape is the lesson: a single
 * boolean cannot express "we asked, the platform said yes, and the effective
 * configuration still is not what we asked for".
 *
 * This module reports what *this* plugin can actually stand behind:
 *
 * - `tool-scope` enforcement is ours, and it is real. `resolveRoleTools`
 *   intersects a role's allow list with its capabilities and removes write and
 *   shell tools, and the Harness derives the callable set from the same data, so
 *   a read-only member cannot reach a write tool. That holds on every platform.
 * - `harness-policy` enforcement is the session sandbox mode and approval policy.
 *   We set them; we can read back what was set; we cannot verify what a given
 *   provider or platform does with it. So the report says `applied` (we set it
 *   and it reads back) rather than `enforced`.
 * - When neither holds, `enforcedBy` is `none` and a fallback reason is present,
 *   because the one outcome that must never be silent is "the restriction you
 *   asked for was not applied".
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/isolation-report
 */

export type IsolationEnforcement = 'tool-scope' | 'harness-policy' | 'both' | 'none'

export interface IsolationReport {
  /** What the caller asked for. */
  readonly requested: 'read-only' | 'workspace-write'
  /** Which mechanism actually restricts the member, as far as we can verify. */
  readonly enforcedBy: IsolationEnforcement
  /** True when the sandbox mode was set and reads back as the requested one. */
  readonly policyApplied: boolean
  /** True when the role's tool allow list was narrowed to exclude writes. */
  readonly toolScopeApplied: boolean
  /** A private worktree was allocated, so writes cannot reach the shared tree. */
  readonly worktree?: string | undefined
  /** Present whenever the requested restriction is not fully in effect. */
  readonly fallbackReason?: string | undefined
  /**
   * The deny list's own reach, when one is configured.
   *
   * `enforcedBy: 'none'` with patterns present is a real answer — it means every
   * pattern was dropped as unusable, and the reader has to see that rather than
   * the member's own `restricted` flag, which is about tool scope and the sandbox
   * policy alone.
   */
  readonly denyEnforcement?: { readonly enforcedBy: 'tool-scope' | 'none'; readonly fallbackReason?: string } | undefined
  /**
   * Whether a mechanism we control narrows the member: tool scope or the session
   * sandbox policy. This is the field to branch on before treating a member as
   * constrained, and it deliberately ignores the worktree — see
   * {@link IsolationReport.contained} for that separate fact.
   */
  readonly restricted: boolean
  /**
   * Whether the member's writes cannot reach the shared tree.
   *
   * A private worktree contains writes without preventing them, and a
   * workspace-write member with no worktree and no sandbox policy is neither
   * restricted nor contained. Reporting containment under `restricted` made the
   * member look constrained on the strength of a worktree it did not have.
   */
  readonly contained: boolean
}

export interface IsolationInput {
  readonly requested: 'read-only' | 'workspace-write'
  /**
   * How far the sandbox deny list reaches, when one is configured.
   *
   * Attached rather than recomputed: `sandbox/profiles.ts` already answers this,
   * and the point of attaching it here is that a member's report and the deny
   * list's report are read together — the restriction a caller plans around is
   * the weaker of the two, which is invisible when they are printed apart.
   */
  readonly denyEnforcement?: { readonly enforcedBy: 'tool-scope' | 'none'; readonly fallbackReason?: string }
  /** Whether `setSandboxMode` was called without throwing and reads back. */
  readonly policyApplied: boolean
  /**
   * Whether the role's resolved tool set actually excludes write/shell tools.
   * For a writing role this is false by design and is not a failure.
   */
  readonly toolScopeApplied: boolean
  readonly worktree?: string | undefined
}

/**
 * Compose the report.
 *
 * `restricted` is true only when a mechanism we control actually narrows the
 * member, and it is computed the same way for both requests: tool scope or the
 * sandbox policy. It used to be hard-coded `true` for a writing member, which
 * reported an unconfined writer as restricted and described it as sitting in a
 * worktree it did not have. Containment is its own field, because a worktree
 * contains writes without preventing them.
 */
export function buildIsolationReport(input: IsolationInput): IsolationReport {
  const enforcedBy: IsolationEnforcement = input.toolScopeApplied && input.policyApplied
    ? 'both'
    : input.toolScopeApplied
      ? 'tool-scope'
      : input.policyApplied
        ? 'harness-policy'
        : 'none'
  const restricted = enforcedBy !== 'none'
  const contained = input.worktree !== undefined || input.policyApplied
  return {
    requested: input.requested,
    enforcedBy,
    policyApplied: input.policyApplied,
    toolScopeApplied: input.toolScopeApplied,
    ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    ...(restricted
      ? {}
      : {
        fallbackReason: input.requested === 'read-only'
          ? 'no mechanism restricted this read-only member: the sandbox mode was not applied and the tool scope did not exclude writes, so it is not a read-only member'
          : 'no mechanism confined this workspace-write member: the sandbox mode was not applied and it has no private worktree, so its writes reach the shared tree',
      }),
    ...(input.denyEnforcement === undefined ? {} : { denyEnforcement: input.denyEnforcement }),
    restricted,
    contained,
  }
}

/**
 * Whether the deny list narrows what this member can reach.
 *
 * Separate from {@link IsolationReport.restricted}, which is about tool scope and
 * the sandbox policy: a deny list is a second, narrower mechanism, and a member
 * can be restricted by scope while a deny list covers nothing. The two are
 * combined in {@link describeIsolation}, where a reader is composing one sentence
 * rather than branching on facts.
 * @param report - the member's report.
 * @returns true when a deny list is configured and usable.
 */
export function denyListApplies(report: IsolationReport): boolean {
  return report.denyEnforcement?.enforcedBy === 'tool-scope'
}

/** One-line summary for a member row. */
export function describeIsolation(report: IsolationReport): string {
  // The deny list's caveat is appended to whatever the row already says, and it is
  // appended to *every* branch: a member confined by tool scope is still subject
  // to the deny list's limits, and a line that mentioned them only for the
  // unrestricted case would read as though the confined case had none.
  const denyCaveat = report.denyEnforcement?.fallbackReason === undefined
    ? ''
    : ` (deny list: ${report.denyEnforcement.fallbackReason})`
  const base = describeIsolationBase(report)
  return denyCaveat === '' ? base : `${base}${denyCaveat}`
}

/** The member's own one-line summary, before the deny list's caveat. */
function describeIsolationBase(report: IsolationReport): string {
  if (report.requested === 'workspace-write') {
    // A worktree is the containment fact, and it is reported whether or not the
    // policy also applied — but it is never claimed when there is no worktree.
    if (report.worktree !== undefined) return `workspace-write member with a private worktree at ${report.worktree}`
    if (report.restricted) return 'workspace-write member confined to the workspace by the session sandbox policy; it shares the tree with its peers'
    return `workspace-write member is NOT contained${report.fallbackReason === undefined ? '' : `: ${report.fallbackReason}`}`
  }
  if (!report.restricted) return `read-only member is NOT restricted${report.fallbackReason === undefined ? '' : `: ${report.fallbackReason}`}`
  const via = report.enforcedBy === 'both' ? 'tool scope and the session sandbox policy'
    : report.enforcedBy === 'tool-scope' ? 'tool scope (no write or shell tools are callable)'
      : 'the session sandbox policy'
  return `read-only member restricted by ${via}`
}
