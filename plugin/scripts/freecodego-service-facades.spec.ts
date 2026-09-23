/**
 * Every host service the FreeCodeGo plugin reaches through `ctx.get()` must be a
 * service the pinned Harness actually declares, and every member its facade
 * asserts must exist on that service's declaration.
 *
 * Why this is a gate rather than a convention
 * ------------------------------------------
 * The plugin reaches the Harness through hand-written facades:
 *
 * ```ts
 * const settings = ctx.get('settings') as { describe(): Row[]; update(ns, patch): Promise<void> }
 * ```
 *
 * Nothing checks that shape. `ctx.get()` answers `any` for a service name the
 * compiler cannot resolve, so the `as` is not a verified narrowing — it is a
 * claim, and TypeScript accepts any claim about `any`. The unit tests cannot
 * check it either: the fakes under `tests/` are written **to the facade**, so a
 * facade naming a member the Harness never had is confirmed by every test that
 * exercises it.
 *
 * Measured instances, both silent:
 *
 * - `subagent-model-routing.ts` read peer settings through `settings.get(ns)`.
 *   `SettingsForms` never declared `get` — it declares `configure`/`describe`/
 *   `update`/`replace`/`mutate`, addressed by entry id. The call threw
 *   `TypeError` into a `.catch(() => undefined)`, so **every** Subagent route
 *   authorization was dropped with no symptom, and the module's own spec passed
 *   because its fake declared the `get` the facade did.
 * - The shipped preset assets configured `@deepseek-ai/dsh-persona`
 *   with `text:`. That package's schema is `prefix` (required) + `suffix`, in
 *   0.1.6 and 0.1.7 alike, so both shipped modes were `broken` at load.
 *
 * Both classes are invisible to `tsc`, to the test suite, and to every other
 * gate here. This one is mechanical: it parses the plugin's facades out of the
 * source, resolves each name against the declaration the pinned Harness
 * publishes, and fails on a name that is not there.
 *
 * What it checks
 * --------------
 * 1. Every `ctx.get('<name>')` names a service that is either declared in a
 *    `declare module '@deepseek-ai/cordis'` Context augmentation, or provided by
 *    a plugin (`ctx.provide('<name>', …)` / a `Service` super-call). A name that
 *    is neither is a facade for a service nobody publishes.
 * 2. Every member of a facade written as a type **literal** — including through
 *    `| undefined` and intersections — exists on the resolved service type.
 *    Members are collected through `extends` clauses and the `Pick<>`/`Omit<>`/
 *    `Partial<>`/`Readonly<>`/`Required<>` wrappers, so an inherited member
 *    (`Loader.entries` comes from `EntryTree`) is not reported as missing.
 * 3. A facade that names a type **the plugin family declares** (for example
 *    `as SessionEventsPersistence`) is expanded the same way, because that
 *    declaration is the plugin's own claim and nothing else checks it.
 * 4. The exemption set equals the dead set exactly, and every exemption states
 *    why. A probe whose facade was deleted fails as stale — the rule
 *    `freecodego-config-readers.spec.ts` uses, for the same reason: an exemption
 *    nobody needs is a hole nobody is watching.
 * 5. The scan found at least the facades it found when the gate was written. A
 *    gate that silently stops seeing the thing it checks is worse than no gate,
 *    and this repository has been bitten by exactly that: an assertion resolving
 *    a path an upgrade had deleted passed for a whole release.
 *
 * Honest limits
 * -------------
 * - A facade naming an **upstream** type (`ctx.get('attachments') as
 *   AttachmentStore`, imported from the package) is not expanded: that name *is*
 *   the declaration `tsc` checks, so expanding it would only re-derive the
 *   compiler. Such a facade contributes no members here, which is why the floor
 *   in check 5 counts services as well.
 * - A `ctx.get('<name>')` written **without** an `as` is out of scope, and that
 *   is correct rather than a hole: those sites compile only because the
 *   service's own package is in the plugin's program (`skills`, for instance,
 *   is a peer dependency), so TypeScript already checks every member on them.
 *   The `as` is what removes that check, and the `as` is what this gate reads.
 * - Members are compared by **name**, not signature. A facade calling
 *   `describe()` with the wrong arity passes here.
 * - Heritage is followed through the type index; a member reachable only through
 *   a mixin built by a static helper is not.
 * - The scan reads TypeScript as text. A facade built by a loop or a mapped type
 *   would be invisible, and would lower the floor rather than pass silently.
 *
 * @module scripts/freecodego-service-facades
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PLUGIN_SOURCE = join(REPO_ROOT, 'packages', 'freecodego', 'harness-plugin', 'src')

/** Directories a walk never descends into: build output is not a declaration. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', 'dist', 'coverage', '__snapshots__'])
/** File suffixes that can carry a declaration. */
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts']
/** Guard text: a file is parsed only when it could contribute something. */
const DECLARATION_HINTS = ['declare module', 'interface ', 'class ', 'type ']
/** Type references whose shape this gate understands and expands itself. */
const WRAPPER_TYPES = new Set(['Pick', 'Omit', 'Partial', 'Required', 'Readonly'])

