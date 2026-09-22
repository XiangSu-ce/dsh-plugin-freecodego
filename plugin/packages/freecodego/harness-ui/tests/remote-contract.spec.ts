import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Why this test reads sources and the generated contract
 * ------------------------------------------------------
 * Three failures are invisible to the typechecker and to the unit tests,
 * because each side of the wire is self-consistent:
 *
 *  - the client calls a Remote the Host stopped declaring, which surfaces as
 *    "did not become available" eight seconds into a click;
 *  - a settings section requires an injected face (an `*SectionInjected`
 *    interface) that no slot provides, which is the same absence one level up;
 *  - a boundary type gained a property but the generated Typert contract was
 *    not regenerated, so the browser-side schema **drops that field** and the
 *    call silently degrades to an empty patch. That is not hypothetical: the
 *    Superpowers / starter-Skill / Skill-map switches were dead for exactly this
 *    reason, and `pnpm run build:freecodego` used not to regenerate Typert — it
 *    does now, as that script's first step, because the bundle this family packs
 *    is built by it and the contract the browser loads has to come from the types
 *    this tree declares. `node scripts/build-freecodego-bundle.mjs` on its own
 *    still packs whatever `lib/` holds, which is the right shape for a re-pack of
 *    bytes that were already built.
 *
 * The last one is why this file reads `lib/typert.remote-client.js`: nothing
 * else compares the shipped contract against the declared types.
 */
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..', 'harness-plugin')
const hostPath = join(pluginRoot, 'src', 'index.ts')
const hostSourceRoot = join(pluginRoot, 'src')
const clientPath = join(here, '..', 'src', 'client', 'index.ts')
const surfacePath = join(here, '..', 'src', 'client', 'settings-tab.tsx')
const typertPath = join(pluginRoot, 'lib', 'typert.remote-client.js')
const engineeringPath = join(pluginRoot, 'src', 'engineering.ts')

const hostSource = await readFile(hostPath, 'utf8')
const clientSource = await readFile(clientPath, 'utf8')
const surfaceSource = await readFile(surfacePath, 'utf8')
const engineeringSource = await readFile(engineeringPath, 'utf8')
const typertSource = await readFile(typertPath, 'utf8').catch(() => {
  throw new Error(`${typertPath} is missing; run 'pnpm run build:lib:host' (or scripts/generate-typert.mjs) before the contract test`)
})
const uiSourceRoot = join(here, '..', 'src')

/**
 * Remotes the Host declares that the UI package does not mention anywhere, and
 * why each one is allowed to stay that way.
 *
 * Why this list exists at all: a Remote is a capability, not a control. A
 * declared method with no caller is invisible — it cannot be clicked, it is not
 * exercised by any test, and nothing fails when it rots. `automationSettingsUpdate`
 * shipped into exactly that state, and the four switches it writes stayed
 * unreachable even after the Remote existed. The set is enumerated here so it can
 * only shrink: adding a Remote without calling it from the UI now fails the
 * suite, and removing an entry requires wiring it.
 *
 * Every entry below is genuinely uncalled as of this revision — not
 * "host-internal": no file in this repository, and nothing outside the plugin
 * package, mentions any of these names. Each reason says what the entry is
 * waiting for, so the list doubles as the backlog rather than a permission slip.
 *
 * The folder-trust three (`trustFolderStatus` / `trustFolderGrant` /
 * `trustFolderRevoke`) were removed when `TrustPanel` landed: the record is now
 * readable, grantable, and revocable from the settings page, which is what
 * "unwired" was tracking.
 */
