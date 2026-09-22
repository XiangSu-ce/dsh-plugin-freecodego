/**
 * The client reaches the Host through ~180 calls dispatched **by string name**,
 * and nothing checked that those names and arguments still match the decorated
 * methods on the other side.
 *
 * The typed path (`ctx.remote.freeCodeGoHarness.catalog()`) is checked by
 * TypeScript, but it is not the path the client mostly uses: a dynamic plugin may
 * only query an optional service through `ctx.get()`, so the client resolves
 * `remote.freeCodeGoHarness` and then either casts it to a hand-written signature
 * or — for most methods — calls `backendCall('name', ...args)`, which is untyped
 * by construction. A typo, a rename, or a parameter that gained a required field
 * therefore fails only in the browser, after `backendCall` has polled for eight
 * seconds and given up with `FreeCodeGo Remote method "…" did not become
 * available`; an argument-count drift is worse, because the call succeeds with the
 * wrong binding.
 *
 * This spec compares the two sides from source:
 *
 * 1. every `@Remote('name')` in the Host plugin, with the decorated method's
 *    parameter list (required and total counts),
 * 2. every `backendCall…('name', …)` site in the client, with its argument count,
 * 3. a name that no remote declares, or an argument count outside the declared
 *    range, is a failure that prints both signatures.
 *
 * The extraction is pinned by counts and by a self-check (each site's first
 * argument must be its own name literal), because a parser that silently stops
 * matching would make this whole file pass while checking nothing — the failure
 * mode that makes a coverage spec worse than none.
 *
 * What it does not do: the cast-style calls (`service.accountLogin({…})`) are not
 * compared, since resolving `service` back to its `@Remote` name needs the
 * binding, not just the call; those were read by hand (they agree). And argument
 * *shapes* are not compared — only the count — because the parameter types here
 * are object literals written in the Host's own vocabulary, and comparing them
 * would mean parsing types on both sides rather than comparing what a call binds.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Source with line endings normalised, so a signature may span lines. */
function source(relative: string): string {
  return stripComments(readFileSync(join(PACKAGES, relative), 'utf8').replace(/\r\n/gu, '\n'))
}

/**
 * Source with its comments blanked out, newlines kept.
 *
 * The count guard below is the only thing separating a parser that still matches
 * from a spec that passes while checking nothing, and that guard counts regex
 * matches: a `backendCall('x')` *quoted in prose* held the count up while the
 * call it described was gone. Blanking comments (rather than deleting lines, so
 * failures still print the line the reader can open) makes the count mean the
 * calls the client actually dispatches.
 */
function stripComments(text: string): string {
  const out: string[] = []
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (quote !== '') {
      out.push(char)
      // A quote cannot end inside a string on the character its own escape
      // introduces, so the escaped pair is copied in one step.
      if (char === '\\') { out.push(next ?? ''); index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; out.push(char); continue }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      index = (end === -1 ? text.length : end) - 1
      out.push('\n')
      continue
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      const stop = end === -1 ? text.length - 1 : end + 1
      for (const kept of text.slice(index, stop + 1)) out.push(kept === '\n' ? '\n' : ' ')
      index = stop
      continue
    }
    out.push(char)
  }
  return out.join('')
}

const HOST = source('harness-plugin/src/index.ts')
const CLIENT = source('harness-ui/src/client/index.ts')

/** Split on top-level commas, respecting strings and every bracket kind. */
function splitTop(text: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const char of text) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue }
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Text inside the bracket pair that opens at `start`. */
function balanced(text: string, start: number): string | undefined {
  let depth = 0
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return text.slice(start + 1, index)
    }
  }
  return undefined
}

/**
 * The open parenthesis of the call whose argument list contains `index`.
 *
 * This is how the argument list is located. The obvious alternative — the first
 * `(` after `backendCall` — is wrong on every call with a type argument that
 * contains one, because `backendCall<import('…').Status>(…)` puts that `import(`
 * first; reading it produced four confident, false arity reports before this
 * helper existed.
 */
function openerBefore(text: string, index: number): number | undefined {
  let depth = 0
  for (let position = index - 1; position >= 0; position -= 1) {
    const char = text[position]
    if (char === ')') depth += 1
    else if (char === '(') {
      if (depth === 0) return position
      depth -= 1
    }
  }
  return undefined
}

interface Remote {
  readonly required: number
  readonly total: number
  readonly signature: string
  readonly line: number
}

interface CallSite {
  readonly name: string
  readonly arguments_: number
  readonly line: number
  readonly sample: string
}

