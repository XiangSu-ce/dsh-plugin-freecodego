/**
 * Mutation probes for the security spine: a guard that is no longer load-bearing
 * is a guard that is gone.
 *
 * Why this exists
 * ---------------
 * Every defect this suite's probes name was found by hand, by reverting the fix
 * and watching a test go red — and every one of them had a test that *looked*
 * like it covered the guard while the guard could be deleted without any test
 * noticing. `command-policy.ts` stated its recursive-deletion rule in a
 * `notMatch` example that the broken matcher also satisfied; `memory-security.ts`
 * had a whole tier of findings that no test asserted anything about. A rule set
 * that tests its own examples is not the same as a rule set whose *decision* is
 * pinned, and the difference is only visible under mutation.
 *
 * Two halves, deliberately split by cost:
 *
 * - **Anchors** run in the default suite. Each probe declares the exact source
 *   text it mutates; if that text moves, the probe fails loudly instead of
 *   silently mutating nothing — which is the only failure mode a mutation harness
 *   has that looks like success.
 * - **Probe runs** are opt-in, because each one spawns a real vitest process:
 *   `FREECODEGO_GUARD_PROBES=1 npx vitest run tests/guard-probes.spec.ts`.
 *   A probe passes when the mutated source makes its named specs fail.
 *
 * The mutations are reverted in a `finally`, and the anchor half of this file
 * also fails if a mutation is left applied, so an interrupted run cannot leave
 * the tree silently patched.
 *
 * **Do not enable this by default, even though it runs in seconds.** A probe
 * writes a broken implementation to a source file while the runner is already
 * executing other spec files in parallel. A worker that imports that module
 * *after* the mutation lands reads the broken version, so enabling this would
 * leak failures into unrelated tests — intermittently, and only under load. Run
 * it as its own invocation, which is what the env gate is for.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/guard-probes
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface GuardProbe {
  /** What the probe proves, in the terms of the defect it guards. */
  readonly name: string
  /** Source file to mutate, relative to this package. */
  readonly file: string
  /** The exact current text. Anchor rot is a failure, not a skip. */
  readonly from: string
  /** The mutation: the *broken* implementation, written how it was written. */
  readonly to: string
  /** Specs that must fail when the mutation is applied, relative to the plugin root. */
  readonly specs: readonly string[]
}

const PACKAGE = resolve(import.meta.dirname, '..')
const PLUGIN_ROOT = resolve(PACKAGE, '../../..')

