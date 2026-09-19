/**
 * Every field a package's `static Config` schema declares must have a reader.
 *
 * Why this is a gate rather than a convention
 * -------------------------------------------
 * A configuration field that nothing reads is worse than a missing feature: it
 * is a *promise the schema makes and the program does not keep*. The class is
 * invisible to every gate this repository already has. `tsc` cannot see it —
 * declaring a field is legal, and the whole-object forward (`config.claude!`)
 * that the engine router uses deliberately does not trigger an excess-property
 * check, so the compiler stays silent even when the consumer's own type has no
 * such field. Tests cannot see it either: a field that is never read has no
 * behaviour to assert.
 *
 * Measured instance, 2026-09-16: `agent-engine-router` declared
 * `Config.claude.workerPath` as a **required** `z.string()` while nothing read
 * it. `runtime-claude`'s launch options had already dropped the field — its own
 * doc comment says the sidecar it used to select "was accepted and then
 * ignored, so the field only made the dead path look wired" — but the schema
 * went on demanding it. Same shape, different font: `root-agent`'s nine specs
 * wrote `{ persona: '' }` when the field is `personaPrefix`, so they ran under
 * the deployment default persona and cordis never objected to the extra key.
 *
 * What it checks
 * --------------
 * 1. Every `static Config` schema under `packages/freecodego` is located,
 *    including the form that points at a named schema in another module.
 * 2. Every leaf field it declares is *read* outside the schema block that
 *    declares it:
 *    - a **top-level** field is read when it is referenced as a member
 *      (`.field`, `{ field }`, `'field'`), and
 *    - a **nested** field is read when its access chain is adjacent
 *      (`codex.workerPath`, `config.codex?.workerPath`) — adjacency is what
 *      makes the check discriminating. Without it, `claude.workerPath` would be
 *      "read" by the *codex* read of `.workerPath` and the measured defect would
 *      pass.
 * 3. A field consumed by an intentional whole-object forward (`.args`,
 *    `.environment`) may be exempt, but only by naming the **consumer's type
 *    declaration**, and the guard verifies that declaration actually declares
 *    the field. An exemption is therefore a checkable claim, not a waiver: the
 *    dead `claude.workerPath` could not be exempted, because no type anywhere
 *    declares it.
 * 4. The exemption set equals the dead set exactly — so a stale exemption (for
 *    a field that got a reader, or was deleted) fails too.
 *
 * Honest limits
 * -------------
 * - A nested field whose parent object is forwarded whole and whose child name
 *   is a common word can pass on a coincidental adjacency elsewhere in the
 *   package. The guard is a floor, not a proof.
 * - It reads TypeScript as text. A schema built by composition at runtime would
 *   simply not be seen; there is none today, and a new one would show up here
 *   as "found fewer schemas than expected" rather than as a silent pass.
 *
 * @module scripts/freecodego-config-readers
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FREECODEGO_ROOT = join(REPO_ROOT, 'packages/freecodego')

/**
 * Fields consumed by an intentional whole-object forward rather than by name.
 *
 * The exemption must name the type declaration that declares the field. This is
 * the point of the exercise: an innocent-looking "consumed elsewhere" note
 * cannot be written for a field no consumer type has — which is exactly what
 * `claude.workerPath` was.
 */
const WHOLE_OBJECT_EXEMPTIONS: Readonly<Record<string, {
  readonly reason: string
  readonly consumer: { readonly file: string; readonly type: string }
}>> = {
  'agent-engine-router:codex.args': {
    reason: 'Forwarded whole to openCodexRootRuntime, which joins them into FREECODEGO_CODEX_APP_SERVER_ARGS.',
    consumer: { file: 'packages/freecodego/runtime-codex/src/index.ts', type: 'CodexWorkerLaunchOptions' },
  },
  'agent-engine-router:codex.environment': {
    reason: 'Forwarded whole to openCodexRootRuntime, which spreads it into the worker env.',
    consumer: { file: 'packages/freecodego/runtime-codex/src/index.ts', type: 'CodexWorkerLaunchOptions' },
  },
  'agent-engine-router:claude.environment': {
    reason: 'Forwarded whole to openClaudeRootRuntime, which spreads it into the SDK process env.',
    consumer: { file: 'packages/freecodego/runtime-claude/src/index.ts', type: 'ClaudeRuntimeLaunchOptions' },
  },
  'agent-engine-router:systemPrompts.claude': {
    reason: 'The parent object is forwarded whole as engineSystemPrompts; the factory picks the per-engine entry.',
    consumer: { file: 'packages/freecodego/root-agent/src/factory.ts', type: 'NativeAgentSystemPrompts' },
  },
  'agent-engine-router:systemPrompts.codex': {
    reason: 'The parent object is forwarded whole as engineSystemPrompts; the factory picks the per-engine entry.',
    consumer: { file: 'packages/freecodego/root-agent/src/factory.ts', type: 'NativeAgentSystemPrompts' },
  },
}

