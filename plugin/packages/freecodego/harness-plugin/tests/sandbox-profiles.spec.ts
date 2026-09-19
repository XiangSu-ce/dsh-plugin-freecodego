/**
 * The sandbox profile language.
 *
 * What these cases protect
 * ------------------------
 * A deny list is a security control that *looks* like configuration, so its two
 * failure modes are quiet:
 *
 * 1. **A pattern that matches nothing.** `…/cache/**` in a literal-path field, or a
 *    typo'd separator, produces a rule the user believes is in force. Every
 *    rejection below exists so that becomes a notice rather than a rule.
 * 2. **A pattern that covers one direction.** Denying writes but not reads still
 *    hands the file to the model, which is the half that leaks. The matrix below is
 *    deliberately written once and asserted for both directions, so dropping read
 *    enforcement cannot pass.
 *
 * The `**\/.env` matrix is the load-bearing case: it is the pattern people actually
 * write, and the four paths it is checked against are the four that decide whether
 * "anywhere in this tree" means what they think it means.
 */

import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nativeToolDenial } from '../src/native-tool-guard.ts'
import { credentialRealpathDenial } from '../src/tool-guards.ts'
import {
  BUILTIN_SANDBOX_PROFILES,
  denyMatch,
  denyPatternToRegExp,
  denyRealpathRefusal,
  denyRefusal,
  describeDenyEnforcement,
  expandEntry,
  kernelDenyAvailable,
  mergeSandboxProfiles,
  normalizeDenyPattern,
  normalizeDenyPatterns,
  denyPatternRejection,
  partitionDenyPatterns,
  pathArgumentOf,
  pathArgumentsOf,
  readPathEntry,
  resolveSandboxProfile,
} from '../src/sandbox/profiles.ts'
import type { SandboxProfileSpec } from '../src/sandbox/profiles.ts'

describe('builtin profiles', () => {
  it('names the five builtins and no others', () => {
    expect([...BUILTIN_SANDBOX_PROFILES]).toStrictEqual(['off', 'workspace', 'devbox', 'read-only', 'strict'])
  })

  it('resolves each builtin to a three-valued mode', () => {
    // The mode vocabulary is closed at three values, so every profile has to land
    // on one of them — there is nowhere else to put a fourth.
    expect(resolveSandboxProfile({ extends: 'off' }, 'linux').mode).toBe('danger-full-access')
    expect(resolveSandboxProfile({ extends: 'workspace' }, 'linux').mode).toBe('workspace-write')
    expect(resolveSandboxProfile({ extends: 'devbox' }, 'linux').mode).toBe('workspace-write')
    expect(resolveSandboxProfile({ extends: 'read-only' }, 'linux').mode).toBe('read-only')
    expect(resolveSandboxProfile({ extends: 'strict' }, 'linux').mode).toBe('read-only')
  })

  it('reports devbox falling back on Windows instead of failing to mount', () => {
    const resolved = resolveSandboxProfile({ extends: 'devbox' }, 'win32')
    expect(resolved.mode).toBe('workspace-write')
    expect(resolved.notices.join(' ')).toContain('no Windows backend')
  })

  it('says so when the profile narrows a mode that already narrows nothing', () => {
    // Otherwise a user is left believing their deny list is containment rather than
    // the only containment they have.
    const resolved = resolveSandboxProfile({ extends: 'off', deny: ['**/.env'] }, 'linux')
    expect(resolved.notices.join(' ')).toContain('the deny list is the only thing narrowing this profile')
  })

  it('never claims to restrict the network', () => {
    // No mode expresses it, so the honest outcome is a notice. Reporting
    // containment here is precisely the misreporting this module exists to prevent.
    const resolved = resolveSandboxProfile({ extends: 'workspace', restrictNetwork: true }, 'linux')
    expect(resolved.notices.join(' ')).toContain('network access is not restricted by this profile')
  })

  it('is pure: the same spec and platform give the same result', () => {
    const spec: SandboxProfileSpec = { extends: 'read-only', deny: ['~/.ssh/**'], readOnly: ['/var/cache'] }
    expect(resolveSandboxProfile(spec, 'darwin')).toStrictEqual(resolveSandboxProfile(spec, 'darwin'))
  })

  it('cannot widen the mode through an added writable path', () => {
    // `read_write` adds writable paths *inside* the builtin's mode; it is not a way
    // out of a stricter builtin.
    expect(resolveSandboxProfile({ extends: 'read-only', readWrite: ['/tmp'] }, 'linux').mode).toBe('read-only')
  })
})