const PROBES: readonly GuardProbe[] = [
  {
    name: 'a force flag is not recursion, so `rm -f out.js` must not be a hard denial',
    file: 'src/command-policy.ts',
    from: "pattern: ['rm', ['-rf', '-fr', '-r', '-R', '--recursive']],",
    to: "pattern: ['rm', ['-rf', '-fr', '-r', '-R', '-f', '--recursive']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'privilege escalation is refused whatever follows sudo, so `sudo apt-get update` cannot pass',
    file: 'src/command-policy.ts',
    from: "pattern: ['sudo'],",
    to: "pattern: ['sudo', ['-n', '-E', '-H', '-u', '-i', '-s']],",
    specs: [
      'packages/freecodego/harness-plugin/tests/command-policy.spec.ts',
      'packages/freecodego/harness-plugin/tests/native-tool-guard.spec.ts',
    ],
  },
  {
    name: 'the denial masks the credential the refused command carries, instead of quoting it out',
    file: 'src/command-policy.ts',
    from: '  const quoted = redactCredentialShapes(command.trim()).slice(0, 200)',
    to: '  const quoted = command.trim().slice(0, 200)',
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'a world-writable recursive chmod is refused however its flag and mode are spelled',
    file: 'src/command-policy.ts',
    from: "      pattern: ['chmod', ['-R', '-r', '--recursive'], ['777', '0777', '666', '0666']],",
    to: "      pattern: ['chmod', ['-R', '-r'], ['777', '666']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'a recursive chmod whose mode the list cannot name asks, instead of defaulting to allow',
    file: 'src/command-policy.ts',
    from: "      pattern: ['chmod', ['-R', '-r', '--recursive']],\n      decision: 'prompt',",
    to: "      pattern: ['chmod', ['-R', '-r', '--recursive']],\n      decision: 'allow',",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'the audit reads the same chmod spellings the guard decides, not one flag and one mode',
    file: 'src/dangerous-command-patterns.ts',
    from: '  /\\bchmod\\s+(?:-[A-Za-z]*[Rr][A-Za-z]*|--recursive)\\s+0*[0-7]?(?:777|666)\\b/,',
    to: '  /\\bchmod\\s+-R\\s+777\\b/,',
    specs: ['packages/freecodego/harness-plugin/tests/skills.spec.ts'],
  },
  {
    name: 'a Windows path names one program token, so its rules are reached',
    file: 'src/command-policy.ts',
    // The anchor carries the whole condition. `revert()` repairs the file by
    // replacing the first occurrence of `to` and declines when it is not unique,
    // so the bare `')'` this probe used to declare could never be taken back out:
    // the file holds 276 closing parentheses, the revert declined, and the tree
    // kept the mutation after every full run.
    from: 'index + 1 < command.length && !WINDOWS_PATH_START.test(current)) {',
    to: 'index + 1 < command.length) {',
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'a rule is decided on the program Windows actually names, whatever its extension',
    file: 'src/command-policy.ts',
    from: '    const actual = index === 0 ? programName(argv[index]!) : argv[index]!',
    to: '    const actual = index === 0 ? basename(argv[index]!) : argv[index]!',
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'the shell rule and the pipeline reader answer "is this a shell?" from one list',
    file: 'src/command-policy.ts',
    from: '      pattern: [SHELL_INTERPRETERS, SHELL_LINE_FLAGS],',
    to: "      pattern: [['sh', 'bash', 'zsh', 'dash', 'ksh', 'script'], ['-c']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'an inline program string is asked about instead of silently allowed',
    file: 'src/command-policy.ts',
    from: "      pattern: [['node', 'nodejs', 'deno', 'bun'], ['-e', '--eval', '-p', '--print']],",
    to: "      pattern: [['node'], ['-e', '--eval', '-p', '--print']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'a long option decides the same way with its value attached by `=`',
    file: 'src/command-policy.ts',
    from: "  if (alternative.startsWith('--')) return actual.startsWith(`${alternative}=`)",
    to: "  if (alternative.startsWith('--')) return false",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    name: 'a transport status outranks cancellation wording, so a 429 is not a silent cancel',
    file: 'src/provider-error-classify.ts',
    from: '  if (status !== undefined) return fromStatus(status, message)',
    to: '  if (status !== undefined && !isCancellationWording(message)) return fromStatus(status, message)',
    specs: ['packages/freecodego/harness-plugin/tests/provider-error-classify.spec.ts'],
  },
  {
    name: 'a changed path resolves against the repository root, not the session workspace',
    file: 'src/inspect/host.ts',
    from: '  const base = repository ?? workspace',
    to: '  const base = workspace',
    specs: ['packages/freecodego/harness-plugin/tests/inspect-host.spec.ts'],
  },
  {
    name: 'the hook seam is registered before the compressor that shares its waterfall',
    file: 'src/index.ts',
    from: '    this.registerHookRuntime(ctx)',
    to: '    this.headroom.start()\n    this.registerHookRuntime(ctx)',
    specs: ['packages/freecodego/harness-plugin/tests/hook-seams.spec.ts'],
  },
  {
    name: 'an unprefixed tool of the plugin’s own cannot sit outside every classification',
    file: 'src/plan-mode.ts',
    from: "  'inspect',\n  'spill_recall',\n  'read_document',\n  // Advisor and its read-only evidence tools.",
    to: "  'inspect',\n  'spill_recall',\n  // Advisor and its read-only evidence tools.",
    specs: ['packages/freecodego/harness-plugin/tests/plan-mode-coverage.spec.ts'],
  },
  {
    name: 'the path-key vocabulary covers the notebook spelling both surfaces use',
    file: 'src/sandbox/profiles.ts',
    from: "export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath', 'filename', 'target_file', 'targetFile', 'locator', 'file'] as const",
    to: "export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'filename', 'target_file', 'targetFile', 'locator', 'file'] as const",
    specs: [
      'packages/freecodego/harness-plugin/tests/sandbox-profiles.spec.ts',
      'packages/freecodego/harness-plugin/tests/tool-guards.spec.ts',
    ],
  },
  {
    name: 'a search names its target through a filter as well as through a path',
    file: 'src/sandbox/profiles.ts',
    from: "export const PATH_FILTER_ARGUMENT_KEYS = ['include', 'glob'] as const",
    to: 'export const PATH_FILTER_ARGUMENT_KEYS = [] as const',
    specs: [
      'packages/freecodego/harness-plugin/tests/sandbox-profiles.spec.ts',
      'packages/freecodego/harness-plugin/tests/tool-guards.spec.ts',
    ],
  },
  {
    name: 'a braced filter is expanded so each alternative is judged, not concatenated',
    file: 'src/sandbox/profiles.ts',
    from: '  return alternatives.flatMap(alternative => expandFilterBraces(`${prefix}${alternative}${suffix}`))',
    to: '  return [value]',
    specs: [
      'packages/freecodego/harness-plugin/tests/sandbox-profiles.spec.ts',
      'packages/freecodego/harness-plugin/tests/tool-guards.spec.ts',
    ],
  },
  {
    name: 'a content search is on the shield’s list, so a search rooted at `.env` is refused',
    file: 'src/tool-guards.ts',
    from: "  'grep',",
    to: "  'grep_',",
    specs: ['packages/freecodego/harness-plugin/tests/tool-guards.spec.ts'],
  },
  {
    name: 'a registered worktree is recognised through another spelling of the same path',
    file: 'src/team/worktree.ts',
    from: '    if (owned !== undefined && (owned.branch !== branch || !sameLocation(owned.path, path))) {',
    to: '    if (owned !== undefined && (owned.branch !== branch || owned.path !== path)) {',
    specs: ['packages/freecodego/harness-plugin/tests/team-worktree.spec.ts'],
  },
  {
    name: 'the credential shield judges every path a call names, not the first it states',
    file: 'src/tool-guards.ts',
    from: '    for (const raw of credentialPathsOf(args)) if (isCredentialPath(raw)) return FILE_DENIAL',
    to: '    const only = view.path ?? view.file_path ?? view.locator; if (typeof only === \'string\' && isCredentialPath(only)) return FILE_DENIAL',
    specs: ['packages/freecodego/harness-plugin/tests/tool-guards.spec.ts'],
  },
  {
    name: 'both listeners on one host event ask for the same workspace, so project hooks load',
    file: 'src/hooks/seams.ts',
    from: "    }), subjectOf(text(request, 'toolName') || text(request, 'subject'), undefined, sessionId, cwdOf(request)))",
    to: "    }), subjectOf(text(request, 'toolName') || text(request, 'subject'), undefined, sessionId))",
    specs: ['packages/freecodego/harness-plugin/tests/hook-seams.spec.ts'],
  },
  {
    name: 'the asset audit refuses vendor-prefixed credentials, not only labelled ones',
    file: 'src/engineering.ts',
    from: "  if (containsSecret(content)) findings.push({ rule: 'ENG_EXTERNAL_SECRET_PATTERN', severity: 'critical', message: 'Potential credential shape detected.', location: id })",
    to: "  if (KEYWORD_SECRET_PATTERN.test(content)) findings.push({ rule: 'ENG_EXTERNAL_SECRET_PATTERN', severity: 'critical', message: 'Potential credential shape detected.', location: id })",
    specs: ['packages/freecodego/harness-plugin/tests/secret-scan.spec.ts'],
  },
  {
    name: 'the Advisor evidence cache keys on the workspace, so one checkout is not another’s evidence',
    file: 'src/advisor.ts',
    from: "    return `${cwd ?? ''}\\u0000${call.name}\\u0000${call.arguments}`",
    to: '    return `${call.name}\\u0000${call.arguments}`',
    specs: ['packages/freecodego/harness-plugin/tests/advisor.spec.ts'],
  },
  {
    name: 'a chain a handler dispatches is counted, so the depth cap is not inert in production',
    file: 'src/hooks/hook-chains.ts',
    from: '    const chainDepth = input.chainDepth ?? chainContext.getStore() ?? 0',
    to: '    const chainDepth = input.chainDepth ?? 0',
    specs: ['packages/freecodego/harness-plugin/tests/hook-chains.spec.ts'],
  },
  {
    name: 'the publish pre-flight and the asset audit read one list, so neither loses a shape',
    file: 'src/dangerous-command-patterns.ts',
    from: '  /\\bmkfs\\b|\\bdd\\s+if=/,',
    to: '  /\\bthe-probe-removed-this-shape\\b,/',
    specs: ['packages/freecodego/harness-plugin/tests/skills.spec.ts'],
  },
  {
    name: 'a durable entry refuses the shape-only tier, so an export never writes it plaintext',
    file: 'src/memory/memory-security.ts',
    from: '  const ok = scan.blocked.length === 0 && shapeOnly.length === 0 && opaqueFields.length === 0',
    to: '  const ok = scan.blocked.length === 0 && opaqueFields.length === 0',
    specs: [
      'packages/freecodego/harness-plugin/tests/memory-hygiene.spec.ts',
      'packages/freecodego/harness-plugin/tests/memory-document.spec.ts',
      'packages/freecodego/harness-plugin/tests/memory-export.spec.ts',
    ],
  },
  {
    name: 'backend text becomes an error message only after the shared masking, on the account surface too',
    file: 'src/account-remotes.ts',
    from: "  return redactCredentialShapes(message === '' ? fallback : message)",
    to: "  return message === '' ? fallback : message",
    specs: [
      'packages/freecodego/harness-plugin/tests/oauth-pending-credentials.spec.ts',
      'packages/freecodego/harness-plugin/tests/plugin.spec.ts',
    ],
  },
  {
    name: "this provider's upstream text is masked for the shapes it does not name itself",
    file: 'src/workbuddy-intl.ts',
    // The provider used to chain two private rules of its own onto the shared
    // scanner; the scanner now covers those shapes, so only the formatting tail
    // stays local. The anchor follows the call that still carries the masking.
    from: "  return redactCredentialShapes(value)\n    .replace(/[\\r\\n]+/g, ' ')",
    to: "  return value\n    .replace(/[\\r\\n]+/g, ' ')",
    specs: ['packages/freecodego/harness-plugin/tests/workbuddy-intl.spec.ts'],
  },
  {
    name: 'a nested upstream failure is framed once, not re-framed by its own message',
    file: 'src/workbuddy-intl.ts',
    from: '  if (error instanceof WorkBuddyIntlError) return error.detail',
    to: '  if (error instanceof WorkBuddyIntlError) return error.message',
    specs: ['packages/freecodego/harness-plugin/tests/workbuddy-intl.spec.ts'],
  },
  {
    name: 'a refused sign-in poll masks the backend text it reports, like the completion steps',
    file: 'src/account-remotes.ts',
    from: '    if (rejection !== undefined) throw new Error(`OAUTH_LOGIN_POLL_FAILED: ${upstreamMessage(rejection, \'sign-in was refused\')}`)',
    to: '    if (rejection !== undefined) throw new Error(`OAUTH_LOGIN_POLL_FAILED: ${rejection}`)',
    specs: ['packages/freecodego/harness-plugin/tests/oauth-pending-credentials.spec.ts'],
  },
  {
    name: 'a package manager refusal is masked before it becomes the durable update status',
    file: 'src/plugin-update.ts',
    from: '      if (result.code !== 0) throw new Error(redactCredentialShapes(result.detail))',
    to: '      if (result.code !== 0) throw new Error(result.detail)',
    specs: ['packages/freecodego/harness-plugin/tests/plugin-update.spec.ts'],
  },
  {
    name: 'a provider error event cannot carry a credential out of the shared wire layer',
    file: 'src/openai-wire.ts',
    from: 'throw new LlmError(redactCredentialShapes(message), typeof providerError.code',
    to: 'throw new LlmError(message, typeof providerError.code',
    specs: [
      'packages/freecodego/harness-plugin/tests/openai-wire.spec.ts',
      'packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts',
    ],
  },
  {
    name: 'git output is masked before it becomes the worktree failure the member reads',
    file: 'src/team/worktree.ts',
    // Written as `String(…)` rather than as the bare call: a mutation that is a
    // substring of its own anchor trips the leftover-mutation check above.
    from: 'redactCredentialShapes(boundedTeamText(retry.stderr || retry.stdout, 500))',
    to: 'String(boundedTeamText(retry.stderr || retry.stdout, 500))',
    specs: [
      'packages/freecodego/harness-plugin/tests/team-worktree.spec.ts',
      'packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts',
    ],
  },
  {
    name: 'an OpenAI-compatible provider failure cannot carry a key out in its own detail text',
    file: 'src/openai-compatible-adapter.ts',
    from: '  return redactCredentialShapes(value)',
    to: '  return String(value)',
    specs: ['packages/freecodego/harness-plugin/tests/anthropic-adapter.spec.ts'],
  },
  {
    name: 'an Agnes failure body cannot carry a key out through this platform\'s own rules alone',
    file: 'src/agnes.ts',
    from: 'function redact(value: string): string { return redactCredentialShapes(value)',
    to: 'function redact(value: string): string { return String(value)',
    specs: ['packages/freecodego/harness-plugin/tests/agnes.spec.ts'],
  },
  {
    name: 'a Cline refusal cannot carry a key out in the detail the caller reads',
    file: 'src/cline.ts',
    from: '  return redactCredentialShapes(value)',
    to: '  return String(value)',
    specs: ['packages/freecodego/harness-plugin/tests/cline.spec.ts'],
  },
  {
    name: 'a worktree fallback reason does not quote git output verbatim',
    file: 'src/worktree/creator.ts',
    from: 'const stderr = redactCredentialShapes(result.stderr.trim())',
    to: 'const stderr = String(result.stderr.trim())',
    specs: ['packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts'],
  },
  {
    name: 'a community lockfile that is not valid JSON is reported through the masking',
    file: 'src/skills/lockfile.ts',
    from: 'redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    to: 'String(error.message)',
    specs: ['packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts'],
  },
  {
    name: 'a catalogue transport failure is masked before it is reported',
    file: 'src/community-remotes.ts',
    from: '${redactCredentialShapes(lastError.message)}',
    to: '${lastError.message}',
    specs: [
      'packages/freecodego/harness-plugin/tests/plugin.spec.ts',
      'packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts',
    ],
  },
  {
    name: 'the registration failure message masks the backend body it is built from',
    file: 'src/managed-catalog-utils.ts',
    from: "    if (message !== undefined && message.trim() !== '') return `${fallback}: ${redactCredentialShapes(message.trim()).slice(0, 300)}`",
    to: "    if (message !== undefined && message.trim() !== '') return `${fallback}: ${message.trim().slice(0, 300)}`",
    specs: ['packages/freecodego/harness-plugin/tests/secret-scan.spec.ts'],
  },
  {
    name: 'a turn that ran the verifier is filed as verification, not as an ordinary change',
    file: 'src/engineering.ts',
    from: '  const verification = toolNames.has(VERIFICATION_TOOL_NAME)',
    to: "  const verification = tools.some(name => name === 'engineering_verify')",
    specs: ['packages/freecodego/harness-plugin/tests/engineering.spec.ts'],
  },
  {
    name: 'the verifier is read from the whole tool set, not the eight-name display window',
    file: 'src/engineering.ts',
    from: '  const verification = toolNames.has(VERIFICATION_TOOL_NAME)',
    to: '  const verification = tools.includes(VERIFICATION_TOOL_NAME)',
    specs: ['packages/freecodego/harness-plugin/tests/engineering.spec.ts'],
  },
  {
    name: 'an engine failure is masked before the council report and the peer block carry it',
    file: 'src/engine-council.ts',
    from: '  return redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    to: '  return error instanceof Error ? error.message : String(error)',
    specs: ['packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts'],
  },
  {
    name: 'a logger site that fingerprints the request header masks the header it quotes',
    file: 'src/index.ts',
    from: 'freecodego: request-shape fingerprint failed: ${redactCredentialShapes(String(error))}',
    to: 'freecodego: request-shape fingerprint failed: ${String(error)}',
    specs: ['packages/freecodego/harness-plugin/tests/upstream-text-masking.spec.ts'],
  },
  {
    name: 'the credential shield reads a shell command under every shell name, not `bash` alone',
    file: 'src/tool-guards.ts',
    from: "  if (toolName !== 'bash' && toolName !== 'shell' && toolName !== 'exec_command' && toolName !== 'pwsh') return undefined",
    to: "  if (toolName !== 'bash') return undefined",
    specs: ['packages/freecodego/harness-plugin/tests/tool-guards.spec.ts'],
  },
  {
    name: 'the native engine guard reads the shell vocabulary from the Harness guard',
    file: 'src/native-tool-guard.ts',
    from: '    const command = bashCommandOf(call.name, call.arguments)',
    to: "    const command = call.name === 'bash' || call.name === 'shell' || call.name === 'exec_command' ? call.arguments.command : undefined",
    specs: ['packages/freecodego/harness-plugin/tests/native-tool-guard.spec.ts'],
  },
  {
    name: 'the card Element is destroyed with the dialog, since detaching its frame leaks an iframe',
    file: '../harness-ui/src/client/payment-dialog.tsx',
    from: '  try { element?.destroy() } catch { for (const child of host?.children ?? []) child.remove?.() }',
    to: '  for (const child of host?.children ?? []) child.remove?.()',
    specs: ['packages/freecodego/harness-ui/tests/payment-dialog.client.spec.tsx'],
  },
  {
    name: 'a settled order is announced once, so the first poll cannot reload the account again',
    file: '../harness-ui/src/client/payment-dialog.tsx',
    from: '  if (guard.current.orderId === orderId && guard.current.announced) return false',
    to: '  if (guard.current.announced) return false',
    specs: ['packages/freecodego/harness-ui/tests/payment-dialog.client.spec.tsx'],
  },
  {
    name: 'the guard travels with the order id, so a second order in one dialog still announces itself',
    file: '../harness-ui/src/client/payment-dialog.tsx',
    from: '    if (!open) return\n    let stopped = false',
    to: '    if (!open) return\n    paidRef.current = { orderId: order.orderId, announced: false }\n    let stopped = false',
    specs: ['packages/freecodego/harness-ui/tests/payment-dialog.client.spec.tsx'],
  },
  {
    name: 'the lossy sampler spends its budget on distinct rows before repeating one',
    file: 'src/headroom/smart-crusher.ts',
    from: '    if (seen.has(key)) {\n      duplicates.push(i)\n      continue\n    }\n    seen.add(key)\n    keep.add(i)',
    to: '    duplicates.push(i)',
    specs: ['packages/freecodego/harness-plugin/tests/headroom-extra.spec.ts'],
  },
  {
    name: 'a caption above a markdown table is carried into the compressed rendering',
    file: 'src/headroom/tabular-ingest.ts',
    from: "  const rendered = preamble.length === 0 ? output : `${preamble.join('\\n')}\\n${output}`",
    to: '  const rendered = output',
    specs: ['packages/freecodego/harness-plugin/tests/headroom-extra.spec.ts'],
  },
  {
    name: 'the answer to an app-server question is projected into that method’s own response shape',
    file: '../runtime-codex/src/worker.ts',
    from: 'questions.set(requestId, (value) => { sendRpc({ id, result: questionResponse(value) }) })',
    to: 'questions.set(requestId, (value) => { sendRpc({ id, result: value }) })',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'the app-server’s question count is not capped by the Claude SDK’s tool schema',
    file: '../runtime-codex/src/worker.ts',
    from: '  if (!Array.isArray(candidate) || candidate.length === 0) return undefined',
    to: '  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 4) return undefined',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a cancel names the turn it interrupts, since the App Server requires both ids',
    file: '../runtime-codex/src/worker.ts',
    from: "      await request('turn/interrupt', { threadId, turnId })",
    to: "      await request('turn/interrupt', { threadId })",
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a cancel with no turn in flight does not send an interrupt that cannot name a turn',
    file: '../runtime-codex/src/worker.ts',
    from: '    if (turnId === undefined) {',
    to: '    if (false) {',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a refused interrupt is not reported as an accepted outcome',
    file: '../runtime-codex/src/worker.ts',
    from: "      event('session/completed', { status: 'failed', message: detail })",
    to: "      event('session/completed', { status: 'aborted' })",
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'the App Server is handed a provider name it has, never the Host route label',
    file: '../runtime-codex/src/worker.ts',
    from: `function appServerProvider(): string | undefined {
  return usesOpenAiBridge() ? 'openai' : undefined
}`,
    to: `function appServerProvider(): string | undefined {
  return process.env.FREECODEGO_CODEX_PROVIDER_OVERRIDE ?? selectedProvider
}`,
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a turn carries no provider field, which turn/start does not declare',
    file: '../runtime-codex/src/worker.ts',
    from: `        ...(appServerModel(selectedEffort) === undefined ? {} : { model: appServerModel(selectedEffort) }),
        effort: codexReasoningEffort(selectedEffort),
        summary: 'detailed',`,
    to: `        ...(appServerModel(selectedEffort) === undefined ? {} : { model: appServerModel(selectedEffort) }),
        ...(modelProvider ? { modelProvider } : {}),
        effort: codexReasoningEffort(selectedEffort),
        summary: 'detailed',`,
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'the thread is persisted, so the id the Host keeps can actually be resumed',
    file: '../runtime-codex/src/worker.ts',
    from: `      // resumability is the contract the id in \`session/started\` implies.
      ...codexThreadSandboxParams(message.params),`,
    to: `      // resumability is the contract the id in \`session/started\` implies.
      ephemeral: true,
      ...codexThreadSandboxParams(message.params),`,
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a disposed App Server is stopped with an EOF, so the rollout it was writing is flushed first',
    file: '../runtime-codex/src/worker.ts',
    from: `  dying.stdin.end()
  const deadline = setTimeout(`,
    to: `  killAppServerTree(dying)
  const deadline = setTimeout(`,
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a failed turn carries the App Server’s own reason to the Host',
    file: '../runtime-codex/src/worker.ts',
    from: `    const status = codexTurnStatus(asRecord(params.turn).status)
    const reason = status === 'failed' ? appServerTurnFailure(asRecord(params.turn).error) : undefined
    event('session/completed', reason === undefined ? { status } : { status, message: reason })`,
    to: `    const status = codexTurnStatus(asRecord(params.turn).status)
    event('session/completed', { status })`,
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a legacy approval refusal is the object ReviewDecision declares, not a bare string',
    file: '../runtime-codex/src/approval-response.ts',
    from: `    const rejection = nonEmptyString(outcome.message) ?? 'User denied this request'
    return { decision: { denied: { rejection } } }`,
    to: "    return { decision: 'denied' }",
    specs: ['packages/freecodego/runtime-codex/tests/approval-response.spec.ts'],
  },
  {
    name: 'the loopback MCP server does not answer a JSON-RPC notification',
    file: '../runtime-codex/src/worker.ts',
    from: '  if (message.id === undefined) { response.writeHead(202); response.end(); return }',
    to: "  if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return }",
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'an unknown MCP method is answered with method-not-found, not with the unreadable-body code',
    file: '../runtime-codex/src/worker.ts',
    from: '  mcpError(response, message.id, new Error(`unsupported Harness MCP method ${String(message.method)}`), -32601)',
    to: '  mcpError(response, message.id, new Error(`unsupported Harness MCP method ${String(message.method)}`), -32000)',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    name: 'a runtime that dies hands the session the failure, not a substitute message',
    file: '../native-runtime-host/src/index.ts',
    from: '    this.config.onFailure?.(error)',
    to: "    this.config.onFailure?.(new Error('native runtime failed'))",
    specs: ['packages/freecodego/native-runtime-host/tests/host.spec.ts'],
  },
  {
    name: 'a dead runtime is reported as the event the Harness settles a turn with',
    file: '../root-agent/src/index.ts',
    from: "          method: 'session/failed',",
    to: "          method: 'session/died',",
    specs: ['packages/freecodego/root-agent/tests/root-agent.spec.ts'],
  },
  {
    // The label form exists because `api_key` reaches the Host in a JSON body --
    // the registration response is read as `payload.api_key` -- and a rule anchored
    // on `?`/`&` never sees it. Anchoring it back is the defect this replaced.
    name: 'the worker boundary masks a labelled API key wherever it is written, not only after a question mark',
    file: '../native-runtime-protocol/src/redact.ts',
    from: "source: '\\\\b(?:api[_-]?key)(?:[",
    to: "source: '(?<=[?&])(?:api[_-]?key)=",
    specs: ['packages/freecodego/harness-plugin/tests/cross-boundary-credential-parity.spec.ts'],
  },
  {
    name: 'the Host masks a labelled API key wherever it is written, not only after a question mark',
    file: 'src/secret-scan.ts',
    from: 'source: "(?<=\\\\bapi[_-]?key[',
    to: 'source: "(?<=[?&])(?:api[_-]?key)=',
    specs: ['packages/freecodego/harness-plugin/tests/cross-boundary-credential-parity.spec.ts'],
  },
  {
    // Slack issues seven `xox` prefixes; the class named five, so `xoxc-` (browser
    // session) and `xoxd-` (the cookie beside it) walked through both maskers.
    name: 'the worker boundary masks every Slack token prefix, not the five the class started with',
    file: '../native-runtime-protocol/src/redact.ts',
    from: "  { id: 'slack-token', source: '\\\\bxox[abprscd]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', flags: 'gu' },",
    to: "  { id: 'slack-token', source: '\\\\bxox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', flags: 'gu' },",
    specs: ['packages/freecodego/harness-plugin/tests/cross-boundary-credential-parity.spec.ts'],
  },
  {
    name: 'the Host masks every Slack token prefix, not the five the class started with',
    file: 'src/secret-scan.ts',
    from: "  { id: 'slack-token', source: '\\\\bxox[abprscd]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', confidence: 'high' },",
    to: "  { id: 'slack-token', source: '\\\\bxox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', confidence: 'high' },",
    specs: ['packages/freecodego/harness-plugin/tests/cross-boundary-credential-parity.spec.ts'],
  },
  {
    // The Host bridge rethrows a failed tool's own error text, and that block is
    // model-visible. An Anthropic-compatible gateway key is whatever string its
    // provider chose, so only the value the session was launched with names it.
    name: 'a Claude MCP tool failure masks the credentials the session was launched with',
    file: '../runtime-claude/src/harness-mcp.ts',
    from: 'String(error), knownValues)}',
    to: 'String(error), [])}',
    specs: ['packages/freecodego/runtime-claude/tests/harness-mcp.spec.ts'],
  },
  {
    // Same gap, second channel: the SDK subprocess holds these values in its
    // environment and prints them back on stderr.
    name: 'Claude SDK stderr masks the credentials the session was launched with',
    file: '../runtime-claude/src/index.ts',
    from: 'redactSecrets(data.trim(), knownSecrets)',
    to: 'redactSecrets(data.trim(), [])',
    specs: ['packages/freecodego/runtime-claude/tests/cancellation.spec.ts'],
  },
  {
    // Third channel, and the only one the user reads: this text becomes the
    // turn's recorded failure rather than a block handed to the model.
    name: 'a failed Claude turn masks the credentials the session was launched with',
    file: '../runtime-claude/src/index.ts',
    from: 'String(error), knownSecrets))',
    to: 'String(error), []))',
    specs: ['packages/freecodego/runtime-claude/tests/cancellation.spec.ts'],
  },
  {
    // This runtime drives the SDK in-process, so a turn *is* `await
    // native.prompt(...)` and `for await` blocks until the session yields or
    // throws. An SDK that goes quiet does neither, so without a deadline the
    // turn never settles and the Host waits on it forever.
    name: 'a silent Claude SDK session cannot hold its turn open forever',
    file: '../runtime-claude/src/index.ts',
    from: 'const conversation = withIdleDeadline(sdkConversation, CLAUDE_TURN_IDLE_MS)',
    to: 'const conversation = sdkConversation',
    specs: ['packages/freecodego/runtime-claude/tests/turn-stall.spec.ts'],
  },
  {
    // A stalled turn is a failure, and the Host has already settled it: an SDK
    // left generating for it is work whose result nobody will ever read.
    name: 'a stalled Claude turn stops the SDK session it gave up on',
    file: '../runtime-claude/src/index.ts',
    from: 'void this.activeConversation?.interrupt?.().catch(() => undefined)',
    to: 'void undefined',
    specs: ['packages/freecodego/runtime-claude/tests/turn-stall.spec.ts'],
  },
  {
    // The one confusion this runtime must never make: a watchdog stop comes
    // from the deadline, not from the client, so announcing `aborted` would
    // settle the Host on a cause the user never chose.
    name: 'a stalled Claude turn is reported as a failure, never as a user cancellation',
    file: '../runtime-claude/src/index.ts',
    from: '      if (abort.signal.aborted) {',
    to: '      if (abort.signal.aborted || error instanceof StreamIdleTimeoutError) {',
    specs: ['packages/freecodego/runtime-claude/tests/turn-stall.spec.ts'],
  },
  {
    // The window is idle, not a budget measured from `turn/start`. `turn/start`
    // answers before any output exists, so a worker that stops resetting the
    // timer on each frame protects exactly the one stretch that was already
    // covered and leaves every generation after it unguarded.
    name: 'a Codex turn watchdog is idle, so every frame during a live turn resets it',
    file: '../runtime-codex/src/worker.ts',
    from: 'else refreshTurnWatchdog()',
    to: 'else disarmTurnWatchdog()',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    // `receiveRpc` also sees the replies to `initialize`, `thread/start` and
    // `models/refresh`. Arming on those starts a timer no turn owns, and the
    // completion it fires settles a session that is doing nothing.
    name: 'no Codex watchdog is armed while no turn is open, so session setup cannot fire one',
    file: '../runtime-codex/src/worker.ts',
    from: 'function refreshTurnWatchdog(): void {\n  if (turnWatchdog === undefined && turnId === undefined) return\n  armTurnWatchdog()\n}',
    to: 'function refreshTurnWatchdog(): void {\n  armTurnWatchdog()\n}',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    // Giving up on a silent turn has to stop the generation it gave up on. The
    // App Server is still running the turn it never finished, and the Host has
    // already settled it, so nothing would ever read the result.
    name: 'giving up on a silent Codex turn interrupts the generation still running',
    file: '../runtime-codex/src/worker.ts',
    from: "      void request('turn/interrupt', { threadId, turnId: hungTurn }).catch(() => undefined)",
    to: '      void undefined',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    // A cancel disarms the watchdog and then awaits `turn/interrupt` with
    // `turnId` still set, because the request has to name its turn. A frame
    // arriving in that round trip is liveness by the idle rule, so it re-arms
    // the timer for a turn that is already over — and the Host answers a failed
    // completion by disposing the runtime.
    name: 'a cancelled Codex turn leaves no watchdog armed behind it',
    file: '../runtime-codex/src/worker.ts',
    from: '    disarmTurnWatchdog()\n    // An interrupted turn never emits turn/completed',
    to: '    // An interrupted turn never emits turn/completed',
    specs: ['packages/freecodego/runtime-codex/tests/worker.spec.ts'],
  },
  {
    // The video tool advertises 1..60 seconds while the first-party transport
    // renders 4..12, so a duration inside the advertised range is refused by a
    // route that a second configured route could have served. Classified by
    // wording, that refusal matched no terminal pattern yet still fell through to
    // the `false` default, which made it terminal by omission.
    name: 'a route that cannot render the request is skipped instead of ending the call',
    file: 'src/media-utils.ts',
    from: '  if (error instanceof MediaRouteLimitation) return true',
    to: '  // Route refusals are classified by their wording alone.',
    specs: ['packages/freecodego/harness-plugin/tests/media-generation.spec.ts'],
  },
  {
    // The first-party transport refuses a duration outside its own range, and the
    // guard in front of it is what turns that refusal into a route limitation
    // rather than a provider error raised after the fact. Its window now travels
    // through the shared rule (`videoSecondsRefusal`), so the mutation is the
    // inverted guard: the length that cannot be rendered reaches the transport and
    // the lengths that can are refused instead.
    name: 'a duration the first-party route cannot render never reaches its transport',
    file: 'src/media-generation.ts',
    from: '      if (unserved !== undefined) throw new MediaRouteCapabilityRefusal(unserved)',
    to: '      if (unserved === undefined) throw new MediaRouteCapabilityRefusal(unserved)',
    specs: ['packages/freecodego/harness-plugin/tests/media-generation.spec.ts'],
  },
  {
    // Same bug, generalized to every protocol route: a window that is *quantized*
    // into instead of refused returns a video whose length the caller never asked
    // for, and because the call succeeds the ladder stops there — so the route
    // that could have rendered the real length is never asked. Removing the
    // refusal is the mutation; the spec asserts both the refusal and the route the
    // ladder reaches instead.
    name: 'a length outside a declared route window steps aside instead of being rounded into it',
    file: 'src/media-utils.ts',
    from: '  const unserved = videoSecondsRefusal(route.provider, args.seconds)\n',
    to: '  const unserved: string | undefined = undefined\n',
    specs: ['packages/freecodego/harness-plugin/tests/media-duration-routes.spec.ts'],
  },
  {
    // The breaker exists for provider health, and a route that declined by its own
    // declaration spent nothing and said nothing about it. Recorded anyway, two
    // requests for a length a route cannot render demote the *configured default*
    // route for five minutes — measured, a 5-second request after two 30-second
    // ones never asked Kling at all. Restoring the unconditional record is the
    // mutation.
    name: 'a route that declined by its own declaration does not feed the breaker',
    file: 'src/media-generation.ts',
    from: '      if (!(error instanceof MediaRouteCapabilityRefusal)) circuitRecordFailure(route, Date.now())',
    to: '      circuitRecordFailure(route, Date.now())',
    specs: ['packages/freecodego/harness-plugin/tests/media-route-health.spec.ts'],
  },
  {
    // One request, two halves: the tool derives `audio/flac` from the file's
    // extension while the upload name used to come from a different list entirely,
    // so `filename: recording.mp3` sat beside `type: audio/flac` and the
    // transcriber reads the container off the name. Adding the container to the
    // exception list is the mutation.
    name: 'the upload name never names a different container than the media type',
    file: 'src/account-remotes.ts',
    from: "  if (subtype === 'mpeg' || subtype === 'mp3') return 'mp3'",
    to: "  if (subtype === 'mpeg' || subtype === 'mp3' || subtype === 'flac') return 'mp3'",
    specs: ['packages/freecodego/harness-plugin/tests/transcribe-request.spec.ts'],
  },
  {
    // The settings page renders its per-category model lists from the user's own
    // overrides; the ladder honoured them for the native directory only, so a
    // managed model the user moved to `text` was still asked as a video route.
    // Dropping the lookup is the mutation.
    name: 'a managed model the user moved out of a category is not asked for it',
    file: 'src/media-generation.ts',
    from: '    const modelCategory = categoryOverride(model.provider, model.id) ?? mediaCategoryForManagedModel(model)',
    to: '    const modelCategory = mediaCategoryForManagedModel(model)',
    specs: ['packages/freecodego/harness-plugin/tests/media-candidates.spec.ts'],
  },
  {
    // Same rule through the free-model directory, whose rows the picker keys as
    // `logfare/<id>`.
    name: 'a model the user moved out of a category is not asked for it through a second directory',
    file: 'src/media-generation.ts',
    from: "    const modelCategory = categoryOverride('logfare', selection) ?? logfareMediaCategory(model)",
    to: '    const modelCategory = logfareMediaCategory(model)',
    specs: ['packages/freecodego/harness-plugin/tests/media-candidates.spec.ts'],
  },
  {
    // The caller's hint is the only contract this module has for the value, and
    // the guard this restores dropped the plausible (`zh_Hans`, `pt-BR `, `  en`)
    // while forwarding `chinese`, which no provider reads as a code.
    name: 'a language hint the provider can read is not dropped on the way out',
    file: 'src/account-remotes.ts',
    from: "  if (typeof language === 'string' && language.trim() !== '') form.set('language', language.trim())",
    to: "  if (typeof language === 'string' && /^[A-Za-z-]{2,16}$/u.test(language)) form.set('language', language)",
    specs: ['packages/freecodego/harness-plugin/tests/transcribe-request.spec.ts'],
  },
  {
    // A name built from the clock alone collides when two parallel tool calls land
    // in the same millisecond — the harness runs parallel-capable calls in a pool —
    // so both results report one path and the file holds whichever payload was
    // written second: the first result points at a file that is not its audio.
    name: 'two audio generations in one millisecond are two files',
    file: 'src/media-generation.ts',
    from: '    const file = path.join(directory, `audio-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`)',
    to: '    const file = path.join(directory, `audio-${Date.now()}.${extension}`)',
    specs: ['packages/freecodego/harness-plugin/tests/media-route-health.spec.ts'],
  },
  {
    // The dropped negation is the realistic form of this bug: with the guard
    // inverted, an unavailable copy primitive takes the branch that reports a
    // fast clone, which is exactly the sentence this function exists to get
    // right.
    name: 'neither worktree strategy available is named as both, not as a fast clone',
    file: 'src/worktree/creator.ts',
    from: '  if (!input.fastAvailable) {',
    to: '  if (input.fastAvailable) {',
    specs: ['packages/freecodego/harness-plugin/tests/worktree-creator.spec.ts'],
  },
  {
    // The label in this rule is also the tail of a header name a provider echoes
    // back, so a span that covers it redacts `x-api-key` down to `x-<redacted>`:
    // neither the readable half of a refused turn nor a complete header name.
    // The lookbehind is what keeps the label and masks only the value, so
    // restoring the label into the span is the mutation that must be caught.
    name: 'a labelled API key is masked at its value, so a refused turn still names the header',
    file: 'src/secret-scan.ts',
    from: '(?<=\\\\bapi[_-]?key[\\"\'=:\\\\s]{1,4}',
    to: '\\\\b(?:api[_-]?key)(?:[\\"\'=:\\\\s]+',
    specs: ['packages/freecodego/harness-plugin/tests/claude-bridge-secret.spec.ts'],
  },
  {
    // The list is curated, so a name it is missing is a read-only role holding a
    // tool that deletes a file rather than an inert entry. The fixture this spec
    // used before only ever offered `write` and `edit`, which is exactly how six
    // mutating names stayed invisible; restoring the short list must be caught.
    name: 'a read-only team role is withheld every mutating tool name, not only the two a fixture offers',
    file: 'src/team/roles.ts',
    from: "  'move_file', 'fs_write', 'fs_edit',",
    to: "  'write_file',",
    specs: ['packages/freecodego/harness-plugin/tests/team-roles-context.spec.ts'],
  },
  {
    // A declared script runs under whichever shell the project uses, and the
    // Windows spellings do not stop at `cmd`. Without these verbs a
    // `Remove-Item -Recurse -Force` is judged a safe verification script, which
    // is the one thing this pattern exists to refuse.
    name: 'a recursive delete is refused under PowerShell and cmd spellings, not only POSIX ones',
    file: 'src/engineering-quality.ts',
    from: '\\\\bdel\\\\b|\\\\berase\\\\b|\\\\bremove-item\\\\b\'',
    to: '\\\\bdel\\\\b\'',
    specs: ['packages/freecodego/harness-plugin/tests/engineering-quality.spec.ts'],
  },
  {
    // A tool schema and the check in front of it are two readers of one list. The
    // schema is the half that fails silently: a value it never offers is one no
    // model can request, and there is nothing on the wire to notice it with.
    name: 'the council schema offers the engines the validator accepts',
    file: 'src/agent-tools.ts',
    from: 'enum: [...COUNCIL_ENGINES] }, minItems: 1, maxItems: COUNCIL_ENGINES.length }',
    to: "enum: ['deepseek', 'codex'] }, minItems: 1, maxItems: COUNCIL_ENGINES.length }",
    specs: ['packages/freecodego/harness-plugin/tests/plugin.spec.ts'],
  },
  {
    name: 'the verification schema offers the stages the validator accepts',
    file: 'src/agent-tools.ts',
    from: 'enum: [...VERIFICATION_STAGES] }, minItems: 1, maxItems: VERIFICATION_STAGES.length }',
    to: "enum: ['scope', 'build', 'types', 'lint'] }, minItems: 1, maxItems: VERIFICATION_STAGES.length }",
    specs: ['packages/freecodego/harness-plugin/tests/plugin.spec.ts'],
  },
  {
    // Drift here is replaced rather than refused: the caller asks for a container
    // the schema offered and receives a different one, with nothing saying so.
    name: 'every audio container the schema offers is one the writer can write',
    file: 'src/media-generation.ts',
    from: 'const AUDIO_FORMAT_NAMES: ReadonlySet<string> = new Set(AUDIO_FORMATS)',
    to: "const AUDIO_FORMAT_NAMES: ReadonlySet<string> = new Set(['mp3', 'wav', 'opus', 'aac'])",
    specs: ['packages/freecodego/harness-plugin/tests/media-generation.spec.ts'],
  },
  {
    // The last answer in a fallback chain is not a free slot. This one held a
    // local literal (`'FreeCodeGo'`), so a row the gateway sent with neither a
    // group id nor a group name was labelled with a group no backend ever
    // published -- and, because the literal was never empty, it also kept the
    // client's own last-resort label (the source, "FreeCodeGo gateway") from
    // ever being reached. The chain has to end at the model's real `provider`.
    name: 'an ungrouped price row is named by the provider the gateway sent, not by a local label',
    file: 'src/payment-remotes.ts',
    from: "          const groupName = (choice.groupId === undefined ? undefined : groupNames.get(choice.groupId)) ?? choice.groupName ?? option.provider ?? ''",
    to: "          const groupName = (choice.groupId === undefined ? undefined : groupNames.get(choice.groupId)) ?? choice.groupName ?? 'FreeCodeGo'",
    specs: ['packages/freecodego/harness-plugin/tests/plugin.spec.ts'],
  },
  {
    // The council list is narrower than the engine-id type on purpose: the root
    // Agent's own engine is not a delegation target, so a convergence that read
    // the wider type would accept a child Agent the council cannot start.
    name: 'the council engine list stays narrower than the engine-id type',
    file: 'src/engineering-remote-utils.ts',
    from: "export const COUNCIL_ENGINES: readonly FreeCodeGoEngineeringCouncilEngine[] = ['deepseek', 'codex', 'claude']",
    to: "export const COUNCIL_ENGINES: readonly FreeCodeGoEngineeringCouncilEngine[] = ['deepseek', 'codex', 'claude', 'freecodego']",
    specs: ['packages/freecodego/harness-plugin/tests/engineering-auto-council.spec.ts'],
  },
  {
    // The automatic plan review hands its `engines` straight to
    // `engineCouncil.start`, so it is a *reader* of the council roster — and it
    // was the reader a hand-written literal had left out, which is why an engine
    // added to `COUNCIL_ENGINES` would have been offered by the explicit council
    // tool and silently skipped by the unattended one. Restoring the literal
    // leaves `councilPeersFor` correct and unused, so the unit that pins the
    // derivation still passes: only the call-site census goes red.
    name: 'the automatic review derives its roster instead of spelling it out',
    file: 'src/index.ts',
    from: 'const engines = councilPeersFor(parentEngine)',
    to: "const engines = (['deepseek', 'codex', 'claude'] as const).filter(engine => engine !== parentEngine)",
    specs: ['packages/freecodego/harness-plugin/tests/engineering-auto-council.spec.ts'],
  },
  {
    // The description is the half of a tool the model reads, and it is the half
    // that fails silently: `saveDraft` writes `trust: 'draft'` and every
    // Agent-facing read resolves `['reviewed']`, so the memory a handoff leaves
    // behind is invisible to the next session — while the sentence the model was
    // given said it would be delivered. A model that believes delivery is
    // automatic does not tell the user that review is the step in the way, which
    // is how the gap survived in the first place.
    name: 'a handoff is described as pending review, not as automatically delivered',
    file: 'src/engineering.ts',
    from: 'It is saved as a draft, not delivered: the next Agent cannot recall it until a user reviews it',
    to: 'It is automatically available to the next Agent working in this project',
    specs: ['packages/freecodego/harness-plugin/tests/engineering-tool-surface.spec.ts'],
  },
  {
    // The store's own spelling of the kind vocabulary. It decides whether an
    // observation keeps its name or is coerced to `'note'`, so a kind the list
    // gained and this chain did not would be offered by the schema, accepted by
    // the type, written by `saveDraft`, and renamed on the way back through the
    // outbox. The mutation restores the hand-written chain one member short, which
    // is how such a drift actually arrives.
    name: 'the memory store recognises every kind the vocabulary declares',
    file: 'src/engineering-memory.ts',
    from: "return typeof value === 'string' && MEMORY_KIND_NAMES.has(value)",
    to: "return value === 'decision' || value === 'discovery' || value === 'bugfix' || value === 'change' || value === 'blocker' || value === 'verification' || value === 'note'",
    specs: ['packages/freecodego/harness-plugin/tests/engineering-memory.spec.ts'],
  },
  {
    // The default purge is the one reached by accident, and the half that matters
    // is what it keeps. Written out again as a list — the shape this replaced —
    // reviewed knowledge goes with everything else.
    name: 'the default purge keeps reviewed knowledge',
    file: 'src/engineering-memory.ts',
    from: "input.includeReviewed === true ? TRUSTS : TRUSTS.filter(trust => trust !== 'reviewed')",
    to: "input.includeReviewed === true ? TRUSTS : ['captured', 'draft', 'reviewed', 'rejected', 'superseded']",
    specs: ['packages/freecodego/harness-plugin/tests/engineering-memory.spec.ts'],
  },
  {
    // A Skill authored on Windows — or checked out under `core.autocrlf=true`,
    // which is this repository's own setting — opens with `---\r\n`. Comparing
    // the raw body refused it as missing frontmatter, and that finding is
    // `high`, so the refusal was the whole install. Every other fixture in the
    // suite is LF, which is why the case stayed invisible.
    name: 'a Skill that opens its frontmatter with CRLF is accepted, not refused as missing frontmatter',
    file: 'src/engineering.ts',
    from: '!content.replaceAll(\'\\r\\n\', \'\\n\').startsWith(\'---\\n\')',
    to: '!content.startsWith(\'---\\n\')',
    specs: ['packages/freecodego/harness-plugin/tests/engineering.spec.ts'],
  },
  {
    // The deny list is the one guard that reads a path exactly as the caller
    // spelled it, and the profile that needs it most says so itself: with
    // `extends: 'off'` the deny list is the only thing narrowing the profile.
    // Collapsing dot segments is what makes `/w/x/../secrets/token.txt` the same
    // string as `/w/secrets/token.txt`; without it the traversal reaches the glob
    // spelled differently and passes a list whose entire job is to refuse it.
    name: 'a deny rule still sees the path a traversal resolves to',
    file: 'src/sandbox/profiles.ts',
    from: '  return collapseDotSegments(trimmed)',
    to: '  return trimmed',
    specs: ['packages/freecodego/harness-plugin/tests/sandbox-profiles.spec.ts'],
  },
  {
    // A name missing from the set is silent rather than loud: `onTurnStopping`
    // returns before it reads the workspace, so the turn is filed as one that
    // changed nothing and the edit goes unverified — the outcome the gate exists
    // to prevent. `multi_edit` was one of nine names absent, so a turn that used
    // nothing else produced no nudge and no workspace read at all.
    name: 'an edit through multi_edit still counts as a turn that changed the workspace',
    file: 'src/verify-on-stop.ts',
    from: "  'multi_edit',",
    to: "  'multi_edit_',",
    specs: ['packages/freecodego/harness-plugin/tests/verify-on-stop.spec.ts'],
  },
  {
    // The shell branch's floor is 200 characters and the generic stage's is
    // `MIN_COMPRESSIBLE_CHARS`, so between the two floors this set is the only gate
    // — and on win32 the base `cordis.patch.yml` disables `tool-bash` and enables
    // `tool-pwsh`, which made the POSIX-only spelling the one spelling that cannot
    // run. The omission stayed invisible because every fixture large enough to fold
    // was also large enough for the generic stage.
    name: 'a read-only search folds under the shell the platform actually provides',
    file: 'src/headroom/runtime.ts',
    from: "const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'pwsh'])",
    to: "const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'exec_command', 'local_shell'])",
    specs: ['packages/freecodego/harness-plugin/tests/headroom-extra.spec.ts'],
  },
  {
    // The same set, one spelling further on: `exec_command` is what a native Codex
    // session's shell approvals arrive as, and it was the one name with a producer
    // that the set did not carry. A mutation that removes it has to fail, or the
    // fix that added it is not load-bearing — the `pwsh` probe above would still
    // pass, since that spelling stays in the set.
    name: 'a read-only search folds under the Codex spelling of a shell as well',
    file: 'src/headroom/runtime.ts',
    from: "const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'pwsh'])",
    to: "const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'local_shell', 'pwsh'])",
    specs: ['packages/freecodego/harness-plugin/tests/headroom-extra.spec.ts'],
  },
  {
    // Same omission as the headroom set, one list further on: `CLEARABLE_TOOL_KINDS`
    // is what makes a result a candidate at all, so a tool missing from it is not
    // merely ranked lower — it is invisible to the whole policy. On win32 the base
    // `cordis.patch.yml` disables `tool-bash` and enables `tool-pwsh`, so the one
    // result class this policy exists to reclaim was the one it could never touch,
    // while the POSIX spelling it does list can never appear on that platform.
    name: 'a shell result is reclaimable on a platform whose shell is not spelled bash',
    file: 'src/cache-cold.ts',
    from: "  'shell', 'bash', 'pwsh', 'exec_command', 'run_command',",
    to: "  'shell', 'bash', 'exec_command', 'run_command',",
    specs: ['packages/freecodego/harness-plugin/tests/cache-cold.spec.ts'],
  },
  {
    // `compileMatcher` anchors its pattern, so a family missing a name does not
    // degrade — it makes that family unreachable through the anchored spelling. On
    // win32 `pwsh` is the only shell this Host registers, so a user's `^bash$`
    // matcher matched nothing at all there and their hook silently never ran.
    name: 'a hook matcher of Bash reaches the shell this platform registers',
    file: 'src/hooks/surface.ts',
    from: "  ['bash', 'shell', 'exec', 'exec_command', 'run_command', 'pwsh'],",
    to: "  ['bash', 'shell', 'exec', 'exec_command', 'run_command'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The same family, one spelling over. A native Codex session's shell approvals
    // arrive as `shell`/`exec_command`, and `shell` was already a member — so the
    // family reached one Codex spelling and not the other. `compileMatcher` anchors
    // its pattern, so the name it could not reach is not a hook that matched more
    // narrowly but a hook that never ran: a guard silently absent in that session.
    name: 'a hook matcher of Bash reaches the Codex spelling of a shell as well',
    file: 'src/hooks/surface.ts',
    from: "  ['bash', 'shell', 'exec', 'exec_command', 'run_command', 'pwsh'],",
    to: "  ['bash', 'shell', 'exec', 'run_command', 'pwsh'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The read family, by the write family's own precedent: `read_document` is a tool
    // name this Host registers, not an alias of `read`, and it is the only reader for
    // a PDF or a notebook. A hook written as `Read` reached every text format and
    // silently not those two, since `compileMatcher` anchors its pattern.
    name: 'a hook matcher of Read reaches the document reader this Host registers',
    file: 'src/hooks/surface.ts',
    from: "  ['read', 'read_file', 'file_read', 'read_document', 'read_image', 'fs_read', 'view', 'readfile', 'cat'],",
    to: "  ['read', 'read_file', 'file_read', 'read_image', 'fs_read', 'view', 'readfile', 'cat'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The same family, the other reader. `@deepseek-ai/dsh-tool-fs` registers
    // `read_image` beside `read` and the base bundle mounts the attachment store it
    // injects on, so it is present in every app built on that bundle. A `Read`
    // matcher written to audit or refuse a file read therefore reached every format
    // except the one whose payload is bytes rather than text.
    name: 'a hook matcher of Read reaches the image reader the base bundle mounts',
    file: 'src/hooks/surface.ts',
    from: "  ['read', 'read_file', 'file_read', 'read_document', 'read_image', 'fs_read', 'view', 'readfile', 'cat'],",
    to: "  ['read', 'read_file', 'file_read', 'read_document', 'fs_read', 'view', 'readfile', 'cat'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The same family closed against the sibling lists rather than the registry.
    // `READ_LIKE_TOOL_NAMES` is "every read-like tool spelling this port knows" and
    // `CREDENTIAL_PATH_TOOLS` carries `fs_read` because the shield has to cover every
    // way a path becomes a file read; neither spelling was in the family, so a
    // `Read` matcher a user believed covered their reads did not cover these.
    name: 'a hook matcher of Read reaches the read spellings the sibling lists know',
    file: 'src/hooks/surface.ts',
    from: "  ['read', 'read_file', 'file_read', 'read_document', 'read_image', 'fs_read', 'view', 'readfile', 'cat'],",
    to: "  ['read', 'read_file', 'file_read', 'read_document', 'read_image', 'cat'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The task family named only `subagent`, while the freecodego preset enables
    // `subagent_fork` (fork provider) and mounts `workflow` / `ralph` as the fan-out
    // runners. Claude Code's spelling for starting a subagent is `Task`, so a hook
    // written to guard delegation reached one provider and silently not the others —
    // the same silent hole as the shell and read families, one family over.
    name: 'a hook matcher of Task reaches every delegation tool the preset enables',
    file: 'src/hooks/surface.ts',
    from: "  ['task', 'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph', 'agent'],",
    to: "  ['task', 'subagent', 'agent'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // `str_replace` is the `command` an editor tool takes; `str_replace_editor` is a
    // tool name this Host registers. Only the first was in the write family, so a
    // hook written to guard file mutation matched everything except the one tool
    // whose entire contract is a byte-exact patch.
    name: 'a hook matcher of Edit reaches the byte-patch editor tool this Host registers',
    file: 'src/hooks/surface.ts',
    from: "  ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_editor', 'edit_file', 'write_file', 'create_file', 'notebook_edit', 'notebook_write', 'delete_file', 'move_file', 'fs_write', 'fs_edit'],",
    to: "  ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'str_replace', 'edit_file', 'write_file', 'create_file', 'notebook_edit', 'notebook_write', 'delete_file', 'move_file', 'fs_write', 'fs_edit'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The write family's remaining holes, in one mutation. `native-tool-guard.ts`
    // renames an engine's tool mechanically, so `NotebookEdit` reaches a hook as
    // `notebook_edit` — a name `tool-guards.ts` says the guards are "actually pointed
    // at" — and `delete_file`/`move_file`/`fs_write`/`fs_edit` are the path-taking
    // editors it carries beside it. A hook written to guard file mutation reached the
    // editor and silently not the notebook writer or the deleting tool.
    name: 'a hook matcher of Edit reaches the mutating spellings the native projection produces',
    file: 'src/hooks/surface.ts',
    from: "  ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_editor', 'edit_file', 'write_file', 'create_file', 'notebook_edit', 'notebook_write', 'delete_file', 'move_file', 'fs_write', 'fs_edit'],",
    to: "  ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_editor', 'edit_file', 'write_file', 'create_file'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // `CLEARABLE_TOOL_KINDS` keeps `list_files` because "they are spellings other
    // agents use, and a name with no registration here is inert while a missing one
    // is a hole". The glob family is where that hole would be for a listing matcher.
    name: 'a hook matcher of Glob reaches the listing spelling the cold-cache list keeps',
    file: 'src/hooks/surface.ts',
    from: "  ['glob', 'listdir', 'list_dir', 'ls', 'find', 'list_files'],",
    to: "  ['glob', 'listdir', 'list_dir', 'ls', 'find'],",
    specs: ['packages/freecodego/harness-plugin/tests/hook-surface.spec.ts'],
  },
  {
    // The third exit of the same root cause: Plan Mode judges a shell call by the
    // declarative command policy rather than by a keyword list, and that branch is
    // gated on the tool's spelling. With only the POSIX spelling in the gate the
    // fence did not exist on Windows — the command refused as `bash` merely
    // prompted as `pwsh`, which is the weaker answer the mode exists to avoid.
    name: 'Plan Mode judges the shell this platform registers, not only the POSIX spelling',
    file: 'src/plan-mode.ts',
    from: "  if (tool !== 'bash' && tool !== 'shell' && tool !== 'pwsh' && tool !== 'exec_command') return undefined",
    to: "  if (tool !== 'bash' && tool !== 'shell' && tool !== 'exec_command') return undefined",
    specs: ['packages/freecodego/harness-plugin/tests/plan-mode.spec.ts'],
  },
  {
    // The fence's own header states the rule — "a name that does not exist is
    // inert, while a missing name is a hole" — and `write_file` was that hole: it
    // was carried by both sibling writer lists and by no test that asked this fence
    // about it. The mutation renames the entry rather than deleting the line,
    // because the fence compares whole names, so a rename and an omission are the
    // same defect and the rename leaves a distinctive string for the revert check.
    name: 'Plan Mode refuses write_file, a writer name two sibling lists already carried',
    file: 'src/plan-mode.ts',
    from: "  'write_file',",
    to: "  'write_file_disabled',",
    specs: ['packages/freecodego/harness-plugin/tests/plan-mode.spec.ts'],
  },
  {
    // One schema property serves eight actions, so a bound applied by only one of
    // them is invisible to the model that read the schema: `approve` kept half the
    // rationale the schema accepted, and nothing recorded the loss. This restores
    // exactly that asymmetry, which is why the probe sits on the `approve` site
    // rather than on the constant.
    name: 'an approval note is stored at the length the schema promised',
    file: 'src/team/board.ts',
    from: 'note: boundedTeamText(note, TEAM_NOTE_LIMIT), at: Date.now()',
    to: 'note: boundedTeamText(note, 1_000), at: Date.now()',
    specs: ['packages/freecodego/harness-plugin/tests/team-tool-state.spec.ts'],
  },
  {
    // The behavioural case cannot see the promise and the behaviour drift: a 1 500
    // character note fits under both 2 000 and 3 000, so it passes whichever number
    // the schema carries. Only comparing the schema's value against the constant
    // does, and this mutation is the one that separates the two tests.
    name: 'the note bound in the tool schema is the one the board applies',
    file: 'src/team/tools.ts',
    from: "          note: { type: 'string', maxLength: TEAM_NOTE_LIMIT },",
    to: "          note: { type: 'string', maxLength: 3_000 },",
    specs: ['packages/freecodego/harness-plugin/tests/team-tool-state.spec.ts'],
  },
  {
    // `member_stop` is the fourth hand-back, and it was the one left out: it stopped
    // the member and released the task, but never cleared the id, so `recover`
    // reported a member holding a task the board had already returned to the pool.
    // Reversing the condition leaves the roster naming it again, which is the defect
    // exactly — the probe is on the condition rather than on the call so that a
    // refactor which keeps the call but inverts the test is still caught.
    name: 'stopping a member clears the task its roster row was naming',
    file: 'src/team/tools.ts',
    from: 'if (released !== undefined) await team.members.update(member.id, { clearTask: true })',
    to: 'if (released === undefined) await team.members.update(member.id, { clearTask: true })',
    specs: ['packages/freecodego/harness-plugin/tests/team-tool-state.spec.ts'],
  },
  {
    // Section 34. The rule's own examples spell the flags `-Recurse -Force`, so
    // dropping the clustered `-Fo` leaves every one of them holding — the rule stays
    // accepted and the module's self-check stays green — while `ri -R -Fo dist`, the
    // spelling a person actually types, falls to the no-match default. This is the
    // only one of the four that the new behavioural cases alone can catch.
    name: 'the Windows delete rule still knows every spelling of the force switch',
    file: 'src/command-policy.ts',
    from: "      pattern: [['remove-item', 'ri'], ['-Recurse', '-recurse', '-r', '-R'], ['-Force', '-force', '-fo', '-Fo']],",
    to: "      pattern: [['remove-item', 'ri'], ['-Recurse', '-recurse', '-r', '-R'], ['-Force', '-force', '-fo']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 37. A name missing from the escalation rule is an escalation that runs
    // unattended, and the rule's own examples name the same three programs the test
    // does, so this one is caught twice over — by the new case and by the compiler
    // refusing the rule. Both are real: the example set proves the spelling is
    // present, the case proves the decision it lands on.
    name: 'privilege escalation is refused for every sibling program the rule names',
    file: 'src/command-policy.ts',
    from: "      pattern: [['doas', 'gsudo', 'runas']],",
    to: "      pattern: [['doas', 'gsudo']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 35. `pipesIntoShell` answers from the shell vocabulary *or* the
    // evaluator one, so dropping `iex` leaves `iwr … | iex` as a plain fetch prompt:
    // the same unaudited text runs, and the pipeline rule that exists to refuse it
    // never matches. The `notMatch` half of the rule's own examples cannot see this,
    // because they assert what is *not* matched.
    name: 'a download piped into the Windows evaluator is still a pipeline into a shell',
    file: 'src/command-policy.ts',
    from: "export const POWERSHELL_EXPRESSION_PROGRAMS: readonly string[] = ['iex', 'invoke-expression']",
    to: "export const POWERSHELL_EXPRESSION_PROGRAMS: readonly string[] = ['invoke-expression']",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 37, the floor half. `cipher` is the spelling whose only meaning is a
    // device wipe, so dropping it turns an unattended wipe back into `allow` — the
    // silence the floor was added to remove. The floor is a `prompt`, not a denial:
    // `dd` on POSIX is only a prompt, and promoting one half of a symmetric pair
    // would invent an asymmetry rather than remove one.
    name: 'the disk verbs that wipe a volume still reach the prompt floor',
    file: 'src/command-policy.ts',
    from: "      pattern: [['diskpart', 'format', 'clear-disk', 'cipher']],",
    to: "      pattern: [['diskpart', 'format', 'clear-disk']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 38. The downloader alternation used to be a hand-written literal in
    // this module, which is exactly what the module exists to prevent. Writing the
    // short aliases back in — the copy that had drifted — drops `Invoke-WebRequest`,
    // so a skill body carrying the long cmdlet spelling passes the pre-flight.
    name: 'the audit reads the PowerShell spelling of a piped download, aliases included',
    file: 'src/dangerous-command-patterns.ts',
    from: "const POWERSHELL_DOWNLOADERS = POWERSHELL_FETCH_PROGRAMS.join('|')",
    to: "const POWERSHELL_DOWNLOADERS = 'iwr|irm'",
    specs: ['packages/freecodego/harness-plugin/tests/skills.spec.ts'],
  },
  {
    // Section 38, the other alternation. `POWERSHELL_EXECUTORS` had no probe at all
    // before this one. Keeping only the long name drops `iex`, the spelling a person
    // actually types, and `iwr … | iex` stops being read as a pipeline into an
    // interpreter — on the audit surface, which is the gate external content passes.
    name: 'the audit reads the PowerShell evaluator from the command policy, alias included',
    file: 'src/dangerous-command-patterns.ts',
    from: "const POWERSHELL_EXECUTORS = POWERSHELL_EXPRESSION_PROGRAMS.join('|')",
    to: "const POWERSHELL_EXECUTORS = 'invoke-expression'",
    specs: ['packages/freecodego/harness-plugin/tests/skills.spec.ts'],
  },
  {
    // Section 38, the derivation itself. A copy cannot answer this probe, because a
    // copy does not read the policy: editing the policy's fetch vocabulary has to
    // move the audit with it, and it only does so while the audit derives its
    // alternation from that list. This is the direct evidence for "derived", where
    // the two probes above only prove the names are load-bearing for their regexes.
    name: 'the audit and the policy answer to one fetch vocabulary, so editing the policy moves both',
    file: 'src/command-policy.ts',
    from: "export const POWERSHELL_FETCH_PROGRAMS: readonly string[] = ['iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']",
    to: "export const POWERSHELL_FETCH_PROGRAMS: readonly string[] = ['irm', 'invoke-webrequest', 'invoke-restmethod']",
    specs: ['packages/freecodego/harness-plugin/tests/skills.spec.ts'],
  },
  {
    // Section 39. The fourth hand-written copy of "what is a shell" lived in the
    // evidence rule, missing `fish` and `script`. Writing back that drifted copy
    // makes `fish -c 'npm test'` fall past the wrapper branch, so a check that
    // really ran is reported as no evidence at all.
    name: 'the evidence rule reads its shells from the command policy rather than a copy',
    file: 'src/verification-evidence.ts',
    from: 'const SHELL_PROGRAMS: ReadonlySet<string> = new Set(SHELL_INTERPRETERS)',
    to: "const SHELL_PROGRAMS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'pwsh', 'powershell'])",
    specs: ['packages/freecodego/harness-plugin/tests/verification-evidence.spec.ts'],
  },
  {
    // Section 39, the derivation again, across the module boundary: dropping `fish`
    // from the policy's own list has to move the evidence rule, which it only does
    // while that rule builds its set from the list rather than a copy of it. The
    // probe is on the policy because the copy's failure mode is "the policy grew
    // and nobody told the copy".
    name: 'editing the shell vocabulary in the policy moves the evidence rule too',
    file: 'src/command-policy.ts',
    from: "export const SHELL_INTERPRETERS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'script']",
    to: "export const SHELL_INTERPRETERS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'script']",
    specs: ['packages/freecodego/harness-plugin/tests/verification-evidence.spec.ts'],
  },
  {
    // Section 22. Trusting the file's spelling is the defect itself: a status this
    // build does not know used to load as a real task belonging to no bucket, so
    // `total` exceeded the sum of the buckets and the task was invisible to every
    // action. The probe leaves the ledger entry alone deliberately — the repair is
    // *recorded*, so the record and the status have to be read together.
    name: 'a status the file spelled wrong is repaired into the open pool, not trusted',
    file: 'src/team/board.ts',
    from: "        status: isStoredStatus(task.status) ? task.status : 'open' as const,",
    to: '        status: asRecorded(task.status),',
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // Section 36. A token stored as a number pins the task: the tool surface asks
    // the member for the string `12345` and the token door compares against the
    // number, so no spelling of that token closes it. Passing the value through
    // instead of dropping it is the defect, and the spec's own assertion that the
    // task can still be closed is what catches it.
    name: 'a token the file stored as a number is dropped rather than passed through',
    file: 'src/team/board.ts',
    from: "        claimToken: typeof task.claimToken === 'string' ? task.claimToken : undefined,",
    to: '        claimToken: task.claimToken as string | undefined,',
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // Section 36, the timestamp. `waiting[].since` is declared a number, and while
    // a missing `updatedAt` travelled through as `undefined`, JSON dropped the key
    // on the way out — so the reader got "no such field" instead of an age. Epoch
    // is a visible "unknown"; the probe restores the invisible one.
    name: 'a row with no recorded date reports a number rather than a missing field',
    file: 'src/team/board.ts',
    from: "        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,",
    to: '        updatedAt: task.updatedAt as number,',
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // Section 36, the third face. `create` accepted a dependency naming nothing,
    // and such a task is not waiting — it never runs. `blocked()` reports a *failed*
    // dependency and a missing one never fails, so the panel counted it as
    // available while `nextFor` never offered it. Inverting the predicate makes
    // every dependency look satisfied, which is the defect exactly.
    name: 'create refuses a dependency that names no task on the board',
    file: 'src/team/board.ts',
    from: '        const missing = task.dependsOn.find(dependency => !known.has(dependency))',
    to: '        const missing = task.dependsOn.find(dependency => known.has(dependency))',
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // Section 26. Closing a task leaves the owner on the row, so the ownership
    // fence passes for the member that just finished the work — releasing a `done`
    // task rewrote it to `open`, cleared the owner, and put finished work back in
    // the pool. Removing the fence is what the probe does, and the spec's refusal
    // assertion is what catches it.
    name: 'release refuses a closed task instead of putting finished work back',
    file: 'src/team/board.ts',
    from: "        this.refuseClosed(current, 'a closed task has no claim to release; rerun reopens a failed or cancelled one')",
    to: '        // [probe] the release fence is disabled',
    specs: ['packages/freecodego/harness-plugin/tests/team-board-cas.spec.ts'],
  },
  {
    // Section 28. Five doors ask one shared question, so they cannot disagree about
    // what "already closed" means. Narrowing it to `done` leaves `failed` and
    // `cancelled` reopenable by a stray call — the vocabulary is the load-bearing
    // part, not the call, which is why the probe is on the predicate.
    name: 'every closed outcome is a record, not only the one spelled done',
    file: 'src/team/board.ts',
    from: '    if (TEAM_TERMINAL_TASK_STATUS_NAMES.has(task.status)) {',
    to: "    if (task.status === 'done') {",
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // Section 34. One deletion has two spellings and only one of them was refused:
    // the POSIX verb was a hard denial while `Remove-Item -Recurse -Force` fell to
    // the no-match default. `ri` is the alias the policy's own sibling list names,
    // so dropping it here puts `ri -R -Fo` back on the floor's `prompt` — and the
    // rule stops matching its own example, which the compiler discards it for.
    name: 'the policy refuses the recursive delete in its short spelling, alias included',
    file: 'src/command-policy.ts',
    from: "      pattern: [['remove-item', 'ri'], ['-Recurse', '-recurse', '-r', '-R'], ['-Force', '-force', '-fo', '-Fo']],",
    to: "      pattern: [['remove-item'], ['-Recurse', '-recurse', '-r', '-R'], ['-Force', '-force', '-fo', '-Fo']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 34. `del /s /q build` and `rd /s build` are the same operation, and
    // the verb list is the only thing that says so. Narrowed to the two directory
    // verbs, `del /s /q build` drops to the floor's prompt.
    name: 'the tree-delete rule reads every cmd verb for it, not only the directory ones',
    file: 'src/command-policy.ts',
    from: "      pattern: [['rd', 'rmdir', 'del', 'erase'], ['/s', '/S']],",
    to: "      pattern: [['rd', 'rmdir'], ['/s', '/S']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 34. `/q` only suppresses the confirmation; it is not recursion, and
    // the `rm -f` rule above records what happens when a flag list confuses the
    // two. Accepting `/q` at that position makes `del /q build\out.js` — one named
    // file — a hard denial.
    name: 'the tree-delete rule keys on the recursion switch, not on the quiet one',
    file: 'src/command-policy.ts',
    from: "      pattern: [['rd', 'rmdir', 'del', 'erase'], ['/s', '/S']],",
    to: "      pattern: [['rd', 'rmdir', 'del', 'erase'], ['/s', '/S', '/q', '/Q']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 34. The floor is the reason an unfamiliar spelling of a Windows
    // delete is a question instead of a silent `allow`. A pattern is an ordered
    // prefix, so `Remove-Item C:\work -Recurse -Force` (flag after the operand)
    // reaches no rule above it and is decided entirely here.
    name: 'a Windows delete whose flags no pattern reaches asks, instead of defaulting to allow',
    file: 'src/command-policy.ts',
    from: "      pattern: [['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']],\n      decision: 'prompt',",
    to: "      pattern: [['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']],\n      decision: 'allow',",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 35. The pipeline rule's verb table is the half that had to learn the
    // Windows fetch verbs. Left with the two POSIX ones, `iwr … | iex` stops being
    // a pipeline into a shell and becomes a plain fetch prompt — the same
    // unaudited text, one approval instead of a refusal. The rule also stops
    // matching its own examples, which the compiler discards it for.
    name: 'the pipeline rule names the Windows fetch verbs, not only curl and wget',
    file: 'src/command-policy.ts',
    from: "      pattern: [['curl', 'wget', ...POWERSHELL_FETCH_PROGRAMS]],",
    to: "      pattern: [['curl', 'wget']],",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 35. The other direction of the same vocabulary: keeping only the long
    // cmdlet spelling drops `iex`, the name a person actually types. The bare
    // evaluator rule then stops matching its own example and is discarded, so
    // `iex build.ps1` — an opaque program string — falls to the no-match default.
    name: 'the bare evaluator rule reads the short spelling a person types, not only the cmdlet',
    file: 'src/command-policy.ts',
    from: "export const POWERSHELL_EXPRESSION_PROGRAMS: readonly string[] = ['iex', 'invoke-expression']",
    to: "export const POWERSHELL_EXPRESSION_PROGRAMS: readonly string[] = ['iex']",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 35. A bare evaluator is the `sh -c` shape, and the `prompt` is the
    // whole guard: the string it runs is opaque to this policy, and
    // `iex 'Remove-Item -Recurse -Force C:\work'` deleted a tree unattended while
    // `pwsh -c '…'` asked.
    name: 'a bare evaluator asks rather than running an opaque program string unattended',
    file: 'src/command-policy.ts',
    from: "      pattern: [[...POWERSHELL_EXPRESSION_PROGRAMS]],\n      decision: 'prompt',",
    to: "      pattern: [[...POWERSHELL_EXPRESSION_PROGRAMS]],\n      decision: 'allow',",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Section 30. The `\r` used to be an ordinary character, so it rode on the token
    // before it: `git push --force\r\n` tokenized to a flag no rule names and the
    // hard denial for a force push dropped to the general `git push` prompt. The
    // spelling of a line ending decided whether one operation was refused.
    name: 'a CRLF line ending cannot change what the tokenizer sees, so no rule flips',
    file: 'src/command-policy.ts',
    from: "    if (character === ' ' || character === '\\t' || character === '\\r') { push(); continue }",
    to: "    if (character === ' ' || character === '\\t') { push(); continue }",
    specs: ['packages/freecodego/harness-plugin/tests/command-policy.spec.ts'],
  },
  {
    // Every other section of the rehydration message is bounded — the memory list
    // by `MAX_MEMORY_EXCERPTS`, each excerpt by `MAX_EXCERPT_CHARS`, the arc by
    // `MAX_FACTS_PER_LIST` — while the task list came straight off the newest
    // `todo/write` payload, which nothing upstream bounds: the harness builds that
    // event from a tool call, so its length is whatever the model sent. A measured
    // 500-item write rendered 88 KB (507 lines) into a session that had just been
    // compacted to reclaim exactly that. The cap and the omitted-count marker are
    // one behaviour: dropping the bound also drops the sentence that admits it.
    name: 'a restored task list is bounded, and says how much it left out',
    file: 'src/rehydration.ts',
    from: 'const shown = input.todos.slice(0, MAX_TODO_ITEMS)',
    to: 'const shown = input.todos.slice()',
    specs: ['packages/freecodego/harness-plugin/tests/rehydration.spec.ts'],
  },
  {
    // The vocabulary is the whole guard: `denyRefusal` and the credential shield
    // both read paths through it, so a key it does not know is a path neither one
    // sees. `engineering_hunks` answers with a preview of the lines a call added
    // and `engineering_hunk_revert` writes the file back, and both spell the path
    // `file` — a key that was in no list, which is the failure the list's own
    // comment calls the one it exists to prevent.
    name: 'a path a call spells `file` is judged like any other spelling',
    file: 'src/sandbox/profiles.ts',
    from: "export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath', 'filename', 'target_file', 'targetFile', 'locator', 'file'] as const",
    to: "export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath', 'filename', 'target_file', 'targetFile', 'locator'] as const",
    specs: ['packages/freecodego/harness-plugin/tests/sandbox-profiles.spec.ts'],
  },
  {
    // The repo map is registered from both engine branches, and the second one
    // used to be a verbatim copy rather than a call. A copy is only a hazard once
    // it drifts, and drift is exactly what nothing here would have noticed:
    // neither branch was asserted, and the tool is present either way — the
    // difference would have shown only in what it does, and only for the users
    // whose configuration picked the other branch. The mutation removes the call
    // rather than the definition, so what goes red is the branch's registration
    // and not the tool.
    name: 'the engine branch registers the runtime-free repo map too',
    file: 'src/engineering.ts',
    from: '    this.registerRepoMapToolOnly()',
    to: '    void this.registerRepoMapToolOnly',
    specs: ['packages/freecodego/harness-plugin/tests/engineering-tool-surface.spec.ts'],
  },
  {
    // The status vocabulary is split in two on purpose: `TEAM_TASK_STATUSES`
    // holds what the model may ask for, `TEAM_STORED_TASK_STATUSES` what a file
    // may hold, and the difference is `blocked`, which the board computes rather
    // than stores. The split is written out by hand because a derived list cannot
    // disagree, and the comment above the stored half says disagreement is the
    // only thing that list is there to detect — but nothing detected it. Adding a
    // status to the full list and not to the stored one is the drift that arrives,
    // and it is silent: the status becomes settable in memory, `isStoredStatus`
    // does not know it, and `parseBoard` repairs it to `open` on the next read
    // while writing a ledger entry that blames the file. The mutation adds the
    // status to the full list only, so what goes red is the partition and nothing
    // else — the same edit that would ship the bug.
    name: 'a status added to the full vocabulary is not left out of the stored half',
    file: 'src/team/board.ts',
    from: "export const TEAM_TASK_STATUSES = ['open', 'claimed', 'needs-review', 'blocked', 'done', 'failed', 'cancelled'] as const",
    to: "export const TEAM_TASK_STATUSES = ['open', 'claimed', 'needs-review', 'blocked', 'done', 'failed', 'cancelled', 'deferred'] as const",
    specs: ['packages/freecodego/harness-plugin/tests/team-board.spec.ts'],
  },
  {
    // The registry-visible settlement is the only channel the owning agent has
    // for a verification run's outcome: the job has no `readOutput`, so
    // `job_output` renders the `output` this settlement carries and nothing else.
    // Dropping it restores the shipped behaviour — an empty body under a
    // completion notice that says "Read its output with job_output." — and the
    // summary is where the fake-green audit reports that the verdict was measured
    // against a different change than the workspace holds. The mutation is the
    // minimal one that reproduces that: the row still settles, the status still
    // crosses, only the text is lost.
    name: 'a settled verification job carries its summary to the owning agent',
    file: 'src/engineering-jobs.ts',
    from: 'const settled = job.summary === undefined ? {} : { output: job.summary }',
    to: 'const settled = {}',
    specs: ['packages/freecodego/harness-plugin/tests/engineering-jobs.spec.ts'],
  },
  {
    // `engineering_team_board` cuts the task list to a window, and the count it
    // was cut from is the only thing that keeps the window from passing for the
    // board. `summary.total` cannot stand in for it: that counts every task on
    // the board, while the window is cut from the ones the `include_done` filter
    // left, so the two disagree by exactly the done tasks. Reading the count off
    // the window instead — which is what the shipped code did, by not carrying a
    // count at all — makes `tasksShown` and `tasksMatching` agree, and a reader
    // that sees them agree reports the board as complete. That is the silent
    // truncation this pair of numbers exists to prevent, so the mutation is the
    // window's own length reported as the number it was cut from.
    name: 'a task-list window says how many tasks it was cut from',
    file: 'src/team/tools.ts',
    from: '          tasksMatching: matching.length,',
    to: '          tasksMatching: Math.min(matching.length, TEAM_BOARD_TASK_LIMIT),',
    specs: ['packages/freecodego/harness-plugin/tests/team-tool-state.spec.ts'],
  },
  {
    // The `kind` guard recognized two of the four members its own type declares,
    // so a row naming a kind with no producer in this build was renamed to
    // `verification` — not a missing answer but a different and more specific
    // one, since that is the kind whose rows carry a verdict. The row is durable
    // and the table has no CHECK constraint on `kind`, so such a row is reachable
    // without any producer here. The mutation restores the shipped guard.
    name: 'a job row keeps the kind it was written with',
    file: 'src/engineering-jobs.ts',
    from: "const kind = row.kind === 'verification' || row.kind === 'graph-build' || row.kind === 'graph-update' || row.kind === 'council' ? row.kind : 'verification'",
    to: "const kind = row.kind === 'graph-build' || row.kind === 'graph-update' ? row.kind : 'verification'",
    specs: ['packages/freecodego/harness-plugin/tests/engineering-jobs.spec.ts'],
  },
  {
    // The merge is the one team tool that changes the shared tree, and the set did
    // not name it: a turn whose only mutation was `git merge --no-ff` at the
    // workspace root was filed as a turn that changed nothing, so the gate returned
    // before it read a single path. The set's own header calls a missing name the
    // hole, and `multi_edit` already fell through it once in this shape. Renamed
    // rather than deleted because an exact-match list cannot tell the two apart —
    // either way the name is not in the set, which is all the gate asks.
    name: 'a merge that changed the shared tree counts as a mutation',
    file: 'src/verify-on-stop.ts',
    from: "  'engineering_team_merge',",
    to: "  'engineering_team_merge_renamed',",
    specs: ['packages/freecodego/harness-plugin/tests/verify-on-stop.spec.ts'],
  },
  {
    // `edit_and_run` is named by the one prompt section this plugin injects, and
    // the never-deferred set did not hold it: the set's own header lists it among
    // the three tools that need an entry *because* they sit outside the prefixed
    // families, so family membership protects nothing here and the set is the only
    // thing that can. Renamed rather than deleted because an exact-match set cannot
    // tell the two apart — either way the name is absent, which is what the model's
    // instruction turns on.
    name: 'a tool the plugin prompt names is never deferred',
    file: 'src/deferred-tools.ts',
    from: "  'edit_and_run',",
    to: "  'edit_and_run_renamed',",
    specs: ['packages/freecodego/harness-plugin/tests/deferred-tools.spec.ts'],
  },
]