/** One `static Config` schema, reduced to the fields it declares. */
interface ConfigSchema {
  /** The FreeCodeGo package that owns the schema — the scope a reader lives in. */
  readonly directory: string
  /** Leaf field paths, nested paths joined with `.`. */
  readonly fields: readonly string[]
  /** The file the schema object itself is written in. */
  readonly declaredIn: string
}

/** Every `.ts`/`.tsx` file below a directory, excluding build output. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/u.test(entry.name)) found.push(path)
    }
  }
  walk(directory)
  return found
}

/** FreeCodeGo package directories that carry sources. */
function packageDirectories(): readonly string[] {
  return readdirSync(FREECODEGO_ROOT)
    .filter(name => statSync(join(FREECODEGO_ROOT, name)).isDirectory())
    .filter(name => statSync(join(FREECODEGO_ROOT, name, 'src'), { throwIfNoEntry: false })?.isDirectory() === true)
    .sort()
}

/**
 * The index just past the comment or string literal starting at `index`, or
 * `index` itself when `index` is ordinary code.
 *
 * Comments have to be skipped before quotes are considered. An apostrophe
 * inside a doc comment (`the user's global .codex directory`) otherwise opens a
 * "string" that swallows the rest of the declaration — which is exactly how an
 * earlier version of this guard silently reported a healthy interface as
 * missing its fields.
 */
function skipNonCode(text: string, index: number): number {
  const char = text[index]
  if (char === '/' && text[index + 1] === '/') {
    const newline = text.indexOf('\n', index)
    return newline === -1 ? text.length : newline + 1
  }
  if (char === '/' && text[index + 1] === '*') {
    const close = text.indexOf('*/', index + 2)
    return close === -1 ? text.length : close + 2
  }
  if (char === '"' || char === "'" || char === '`') {
    let cursor = index + 1
    while (cursor < text.length && text[cursor] !== char) cursor += text[cursor] === '\\' ? 2 : 1
    return cursor + 1
  }
  return index
}

/** The index of the `}` matching the `{` at `open`, skipping comments and strings. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  let index = open
  while (index < text.length) {
    const skipped = skipNonCode(text, index)
    if (skipped !== index) {
      index = skipped
      continue
    }
    const char = text[index]!
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

/**
 * Leaf field paths inside one `z.object({...})` body.
 *
 * An object member with no declared keys (`z.object({})`) counts as a leaf: its
 * value is an opaque record, and its name is the only thing to look for.
 */
function memberPaths(body: string, prefix: string): readonly string[] {
  const leaves: string[] = []
  let index = 0
  let depth = 0
  while (index < body.length) {
    const skipped = skipNonCode(body, index)
    if (skipped !== index) {
      index = skipped
      continue
    }
    const char = body[index]!
    if (char === '(' || char === '[') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' || char === ']') {
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0 && /[A-Za-z_$]/u.test(char)) {
      let end = index
      while (end < body.length && /[\w$]/u.test(body[end]!)) end += 1
      const name = body.slice(index, end)
      let colon = end
      while (colon < body.length && /\s/u.test(body[colon]!)) colon += 1
      if (body[colon] === ':') {
        let value = colon + 1
        while (value < body.length && /\s/u.test(body[value]!)) value += 1
        const path = prefix === '' ? name : `${prefix}.${name}`
        if (body.startsWith('z.object({', value)) {
          const inner = value + 'z.object('.length
          const close = matchBrace(body, inner)
          const nested = memberPaths(body.slice(inner + 1, close), path)
          // An object with no declared keys is an opaque record: its own name is
          // the only field the schema promised.
          leaves.push(...(nested.length === 0 ? [path] : nested))
          index = close + 1
          if (body[index] === ')') index += 1
          continue
        }
        leaves.push(path)
        index = colon + 1
        continue
      }
      index = end
      continue
    }
    index += 1
  }
  return leaves
}