/**
 * A facade member the pinned Harness does not declare, kept on purpose.
 *
 * The value is the reason, and the assertion below reads it: an entry without a
 * sentence is a hole, not a decision. Keyed `<service>.<member>` so the probe
 * names the call site a reader can check.
 */
const MEMBER_PROBES: Readonly<Record<string, string>> = {
  'workspaceRegistry.forgetSession':
    'Capability probe in engine-remotes.ts: no shipped Harness declares it, the call is optional-chained so it ' +
    'no-ops, and the comment there names what does the work instead (`api-session/removed`). Kept because a Host ' +
    'that did expose it is the only way to drop the durable association before the registry next re-lists.',
}

/**
 * A service name the plugin probes that no plugin provides.
 *
 * The value is the reason; see {@link MEMBER_PROBES}.
 */
const SERVICE_PROBES: Readonly<Record<string, string>> = {
  freeCodeGoAgentFactoryAlpha:
    'Legacy alpha name read as a `??` fallback beside `freeCodeGoAgentEngineRouter` in engine-remotes.ts, so an ' +
    'older preview profile still resolves a router. Nothing provides it in this tree; being absent is the point.',
}

/**
 * Extraction floors, and why they are floors rather than exact counts.
 *
 * Asserting the exact set would make every added facade read as a gate failure,
 * and the churn it would cause is the reason gates like this get deleted. What
 * may not move silently is the order of magnitude: the scan sees 20 services,
 * 85 literal members and 127 service declarations today, so the floors sit
 * below that with room for feature work and still fail a scan that stopped
 * resolving — a changed `ctx` binding convention, `src` moved — instead of
 * reporting success over an empty list.
 */
const MINIMUM_SERVICES = 16
const MINIMUM_LITERAL_MEMBERS = 50
const MINIMUM_SERVICE_DECLARATIONS = 100

interface ServiceDeclaration {
  /** The file declaring the service, relative to the repository root. */
  readonly file: string
  /** The declared type, as written in the Context augmentation. */
  readonly typeText: string
}

interface TypeDeclaration {
  /** The file declaring the type, relative to the repository root. */
  readonly file: string
  /** True when the plugin family rather than the Harness declares it. */
  readonly own: boolean
  readonly node: ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration
}

interface Facade {
  readonly service: string
  readonly file: string
  readonly line: number
  /** Members this facade itself asserts; empty when it only names a type. */
  readonly members: readonly string[]
  /** The assertion as written, for the failure message. */
  readonly raw: string
}

/** Read every candidate source file under a directory. */
function collectSources(directory: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      collectSources(path, out)
      continue
    }
    if (SOURCE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) out.push(path)
  }
  return out
}

/**
 * Every source file the pinned Harness publishes, plus the plugin family's own
 * packages — a service the family provides is a real service, and leaving those
 * out would report the family's own seams as facades for nothing.
 * @returns Absolute paths of the files worth parsing.
 */
function harnessSources(): string[] {
  const out: string[] = []
  for (const root of ['packages', 'vendor']) {
    for (const group of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      collectSources(join(REPO_ROOT, root, group.name), out)
    }
  }
  return out
}