const read = (file: string): string => readFileSync(resolve(PACKAGE, file), 'utf8')

/**
 * Read a file in the coordinate space the anchors above are written in.
 *
 * `core.autocrlf=true` — set on this checkout — rewrites to CRLF any file git
 * touches, while an anchor is written with `\n`. Comparing the two byte for byte
 * reports an anchor that *is* there as gone, and the probe it belongs to silently
 * stops guarding the tree. Measured: `src/plan-mode.ts` carries CRLF in the
 * working copy while the anchored files around it are LF, and its is the only
 * multi-line anchor in the list — every single-line anchor in the same CRLF files
 * matched, which is exactly what made this look like a content problem.
 *
 * `restore` puts the file's own endings back on the way out, so a run neither
 * converts a CRLF file to LF nor leaves a probe unable to revert: the mutation
 * rewrites one anchor, not the file's line endings, and the probe-run half's
 * byte comparison against the pre-mutation content still holds.
 */
function anchorSpace(text: string): { readonly body: string; readonly restore: (mutated: string) => string } {
  if (!text.includes('\r\n')) return { body: text, restore: mutated => mutated }
  return { body: text.replace(/\r\n/g, '\n'), restore: mutated => mutated.replace(/\n/g, '\r\n') }
}

describe('guard probe anchors', () => {
  it('finds every declared mutation anchor, and no leftover mutation', () => {
    for (const probe of PROBES) {
      const source = anchorSpace(read(probe.file)).body
      // An anchor that no longer exists mutates nothing and reports success,
      // which is the one way this file could lie.
      expect(source, `${probe.file} no longer contains the anchor for "${probe.name}"`).toContain(probe.from)
      // The anchor check above is the decisive half: applying a mutation is
      // exactly what removes `from`, so a leftover mutation cannot pass it.
      //
      // Scanning for `to` looks like the other half, but no single snapshot can
      // decide it. A mutation may replace a block with a line already written
      // inside that block, and its replacement may equally be text that occurs
      // elsewhere in the file for its own reasons — `{ status: 'cancelled' }` is
      // both the mutation for one probe and the correct code two lines below it.
      // In both shapes a healthy file contains `to`, so the scan reports rot
      // that is not there. A leftover mutation is caught by `runProbe` instead,
      // which compares the file against the content it read before mutating.
    }
  })

  it('declares a mutation it can take back out, so no probe can strand the tree', () => {
    // `revert()` repairs the file by replacing the first occurrence of `to`, and
    // refuses when `to` is not unique — replacing one of several would *move* the
    // mutation rather than remove it. So a probe whose `to` occurs more than once
    // in its own mutated content can never be reverted: it applies its mutation,
    // the specs run, the revert declines, and the source tree keeps a broken
    // guard until someone restores it by hand.
    //
    // That is not hypothetical. `a Windows path names one program token` declares
    // `to: ')'`, and the file it mutates carries 276 closing parentheses, so its
    // revert could only ever decline. The scan the sibling test above describes
    // and rejects is a different question — "does the *original* file contain
    // `to`" — and is indeed undecidable; this one applies the mutation in memory
    // and counts in the result, which is exactly the precondition `revert()`
    // tests at runtime.
    const stranded: string[] = []
    for (const probe of PROBES) {
      const mutated = anchorSpace(read(probe.file)).body.replace(probe.from, probe.to)
      const occurrences = mutated.split(probe.to).length - 1
      if (occurrences !== 1) {
        stranded.push(`${probe.name} (${probe.file}): \`to\` occurs ${occurrences} times in the mutated file, so revert() declines`)
      }
    }
    expect(stranded).toStrictEqual([])
  })

  it('reads an anchor in the file’s own line endings, so CRLF cannot disarm a probe', () => {
    const crlf = "  'inspect',\r\n  'spill_recall',\r\n"
    const space = anchorSpace(crlf)
    expect(space.body).toBe("  'inspect',\n  'spill_recall',\n")
    // `restore` is the exact inverse, which is what the probe-run half asserts
    // after its revert: the file must come back byte for byte.
    expect(space.restore(space.body)).toBe(crlf)
    // An LF file is passed through untouched, mutation and revert alike.
    const lf = "  'inspect',\n"
    expect(anchorSpace(lf).restore(anchorSpace(lf).body.replace("  'inspect',", ''))).toBe("\n")
  })

  it('names a spec that exists for every probe, so no probe can pass vacuously', () => {
    for (const probe of PROBES) {
      // A length check alone does not close this. `vitest run` with a path that
      // does not exist exits non-zero without running a test -- "No test files
      // found, exiting with code 1" -- and the verdict table reads any non-zero
      // exit as `caught`. A probe with empty or mistyped specs would therefore
      // report the strongest verdict while proving nothing, which is the same
      // failure mode the anchor check above exists to stop, one level up.
      expect(probe.specs.length, probe.name).toBeGreaterThan(0)
      for (const spec of probe.specs) {
        expect(existsSync(resolve(PLUGIN_ROOT, spec)), `${probe.name} names a spec that is not there: ${spec}`).toBe(true)
      }
    }
  })
})