describe('readPathEntry', () => {
  it('rejects surrounding whitespace instead of trimming it', () => {
    // A path may legally contain a space, so trimming a typo could turn it into a
    // different, valid path — the worst outcome, because it would take effect.
    expect(readPathEntry(' /var/cache')).toStrictEqual({ rejected: expect.stringContaining('leading or trailing whitespace') })
    expect(readPathEntry('')).toStrictEqual({ rejected: 'empty path' })
  })

  it('reads a trailing glob as the parent directory', () => {
    expect(readPathEntry('/var/cache/**')).toStrictEqual({ path: '/var/cache' })
    expect(readPathEntry('/var/cache/*')).toStrictEqual({ path: '/var/cache' })
  })

  it('rejects a wildcard anywhere else rather than matching nothing quietly', () => {
    expect(readPathEntry('/var/*/cache')).toStrictEqual({ rejected: expect.stringContaining('contains a wildcard') })
    expect(readPathEntry('/var/cache/[*]')).toStrictEqual({ rejected: expect.stringContaining('contains a wildcard') })
  })

  it('expands a leading tilde', () => {
    expect(readPathEntry('~/.cache')).toStrictEqual({ path: `${homedir().replaceAll('\\', '/')}/.cache` })
  })

  it('normalizes separators so one path has one spelling', () => {
    expect(readPathEntry('C:\\work\\cache')).toStrictEqual({ path: 'C:/work/cache' })
  })
})

describe('normalizeDenyPattern', () => {
  it('collapses duplicate separators and a trailing one', () => {
    expect(normalizeDenyPattern('/a//b/')).toBe('/a/b')
    expect(normalizeDenyPattern('/a/b')).toBe('/a/b')
  })

  it('keeps glob metacharacters intact', () => {
    expect(normalizeDenyPattern('**/.env')).toBe('**/.env')
    expect(normalizeDenyPattern('~/**/*.pem')).toBe(`${homedir().replaceAll('\\', '/')}/**/*.pem`)
  })

  it('deduplicates so one tree is not denied twice', () => {
    const resolved = resolveSandboxProfile({ extends: 'workspace', deny: ['/a/b', '/a//b/', '/a/b'] }, 'linux')
    expect(resolved.deny).toStrictEqual(['/a/b'])
  })

  it('normalizes a whole list the same way it normalizes a profile’s own', () => {
    // One entry point, so a list from settings and a list from a profile cannot
    // disagree about what a pattern means.
    expect(normalizeDenyPatterns(['/a//b/', '', '/a/b'])).toStrictEqual(['/a/b'])
  })

  it('expands a bare tilde', () => {
    expect(expandEntry('~')).toBe(homedir().replaceAll('\\', '/'))
  })
})