/** Member names of an interface, class or type literal, public and non-computed only. */
function literalMembers(node: ts.Node): string[] {
  const target = ts.isTypeAliasDeclaration(node) ? node.type : node
  if (target === undefined) return []
  const groups: readonly (ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>)[] =
    ts.isTypeLiteralNode(target) ? [target.members]
      : ts.isInterfaceDeclaration(target) || ts.isClassDeclaration(target) ? [target.members]
        : []
  const out: string[] = []
  for (const group of groups) {
    for (const member of group) {
      if (member.name === undefined) continue
      if (ts.isComputedPropertyName(member.name) || ts.isPrivateIdentifier(member.name)) continue
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : []
      const hidden = modifiers.some(modifier =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)
      if (!hidden) out.push(member.name.getText())
    }
  }
  return out
}

/** The string keys a `Pick`/`Omit` second argument names. */
function literalKeys(node: ts.TypeNode | undefined): string[] {
  if (node === undefined) return []
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(literalKeys)
  if (ts.isParenthesizedTypeNode(node)) return literalKeys(node.type)
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
  return []
}

/**
 * Declarations of a type name, with the family's own declarations preferred.
 *
 * A name the family declares is its own claim and nothing else checks it, so it
 * resolves first. A name only the Harness declares is the compiler's business
 * and is not expanded.
 */
class TypeIndex {
  readonly #byName = new Map<string, TypeDeclaration[]>()

  /** Record one declaration. */
  add(name: string, declaration: TypeDeclaration): void {
    const entries = this.#byName.get(name) ?? []
    entries.push(declaration)
    this.#byName.set(name, entries)
  }

  /** True when the family declares this name. */
  hasOwn(name: string): boolean {
    return (this.#byName.get(name) ?? []).some(entry => entry.own)
  }

  /** Declarations of a name, family-owned ones first. */
  declarations(name: string): readonly TypeDeclaration[] {
    const entries = this.#byName.get(name) ?? []
    return [...entries.filter(entry => entry.own), ...entries.filter(entry => !entry.own)]
  }

  /** Member names of a type, following heritage and the wrapper types above. */
  members(node: ts.TypeNode, seen: ReadonlySet<string> = new Set()): string[] {
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      return [...new Set(node.types.flatMap(part => this.members(part, seen)))]
    }
    if (ts.isParenthesizedTypeNode(node)) return this.members(node.type, seen)
    if (ts.isTypeLiteralNode(node)) return literalMembers(node)
    if (ts.isImportTypeNode(node)) {
      // `import('./contract/sessions.ts').ISessions` — the qualifier is the name.
      const qualifier = node.qualifier
      return qualifier === undefined ? [] : this.membersOfName(qualifier.getText(), seen)
    }
    if (!ts.isTypeReferenceNode(node)) return []
    const name = node.typeName.getText()
    const args = node.typeArguments ?? []
    if (name === 'Pick') {
      const keys = new Set(literalKeys(args[1]))
      return this.members(args[0] as ts.TypeNode, seen).filter(member => keys.has(member))
    }
    if (name === 'Omit') {
      const keys = new Set(literalKeys(args[1]))
      return this.members(args[0] as ts.TypeNode, seen).filter(member => !keys.has(member))
    }
    if (WRAPPER_TYPES.has(name)) return this.members(args[0] as ts.TypeNode, seen)
    // `Record<K, V>` and friends describe no named member.
    if (name === 'Record') return []
    return this.membersOfName(name, seen)
  }

  /** Member names of a declared name, following `extends` clauses. */
  membersOfName(name: string, seen: ReadonlySet<string>): string[] {
    if (seen.has(name)) return []
    const next = new Set(seen).add(name)
    const out: string[] = []
    for (const declaration of this.declarations(name)) {
      out.push(...literalMembers(declaration.node))
      const target = ts.isTypeAliasDeclaration(declaration.node) ? declaration.node.type : declaration.node
      if (target === undefined) continue
      if (ts.isTypeLiteralNode(target)) {
        out.push(...literalMembers(target))
        continue
      }
      const heritage = ts.isInterfaceDeclaration(target) || ts.isClassDeclaration(target) ? target.heritageClauses ?? [] : []
      for (const clause of heritage) {
        for (const base of clause.types) out.push(...this.membersOfName(base.expression.getText(), next))
      }
    }
    return out
  }