type Verdict = 'caught' | 'missed' | 'inconclusive'

/**
 * What one probe run concludes, as a pure decision so the table can be tested.
 *
 * The distinction this exists for is between a spec that *saw* the broken guard
 * and passed, and a run that cannot answer the question at all:
 *
 * - Nothing mutated — the anchor text is not in the file, so the child tested the
 *   guard that is still there. A pass here says nothing, and a failure could come
 *   from anywhere.
 * - The file changed while the child ran — a shared checkout gets written by other
 *   agents, and a mutation reverted mid-run was never in front of the specs. This
 *   is the one that produced a false "not caught" once.
 * - The child did not exit on its own — `null` is a timeout or a signal. A killed
 *   run says nothing about the guard, and reading it as `caught` would report the
 *   strongest verdict for a probe that never finished.
 * - The child collected no spec file — no summary line, so vitest never got as
 *   far as running a test. This is the shape of a mistyped spec path
 *   ("No test files found, exiting with code 1") and of a shell that could not
 *   start vitest at all; both exit non-zero for a reason unrelated to the guard.
 *
 * None of these is a defect in the guard, and none may be read as one. The last
 * two are why `caught` needs positive evidence rather than a non-zero exit.
 */
function verdictOf(run: {
  readonly status: number | null
  readonly changedWhileRunning: boolean
  readonly mutatedAtAll: boolean
  readonly ranSpecs: boolean
}): Verdict {
  if (!run.mutatedAtAll || run.changedWhileRunning) return 'inconclusive'
  if (run.status === null || !run.ranSpecs) return 'inconclusive'
  return run.status === 0 ? 'missed' : 'caught'
}

