import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Why this test reads sources
 * ---------------------------
 * A Remote that rejects is not a Remote that failed. A *failed* call resolves with
 * `RemoteResult` and every surface reads that; a *rejected* call is the Host being
 * unreachable, and a chain that only carries a success handler swallows it — no
 * state changes, nothing rendered, and the rejection escapes as an unhandled one
 * out of an effect. The type checker cannot see it (the handler's parameter type is
 * satisfied) and no unit test renders a disconnected Host, so the shape is checked
 * here instead.
 *
 * The rule is per chain, not per call: a rejection arm anywhere in the chain counts,
 * because `a().then(f).then(onOk, onErr)` handles both. What does not count is a
 * chain that ends with a `.then` taking one argument and nothing after it — that is
 * the shape that leaked.
 *
 * The exception list below is the set of chains whose rejection is handled
 * somewhere this scan cannot follow (a surrounding `try`, or a `.catch` on a
 * variable the chain was assigned to). Each entry says where the arm is, so the
 * list can only be justified by reading the named line; a new chain with no arm
 * fails this test and the fix is to add the arm rather than an entry.
 */
const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', 'src', 'client')

/** Chains whose rejection arm lives outside the chain, keyed by `<file>:<callee>`. */
const HANDLED_OUTSIDE_THE_CHAIN: Readonly<Record<string, string>> = {
  'community-plugins.tsx:communityCatalog': 'read inside the `try` of `load()`, whose `catch` sets the page error',
  'community-plugins.tsx:communityInstalled': 'read inside the `try` of `load()`, whose `catch` sets the page error',
  'community-plugins.tsx:communityEnvironment': 'read inside the `try` of `load()`, whose `catch` sets the page error',
  'community-plugins.tsx:current': '`installedCall.current()` is awaited inside the `try` of `check()`',
  'community-plugins.tsx:communityInstall': 'awaited inside the `try` of `install()`',
  'community-plugins.tsx:communityUninstall': 'awaited inside the `try` of `uninstall()`',
  'token-usage-dashboard.tsx:tokenUsageLocal': 'the chain is held in `work`, whose `.catch(fail)` is two lines below',
  'token-usage-dashboard.tsx:tokenUsageGateway': 'the chain is held in `work`, whose `.catch(fail)` is two lines below',
}

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(full))
    else if (/\.tsx?$/u.test(entry.name)) files.push(full)
  }
  return files.sort()
}

/** Index just past the call whose open parenthesis sits at `open`. */
function callEnd(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

/** Top-level argument count of the call whose open parenthesis sits at `open`. */
function argumentCount(text: string, open: number): number {
  let depth = 0
  let count = 1
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return count
    } else if (char === ',' && depth === 1) count += 1
  }
  return count
}

/**
 * Whether the chain that continues at `from` handles a rejection.
 *
 * A `.catch` anywhere, or a later `.then` with a second argument, is an arm: a
 * rejection crosses every link of a chain until one of them takes it.
 */
function chainHandlesRejection(text: string, from: number): boolean {
  let i = from
  for (;;) {
    while (i < text.length && /\s/u.test(text[i] ?? '')) i += 1
    const link = /^\.(then|finally|catch)\(/u.exec(text.slice(i))
    if (link === null) return text.slice(i).startsWith('.catch(')
    const open = i + link[0].length - 1
    if (link[1] === 'catch') return true
    if (link[1] === 'then' && argumentCount(text, open) >= 2) return true
    i = callEnd(text, open)
  }
}

/** The callee a `.then` was attached to, as it is written. */
function calleeOf(text: string, thenIndex: number): string {
  const before = text.slice(0, thenIndex)
  const named = /([A-Za-z_$][\w$]*)\(\s*[^()]*\)\s*$/u.exec(before)
  return named?.[1] ?? before.trim().split(/\s/u).at(-1) ?? '?'
}

/** Chains in the client sources that leave a rejection to nobody. */
async function chainsWithoutRejectionArm(): Promise<readonly string[]> {
  const offenders: string[] = []
  for (const file of await sourceFiles(clientRoot)) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/\.then\(/gu)) {
      const open = match.index + match[0].length - 1
      if (argumentCount(text, open) >= 2) continue
      if (chainHandlesRejection(text, callEnd(text, open))) continue
      offenders.push(`${relative(clientRoot, file).replaceAll('\\', '/')}:${calleeOf(text, match.index)}`)
    }
  }
  return offenders.sort()
}

describe('remote call chains', () => {
  it('handle a rejected call instead of letting it escape', async () => {
    expect(await chainsWithoutRejectionArm()).toEqual(Object.keys(HANDLED_OUTSIDE_THE_CHAIN).sort())
  })

  it('explains every chain it excuses', () => {
    for (const [chain, reason] of Object.entries(HANDLED_OUTSIDE_THE_CHAIN)) {
      expect(reason.trim(), chain).not.toBe('')
    }
  })
})