/** The body range of `z.object({...})` starting at or after `from`, if present. */
function objectBodyAt(text: string, from: number): { readonly start: number; readonly end: number } | undefined {
  const marker = text.indexOf('z.object({', from)
  if (marker === -1) return undefined
  const open = marker + 'z.object('.length
  const close = matchBrace(text, open)
  if (close === -1) return undefined
  return { start: open + 1, end: close }
}

/**
 * Locate every `static Config` schema under `packages/freecodego`.
 *
 * Both forms are supported: the inline `z.object({...})` and the reference to a
 * named schema (`static Config = FreeCodeGoConfigSchema`), which is resolved to
 * its defining module so the fields, not the alias, are what gets checked.
 */
function configSchemas(): readonly ConfigSchema[] {
  const schemas: ConfigSchema[] = []
  for (const directory of packageDirectories()) {
    const files = sourceFiles(join(FREECODEGO_ROOT, directory, 'src'))
    const texts = new Map(files.map(path => [path, readFileSync(path, 'utf8')]))
    for (const [path, text] of texts) {
      const declaration = /static\s+Config\b[^\n]*?=\s*([^\n]+)/u.exec(text)
      if (declaration === null) continue
      const value = declaration[1]!.trim()
      let schemaText = text
      let schemaPath = path
      // Where to start looking for the schema object: after the alias itself for
      // the inline form, or after the definition for the named form. Starting at
      // 0 would pick up an unrelated `z.object` earlier in the module.
      let searchFrom = declaration.index
      if (!value.startsWith('z.object(')) {
        const identifier = /^[A-Za-z_$][\w$]*/u.exec(value)?.[0]
        if (identifier === undefined) continue
        const definition = new RegExp(`const\\s+${identifier}\\b[^\\n]*=\\s*z\\.object\\(\\{`, 'u')
        const owner = [...texts.entries()].find(([, candidate]) => definition.test(candidate))
        if (owner === undefined) continue
        schemaText = owner[1]
        schemaPath = owner[0]
        searchFrom = definition.exec(schemaText)!.index
      }
      const body = objectBodyAt(schemaText, searchFrom)
      if (body === undefined) continue
      schemas.push({
        directory,
        fields: memberPaths(schemaText.slice(body.start, body.end), ''),
        declaredIn: relative(REPO_ROOT, schemaPath).replace(/\\/gu, '/'),
      })
    }
  }
  return schemas
}