  /** True when a name resolved to at least one declaration. */
  known(name: string): boolean {
    return this.declarations(name).length > 0
  }
}

/** Parse a type expression that was captured as text. */
function parseType(text: string): ts.TypeNode | undefined {
  const source = ts.createSourceFile('facade.ts', `type __Facade = ${text}\n`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = source.statements[0]
  return statement !== undefined && ts.isTypeAliasDeclaration(statement) ? statement.type : undefined
}

/** The `as` assertion a call is the subject of, through `??` and parentheses. */
function enclosingAssertion(node: ts.Node): ts.TypeNode | undefined {
  let current: ts.Node = node
  while (current.parent !== undefined) {
    if (ts.isAsExpression(current.parent) && current.parent.expression === current) return current.parent.type
    const stop = ts.isStatement(current.parent) || ts.isVariableDeclaration(current.parent) || ts.isPropertyDeclaration(current.parent)
    if (stop) return undefined
    current = current.parent
  }
  return undefined
}

/**
 * Members a facade itself asserts.
 *
 * Only literal members and the family's own named types are expanded: an
 * upstream name is the declaration `tsc` already checks, so counting its
 * hundreds of members here would make the check vacuous.
 * @param typeNode - the asserted type.
 * @param index - the type index, for names the family declares.
 * @returns The asserted member names.
 */
function facadeMembers(typeNode: ts.TypeNode, index: TypeIndex): string[] {
  const members = new Set<string>()
  const walk = (node: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      for (const part of node.types) walk(part)
      return
    }
    if (ts.isParenthesizedTypeNode(node)) {
      walk(node.type)
      return
    }
    if (ts.isTypeLiteralNode(node)) {
      for (const member of literalMembers(node)) members.add(member)
      return
    }
    if (!ts.isTypeReferenceNode(node)) return
    const name = node.typeName.getText()
    if (WRAPPER_TYPES.has(name) || name === 'Record') return
    if (index.known(name)) {
      for (const member of index.membersOfName(name, new Set())) members.add(member)
      return
    }
    // An upstream import: the compiler's business, not this gate's.
  }
  walk(typeNode)
  return [...members]
}

interface Collection {
  readonly services: ReadonlyMap<string, readonly ServiceDeclaration[]>
  readonly provided: ReadonlySet<string>
  readonly index: TypeIndex
  readonly facades: readonly Facade[]
  readonly parsedFiles: number
}