/** Every `@Remote('name')` and the parameter list of the method under it. */
function hostRemotes(text: string): ReadonlyMap<string, Remote> {
  const remotes = new Map<string, Remote>()
  for (const match of text.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/gu)) {
    const after = text.slice(match.index + match[0].length)
    const signature = /^\s*(?:async\s+)?[A-Za-z0-9_$]+\s*\(/u.exec(after)
    if (signature === null) continue
    const open = match.index + match[0].length + signature[0].length - 1
    const parameters = balanced(text, open)
    if (parameters === undefined) continue
    const list = splitTop(parameters)
    const optional = list.filter(parameter => /\?\s*:/u.test(parameter) || /\s=/u.test(parameter)).length
    remotes.set(match[1] ?? '', {
      required: list.length - optional,
      total: list.length,
      signature: parameters.replace(/\s+/gu, ' ').slice(0, 120),
      line: text.slice(0, match.index).split('\n').length,
    })
  }
  return remotes
}

/**
 * Every call whose first argument is a name literal.
 *
 * The name match is deliberately permissive — the type-argument list may hold
 * brackets and `import(…)` calls — and the *argument list* is then located by
 * balancing from the literal. `firstArgumentIsName` below is the self-check that
 * this really attached the argument list to the call the name belongs to.
 */
