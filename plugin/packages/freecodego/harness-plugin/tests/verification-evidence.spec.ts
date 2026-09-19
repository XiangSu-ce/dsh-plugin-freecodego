/**
 * The evidence rule exists so a verdict cannot be bought with a command that
 * could not have come out the other way. Three properties are worth pinning:
 *
 * 1. A real gate is a check whatever shape it arrives in (runner, project
 *    script, dispatcher, platform build tool).
 * 2. A command that cannot fail is not a check, and the refusal names why.
 * 3. An exit status is attributed to the check only when the shell would report
 *    the check's own status.
 */

import { describe, expect, it } from 'vitest'
import { SHELL_INTERPRETERS } from '../src/command-policy.ts'
import {
  classifyVerificationCommand,
  exitStatusIsAttributable,
  inlineScriptCanFail,
  isTemporaryPath,
  shellSegments,
  verificationCoversChange,
} from '../src/verification-evidence.ts'

describe('verification command classification', () => {
  it('recognizes the runners a project gate uses, with their kind', () => {
    expect(classifyVerificationCommand(['npx', 'vitest', 'run']).kind).toBe('tests')
    expect(classifyVerificationCommand(['pnpm', 'pytest', '-q']).kind).toBe('tests')
    expect(classifyVerificationCommand(['npx', 'tsc', '-b']).kind).toBe('types')
    expect(classifyVerificationCommand(['biome', 'check', '.']).kind).toBe('lint')
    expect(classifyVerificationCommand(['go', 'test', './...']).kind).toBe('tests')
    expect(classifyVerificationCommand(['cargo', 'clippy']).kind).toBe('lint')
    for (const command of [['npx', 'vitest', 'run'], ['pnpm', 'pytest', '-q'], ['npx', 'tsc', '-b']] as const) {
      expect(classifyVerificationCommand(command).verification).toBe(true)
    }
  })

  it('reads a dispatcher as the program it hands off to', () => {
    // `npx vitest run` is a test run, not an unknown script: npx passes every
    // argument through, so the program after it decides the kind.
    const classified = classifyVerificationCommand(['npx', 'vitest', 'run', 'src/a.test.ts'])
    expect(classified.kind).toBe('tests')
    expect(classified.runner).toBe('vitest')
    expect(classified.reason).toContain('via `npx`')
  })

  it('treats a project-declared script as the project intent, keeping only its kind unknown', () => {
    const named = classifyVerificationCommand(['pnpm', 'run', 'typecheck'])
    expect(named.verification).toBe(true)
    expect(named.kind).toBe('types')
    const unknown = classifyVerificationCommand(['pnpm', 'run', 'gate'])
    expect(unknown.verification).toBe(true)
    expect(unknown.kind).toBe('check-script')
  })

  it('reads a manager verb that is not a subcommand as the binary it hands off to', () => {
    // `pnpm pytest -q` runs pytest; the manager only passes the word through.
    const classified = classifyVerificationCommand(['pnpm', 'pytest', '-q'])
    expect(classified.kind).toBe('tests')
    expect(classified.reason).toContain('via `pnpm`')
    expect(classifyVerificationCommand(['pnpm', 'exec', 'tsc', '-b']).kind).toBe('types')
  })

  it('refuses a manager verb that manages the tree instead of checking it', () => {
    const installed = classifyVerificationCommand(['npm', 'ci'])
    expect(installed.verification).toBe(false)
    expect(installed.reason).toContain('dependency tree')
    expect(classifyVerificationCommand(['pnpm', 'install']).verification).toBe(false)
    // ...but an audit does report, and can fail on what it finds.
    expect(classifyVerificationCommand(['npm', 'audit']).verification).toBe(true)
  })

  it('refuses programs that observe nothing', () => {
    for (const command of [['echo', 'ok'], ['true'], ['ls', '-la'], ['sleep', '1'], ['pwd']] as const) {
      const classified = classifyVerificationCommand(command)
      expect(classified.verification).toBe(false)
      expect(classified.kind).toBe('not-a-check')
      expect(classified.reason).toContain('cannot fail')
    }
  })

  it('refuses an unfalsifiable one-liner whatever runtime or spelling carries it', () => {
    // The rule this module exists for — "the cheapest way to turn red green is to
    // declare a probe that cannot fail" — used to hold for `node -e` and break for
    // every sibling: `bun` is an interpreter *and* a package manager, so the manager
    // branch ran first, read `-e` as an unknown verb, handed it back as a program
    // name and answered `check-script`; `php` evaluates with `-r`, which no shared
    // flag set carried, so its code string was read as a script *file*. Changing the
    // runtime is not supposed to change the verdict.
    for (const command of [
      ['node', '-e', 'process.exit(0)'],
      ['bun', '-e', 'process.exit(0)'],
      ['bun', '--eval', 'process.exit(0)'],
      ['bun', '-p', '1'],
      ['php', '-r', 'echo 1;'],
      ['deno', 'eval', 'Deno.exit(0)'],
    ] as const) {
      const classified = classifyVerificationCommand(command)
      expect(classified.verification, command.join(' ')).toBe(false)
      expect(classified.reason, command.join(' ')).toContain('no assertion')
    }
    // ...and the same spellings still count when the script *can* fail.
    expect(classifyVerificationCommand(['bun', '-e', 'require("node:assert").ok(false)']).verification).toBe(true)
    expect(classifyVerificationCommand(['php', '-r', 'assert(false);']).verification).toBe(true)
  })

  it('reads `-c` as the program means it, not as one shared spelling', () => {
    // `-c` hands code to python and a *file* to node/ruby/perl, where it is the short
    // form of `--check`. One shared flag set made the long spelling correct and the
    // short one wrong, so the same syntax check counted as evidence or not depending
    // on how it was typed.
    for (const command of [
      ['node', '-c', 'script.mjs'],
      ['ruby', '-c', 'app.rb'],
      ['perl', '-c', 'script.pl'],
    ] as const) {
      const classified = classifyVerificationCommand(command)
      expect(classified.verification, command.join(' ')).toBe(true)
      expect(classified.kind, command.join(' ')).toBe('check-script')
      expect(classified.reason, command.join(' ')).not.toContain('no assertion')
    }
    // The long spelling was always read this way; the two must agree.
    expect(classifyVerificationCommand(['node', '--check', 'script.mjs']).kind).toBe('check-script')
    // ...while python's `-c` really is code, and an empty one cannot fail.
    expect(classifyVerificationCommand(['python', '-c', 'pass']).verification).toBe(false)
  })

  it('reads a flag as the subject of the run only when the program evaluates it', () => {
    // `-p`/`-c` name a project, plugin or config file just as often as they name an
    // inline script, and this reading decides whether a changed path is `uncovered`.
    for (const command of [
      ['pnpm', 'exec', 'tsc', '-p', 'packages/app/tsconfig.json'],
      ['pytest', '-p', 'no:cacheprovider'],
      ['vitest', 'run', '-c', 'vitest.config.ts'],
    ] as const) {
      const classified = classifyVerificationCommand(command)
      expect(classified.verification, command.join(' ')).toBe(true)
      expect(classified.inline, command.join(' ')).toBeUndefined()
      expect(verificationCoversChange(command, ['src/a.ts']), command.join(' ')).toBe('suite')
    }
    // The positive control: a real inline script still covers what it was written for.
    expect(verificationCoversChange(['node', '-e', 'assert(x)'], ['src/a.ts'])).toBe('targeted')
  })

  it('refuses an inline script that has no way to report failure', () => {
    const classified = classifyVerificationCommand(['node', '-e', 'process.exit(0)'])
    expect(classified.verification).toBe(false)
    expect(classified.reason).toContain('no assertion')
    expect(classifyVerificationCommand(['node', '-e', 'require("node:assert").ok(false)']).verification).toBe(true)
    expect(inlineScriptCanFail('process.exit(0)')).toBe(false)
    expect(inlineScriptCanFail('assert(x === 1)')).toBe(true)
    expect(inlineScriptCanFail('throw new Error("boom")')).toBe(true)
  })

  it('refuses a script under a temporary directory, which is never the workspace', () => {
    const temporary = classifyVerificationCommand(['node', '/tmp/probe.js'], '/workspace/app')
    expect(temporary.verification).toBe(false)
    expect(temporary.reason).toContain('temporary directory')
  })

  it('tells a workspace script apart from one outside it, and admits when it cannot', () => {
    const outside = classifyVerificationCommand(['node', '/opt/tools/probe.js'], '/workspace/app')
    expect(outside.verification).toBe(true)
    expect(outside.reason).toContain('outside the verified workspace')
    const inside = classifyVerificationCommand(['node', '/workspace/app/tools/probe.js'], '/workspace/app')
    expect(inside.reason).toContain('inside the verified workspace')
    // Not knowing the workspace is a third answer, not a guess in either direction.
    expect(classifyVerificationCommand(['node', '/opt/tools/probe.js']).reason).toContain('membership unstated')
  })

  it('classifies a shell line by its last stage, naming the wrapper', () => {
    expect(classifyVerificationCommand(['sh', '-c', 'cd app && npm test']).kind).toBe('tests')
    expect(classifyVerificationCommand(['sh', '-c', 'cd app && npm test']).reason).toContain('via `sh -c`')
    expect(classifyVerificationCommand(['cmd', '/c', 'echo done']).verification).toBe(false)
    expect(classifyVerificationCommand(['bash', '-c', '   ']).reason).toContain('empty line')
  })

  it('reads every shell the command policy names as a wrapper, not just the POSIX few', () => {
    // The wrapper branch answers from `command-policy.ts`'s SHELL_INTERPRETERS. The
    // copy that used to live in this module drifted in both directions: it was
    // missing `fish` and `script` — so `fish -c 'npm test'`, a check that really
    // ran, was recorded as no evidence at all — and it carried `cmd.exe` and
    // `powershell.exe`, which `bareProgram()` has already stripped the extension
    // from and which therefore could never match anything.
    for (const shell of SHELL_INTERPRETERS) {
      expect(classifyVerificationCommand([shell, '-c', 'npm test']).kind, shell).toBe('tests')
    }
    // Named one by one as well: a loop over the policy's own list cannot see a
    // member going missing from that list, and these two are the ones lost.
    for (const shell of ['fish', 'script']) {
      expect(classifyVerificationCommand([shell, '-c', 'npm test']).kind, shell).toBe('tests')
      expect(classifyVerificationCommand([shell, '-c', 'npm test']).reason, shell).toContain(`via \`${shell} -c\``)
    }
  })

  it('names no program as the reason a bare empty command is not a check', () => {
    expect(classifyVerificationCommand(['  ']).verification).toBe(false)
    expect(classifyVerificationCommand(['  ']).reason).toContain('names no program')
  })

  it('reads a formatter as a check only when it would report rather than rewrite', () => {
    expect(classifyVerificationCommand(['prettier', '--check', '.']).verification).toBe(true)
    expect(classifyVerificationCommand(['prettier', '--write', '.']).verification).toBe(false)
  })

  it('splits a shell line on separators and pipes, in reading order', () => {
    expect(shellSegments('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(shellSegments('   \n  ')).toEqual([])
  })

  it('recognizes temporary locations on both separators', () => {
    expect(isTemporaryPath('/tmp/x.js')).toBe(true)
    expect(isTemporaryPath('C:\\Users\\me\\AppData\\Local\\Temp\\x.js')).toBe(true)
    expect(isTemporaryPath('src/x.js')).toBe(false)
  })
})

describe('exit status attribution', () => {
  it('attributes an argv command to itself', () => {
    expect(exitStatusIsAttributable(['npm', 'run', 'test']).attribuable).toBe(true)
  })

  it('refuses a status that belongs to a filter after the check', () => {
    const piped = exitStatusIsAttributable(['sh', '-c', 'npm test | tail -20'])
    expect(piped.attribuable).toBe(false)
    expect(piped.reason).toContain("filter's")
    expect(exitStatusIsAttributable(['bash', '-c', 'pytest -q | grep FAIL']).attribuable).toBe(false)
  })

  it('finds the shell behind a launcher before calling a status attributable', () => {
    // The reading used to start at `argv[0]`. A launcher in front of the shell made
    // that position a word no rule knows — not a shell, so not a pipeline — and the
    // line was declared attributable, so a status that really belongs to `tail` was
    // counted as the check's own pass. The same four words are in
    // `command-policy.ts`'s `SHELL_WRAPPERS`, which is the list read here now.
    for (const launcher of [
      ['timeout', '30'],
      ['nice', '-n', '5'],
      ['env', 'CI=1'],
      ['nohup'],
    ] as const) {
      const command = [...launcher, 'sh', '-c', 'pnpm test | tail -20']
      const attribution = exitStatusIsAttributable(command)
      expect(attribution.attribuable, command.join(' ')).toBe(false)
      expect(attribution.reason, command.join(' ')).toContain("filter's")
    }
    // And the control: a launcher over a check that has no filter is still the check's
    // own status, so finding the shell must not turn every launched run unattributable.
    expect(exitStatusIsAttributable(['timeout', '300', 'pnpm', 'test']).attribuable).toBe(true)
  })

  it('refuses a backgrounded line, which returns before the check does', () => {
    const backgrounded = exitStatusIsAttributable(['sh', '-c', 'npm test &'])
    expect(backgrounded.attribuable).toBe(false)
    expect(backgrounded.reason).toContain('backgrounds')
    // A dangling `&&` is a separator, not a background, and must not read as one.
    expect(exitStatusIsAttributable(['sh', '-c', 'npm test &&']).attribuable).toBe(true)
  })

  it('attributes a plain shell line to its only stage', () => {
    const plain = exitStatusIsAttributable(['sh', '-c', 'npm test'])
    expect(plain.attribuable).toBe(true)
    expect(plain.reason).toContain('the check itself')
  })
})

describe('change coverage', () => {
  it('calls a command that names a changed path targeted', () => {
    expect(verificationCoversChange(['node', '--test', 'src/a.test.ts'], ['src/a.ts'])).toBe('targeted')
  })

  it('calls a whole gate a superset rather than a claim about the change', () => {
    expect(verificationCoversChange(['npm', 'run', 'test'], ['src/a.ts'])).toBe('suite')
    expect(verificationCoversChange(['npm', 'run', 'test'], [])).toBe('suite')
  })

  it('calls a non-check unrelated, which is what stops it counting as evidence', () => {
    expect(verificationCoversChange(['echo', 'ok'], ['src/a.ts'])).toBe('unrelated')
  })
})