const UNWIRED_REMOTES: Readonly<Record<string, string>> = {
  // The Host's own account/quota plumbing. These read or refresh credentials the
  // other wired account Remotes already surface; a button for them would be a
  // second control for state the user changes elsewhere.
  accountRefresh: 'credential plumbing; the account panel re-reads state through accountStatus',
  backendBootstrap: 'bootstrap plumbing consumed by other Remotes rather than by a gesture',
  backendQuota: 'quota plumbing; tokenUsage* already render the figures the UI shows',
  backendRuntimeHealth: 'health probe with no user gesture; readiness is derived from the catalog',
  backendUsage: 'usage plumbing; tokenUsage* already render the figures the UI shows',
  workbuddyRefreshToken: 'token plumbing that takes a raw refresh token, which the panel never holds',
  // Redundant with a status the UI already renders.
  lspMountStatus: 'superseded for the UI by guardSettingsStatus.lsp, which the guard panel renders',
  // Waiting on a companion read that does not exist yet, not on a panel.
  //
  // `engineeringMemoryForget` takes `{ path, sha256 }` and verifies the file
  // still hashes to the bytes the caller read; that evidence *is* the safety
  // argument in `memory/forget.ts`, which is why the Host never reads on the
  // caller's behalf. A browser cannot produce it: the curated-topic surface
  // exposes `engineeringMemoryManifest` (names, paths, descriptions) and nothing
  // that returns a record's bytes or their digest. Wiring this needs a Host
  // change — either the manifest carrying each entry's digest, or a companion
  // read Remote — and both widen what the browser can reach, so the decision is
  // not this file's to make. `engineeringMemoryConsolidate` and
  // `engineeringMemoryManifest` left this record instead: the memory panel now
  // carries 立即整合 and 重建记忆索引, and renders the index it gets back.
  engineeringMemoryForget: 'needs a Host read that returns a record\'s bytes and their digest; the browser cannot hash a file it cannot read',
  // The unified inspect surface (G9) and plan review (A1) left this record when
  // `InspectPanel` and `PlanReviewOverlay` landed: the report panel calls
  // `inspectReport`, and the overlay calls `planReviewOpen` for the numbered plan
  // surface and `planReviewCompose` for the rework message. They left it because
  // the UI calls them — the only thing that moves an entry out of this record.
  // Every other user-facing Remote now has a surface: the Advisor review action,
  // the Cline refresh-token input, the Logfare key field, the memory search box
  // and recall preview, the Skill draft action, the spec-bundle export, and the
  // self-check report. They left this record because the panels call them, which
  // is the only thing that moves an entry out of it.
}

/**
 * Every Remote name the UI package actually *calls*, across all of its sources.
 *
 * Calls rather than mentions, and every file rather than the entry points. Both
 * halves matter, and each was measured: a Remote whose name merely appears — as a
 * component prop, or as an i18n key that happens to share the name — is not
 * reachable, and a mention-based scan cannot tell the difference. Deleting the
 * `backendCall('automationSettingsStatus')` line left the name in the panel's
 * prop interface and the check passed, which is exactly the failure this test
 * exists to catch.
 */
async function uiCalledRemoteNames(): Promise<ReadonlySet<string>> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.[jt]sx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full)
    }
  }
  await walk(uiSourceRoot)
  const names = new Set<string>()
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const name of clientRemoteNames(text)) names.add(name)
  }
  expect(files.length).toBeGreaterThan(0)
  return names
}

/** Every Remote the Host declares. */
function hostRemoteNames(source: string): readonly string[] {
  return [...source.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/gu)].map(match => match[1]!)
}

/**
 * Every Remote name the client can reach.
 *
 * Two call shapes exist: the shared `backendCall('name', …)` helper, and direct
 * calls on the remote service, which name the method on the identifier the
 * `ctx.get('remote.freeCodeGoHarness')` result was bound to. Reading the bound
 * identifier rather than the cast literal matters — the cast's parameter types
 * contain braces, so a brace-matching scan of the cast would report argument
 * names as methods.
 */
function clientRemoteNames(source: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const name of backendCallNames(source)) names.add(name)
  const serviceIdentifiers = new Set<string>()
  for (const match of source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*(?:await\s+)?ctx\.get\('remote\.freeCodeGoHarness'\)/gu)) {
    serviceIdentifiers.add(match[1]!)
  }
  for (const identifier of serviceIdentifiers) {
    const call = new RegExp(`\\b${identifier}\\??\\.([A-Za-z0-9_]+)\\s*\\(`, 'gu')
    for (const match of source.matchAll(call)) names.add(match[1]!)
  }
  return names
}

/**
 * Remote names passed to the shared `backendCall` helper.
 *
 * A regex cannot read the type argument: `backendCall<Record<string, unknown>>(\n * 'x')` hides a `>` inside the generic, and a type argument may contain string
 * literals (`<{ readonly state: 'ready' }>`) that defeat any quote-delimited
 * scan. Both shapes are in this codebase, and a pattern that misses one reports a
 * wired Remote as dead — which in the other direction silently weakens the check
 * that the client only calls declared Remotes. So the type argument is skipped by
 * counting angle brackets, the way {@link injectBlocks} counts parentheses.
 */