describe('deny matching', () => {
  it('matches `**/.env` at the root and at every depth, and not a suffix', () => {
    // The pattern people actually write. `a.env` must not match: it is a different
    // file, and a rule that quietly covers it is a rule that covers more than the
    // user asked for.
    const deny = ['**/.env']
    expect(denyMatch(deny, '/work/.env', 'linux')).toBe('**/.env')
    expect(denyMatch(deny, '/work/a/.env', 'linux')).toBe('**/.env')
    expect(denyMatch(deny, '/work/a/b/.env', 'linux')).toBe('**/.env')
    expect(denyMatch(deny, '/work/a.env', 'linux')).toBeUndefined()
  })

  it('reads a bare name as "anywhere", the way it is written', () => {
    // `.env` on its own is the same rule as `**/.env` to the person writing it.
    // A tool reports absolute paths, so a literal reading of the bare spelling
    // would match nothing at all — a rule that looks configured and is not.
    const deny = ['.env']
    expect(denyMatch(deny, '/work/.env', 'linux')).toBe('.env')
    expect(denyMatch(deny, '/work/a/b/.env', 'linux')).toBe('.env')
    expect(denyMatch(deny, '/work/a.env', 'linux')).toBeUndefined()
    // A pattern that names a place is still a path: the basename must not rescue
    // it from failing to match the whole path it was written against.
    expect(denyMatch(['/work/.env'], '/other/.env', 'linux')).toBeUndefined()
    expect(denyMatch(['*.key'], '/work/deploy.key', 'linux')).toBe('*.key')
  })

  it('stops `*` at a separator and lets `**` cross it', () => {
    expect(denyMatch(['/work/*/.env'], '/work/a/.env', 'linux')).toBe('/work/*/.env')
    expect(denyMatch(['/work/*/.env'], '/work/a/b/.env', 'linux')).toBeUndefined()
    expect(denyMatch(['/work/**/.env'], '/work/a/b/.env', 'linux')).toBe('/work/**/.env')
  })

  it('treats an unterminated character class as a literal', () => {
    // A user who typed `[` meant a `[`.
    expect(denyPatternToRegExp('/a[/b').test('/a[/b')).toBe(true)
  })

  it('normalizes separators in both the pattern and the candidate', () => {
    // Windows tools report `\` and settings files are written with either.
    expect(denyMatch(['C:/work/secret/**'], 'C:\\work\\secret\\k.pem', 'win32')).toBe('C:/work/secret/**')
  })

  it('folds case where the filesystem does', () => {
    expect(denyMatch(['/work/Secret/**'], '/work/secret/k.pem', 'darwin')).toBe('/work/Secret/**')
    expect(denyMatch(['/work/Secret/**'], '/work/secret/k.pem', 'linux')).toBeUndefined()
  })

  it('reads a Win32 data stream as the file it names, and only on Win32', () => {
    // `file:stream` and `file::$DATA` both name data **of** `file`, and the default
    // stream *is* the file: measured against the filesystem, opening
    // `.env::$DATA` returned the bytes of `.env` while a `**/.env` rule allowed the
    // path. That is the same hole `tool-guards.ts` closed in its own path reader,
    // so a user's deny rule and the credential shield cannot disagree here.
    expect(denyMatch(['**/.env'], 'C:/work/.env::$DATA', 'win32')).toBe('**/.env')
    expect(denyMatch(['**/.env'], 'C:/work/.env:stream', 'win32')).toBe('**/.env')
    // A bare-name rule is the same rule, so it has to read the stream too.
    expect(denyMatch(['.env'], 'C:/work/.env::$DATA', 'win32')).toBe('.env')
    // Spelled the way a Windows tool reports it, as well.
    const asWindowsReports = ['C:', 'work', '.env::$DATA'].join('\\')
    expect(denyMatch(['**/.env'], asWindowsReports, 'win32')).toBe('**/.env')
    // Two boundaries, because each is a plausible reading that goes wrong: a drive's
    // colon is not a stream, and a colon in a directory segment is not one either.
    expect(denyMatch(['C:/work/secret/**'], 'C:/work/secret/k.pem', 'win32')).toBe('C:/work/secret/**')
    expect(denyMatch(['C:/w:1/**'], 'C:/w:1/.env', 'win32')).toBe('C:/w:1/**')
    // The drive itself is not a stream either: `C:/w/..` names the drive, and a rule
    // naming the drive has to still see one. Cutting at the first colon would rewrite
    // the path into a bare letter, which reads like a different answer rather than an
    // unreadable one.
    expect(denyMatch(['C:'], 'C:/w/..', 'win32')).toBe('C:')
    expect(denyMatch(['**/.env'], 'C:.env', 'win32')).toBeUndefined()
    // And the rule is Win32-only: on POSIX a colon is an ordinary character, so
    // `notes:2024` is a different file from `notes`, and refusing it would refuse a
    // file the user never named.
    expect(denyMatch(['**/notes:2024'], '/work/notes:2024', 'linux')).toBe('**/notes:2024')
    expect(denyMatch(['**/notes'], '/work/notes:2024', 'linux')).toBeUndefined()
    // The judgment surface, not only the matcher: a tool call spelled this way is
    // refused rather than passed on to the approval path.
    expect(denyRefusal({ deny: ['**/.env'], args: { path: 'C:/work/.env::$DATA' }, platform: 'win32' })).toContain('**/.env')
  })

  it('reports which pattern matched, not merely that one did', () => {
    // The settings surface names the rule that refused a call; "something denied it"
    // is not actionable for a user auditing their own list.
    expect(denyMatch(['/a/**', '/b/**'], '/b/x', 'linux')).toBe('/b/**')
  })

  it('matches nothing without a deny list', () => {
    expect(denyMatch([], '/work/.env', 'linux')).toBeUndefined()
  })

  it('is one judgment for reading and writing', () => {
    // There is no direction argument, and this case pins that: a deny list covering
    // writes but not reads still hands the file to the model, so the two must not be
    // separable without changing this signature.
    expect(denyMatch.length).toBeLessThanOrEqual(3)
    expect(denyMatch(['**/.env'], '/work/.env', 'linux')).toBe('**/.env')
  })

  it('does not throw on a pattern that cannot compile, and matches nothing with it', () => {
    // A character class is passed through verbatim so `[0-9]` works, which means a
    // class JavaScript refuses reaches `new RegExp`. That throw would land inside a
    // tool guard: one malformed entry in settings would make every call in the
    // session an error rather than a denial.
    expect(() => denyMatch(['**/[z-a]'], '/work/[z-a]', 'linux')).not.toThrow()
    expect(denyMatch(['**/[z-a]'], '/work/[z-a]', 'linux')).toBeUndefined()
  })

  it('refuses a traversal that resolves into a denied tree', () => {
    // The deny list is the one guard that reads a path exactly as the caller spelled
    // it, and the profile that needs it most says so itself: with `extends: 'off'`
    // the deny list is the only thing narrowing the profile. So a spelling the
    // kernel resolves but the glob does not is a bypass of exactly that control.
    const deny = ['/w/secrets/**']
    expect(denyMatch(deny, '/w/secrets/token.txt', 'linux')).toBe('/w/secrets/**')
    expect(denyMatch(deny, '/w/x/../secrets/token.txt', 'linux')).toBe('/w/secrets/**')
    expect(denyMatch(deny, '/w/./secrets/token.txt', 'linux')).toBe('/w/secrets/**')
    expect(denyMatch(deny, '/w/other/../../w/secrets/token.txt', 'linux')).toBe('/w/secrets/**')
  })

  it('gives one file one answer, instead of judging the literal and the resolved form separately', () => {
    // Comparing both forms would refuse `/work/secrets/../notes.md` while allowing
    // `/work/notes.md` — two answers for one file, which is the rule this module
    // already writes down for separators and must hold for dot segments too.
    const deny = ['/work/secrets/**']
    expect(denyMatch(deny, '/work/secrets/../notes.md', 'linux')).toBeUndefined()
    expect(denyMatch(deny, '/work/notes.md', 'linux')).toBeUndefined()
    expect(denyMatch(deny, '/work/secrets/./../secrets/k.pem', 'linux')).toBe('/work/secrets/**')
  })

  it('resolves a traversal in the pattern too, through the entry point settings take', () => {
    // `denyMatch` documents that it receives *normalized* globs, so the way to ask
    // about a pattern as written is `normalizeDenyPatterns`; handing a raw pattern
    // to `denyMatch` asserts the wrong contract and passes for the wrong reason.
    const deny = normalizeDenyPatterns(['/work/secrets/../private/**'])
    expect(deny).toStrictEqual(['/work/private/**'])
    expect(denyMatch(deny, '/work/private/k.pem', 'linux')).toBe('/work/private/**')
  })

  it('stops a `..` above the root, keeps a relative one, and reads a drive segment as a segment', () => {
    // Three boundaries, each a place a plausible reading goes wrong: an absolute
    // path cannot climb above its root (the kernel agrees), a leading `..` on a
    // relative path is kept because nothing here knows what it is relative to, and
    // a drive segment is an ordinary segment.
    expect(normalizeDenyPattern('/../w/**')).toBe('/w/**')
    expect(normalizeDenyPattern('../w/**')).toBe('../w/**')
    expect(normalizeDenyPattern('C:/w/x/../secrets')).toBe('C:/w/secrets')
  })
})