/** How many times an inconclusive run is retried before it is reported as such. */
const PROBE_ATTEMPTS = 3

/**
 * Vitest's per-run file summary, printed once for every run that collected a
 * spec file and absent when it collected none.
 *
 * The absence is the signal: `npx vitest run <a path that does not exist>` exits
 * 1 with "No test files found" and prints no summary at all, so a non-zero exit
 * on its own cannot distinguish a spec that failed from a run that never began.
 */
const SPEC_SUMMARY = /Test Files\s+\d/

/**
 * SGR colour codes, stripped before {@link SPEC_SUMMARY} is applied.
 *
 * Vitest writes the counts as `Test Files \e[22m \e[1m\e[32m6 passed…`, so the
 * text is followed by an escape and never by a digit. A pattern that cannot
 * match is worse here than no check at all: every probe would read as
 * inconclusive, retry its whole run three times, and the suite would report that
 * it proved nothing about any guard.
 */
const SGR = /\u001b\[[0-9;]*m/g

interface ProbeRun {
  readonly verdict: Verdict
  /** The child's output, for a verdict that needs explaining. */
  readonly output: string
  /**
   * The file exactly as it was read immediately before the last mutation.
   *
   * The leftover check compares against this rather than against `to`, because
   * `to` is not always absent from a restored file: a mutation may replace a
   * block with a line from inside it, or with text that occurs elsewhere for its
   * own reasons. Both shapes leave a healthy file containing `to`.
   */
  readonly original: string
}

/**
 * Mutate the guard, run its specs, and take the mutation back out.
 *
 * The revert is surgical: it rewrites the mutated token and nothing else. Writing
 * the whole previous file back would discard whatever another agent saved while
 * the child was running — which is what happened once in a shared checkout, and
 * it also left the mutation in the tree when the write was skipped, so the next
 * attempt could not find its anchor and could not repair it either.
 */
function runProbe(probe: GuardProbe): ProbeRun {
  const path = resolve(PACKAGE, probe.file)
  let output = ''
  let original = read(probe.file)
  // Reverts this probe's own mutation wherever it currently is, and touches
  // nothing else. Returns whether anything was reverted. Every read and write
  // below goes through the anchor's coordinate space, so a working copy git wrote
  // with CRLF is mutated (and restored) instead of being read as if its anchor
  // were missing.
  const revert = (): boolean => {
    const current = anchorSpace(read(probe.file))
    // `replace` rewrites the first occurrence. With a second one the mutation
    // would not be removed but *moved*: the first hit gets repaired and the
    // leftover stays where it was not before, which is how one probe left
    // `worker.ts` reporting a refused cancel as `failed` from its idle path.
    // Refusing leaves the tree dirty and lets the caller's comparison report it.
    const occurrences = current.body.split(probe.to).length - 1
    if (occurrences !== 1) return false
    writeFileSync(path, current.restore(current.body.replace(probe.to, probe.from)))
    return true
  }
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    original = read(probe.file)
    const space = anchorSpace(original)
    const mutated = space.body.replace(probe.from, probe.to)
    const mutatedAtAll = mutated !== space.body
    writeFileSync(path, space.restore(mutated))
    let status: number | null = null
    let changedWhileRunning = false
    let ranSpecs = false
    try {
      const run = spawnSync(
        `npx vitest run ${probe.specs.join(' ')}`,
        { cwd: PLUGIN_ROOT, shell: true, encoding: 'utf8', timeout: 240_000 },
      )
      status = run.status
      output = run.stdout ?? ''
      // Vitest prints its file summary once per run that collected a spec file,
      // and omits it when it collected none. This is the positive evidence that
      // a non-zero exit came from a test and not from the runner failing to
      // start -- see `verdictOf`.
      ranSpecs = SPEC_SUMMARY.test(output.replace(SGR, ''))
      // Read before the revert: after it, this comparison is trivially true and
      // the race would be invisible.
      changedWhileRunning = !anchorSpace(read(probe.file)).body.includes(probe.to)
    } finally {
      revert()
    }
    const verdict = verdictOf({ status, changedWhileRunning, mutatedAtAll, ranSpecs })
    if (verdict !== 'inconclusive' || !mutatedAtAll) return { verdict, output, original }
  }
  return { verdict: 'inconclusive', output, original }
}

