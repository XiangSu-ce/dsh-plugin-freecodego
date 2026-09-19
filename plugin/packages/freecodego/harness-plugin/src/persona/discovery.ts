/**
 * Where personas come from, and which one wins.
 *
 * Precedence, most specific first: inline `settings.personas` > project
 * `<workspace>/.freecodego/personas/*.toml` > user
 * `$DSH_HOME/freecodego/personas/*.toml` > bundled (read only). The project tier
 * is gated on folder trust (G1) — an untrusted checkout's persona files are not
 * opened at all, not merely ignored after parsing, because a persona is
 * instructions the child will follow.
 *
 * The TOML decision, stated plainly
 * --------------------------------
 * This package has no TOML dependency, and hand-rolling a general TOML parser
 * to read five scalar fields would be a bug farm with a security surface. So
 * `parseTomlSubset` accepts a **documented subset** — comments, `[section]`
 * headers, and `key = value` for strings, booleans, integers, and arrays of
 * strings — and **refuses the whole file**, naming the line, for anything else.
 *
 * That choice is the point: the alternative, parsing what it recognizes and
 * ignoring the rest, would silently drop a persona's `default_isolation` line
 * written as an unterminated string, and the child would run without isolation
 * while every log said the persona loaded. Refusing is louder and correct.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/persona/discovery
 */

import { redactCredentialShapes } from '../secret-scan.ts'
import { PERSONA_SOURCE_PRECEDENCE, normalizePersona, type PersonaDefinition, type PersonaIssue, type PersonaSource } from './contract.ts'

/** One file the discovery pass considered. */
export interface PersonaFile {
  /** Absolute path, or a synthetic path for inline entries. */
  readonly path: string
  readonly source: PersonaSource
  readonly contents: string
}

/** The result of discovering personas across every source. */
export interface PersonaDiscovery {
  /** Effective personas by name, most specific source winning. */
  readonly personas: readonly PersonaDefinition[]
  /** Names that appear in more than one source, with the sources, most specific first. */
  readonly shadowed: readonly { readonly name: string; readonly sources: readonly PersonaSource[] }[]
  readonly issues: readonly PersonaIssue[]
}

/** A refusal from the TOML subset parser. */
export interface TomlParseIssue {
  readonly line: number
  readonly reason: string
}

/** The subset parser's result. */
export type TomlSubsetResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issue: TomlParseIssue }

/** Strip a trailing `# comment` that is not inside a string. */
function stripComment(line: string): string {
  let inString = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') inString = !inString
    if (character === '#' && !inString) return line.slice(0, index)
  }
  return line
}

/**
 * Expand the escapes this subset defines, in one pass.
 *
 * One pass rather than a chain of replacements, because the chain's order decides
 * the answer: expanding `\n` before collapsing `\\` reads the `\\n` of `\\notes` as a
 * newline, so an author's `C:\\notes\\style.md` arrives with a line break inside it
 * — a path that names nothing, refused later for a reason unrelated to what was
 * typed. A single pass also gives an escape this subset does not define a stated
 * answer: it stays as written, rather than being silently eaten.
 * @param body - the text between the quotes, as the file wrote it.
 * @returns the decoded value.
 */
function unescapeSubsetString(body: string): string {
  return body.replace(/\\([\s\S])/gu, (match, escaped: string) => {
    if (escaped === 'n') return '\n'
    if (escaped === '"') return '"'
    if (escaped === '\\') return '\\'
    return match
  })
}