function backendCallNames(source: string): readonly string[] {
  const names: string[] = []
  const marker = 'backendCall'
  let from = 0
  for (;;) {
    const start = source.indexOf(marker, from)
    if (start < 0) return names
    let index = start + marker.length
    if (source[index] === '<') {
      let depth = 0
      for (; index < source.length; index += 1) {
        const char = source[index]
        if (char === '<') depth += 1
        else if (char === '>') {
          depth -= 1
          if (depth === 0) { index += 1; break }
        }
      }
    }
    while (/\s/u.test(source[index] ?? '')) index += 1
    if (source[index] !== '(') { from = start + marker.length; continue }
    index += 1
    while (/\s/u.test(source[index] ?? '')) index += 1
    const quote = source[index]
    if (quote !== '\'' && quote !== '"' && quote !== '`') { from = start + marker.length; continue }
    const end = source.indexOf(quote, index + 1)
    if (end < 0) return names
    names.push(source.slice(index + 1, end))
    from = end + 1
  }
}

/**
 * The text of every `inject: () => (…)` slot object.
 *
 * Paren depth, not a regex: slot objects contain arrow functions and calls, so
 * matching the closing `)` by pattern would stop early on the first nested
 * call. Depth counting is exact for well-formed source, which the typechecker
 * already guarantees.
 */
function injectBlocks(source: string): readonly string[] {
  const marker = 'inject: () => ('
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(marker, from)
    if (start < 0) return blocks
    let depth = 0
    let index = start + marker.length - 1
    for (; index < source.length; index += 1) {
      const char = source[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(source.slice(start, index + 1))
    from = index + 1
  }
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, 'u').test(text)
}

/**
 * Split a parameter or argument list on the commas that separate its entries.
 *
 * Depth counting rather than a split: a parameter list holds object types,
 * generics and arrow types whose own commas are not separators. A list that is
 * empty or whitespace-only yields nothing, which is what makes arity zero
 * distinguishable from arity one.
 */
function topLevelList(text: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if ('([{<'.includes(char)) depth += 1
    if (')]}>'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** The text of the parenthesised list whose opening paren sits at `open`. */
function readParenthesised(source: string, open: number): string {
  let index = open + 1
  let depth = 1
  let text = ''
  while (index < source.length && depth > 0) {
    const char = source[index]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth > 0) text += char
    index += 1
  }
  return text
}

/**
 * Whether `index` sits inside a comment.
 *
 * Source-level scanning reads prose too, and prose about this contract quotes
 * the calls it describes — the paragraph explaining the arity rule names the
 * argument-less form of a Remote that is now called correctly, and reading it as
 * a call site reports a bug that does not exist. Line comments and the `*`
 * continuations of block comments are what this recognizes; the first line of a
 * `/* … *\/` block is recognized by its opener, which is where an example would
 * live. Nothing else in these files can start a comment line, so the check stays
 * a per-line judgement rather than a tokenizer.
 */
function insideComment(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1
  const line = source.slice(lineStart, index)
  if (line.includes('//')) return true
  if (/^\s*\*/u.test(source.slice(lineStart, index + 1))) return true
  return false
}

/** The declared parameter list of every `@Remote` method, in source order. */
function hostRemoteParameters(source: string): ReadonlyMap<string, readonly string[]> {
  const parameters = new Map<string, readonly string[]>()
  const marker = /@Remote\('([A-Za-z0-9_]+)'\)\s*(?:async\s+)?[A-Za-z0-9_]+\s*\(/gu
  for (const match of source.matchAll(marker)) {
    if (insideComment(source, match.index)) continue
    const open = match.index + match[0].length - 1
    parameters.set(match[1]!, topLevelList(readParenthesised(source, open)))
  }
  return parameters
}

/** One Remote call site and how many arguments it passes. */
interface RemoteCallSite {
  readonly file: string
  readonly name: string
  readonly passed: number
}

/** Remote names passed to the shared helper, with their argument counts. */
function backendCallArgumentCounts(source: string): readonly { readonly name: string; readonly passed: number }[] {
  const calls: { readonly name: string; readonly passed: number }[] = []
  const marker = 'backendCall'
  let from = 0
  for (;;) {
    const start = source.indexOf(marker, from)
    if (start < 0) return calls
    let index = start + marker.length
    if (source[index] === '<') {
      let depth = 0
      for (; index < source.length; index += 1) {
        const char = source[index]
        if (char === '<') depth += 1
        else if (char === '>') {
          depth -= 1
          if (depth === 0) { index += 1; break }
        }
      }
    }
    while (/\s/u.test(source[index] ?? '')) index += 1
    if (source[index] !== '(') { from = start + marker.length; continue }
    index += 1
    while (/\s/u.test(source[index] ?? '')) index += 1
    const quote = source[index]
    if (quote !== '\'' && quote !== '"' && quote !== '`') { from = start + marker.length; continue }
    const end = source.indexOf(quote, index + 1)
    if (end < 0) return calls
    // Everything between the name literal and the call's closing paren: the
    // commas at depth zero are exactly one per further argument.
    let cursor = end
    let depth = 0
    let passed = 0
    while (cursor < source.length) {
      const char = source[cursor] ?? ''
      if ('([{'.includes(char)) depth += 1
      else if (char === ')' && depth === 0) break
      else if (')]}'.includes(char)) depth -= 1
      else if (char === ',' && depth === 0) passed += 1
      cursor += 1
    }
    if (!insideComment(source, start)) calls.push({ name: source.slice(index + 1, end), passed })
    from = end + 1
  }
}

/**
 * Every Remote call in the UI package, both call shapes, across every file.
 *
 * Shape one is the shared `backendCall` helper. Shape two calls the method on
 * the identifier `ctx.get('remote.freeCodeGoHarness')` was bound to, which is
 * how the account Remotes are reached; the receiver there is a local name, so
 * the scan has to discover the bindings first rather than look for a literal.
 */
async function uiRemoteCallSites(): Promise<readonly RemoteCallSite[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.[jt]sx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full)
    }
  }
  await walk(uiSourceRoot)
  const sites: RemoteCallSite[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const relative = file.slice(uiSourceRoot.length + 1)
    for (const call of backendCallArgumentCounts(text)) {
      sites.push({ file: relative, name: call.name, passed: call.passed })
    }
    const bindings = new Set<string>()
    for (const match of text.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*(?:await\s+)?ctx\.get\('remote\.freeCodeGoHarness'\)/gu)) {
      bindings.add(match[1]!)
    }
    for (const binding of bindings) {
      const call = new RegExp(`\\b${binding}\\??\.([A-Za-z0-9_]+)\\s*\\(`, 'gu')
      for (const match of text.matchAll(call)) {
        if (insideComment(text, match.index)) continue
        const open = match.index + match[0].length - 1
        sites.push({ file: relative, name: match[1]!, passed: topLevelList(readParenthesised(text, open)).length })
      }
    }
  }
  return sites
}

