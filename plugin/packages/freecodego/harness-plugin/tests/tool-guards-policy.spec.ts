import { describe, expect, it } from 'vitest'
import { COMPILED_BUILT_IN_COMMAND_POLICY } from '../src/command-policy.ts'
import { DoomLoopGuard, freeCodeGoToolGuard } from '../src/tool-guards.ts'

function guard(options: { readonly planMode?: 'plan' | 'execute' | undefined } = {}) {
  const doomLoop = new DoomLoopGuard()
  return freeCodeGoToolGuard({
    settings: () => ({ envReadGuardEnabled: true, doomLoopGuardEnabled: true, commandPolicyEnabled: true, planModeEnabled: true }),
    doomLoop,
    policy: COMPILED_BUILT_IN_COMMAND_POLICY,
    ...(options.planMode === undefined ? {} : { planMode: { policy: COMPILED_BUILT_IN_COMMAND_POLICY, modeFor: () => options.planMode } }),
  })
}

const exec = (name: string, args: unknown) => ({ name, arguments: args, agent: { id: 'a1' } }) as never

describe('command policy guard', () => {
  it('denies a forbidden command with the rule\'s own justification', () => {
    const denial = guard()(exec('bash', { command: 'rm -rf build' }))
    expect(denial).toContain('Blocked by the FreeCodeGo command policy')
    expect(denial).toContain('name the exact files')
  })

  it('leaves a prompt-decision command to the approval layer, because this guard is monotonic', () => {
    expect(guard()(exec('bash', { command: 'git push origin main' }))).toBeUndefined()
    expect(guard()(exec('bash', { command: 'pnpm exec tsc -b' }))).toBeUndefined()
  })

  it('ignores tools that do not run shell commands', () => {
    expect(guard()(exec('read', { path: 'src/a.ts' }))).toBeUndefined()
  })

  it('reads a stringified argument payload', () => {
    expect(guard()(exec('bash', JSON.stringify({ command: 'rm -rf /' })))).toContain('command policy')
  })
})

describe('plan mode guard', () => {
  it('refuses a mutating tool while the conversation is planning', () => {
    const denial = guard({ planMode: 'plan' })(exec('write', { path: 'a.ts', content: 'x' }))
    expect(denial).toContain('Refused by Plan Mode')
  })

  it('refuses an unclear command but allows a read-only one', () => {
    const subject = guard({ planMode: 'plan' })
    expect(subject(exec('bash', { command: 'npm install left-pad' }))).toContain('Refused by Plan Mode')
    expect(subject(exec('bash', { command: 'pnpm exec vitest run' }))).toBeUndefined()
    expect(subject(exec('grep', { pattern: 'a' }))).toBeUndefined()
  })

  it('enforces nothing once the mode is left', () => {
    expect(guard({ planMode: 'execute' })(exec('write', { path: 'a.ts' }))).toBeUndefined()
  })

  it('does not enforce Plan Mode when no mode source is wired', () => {
    expect(guard()(exec('write', { path: 'a.ts' }))).toBeUndefined()
  })

  it('does not report a policy refusal as a doom loop', () => {
    const subject = guard({ planMode: 'plan' })
    for (let index = 0; index < 5; index += 1) {
      expect(subject(exec('bash', { command: 'rm -rf build' }))).toContain('command policy')
    }
  })
})

describe('guard switches', () => {
  it('honours the command-policy off switch', () => {
    const subject = freeCodeGoToolGuard({
      settings: () => ({ commandPolicyEnabled: false, doomLoopGuardEnabled: false }),
      doomLoop: new DoomLoopGuard(),
      policy: COMPILED_BUILT_IN_COMMAND_POLICY,
    })
    expect(subject(exec('bash', { command: 'rm -rf build' }))).toBeUndefined()
  })

  it('honours the Plan Mode off switch while the guard still protects credentials', () => {
    const subject = freeCodeGoToolGuard({
      settings: () => ({ planModeEnabled: false, commandPolicyEnabled: false, doomLoopGuardEnabled: false }),
      doomLoop: new DoomLoopGuard(),
      policy: COMPILED_BUILT_IN_COMMAND_POLICY,
      planMode: { policy: COMPILED_BUILT_IN_COMMAND_POLICY, modeFor: () => 'plan' },
    })
    expect(subject(exec('write', { path: '.env' }))).toContain('credential guard')
  })
})