/** Parse one TOML value from the subset, or refuse it. */
function parseTomlValue(text: string, line: number): { readonly value: unknown } | { readonly issue: TomlParseIssue } {
  const trimmed = text.trim()
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      return { issue: { line, reason: 'unterminated string' } }
    }
    return { value: unescapeSubsetString(trimmed.slice(1, -1)) }
  }
  if (trimmed === 'true') return { value: true }
  if (trimmed === 'false') return { value: false }
  if (/^-?\d+$/.test(trimmed)) return { value: Number.parseInt(trimmed, 10) }
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) return { issue: { line, reason: 'unterminated array' } }
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return { value: [] }
    const parts = inner.split(',').map(part => part.trim()).filter(part => part !== '')
    const items: unknown[] = []
    for (const part of parts) {
      const item = parseTomlValue(part, line)
      if ('issue' in item) return item
      if (typeof item.value === 'object') {
        return { issue: { line, reason: 'nested arrays and inline tables are not supported; use JSON for this persona' } }
      }
      items.push(item.value)
    }
    return { value: items }
  }
  if (trimmed.startsWith('{')) {
    return { issue: { line, reason: 'inline tables are not supported; use JSON for this persona' } }
  }
  if (trimmed === '') return { issue: { line, reason: 'missing value' } }
  return { issue: { line, reason: `unsupported value ${JSON.stringify(trimmed)}; quote it, or use JSON for this persona` } }
}

/**
 * Parse the documented TOML subset.
 * @param text - file contents.
 * @returns the parsed record, or the first construct outside the subset.
 */
export function parseTomlSubset(text: string): TomlSubsetResult {
  const value: Record<string, unknown> = {}
  let section: Record<string, unknown> = value
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const withoutComment = stripComment(lines[index]!).trim()
    if (withoutComment === '') continue
    if (withoutComment.startsWith('[[')) {
      return { ok: false, issue: { line: lineNumber, reason: 'arrays of tables are not supported; use JSON for this persona' } }
    }
    if (withoutComment.startsWith('[')) {
      if (!withoutComment.endsWith(']')) return { ok: false, issue: { line: lineNumber, reason: 'unterminated section header' } }
      const name = withoutComment.slice(1, -1).trim()
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        return { ok: false, issue: { line: lineNumber, reason: `unsupported section name ${JSON.stringify(name)}` } }
      }
      // Refused rather than merged: a second `[section]` header would silently
      // discard the first one's keys, and a parser that drops declarations without
      // saying so is the shape this subset exists to avoid.
      if (Object.hasOwn(value, name)) {
        return { ok: false, issue: { line: lineNumber, reason: `section [${name}] is declared twice` } }
      }
      const nested: Record<string, unknown> = {}
      value[name] = nested
      section = nested
      continue
    }
    const equals = withoutComment.indexOf('=')
    if (equals <= 0) {
      return { ok: false, issue: { line: lineNumber, reason: 'expected `key = value`' } }
    }
    const key = withoutComment.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      return { ok: false, issue: { line: lineNumber, reason: `unsupported key ${JSON.stringify(key)}` } }
    }
    // Same rule: the first of a duplicated pair would otherwise vanish, with no
    // refusal anywhere to say that it had been read and thrown away.
    if (Object.hasOwn(section, key)) {
      return { ok: false, issue: { line: lineNumber, reason: `key ${JSON.stringify(key)} is declared twice` } }
    }
    const parsed = parseTomlValue(withoutComment.slice(equals + 1), lineNumber)
    if ('issue' in parsed) return { ok: false, issue: parsed.issue }
    section[key] = parsed.value
  }
  return { ok: true, value }
}

/**
 * Parse one persona file, choosing a parser by extension.
 *
 * `.json` and `.toml` are both accepted; anything else is refused by name so a
 * persona written in YAML is not silently absent from the roster.
 * @param file - the file to parse.
 * @returns the persona, or the issue that refused it.
 */
export function parsePersonaFile(file: PersonaFile): { readonly persona: PersonaDefinition } | { readonly issue: PersonaIssue } {
  const extension = file.path.split('.').pop()?.toLowerCase()
  const name = fileNameStem(file.path)
  if (file.path.startsWith('inline:')) {
    const raw = parseJsonRecord(file.contents)
    if ('issue' in raw) return { issue: { path: file.path, reason: raw.issue } }
    return normalizePersona(raw.value, name, file.source, file.path)
  }
  if (extension === 'json') {
    const raw = parseJsonRecord(file.contents)
    if ('issue' in raw) return { issue: { path: file.path, reason: raw.issue } }
    return normalizePersona(raw.value, name, file.source, file.path)
  }
  if (extension === 'toml') {
    const parsed = parseTomlSubset(file.contents)
    if (!parsed.ok) {
      return { issue: { path: file.path, reason: `line ${parsed.issue.line}: ${parsed.issue.reason}` } }
    }
    return normalizePersona(parsed.value, name, file.source, file.path)
  }
  return { issue: { path: file.path, reason: `unsupported persona format ".${extension ?? ''}" — use .toml or .json` } }
}