/** Property names of every `export interface *SectionInjected` face. */
function requiredSectionProps(source: string): readonly { readonly face: string; readonly props: readonly string[] }[] {
  return [...source.matchAll(/export interface (\w*SectionInjected) \{([^}]*)\}/gu)].map(match => ({
    face: match[1]!,
    props: [...match[2]!.matchAll(/^\s*readonly ([A-Za-z0-9_]+)/gmu)].map(prop => prop[1]!),
  }))
}

/** The named parameter type of each Remote, when it is a single named type. */
function remoteParameterTypes(source: string): ReadonlyMap<string, string> {
  const types = new Map<string, string>()
  const marker = /@Remote\('([A-Za-z0-9_]+)'\)/gu
  for (const match of source.matchAll(marker)) {
    const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 600)
    const signature = rest.match(/\(\s*[A-Za-z0-9_]+\s*\??:\s*(?:Partial<)?([A-Za-z][A-Za-z0-9_]*)/u)
    if (signature !== null) types.set(match[1]!, signature[1]!)
  }
  return types
}

/** Property names of every exported interface, across the plugin's sources. */
async function declaredInterfaceProps(): Promise<ReadonlyMap<string, readonly string[]>> {
  const files = (await readdir(hostSourceRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => join(hostSourceRoot, entry.name))
  const props = new Map<string, readonly string[]>()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/export interface ([A-Za-z0-9_]+) \{([^}]*)\}/gu)) {
      const names = [...match[2]!.matchAll(/^\s*readonly ([A-Za-z0-9_]+)/gmu)].map(prop => prop[1]!)
      if (names.length > 0) props.set(match[1]!, names)
    }
  }
  return props
}