/** Whether a top-level field name is referenced as a member anywhere in the text. */
function topLevelReader(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:\\.\\s*${escaped}\\b|[{,]\\s*${escaped}\\s*[,}:=]|['"\`]${escaped}['"\`])`, 'u').test(text)
}

/**
 * Whether a nested field has an adjacent access chain.
 *
 * Adjacency is the whole point: `config.codex.workerPath` reads codex's field
 * and must not count as a reader of `claude.workerPath`, which is the defect
 * this guard exists for.
 */
function nestedReader(text: string, path: string): boolean {
  const [parent, ...rest] = path.split('.')
  const escapedParent = parent!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const tail = rest.map(segment => `\\.\\s*${segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`).join('')
  return new RegExp(`\\b${escapedParent}\\b[^;\\n{}]{0,120}?${tail}`, 'u').test(text)
}

/**
 * Whether a named type declaration in a file declares the given field.
 *
 * Both shapes count: an `interface` (brace body) and a `type` alias (its own
 * statement, which is where the engine unions live).
 */
function consumerDeclaresField(file: string, type: string, field: string): boolean {
  const path = join(REPO_ROOT, file)
  if (statSync(path, { throwIfNoEntry: false }) === undefined) return false
  const text = readFileSync(path, 'utf8')
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const declaration = new RegExp(`(?:interface|type)\\s+${escapedType}\\b`, 'u').exec(text)
  if (declaration === null) return false
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const open = text.indexOf('{', declaration.index)
  const isInterface = /^interface\b/u.test(text.slice(declaration.index).trimStart())
  let scope: string | undefined
  if (isInterface && open !== -1) {
    const close = matchBrace(text, open)
    if (close !== -1) scope = text.slice(open, close)
  } else {
    // A type alias ends at the blank line after it; that covers both the
    // single-line `Partial<Record<...>>` and a wrapped union.
    const end = text.indexOf('\n\n', declaration.index)
    scope = text.slice(declaration.index, end === -1 ? undefined : end)
  }
  return scope !== undefined && new RegExp(`\\b${escapedField}\\b`, 'u').test(scope)
}

describe('FreeCodeGo config fields', () => {
  const schemas = configSchemas()
  const byPackage = packageDirectories().map(directory => ({
    directory,
    fields: schemas
      .filter(schema => schema.directory === directory)
      .flatMap(schema => schema.fields.map(field => `${directory}:${field}`)),
  }))

  it('finds the schemas to guard, so an empty scan cannot pass silently', () => {
    // Two today: the engine router's inline schema and the plugin's named one.
    expect(schemas.length).toBeGreaterThanOrEqual(2)
    expect(schemas.map(schema => schema.declaredIn).sort()).toEqual([
      'packages/freecodego/agent-engine-router/src/index.ts',
      'packages/freecodego/harness-plugin/src/plugin-config.ts',
    ])
    expect(byPackage.find(entry => entry.directory === 'agent-engine-router')!.fields)
      .toContain('agent-engine-router:codex.workerPath')
    // Nested members are reached, not just top-level keys: a schema whose
    // sub-object were skipped would look complete while checking only `gateway`.
    expect(byPackage.find(entry => entry.directory === 'harness-plugin')!.fields)
      .toContain('harness-plugin:gateway.baseUrl')
    // Every other package owns no schema, so it contributes no fields. An
    // earlier version attributed every schema to every package, which meant a
    // field could be "read" by coincidence in an unrelated package.
    expect(byPackage.filter(entry => entry.fields.length > 0).map(entry => entry.directory))
      .toEqual(['agent-engine-router', 'harness-plugin'])
    expect(relative(REPO_ROOT, schemas[0]!.declaredIn).startsWith('packages')).toBe(true)
  })

  it('reads every leaf field the schemas declare', () => {
    const dead: string[] = []
    for (const entry of byPackage) {
      const texts = sourceFiles(join(FREECODEGO_ROOT, entry.directory, 'src'))
        .map(path => readFileSync(path, 'utf8'))
      for (const key of entry.fields) {
        const field = key.slice(entry.directory.length + 1)
        const read = field.includes('.')
          ? texts.some(text => nestedReader(text, field))
          : texts.some(text => topLevelReader(text, field))
        if (!read) dead.push(key)
      }
    }
    // Sorted on both sides: the point is *which* fields are dead, not the order
    // a directory walk happened to produce.
    expect(dead.sort()).toStrictEqual(Object.keys(WHOLE_OBJECT_EXEMPTIONS).sort())
  })

  it('accepts an exemption only when the consumer type really declares the field', () => {
    const unverifiable = Object.entries(WHOLE_OBJECT_EXEMPTIONS)
      .filter(([key, exemption]) => {
        const field = key.slice(key.indexOf(':') + 1)
        const leaf = field.split('.').at(-1)!
        return exemption.reason.trim() === ''
          || !consumerDeclaresField(exemption.consumer.file, exemption.consumer.type, leaf)
      })
      .map(([key]) => key)
    // This is what makes the exemption table a claim rather than a waiver: the
    // dead `claude.workerPath` had no type that declared it, so no entry could
    // have been written for it.
    expect(unverifiable).toStrictEqual([])
  })

  it('keeps the guarded package list honest', () => {
    // A package that gains a `static Config` must appear in the scan above; this
    // pins the scan itself rather than any one field.
    expect(packageDirectories().length).toBeGreaterThanOrEqual(9)
    expect(relative(REPO_ROOT, FREECODEGO_ROOT).replace(/\\/gu, '/')).toBe('packages/freecodego')
  })
})