/** The persona name a file path implies. */
function fileNameStem(path: string): string {
  const base = path.startsWith('inline:') ? path.slice('inline:'.length) : path.replace(/\\/g, '/').split('/').pop() ?? path
  return base.replace(/\.(toml|json)$/i, '')
}

/** Parse a JSON object, refusing anything that is not one. */
function parseJsonRecord(contents: string): { readonly value: Record<string, unknown> } | { readonly issue: string } {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { issue: 'a persona document must be an object' }
    }
    return { value: parsed as Record<string, unknown> }
  } catch (error) {
    // Masked: a persona document is distributed content — the community tier
    // installs it. The parse error quotes at most the first ten characters, so
    // this covers a short value rather than a prefixed key.
    return { issue: `not valid JSON: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}` }
  }
}

/**
 * Discover the effective persona roster.
 *
 * Precedence is resolved by *name*, most specific source winning, and every
 * shadowed name is reported. A shadowed persona is not an error — that is how a
 * project overrides a user default — but it is not silent either, because a
 * user wondering why their edits did nothing deserves the answer.
 * @param files - every candidate file, in any order; precedence comes from the source.
 * @param options - `projectTrusted` gates the project tier.
 * @returns the effective roster, shadowing report, and every refusal.
 */
export function discoverPersonas(
  files: readonly PersonaFile[],
  options: { readonly projectTrusted: boolean },
): PersonaDiscovery {
  const issues: PersonaIssue[] = []
  const bySource = new Map<PersonaSource, Map<string, { readonly persona: PersonaDefinition; readonly path: string }>>()
  for (const file of files) {
    if (file.source === 'project' && !options.projectTrusted) {
      // Not parsed, let alone applied: an untrusted checkout's instructions are
      // instructions, and this is the gate that keeps them out.
      issues.push({ path: file.path, reason: 'project persona files are not read until the folder is trusted' })
      continue
    }
    const parsed = parsePersonaFile(file)
    if ('issue' in parsed) {
      issues.push(parsed.issue)
      continue
    }
    const bucket = bySource.get(file.source) ?? new Map<string, { readonly persona: PersonaDefinition; readonly path: string }>()
    // Two files in *one* tier claiming the same name: the later one is loaded and
    // the earlier contributes nothing. Reported for the same reason a cross-tier
    // shadow is — the useful answer to "why did my edit do nothing" is which file
    // won — and this case is easier to hit, since two files in one directory can
    // declare the same `name` outright.
    const previous = bucket.get(parsed.persona.name)
    if (previous !== undefined) {
      issues.push({
        path: previous.path,
        reason: `persona "${parsed.persona.name}" is declared by ${file.path} too, which is the one loaded; this file contributes nothing`,
      })
    }
    bucket.set(parsed.persona.name, { persona: parsed.persona, path: file.path })
    bySource.set(file.source, bucket)
  }

  const effective = new Map<string, PersonaDefinition>()
  const shadowed: { name: string; sources: PersonaSource[] }[] = []
  for (const source of PERSONA_SOURCE_PRECEDENCE) {
    const bucket = bySource.get(source)
    if (bucket === undefined) continue
    for (const [name, entry] of bucket) {
      const persona = entry.persona
      const existing = effective.get(name)
      if (existing === undefined) {
        effective.set(name, persona)
        continue
      }
      const record = shadowed.find(entry => entry.name === name)
      if (record === undefined) shadowed.push({ name, sources: [existing.source, source] })
      else record.sources.push(source)
    }
  }
  return { personas: [...effective.values()], shadowed, issues }
}