describe('pattern validity', () => {
  it('reports why a pattern cannot be compiled, and nothing for one that can', () => {
    expect(denyPatternRejection('**/.env')).toBeUndefined()
    expect(denyPatternRejection('[z-a]')).toContain('character class')
  })

  it('drops an uncompilable pattern from the list the guard is given', () => {
    // The settings path is the one that can drop it before it ever reaches a call.
    expect(normalizeDenyPatterns(['**/.env', '[z-a]'])).toStrictEqual(['**/.env'])
  })

  it('keeps the reasons, because a dropped pattern is one the user believes protects them', () => {
    const partition = partitionDenyPatterns(['**/.env', '[z-a]'])
    expect(partition.accepted).toStrictEqual(['**/.env'])
    expect(partition.rejected).toHaveLength(1)
    expect(partition.rejected[0]?.pattern).toBe('[z-a]')
  })

  it('says so in the profile notices rather than matching nothing quietly', () => {
    const resolved = resolveSandboxProfile({ extends: 'workspace', deny: ['[z-a]', '**/.env'] }, 'linux')
    expect(resolved.deny).toStrictEqual(['**/.env'])
    expect(resolved.notices.join(' ')).toContain('deny pattern dropped')
  })

  it('still denies through a valid pattern alongside a broken one', () => {
    // The end of the path a user's settings take: one bad entry must not disable the
    // rest of the list, which is what "drop the broken one" has to mean.
    const deny = normalizeDenyPatterns(['[z-a]', '**/.env'])
    expect(denyRefusal({ deny, args: { file_path: '/work/.env' } })).toContain('FREECODEGO_SANDBOX_DENY')
  })
})

describe('the path-key vocabulary against the keys the plugin’s own tools declare', () => {
  it('reads a path a call spells `file`, not only the engine spellings', () => {
    // `engineering_hunks` and `engineering_hunk_revert` are the two tools that spell
    // their path `file`. The first answers with a preview of the lines a call added
    // and the second writes the file back, so a key outside this vocabulary was a
    // read and a write the judgment never saw — and the credential shield reads the
    // same vocabulary, so it missed them too.
    expect(pathArgumentsOf({ file: '/work/.env' })).toStrictEqual([{ key: 'file', value: '/work/.env' }])
    expect(denyRefusal({ deny: normalizeDenyPatterns(['**/.env']), args: { file: '/work/.env' } })).toContain('FREECODEGO_SANDBOX_DENY')
  })

  it('still answers the singular lookup with the more specific spelling', () => {
    // Order in the vocabulary is a preference only for the caller that wants one
    // answer; a judgment has to see every key, or a denied path hides behind an
    // allowed one on the same call.
    expect(pathArgumentOf({ path: 'src/a.ts', file: '.env' })).toStrictEqual({ key: 'path', value: 'src/a.ts' })
    expect(pathArgumentsOf({ path: 'src/a.ts', file: '.env' })).toHaveLength(2)
  })
})