describe('the probe verdict table', () => {
  it('reads a failing spec as caught, and a passing one as missed', () => {
    expect(verdictOf({ status: 1, changedWhileRunning: false, mutatedAtAll: true, ranSpecs: true })).toBe('caught')
    expect(verdictOf({ status: 0, changedWhileRunning: false, mutatedAtAll: true, ranSpecs: true })).toBe('missed')
  })

  it('refuses to conclude anything when the file moved under the run', () => {
    // The false "not caught" of a shared checkout: the mutation was reverted by
    // another agent's save while the child was running, so the specs saw the
    // guard that is still there and passed.
    expect(verdictOf({ status: 0, changedWhileRunning: true, mutatedAtAll: true, ranSpecs: true })).toBe('inconclusive')
    expect(verdictOf({ status: 1, changedWhileRunning: false, mutatedAtAll: false, ranSpecs: true })).toBe('inconclusive')
  })

  it('refuses to read a child that never reached a verdict as caught', () => {
    // `caught` is the verdict this suite exists to produce, so a run that
    // proved nothing must not be able to claim it. Both shapes below exit
    // non-zero -- `null` for a timeout or a signal, and 1 for a run that
    // collected no spec -- and neither says anything about the guard.
    expect(verdictOf({ status: null, changedWhileRunning: false, mutatedAtAll: true, ranSpecs: true })).toBe('inconclusive')
    expect(verdictOf({ status: 1, changedWhileRunning: false, mutatedAtAll: true, ranSpecs: false })).toBe('inconclusive')
    // A passing run that collected nothing is not `missed` either: a spec that
    // never ran cannot have missed the mutation.
    expect(verdictOf({ status: 0, changedWhileRunning: false, mutatedAtAll: true, ranSpecs: false })).toBe('inconclusive')
  })

  it('reads the summary vitest prints only for a run that collected a file', () => {
    expect(SPEC_SUMMARY.test(' Test Files  1 failed (1)\n      Tests  2 failed (2)')).toBe(true)
    expect(SPEC_SUMMARY.test(' Test Files  1 passed (1)')).toBe(true)
    // The real output of `npx vitest run <a path that does not exist>`.
    expect(SPEC_SUMMARY.test('No test files found, exiting with code 1')).toBe(false)
  })
})

const enabled = process.env.FREECODEGO_GUARD_PROBES === '1'

describe.skipIf(!enabled)('guard probes under mutation', () => {
  for (const probe of PROBES) {
    it(
      probe.name,
      () => {
        const result = runProbe(probe)
        // The invariant that matters after any attempt: the tree does not keep a
        // broken guard, whatever happened to the file during the run. Compared
        // against the pre-mutation content, not against `to`: a mutation may
        // replace a whole block with a line from inside it, and then `to` is
        // still present in a correctly restored file.
        expect(read(probe.file), `${probe.file} was left carrying a mutation`).toBe(result.original)
        if (result.verdict === 'inconclusive') {
          throw new Error(`${probe.file} could not be mutated and held still for a full run. Nothing was concluded; re-run when the tree is quiet.`)
        }
        expect(result.verdict, `${probe.file} mutated, but its specs still passed:\n${result.output}`).toBe('caught')
      },
      300_000 * PROBE_ATTEMPTS,
    )
  }
})