function clientCallSites(text: string): readonly CallSite[] {
  const sites: CallSite[] = []
  for (const match of text.matchAll(/backendCall\s*(?:<[^>]*>)?\s*\(\s*'([A-Za-z0-9_]+)'/gu)) {
    const name = match[1] ?? ''
    const literalAt = match.index + match[0].lastIndexOf(`'${name}'`)
    const open = openerBefore(text, literalAt)
    const arguments_ = open === undefined ? undefined : balanced(text, open)
    if (arguments_ === undefined) continue
    const parts = splitTop(arguments_)
    if (parts[0] !== `'${name}'`) continue
    sites.push({
      name,
      arguments_: Math.max(0, parts.length - 1),
      line: text.slice(0, literalAt).split('\n').length,
      sample: parts.slice(1).map(part => part.replace(/\s+/gu, ' ').slice(0, 36)).join(' | '),
    })
  }
  return sites
}

const REMOTES = hostRemotes(HOST)
const SITES = clientCallSites(CLIENT)

/**
 * The contract rule, so its own behaviour is testable.
 *
 * A name the Host does not declare, or an argument count outside the declared
 * range, is a gap. Both are printed with the site's line and the Host signature,
 * because "which side moved" is the whole diagnosis.
 */
function contractGaps(remotes: ReadonlyMap<string, Remote>, sites: readonly CallSite[]): readonly string[] {
  const gaps: string[] = []
  for (const site of sites) {
    const remote = remotes.get(site.name)
    if (remote === undefined) {
      gaps.push(`client/index.ts:${site.line} calls "${site.name}", which no @Remote declares`)
      continue
    }
    if (site.arguments_ < remote.required || site.arguments_ > remote.total) {
      gaps.push(
        `client/index.ts:${site.line} calls "${site.name}" with ${site.arguments_} argument(s) ` +
        `[${site.sample}], but the Host method takes ${remote.required} required of ${remote.total} ` +
        `[${remote.signature}] (index.ts:${remote.line})`,
      )
    }
  }
  return gaps
}

describe('the remote call contract', () => {
  it('reads the same inventory the source has', () => {
    // Vacuity guard: a parser that stops matching must fail here rather than let
    // every rule below pass while comparing nothing.
    // 204 → 205: `accountRememberedPassword`, the read the sign-in form uses to
    // prefill a password the user asked this machine to keep. Its client side is
    // a cast-style call, the shape this spec deliberately does not count, so
    // REMOTES moves while SITES does not.
    // 205 → 214: the nine Trae remotes (status, start, poll, submit callback,
    // cancel, the model directory, logout, and the two pool operations).
    // 214 → 216: `qoderCheckin` and `traeCheckin`, one dispatch site each. Both
    // carry the run report rather than the account status, so neither moves the
    // status remotes' argument counts.
    // 216 → 215: `teamStatus` went with this plugin's own team runtime; the
    // Harness's agent team owns that surface now, so there is nothing left here to
    // report on.
    // 215 → 216: `skillPresetRemove`, the removal of a Skill the Marketplace
    // installed. Its client side is one dispatch site, so both counts below move
    // by one together — which is the check that says the pair was extended rather
    // than one of them drifting.
    // 216 → 217: `skillPlacements`. Its second side is one dispatch site, and it also
    // moved `skillPresetInstall` from one parameter to two (one required, one optional),
    // which the arity check reads from the decorated signature rather than from a count.
    // 217 → 218: `skillPlacementPrefer`, the write for the remembered destination. Its one
    // parameter is optional because no argument *is* the clear, which the arity check
    // reads from the signature: the client's two calls (axes, and no axes) both sit inside
    // the declared range.
    // 218 → 219: `paymentStripeReceiptDocument`, Stripe's own PDF receipt for a paid
    // Stripe order. Its second side is one dispatch site in `client/index.ts`, like the
    // receipt beside it, so the two counts below move with REMOTES — the pair check is
    // what says this was an extension of both sides rather than one of them drifting.
    expect(REMOTES.size, 'the Host remote inventory changed — re-verify the pairs, then update this count').toBe(219)
    // Re-verified when this moved 182 → 176: the five conditional dispatches
    // (`agnesRefresh`, `agnesCreateApiKey`, `agnesLogout`, `codexRuntimeInstall`,
    // `claudeRuntimeInstall`) that branched into a zero-argument call collapsed
    // into the one explicit-`undefined` call each, and the sixth (`clineRefresh`)
    // reads the same now that prose quoting it is no longer counted as a site.
    // Both are the fix for `expected 1 argument(s), got 0` on those buttons.
    //
    // 176 → 186: seven Qoder account remotes and three review remotes, each with
    // exactly one dispatch site. Both pairs of counts moved together, which is the
    // check that says the two sides were extended rather than one of them drifting.
    // 186 → 195: the same nine Trae remotes on the client side. The dispatch is
    // counted whether or not it passes an argument — `traePollBrowserLogin` sends
    // none because the card polls the status the Host already holds — so both
    // counts moved by nine, which is the check that says the two sides were
    // extended together rather than one of them drifting.
    // 195 → 197: `qoderCheckin` and `traeCheckin` on the client side too, one
    // dispatch each — again both counts moved together, which is the check that
    // says the pair was extended rather than one side drifting.
    // 197 → 196: `teamStatus` on the client side, removed with this plugin's own
    // team runtime; the dispatch and its name went together, so both counts moved
    // by one.
    // 196 → 197: `skillPresetRemove` on the client side too, one dispatch.
    // 197 → 198: `skillPlacements`, the matrix the Skills page renders as the install
    // destination. One dispatch on the client side as well, so both counts moved by one
    // — the check that says the pair was extended together.
    // 198 → 199: `skillPlacementPrefer`, the write for the remembered destination.
    // 199 → 200: the Stripe receipt dispatch that arrived with the payment work in this
    // checkout; it is counted here because it is a real dispatch, whoever added it.
    expect(SITES.length, 'the client dispatch inventory changed — re-verify, then update this count').toBe(200)
    // 196 → 197: `skillPlacements` is a name no earlier dispatch carried, so this count
    // moves with the two above rather than staying put — the check that a new *name*
    // arrived instead of another call to one already counted.
    // 198 → 199: `paymentStripeReceiptDocument` is a name no earlier dispatch carried.
    expect(new Set(SITES.map(site => site.name)).size, 'distinct dispatched names changed').toBe(199)
  })

  it('reads a known signature correctly, which is what the arity check rests on', () => {
    // The one shape an earlier parser got wrong: a second parameter whose type is
    // an indexed access. It counted three parameters and reported a false arity
    // for a call that is correct, so the count it reads now is pinned here.
    const reviewed = REMOTES.get('engineeringTeamDecision')
    expect(reviewed, 'a remote the client calls must be declared').toBeDefined()
    expect(reviewed?.required).toBe(2)
    expect(reviewed?.total).toBe(2)
    expect(reviewed?.signature).toContain("FreeCodeGoEngineeringCouncilDecision['state']")
    expect(reviewed?.signature).toContain('sessionId: string')
  })

  it('declares every name the client dispatches', () => {
    expect(contractGaps(REMOTES, SITES).filter(gap => gap.includes('no @Remote declares'))).toEqual([])
  })

  it('binds every dispatch inside the declared argument range', () => {
    expect(contractGaps(REMOTES, SITES)).toEqual([])
  })

  it('leaves a known set of Host remotes without a dynamic client call', () => {
    // A drop means a caller was removed (or renamed onto another method); a rise
    // means a new remote has no client entry point yet. Either way it is a
    // deliberate edit, not something to discover in the browser.
    const called = new Set(SITES.map(site => site.name))
    const unused = [...REMOTES.keys()].filter(name => !called.has(name))
    // 19 → 20 by `accountRememberedPassword`: it is reached through the
    // cast-style call in `client/index.ts` (like `accountLogin`), which is not a
    // dispatch site, so it lands here rather than in SITES.
    expect(unused.length, `unreached remotes changed: ${unused.join(', ')}`).toBe(20)
  })

  it('reports an undeclared name and a wrong argument count, which is the defect this gate exists for', () => {
    // Falsifiability, without touching either source.
    const remotes = new Map<string, Remote>([
      ['engineeringTeamDecision', { required: 2, total: 2, signature: 'sessionId: string, request: {...}', line: 1660 }],
    ])
    const sites: readonly CallSite[] = [
      { name: 'engineeringTeamDecision', arguments_: 2, line: 530, sample: 'sessionId | request' },
      { name: 'engineeringTeamDecision', arguments_: 1, line: 531, sample: 'sessionId' },
      { name: 'engineeringTeamVerify', arguments_: 2, line: 532, sample: 'sessionId | request' },
    ]
    const gaps = contractGaps(remotes, sites)
    expect(gaps).toHaveLength(2)
    expect(gaps[0]).toContain('calls "engineeringTeamDecision" with 1 argument(s)')
    expect(gaps[0]).toContain('takes 2 required of 2')
    expect(gaps[1]).toContain('calls "engineeringTeamVerify", which no @Remote declares')
  })
})