describe('literal path entries in a resolved profile', () => {
  it('returns the read_only and read_write paths rather than dropping them after validation', () => {
    // These were parsed, screened, and then absent from every result, so a profile
    // could declare a narrowing no caller could ever learn about.
    const resolved = resolveSandboxProfile({ extends: 'workspace', readOnly: ['/var/cache'], readWrite: ['~/build'] }, 'linux')
    expect(resolved.readOnly).toStrictEqual(['/var/cache'])
    expect(resolved.readWrite).toStrictEqual([`${homedir().replaceAll('\\', '/')}/build`])
  })

  it('says out loud that the seam has no field for a path list', () => {
    // The failure this prevents is a user reading `read_only` as containment the
    // kernel is applying. It is not, and `deny` is what actually does something.
    const resolved = resolveSandboxProfile({ extends: 'workspace', readOnly: ['/var/cache'] }, 'linux')
    expect(resolved.notices.join(' ')).toContain('no field for a path list')
  })

  it('says nothing when no path entry was declared', () => {
    expect(resolveSandboxProfile({ extends: 'workspace' }, 'linux').notices).toStrictEqual([])
  })

  it('counts a declared path list as a difference between two profiles', () => {
    // `sameSpec` compares resolved output, so without the path lists two profiles
    // differing only in where they are read-only were reported as identical — and
    // the project's silent version won.
    const merged = mergeSandboxProfiles({
      project: { locked: { extends: 'workspace', readOnly: ['/a'] } },
      user: { locked: { extends: 'workspace', readOnly: ['/b'] } },
    })
    expect(merged.notices.join(' ')).toContain('defined differently')
  })
})

describe('mergeSandboxProfiles', () => {
  const hardening: SandboxProfileSpec = { extends: 'workspace', deny: ['**/.env'] }

  it('rejects a custom profile that takes a builtin name', () => {
    // It would change what every existing `extends` means, and the reference most
    // likely to exist is the user's own.
    const merged = mergeSandboxProfiles({ user: { workspace: hardening } })
    expect(merged.profiles).toStrictEqual({})
    expect(merged.notices.join(' ')).toContain('is a builtin profile name')
  })

  it('lets the user’s definition win over the project’s, and says so', () => {
    // The project document arrives with a clone, so letting it win would let a
    // repository redefine a profile the user already relies on.
    const merged = mergeSandboxProfiles({
      project: { locked: { extends: 'off' } },
      user: { locked: hardening },
    })
    expect(merged.profiles.locked).toStrictEqual(hardening)
    expect(merged.notices.join(' ')).toContain("the user's definition is used")
  })

  it('does not report identical definitions as a conflict', () => {
    // A warning that fires on a non-problem is how a real warning gets ignored.
    const merged = mergeSandboxProfiles({ project: { locked: hardening }, user: { locked: { ...hardening } } })
    expect(merged.notices).toStrictEqual([])
  })

  it('reports a conflict when the two differ only in resolved behaviour', () => {
    const merged = mergeSandboxProfiles({
      project: { locked: { extends: 'workspace', deny: ['/a/**'] } },
      user: { locked: { extends: 'workspace', deny: ['/b/**'] } },
    })
    expect(merged.notices).toHaveLength(1)
    expect(merged.profiles.locked).toStrictEqual({ extends: 'workspace', deny: ['/b/**'] })
  })
})

describe('enforcement reporting', () => {
  it('admits that no platform can express a kernel-level deny today', () => {
    // A checked fact rather than a comment: the day the seam grows a deny field,
    // this assertion is what makes someone revisit every report that depends on it.
    expect(kernelDenyAvailable()).toBe(false)
  })

  it('reports nothing in force when there is no deny list', () => {
    expect(describeDenyEnforcement([])).toStrictEqual({ enforcedBy: 'none' })
  })

  it('always names the fallback rather than implying containment', () => {
    const reported = describeDenyEnforcement(['**/.env'])
    expect(reported.enforcedBy).toBe('tool-scope')
    expect(reported.fallbackReason).toContain('shell redirection')
  })
})