/** Build the state one run of the gate needs. */
function collect(): Collection {
  const services = new Map<string, ServiceDeclaration[]>()
  const provided = new Set<string>()
  const index = new TypeIndex()
  let parsedFiles = 0

  for (const path of harnessSources()) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!DECLARATION_HINTS.some(hint => text.includes(hint))) continue
    parsedFiles += 1
    const file = relative(REPO_ROOT, path)
    const own = file.split(/[\\/]/).includes('freecodego')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === '@deepseek-ai/cordis'
        && node.body !== undefined && ts.isModuleBlock(node.body)) {
        for (const statement of node.body.statements) {
          if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'Context') continue
          // One service name can be declared in two planes — `sessions` is a
          // `SessionStore` in the core session package and an `ISessions` in the
          // client controller. Every declaration counts, and the members below
          // are unioned, or a facade for the host-plane face is accused of a
          // member only the client-plane face lacks.
          for (const member of statement.members) {
            if (!ts.isPropertySignature(member) || member.name === undefined) continue
            const name = member.name.getText()
            const entries = services.get(name) ?? []
            entries.push({ file, typeText: member.type?.getText(source) ?? '' })
            services.set(name, entries)
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'provide') {
          const argument = node.arguments[0]
          if (argument !== undefined && ts.isStringLiteral(argument)) provided.add(argument.text)
        }
        if (callee.kind === ts.SyntaxKind.SuperKeyword) {
          const argument = node.arguments[1]
          if (argument !== undefined && ts.isStringLiteral(argument)) provided.add(argument.text)
        }
      }
      if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node))
        && node.name !== undefined) {
        index.add(node.name.text, { file, own, node })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const facades: Facade[] = []
  for (const path of collectSources(PLUGIN_SOURCE)) {
    const text = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const file = relative(REPO_ROOT, path)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'get' && /(?:^|\.)ctx$/.test(node.expression.expression.getText(source))) {
        const argument = node.arguments[0]
        const asserted = enclosingAssertion(node)
        if (argument !== undefined && ts.isStringLiteral(argument) && asserted !== undefined) {
          facades.push({
            service: argument.text,
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            members: facadeMembers(asserted, index),
            raw: asserted.getText(source).replace(/\s+/g, ' ').slice(0, 72),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return { services, provided, index, facades, parsedFiles }
}

/** Member names every declaration of a service publishes, unioned across declarations. */
function publishedMembers(index: TypeIndex, declarations: readonly ServiceDeclaration[]): string[] {
  const out = new Set<string>()
  for (const declaration of declarations) {
    const node = parseType(declaration.typeText)
    if (node === undefined) continue
    for (const member of index.members(node)) out.add(member)
  }
  return [...out]
}

describe('FreeCodeGo plugin host-service facades', () => {
  const state = collect()

  it('parses the pinned Harness declarations rather than an empty tree', () => {
    expect(state.parsedFiles).toBeGreaterThan(200)
    expect(state.services.size).toBeGreaterThan(MINIMUM_SERVICE_DECLARATIONS)
  })

  it('reaches every host service through a name the pinned Harness publishes', () => {
    const unknown = [...new Set(state.facades.map(facade => facade.service))]
      .filter(name => !state.services.has(name) && !state.provided.has(name))
      .sort()
    expect(unknown).toEqual(Object.keys(SERVICE_PROBES).sort())
    for (const reason of Object.values(SERVICE_PROBES)) expect(reason.length).toBeGreaterThan(40)
  })

  it('asserts only members the declared service type publishes', () => {
    const dead: string[] = []
    const lines: string[] = []
    for (const facade of state.facades) {
      if (facade.members.length === 0) continue
      const declarations = state.services.get(facade.service)
      if (declarations === undefined) continue
      const published = publishedMembers(state.index, declarations)
      const missing = facade.members.filter(member => !published.includes(member))
      if (missing.length === 0) continue
      dead.push(...missing.map(member => `${facade.service}.${member}`))
      lines.push(`${facade.file}:${facade.line} asserts '${missing.join(', ')}' on ${facade.service}\n    declared as: ${declarations.map(entry => entry.typeText).join(' | ')}`)
    }
    // The locations ride in the assertion message rather than the compared
    // value, so the ledger below stays a set of `<service>.<member>` keys.
    const report = `facades naming members the pinned Harness does not declare:\n${lines.join('\n')}`
    expect(lines.join('\n') === '' ? [] : dead.sort(), report).toEqual(Object.keys(MEMBER_PROBES).sort())
    for (const reason of Object.values(MEMBER_PROBES)) expect(reason.length).toBeGreaterThan(40)
  })

  it('sees the facades the bug this gate exists for was hiding behind', () => {
    // A scan that quietly stopped resolving facades reports a clean run, so the
    // pairs below pin the shapes that must stay visible. The first two are the
    // call the `settings.get(ns)` defect lived in: a facade that names them is a
    // facade this gate reads.
    const pinned: ReadonlyArray<readonly [service: string, member: string]> = [
      ['settings', 'describe'],
      ['settings', 'update'],
      ['sessionPersistence', 'open'],
      ['tools', 'register'],
      ['llm', 'listProviders'],
      ['agents', 'get'],
      ['sessions', 'get'],
      ['loader', 'entries'],
      ['sandboxPolicy', 'resolve'],
      ['goals', 'create'],
    ]
    const seen = new Set(state.facades.flatMap(facade => facade.members.map(member => `${facade.service}.${member}`)))
    const absent = pinned.filter(([service, member]) => !seen.has(`${service}.${member}`))
    expect(absent.map(([service, member]) => `${service}.${member}`)).toEqual([])
  })

  it('found the facades it was written to check', () => {
    const services = new Set(state.facades.map(facade => facade.service))
    const literals = state.facades.reduce((total, facade) => total + facade.members.length, 0)
    expect(services.size).toBeGreaterThanOrEqual(MINIMUM_SERVICES)
    expect(literals).toBeGreaterThanOrEqual(MINIMUM_LITERAL_MEMBERS)
  })
})