/** Property names of one method's generated parameter schema, if it has one. */
function generatedParameterProps(method: string): readonly string[] | undefined {
  const marker = `_${method}_parameter_0$schema = z.object({`
  const start = typertSource.indexOf(marker)
  if (start < 0) return undefined
  let depth = 0
  let index = start + marker.length - 1
  for (; index < typertSource.length; index += 1) {
    const char = typertSource[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const body = typertSource.slice(start + marker.length, index)
  return [...body.matchAll(/'([A-Za-z0-9_]+)':/gu)].map(entry => entry[1]!)
}

/**
 * Module ids the settings surface disables itself on, and the ids the Host can
 * actually emit. A gate on an id the Host never sends is permanently false:
 * the whole surface stays hidden while every Remote behind it works, which is
 * exactly how the workspace-checkpoint panel became unreachable.
 */
function gatedModuleIds(source: string): readonly string[] {
  return [...new Set([...source.matchAll(/module\.id === '([a-z]+)'/gu)].map(match => match[1]!))]
}

function emittedModuleIds(source: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const match of source.matchAll(/(?:moduleState|deferredModule)\('([a-z]+)'/gu)) ids.add(match[1]!)
  for (const match of source.matchAll(/id: '([a-z]+)' as const/gu)) ids.add(match[1]!)
  return ids
}

describe('FreeCodeGo Remote contract', () => {
  it('emits every engineering module the settings surface gates on', () => {
    const emitted = emittedModuleIds(engineeringSource)
    expect(emitted.size).toBeGreaterThan(0)
    const orphanGates = gatedModuleIds(surfaceSource).filter(id => !emitted.has(id)).sort()
    expect(orphanGates).toStrictEqual([])
  })

  it('declares each Remote exactly once', () => {
    const names = hostRemoteNames(hostSource)
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect([...new Set(duplicates)]).toStrictEqual([])
  })

  it('only calls Remotes the Host declares', () => {
    const declared = new Set(hostRemoteNames(hostSource))
    const missing = [...clientRemoteNames(clientSource)].filter(name => !declared.has(name)).sort()
    expect(missing).toStrictEqual([])
  })

  it('provides every required settings-section prop from some slot', () => {
    const blocks = injectBlocks(clientSource)
    const faces = requiredSectionProps(surfaceSource)
    expect(faces.length).toBeGreaterThan(0)
    const unprovided = faces.flatMap(face => face.props
      .filter(prop => !blocks.some(block => mentions(block, prop)))
      .map(prop => `${face.face}.${prop}`))
      .sort()
    expect(unprovided).toStrictEqual([])
  })

  it('calls every declared Remote from the UI, or records why it does not', async () => {
    const declared = [...new Set(hostRemoteNames(hostSource))]
    const called = await uiCalledRemoteNames()
    expect(called.size).toBeGreaterThan(0)
    const unwired = declared
      .filter(name => !called.has(name))
      .sort()
    // Exact equality in both directions, so the record cannot rot either way:
    // every Remote the UI does not mention must be explained, and every
    // explanation must still describe a Remote that exists — an entry left behind
    // after a rename would otherwise mask the next silent addition.
    expect(unwired).toStrictEqual(Object.keys(UNWIRED_REMOTES).sort())
    const unexplained = unwired.filter(name => (UNWIRED_REMOTES[name] ?? '').trim() === '')
    expect(unexplained).toStrictEqual([])
  })

  // A Remote call is refused before the Host ever runs when it passes fewer
  // arguments than the Host declares, because an **optional** parameter still
  // counts toward arity: `trustFolderStatus(directory?: string)` demands one
  // argument and answered the panel's argument-less call with `expected 1
  // argument(s), got 0`, which rendered as "授信状态读取失败" over an empty
  // section. The same shape hid behind `accountMfaComplete(totpCode, deviceId?)`.
  // Neither is a type error — the UI declares its own wrapper signature — so the
  // only place this can be caught is here, by reading both sides.
  it('passes each Remote at least the arguments the Host declares', async () => {
    const declared = hostRemoteParameters(hostSource)
    expect(declared.size).toBeGreaterThan(0)
    const sites = await uiRemoteCallSites()
    // A floor rather than `> 0`: the two call shapes are found by pattern, and a
    // pattern that stops matching would leave this test passing while measuring
    // almost nothing. The current tree measures well over this many sites.
    expect(sites.length).toBeGreaterThan(150)
    const shortfalls = sites.flatMap((site) => {
      const parameters = declared.get(site.name)
      if (parameters === undefined) return []
      if (site.passed >= parameters.length) return []
      return [`${site.file}: ${site.name} passes ${String(site.passed)} of ${String(parameters.length)}`]
    }).sort()
    expect(shortfalls).toStrictEqual([])
  })

  it('ships a Typert contract that still knows every declared field', async () => {
    const interfaces = await declaredInterfaceProps()
    const parameterTypes = remoteParameterTypes(hostSource)
    expect(parameterTypes.size).toBeGreaterThan(0)
    const stale: string[] = []
    for (const [method, type] of parameterTypes) {
      const declared = interfaces.get(type)
      if (declared === undefined) continue
      const generated = generatedParameterProps(method)
      if (generated === undefined) continue
      const dropped = declared.filter(prop => !generated.includes(prop))
      if (dropped.length > 0) stale.push(`${method}: ${dropped.join(', ')}`)
    }
    // A dropped field is not a cosmetic drift: the browser-side zod object
    // strips it, so the Remote receives a patch that is missing what the user
    // just changed, and the switch appears to ignore the click.
    expect(stale.sort()).toStrictEqual([])
  })
})