describe('denyRefusal', () => {
  it('reads the path out of whichever key a call carries', () => {
    // Keys rather than tool names: a tool-name list would have to be extended for
    // every new write tool and every engine's own spelling, and forgetting one
    // fails silently.
    expect(pathArgumentOf({ path: '/a/b' })).toStrictEqual({ key: 'path', value: '/a/b' })
    expect(pathArgumentOf({ file_path: '/a/b' })).toStrictEqual({ key: 'file_path', value: '/a/b' })
    expect(pathArgumentOf({ filePath: '/a/b' })).toStrictEqual({ key: 'filePath', value: '/a/b' })
  })

  it('leaves a call that touches no file alone', () => {
    expect(pathArgumentOf({ command: 'ls' })).toBeUndefined()
    expect(pathArgumentOf({ path: 42 })).toBeUndefined()
    expect(pathArgumentOf(undefined)).toBeUndefined()
    expect(pathArgumentOf('a string')).toBeUndefined()
  })

  it('does nothing without a deny list', () => {
    expect(denyRefusal({ deny: [], args: { path: '/work/.env' }, platform: 'linux' })).toBeUndefined()
  })

  it('refuses a denied path and names the pattern', () => {
    const refusal = denyRefusal({ deny: ['**/.env'], args: { path: '/work/.env' }, platform: 'linux' })
    expect(refusal).toContain('FREECODEGO_SANDBOX_DENY')
    expect(refusal).toContain('**/.env')
  })

  it('refuses a denied read exactly as it refuses a denied write', () => {
    // One judgment, no direction argument: a deny list that stopped writes while
    // allowing reads would still hand the file's contents to the model.
    expect(denyRefusal({ deny: ['**/.env'], args: { path: '/work/.env' }, platform: 'linux' }))
      .toBe(denyRefusal({ deny: ['**/.env'], args: { path: '/work/.env' }, platform: 'linux' }))
  })

  it('lets an undetermined call continue to the normal approval path', () => {
    // Refusal is all this can do, so a rule can only remove a capability.
    expect(denyRefusal({ deny: ['**/.env'], args: { path: '/work/notes.md' }, platform: 'linux' })).toBeUndefined()
    expect(denyRefusal({ deny: ['**/.env'], args: { command: 'cat .env' }, platform: 'linux' })).toBeUndefined()
  })

  it('covers the notebook spelling an engine and a Harness tool both use', () => {
    // `notebook_path` lived in the native projection's key list and in no judgment
    // list, so the projection — which the Harness pipeline never runs — was the
    // only reason an engine's `NotebookEdit` was seen at all. The same call from a
    // Harness tool, whose name `tool-guards.ts` already lists among the tools it is
    // pointed at, was judged by nothing. One call, two answers, decided by which
    // component dispatched it.
    for (const key of ['notebook_path', 'notebookPath'] as const) {
      expect(pathArgumentOf({ [key]: '/work/.env' }), key).toStrictEqual({ key, value: '/work/.env' })
      expect(denyRefusal({ deny: ['**/.env'], args: { [key]: '/work/.env' }, platform: 'linux' }), key).toContain('FREECODEGO_SANDBOX_DENY')
    }
  })

  it('covers a reader that names its file a locator', () => {
    // `spill_recall` takes the path from a marker and spells it `locator`. A deny
    // list that only understood `path` and `file_path` would have refused `read`
    // of a denied file and allowed this, which is the whole file by another name.
    const refusal = denyRefusal({ deny: ['**/.env'], args: { locator: '/work/.env' }, platform: 'linux' })
    expect(refusal).toContain('FREECODEGO_SANDBOX_DENY')
    expect(refusal).toContain('/work/.env')
  })

  it('judges every path a batch call names, not just the first', () => {
    // A batch tool is where one denied file hides behind an allowed one.
    const refusal = denyRefusal({ deny: ['**/.env'], args: { paths: ['/work/notes.md', '/work/.env'] }, platform: 'linux' })
    expect(refusal).toContain('FREECODEGO_SANDBOX_DENY')
    expect(refusal).toContain('/work/.env')
    expect(denyRefusal({ deny: ['**/.env'], args: { files: ['/work/a.md', '/work/b.md'] }, platform: 'linux' })).toBeUndefined()
    // A non-string entry names no file, so it is skipped rather than coerced.
    expect(denyRefusal({ deny: ['**/.env'], args: { paths: [null, '/work/.env'] }, platform: 'linux' })).toContain('/work/.env')
  })

  it('reads a filter for the file it can select, not only for a path', () => {
    // A search tool names its target two ways and the second one is a glob: `grep`
    // takes `path` for where to look and `include` for which files to print, and
    // Claude's `Grep` spells the same filter `glob`. `grep({ path: '/work', include:
    // '*.env' })` prints the lines of the denied file, so a judgment that read only
    // `path` refused `read` of that file and allowed this — the contents by another
    // route, which is the one bypass this list exists to prevent. The filter is read
    // as the literal name it can select, so a wildcard spelling is judged like a path.
    for (const key of ['include', 'glob'] as const) {
      expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', [key]: '*.env' }, platform: 'linux' }), key).toContain('FREECODEGO_SANDBOX_DENY')
    }
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', include: '**/.env' }, platform: 'linux' })).toContain('FREECODEGO_SANDBOX_DENY')
    // Braced alternations select every alternative: a reducer that concatenated
    // `{env,md}` into `.env,md` would miss the deny while ripgrep still printed
    // `.env`. Nested braces and a bare brace-group of credential names are the
    // same hole spelled two other ways engines accept.
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', include: '*.{env,md}' }, platform: 'linux' })).toContain('FREECODEGO_SANDBOX_DENY')
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', glob: '{.env,.npmrc}' }, platform: 'linux' })).toContain('FREECODEGO_SANDBOX_DENY')
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', include: '*.env.*' }, platform: 'linux' })).toContain('FREECODEGO_SANDBOX_DENY')
    // A filter that cannot select a denied file stays with the approval path, and
    // `pattern` is never read as a file: it is grep's content expression and Glob's
    // filename glob, so reading it would refuse every search in a workspace that
    // denies one file.
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '.', path: '/work', include: '*.md' }, platform: 'linux' })).toBeUndefined()
    expect(denyRefusal({ deny: ['**/.env'], args: { pattern: '**/.env', path: '/work' }, platform: 'linux' })).toBeUndefined()
  })
})

describe('a native engine’s own tools get the same judgment', () => {
  const deps = {
    settings: () => ({ envReadGuardEnabled: false, commandPolicyEnabled: false, planModeEnabled: false, doomLoopGuardEnabled: false }),
    deny: ['**/.env'],
  }

  it('refuses a native read of a denied path', async () => {
    // Native tools never cross the tool registry, so the registry guard above would
    // have skipped them entirely without this tier.
    await expect(nativeToolDenial({ name: 'read', arguments: { path: '/work/.env' } }, deps)).resolves
      .toContain('FREECODEGO_SANDBOX_DENY')
  })

  it('refuses a native read that reaches a denied path through a link', async () => {
    // The resolution tier is wired here as well as on the waterfall: a native engine's
    // tools never cross the registry, so a link would otherwise be judged by its name
    // only — which is exactly the bypass the tier exists to close. Real files, because
    // this pin is about the wiring reaching a syscall.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-native-deny-'))
    try {
      const secrets = join(root, 'secrets')
      await mkdir(secrets)
      await writeFile(join(secrets, 'token.txt'), 'SECRET=marker\n')
      await symlink(secrets, join(root, 'junc'), 'junction')
      const args = { path: join(root, 'junc', 'token.txt') }
      const linkDeps = { ...deps, deny: ['**/secrets/**'] }
      // The name is innocent in both halves — `token.txt` under a directory called
      // `junc` — so the lexical tier cannot answer it, and this pin reaches the tier
      // it is about rather than passing because the leaf happened to spell `.env`.
      expect(denyRefusal({ deny: ['**/secrets/**'], args })).toBeUndefined()
      await expect(nativeToolDenial({ name: 'read', arguments: args }, linkDeps)).resolves
        .toContain('FREECODEGO_SANDBOX_DENY')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a native call that touches no denied path alone', async () => {
    await expect(nativeToolDenial({ name: 'read', arguments: { path: '/work/notes.md' } }, deps)).resolves.toBeUndefined()
  })
})

describe('deny resolution tier', () => {
  // Real files, because this tier is a syscall: "is this the file the rule names?" is
  // a question only the filesystem settles. The same idiom as `tool-guards.spec.ts`,
  // which creates the symlinks its own tier needs — and the links are created rather
  // than mocked so a host that cannot create one fails here instead of quietly
  // testing nothing.
  const roots: string[] = []
  afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })
  const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-deny-'))
    roots.push(root)
    return root
  }
  /** A denied directory holding a secret, with every kind of link that reaches it. */
  const scene = async (): Promise<{ root: string; secrets: string }> => {
    const root = await scratch()
    const secrets = join(root, 'secrets')
    await mkdir(secrets)
    await writeFile(join(secrets, 'token.txt'), 'SECRET=marker\n')
    await writeFile(join(secrets, '.env'), 'TOKEN=marker\n')
    await writeFile(join(root, 'plain.txt'), 'ordinary\n')
    await symlink(join(secrets, 'token.txt'), join(root, 'alias.txt'), 'file')
    await symlink(secrets, join(root, 'symdir'), 'dir')
    await symlink(secrets, join(root, 'junc'), 'junction')
    return { root, secrets }
  }

  it('denies a path that reaches a denied directory through a link', async () => {
    const { root } = await scene()
    const deny = ['**/secrets/**']
    for (const [label, spelling] of [
      ['a file symlink', join(root, 'alias.txt')],
      ['a directory symlink', join(root, 'symdir', 'token.txt')],
      ['a directory junction', join(root, 'junc', 'token.txt')],
    ] as const) {
      // The name the call states is innocent, which is why the lexical tier cannot
      // answer this at all: no spelling of `alias.txt` is under `secrets`.
      expect(denyRefusal({ deny, args: { path: spelling } }), label).toBeUndefined()
      const denial = await denyRealpathRefusal({ deny, args: { path: spelling } })
      expect(denial, label).toContain('resolves to')
      expect(denial, label).toContain('**/secrets/**')
      expect(denial, label).toContain('FREECODEGO_SANDBOX_DENY')
    }
  })

  it('resolves the nearest existing ancestor, so a write target that does not exist counts', async () => {
    // `realpath` needs the leaf to exist; a write legitimately targets a file that
    // does not yet, so the walk climbs to the nearest existing ancestor — here the
    // junction itself — and re-appends the missing tail.
    const { root } = await scene()
    const denial = await denyRealpathRefusal({ deny: ['**/secrets/**'], args: { path: join(root, 'junc', 'new.txt') } })
    expect(denial).toContain('resolves to')
  })

  it('leaves an unresolvable path with the lexical answer', async () => {
    // Fail-open, deliberately: a dangling link, a permission error or a race leaves
    // the decision where it was rather than turning an I/O failure into a refusal the
    // model cannot act on.
    const root = await scratch()
    await symlink(join(root, 'nowhere.txt'), join(root, 'dangling.txt'), 'file')
    for (const spelling of [join(root, 'dangling.txt'), 'Z:/nowhere/secret.txt']) {
      await expect(denyRealpathRefusal({ deny: ['**/secrets/**'], args: { path: spelling } })).resolves.toBeUndefined()
    }
  })

  it('does not resolve a filter name, which is a name rather than a path', async () => {
    // A filter states the name a *searched directory* is scanned for, so resolving it
    // would invent a path — against this process's working directory, which the call
    // never named — and a rule naming that directory would refuse a search that touches
    // nothing it protects. The lexical tier judges filter names on purpose; only paths
    // are resolved.
    const rule = [`${process.cwd().replaceAll('\\', '/')}/**`]
    await expect(denyRealpathRefusal({ deny: rule, args: { include: 'token.txt' } })).resolves.toBeUndefined()
    // A path key under the same rule is resolved, and refused.
    const denial = await denyRealpathRefusal({ deny: rule, args: { path: join(process.cwd(), 'package.json') } })
    expect(denial).toContain('FREECODEGO_SANDBOX_DENY')
  })

  it('preserves the lexical refusals, so a caller that wires only this tier is correct', async () => {
    const { secrets } = await scene()
    const denial = await denyRealpathRefusal({ deny: ['**/secrets/**'], args: { path: join(secrets, 'token.txt') } })
    expect(denial).toContain('is denied by the sandbox profile pattern')
  })

  it('gives the credential shield and the deny list one answer for one link', async () => {
    const { root } = await scene()
    const args = { path: join(root, 'notes.md') }
    await symlink(join(root, 'secrets', '.env'), join(root, 'notes.md'), 'file')
    // The user's own rule and the built-in shield read the same file, so neither may be
    // the one that lets it through: the shield already knew this shape, and the deny
    // list did not.
    expect(await denyRealpathRefusal({ deny: ['**/.env'], args })).toContain('**/.env')
    expect(await credentialRealpathDenial('read', args)).toContain('symlink')
    // An innocent path stays allowed by both: this is a shield, not a blanket refusal.
    const plain = { path: join(root, 'plain.txt') }
    await expect(denyRealpathRefusal({ deny: ['**/.env'], args: plain })).resolves.toBeUndefined()
    await expect(credentialRealpathDenial('read', plain)).resolves.toBeUndefined()
  })

  it('does not refuse a link whose target is ordinary, even when its own name is not', async () => {
    // The mirror of the first case, and the direction a resolution tier is allowed to be
    // wrong in: a link *named* for a denied directory that points somewhere ordinary
    // reads the target, so the name is not evidence.
    const { root } = await scene()
    await symlink(join(root, 'plain.txt'), join(root, 'secrets-link'), 'file')
    await expect(denyRealpathRefusal({ deny: ['**/secrets/**'], args: { path: join(root, 'secrets-link') } })).resolves.toBeUndefined()
  })

  it('does not follow a hard link, which is a boundary both guards share', async () => {
    // `realpath` has no target to follow for a hard link: the two names are one file
    // with no relation between them. Measured against the filesystem, the link opens
    // the file while both tiers allow it — pinned as a decision rather than left
    // silent, because "we decided this" and "we never noticed" are different facts.
    const { root } = await scene()
    const hard = join(root, 'hard.txt')
    await link(join(root, 'secrets', 'token.txt'), hard)
    await expect(denyRealpathRefusal({ deny: ['**/secrets/**'], args: { path: hard } })).resolves.toBeUndefined()
    await expect(credentialRealpathDenial('read', { path: hard })).resolves.toBeUndefined()
  })
})

describe('the deny direction is load-bearing', () => {
  it('rejects an implementation that only guards writes', () => {
    // The mutation: a matcher consulted on the write path only. It agrees with the
    // real one for a write and disagrees for a read, which is the half that leaks.
    const writeOnly = (deny: readonly string[], path: string, writing: boolean): string | undefined =>
      writing ? denyMatch(deny, path, 'linux') : undefined
    expect(writeOnly(['**/.env'], '/work/.env', true)).toBe('**/.env')
    expect(writeOnly(['**/.env'], '/work/.env', false)).toBeUndefined()
    // The real judgment has no direction to get wrong.
    expect(denyMatch(['**/.env'], '/work/.env', 'linux')).toBe('**/.env')
  })
})
