/**
 * Lightweight repository map — a zero-dependency take on aider's Repomap
 * (https://aider.chat/docs/repomap.html, Apache-2.0): extract identifier
 * definitions and references from source files, build a weighted
 * file↔identifier reference graph, rank it with PageRank, and render the
 * highest-ranked definitions (with signatures) within a token budget.
 *
 * Where Graphify gives a deep (but Python-installed) whole-repo graph, this
 * module gives an instant, always-available structural summary for every
 * language family in {@link LANGUAGE_BY_EXTENSION}, so a session-start map is
 * never gated on a runtime install.
 *
 * Relationship to aider, stated honestly: aider ranks a tree-sitter-derived
 * symbol graph; this module ranks a line-pattern-derived one. Both use weighted
 * PageRank (damping 0.85, 20 iterations), a chat-focus multiplier, and a
 * binary-searched token budget, so the *ranking and budget* behaviour matches.
 * The difference is extraction precision — see the module notes on
 * {@link extractDefinitions} for the exact surface each family covers.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-repo-map
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import path from 'node:path'

import { tokensFromChars } from './token-estimate.ts'

/** One ranked entry of the rendered map. */
export interface RepoMapEntry {
  readonly file: string
  readonly identifier: string
  readonly kind: 'function' | 'class' | 'method' | 'const' | 'type' | 'definition'
  readonly signature?: string
  readonly rank: number
  readonly references: number
}

/** A workspace's ranked repository map, plus what the scan could not read. */
export interface RepoMapResult {
  readonly projectId: string
  readonly filesScanned: number
  readonly tokensEstimate: number
  readonly map: readonly RepoMapEntry[]
  readonly graphSummary: string
  /** True when the token budget cut the ranked list, so the tail is ranked but unshown. */
  readonly truncated: boolean
  /** What the scan could not read, so `filesScanned` is not read as the workspace. */
  readonly unscanned: RepoMapUnscanned
}

/**
 * Source files a map was built without, and why.
 *
 * Every one of these was previously silent, and silence is what makes the map
 * unusable as a claim about a workspace: `filesScanned` counts what the map is
 * *built from*, so a map that omits the largest module is indistinguishable from a
 * workspace that has none. `unreached` is the sharper half — a cap that ends the
 * walk means the tail was never even located, so no count of skipped files can stand
 * in for it.
 */
export interface RepoMapUnscanned {
  /** Files the walk located and skipped for size ({@link MAX_FILE_BYTES}). */
  readonly oversized: number
  /** Located files that could not be read at all. */
  readonly unreadable: number
  /** True when a walk cap ended the enumeration before the whole workspace was seen. */
  readonly unreached: boolean
  /** Up to {@link UNSCANNED_EXAMPLES} of the omitted paths, for a caller that has to act. */
  readonly examples: readonly string[]
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache',
  'lib', 'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
])

/**
 * Definition-extraction families. aider's Repomap drives extraction through
 * tree-sitter grammars for 30+ languages; this port stays zero-dependency (a
 * native grammar toolchain would need a new `allowBuilds` entry and a WASM
 * runtime) and instead pairs a widened extension table with per-family
 * patterns below. The practical rule that keeps the gap honest: every language
 * listed here must contribute real *definitions*, never references only.
 */
type Language =
  | 'ts' | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'scala' | 'csharp' | 'swift'
  | 'c' | 'cpp' | 'ruby' | 'php' | 'lua' | 'r' | 'julia' | 'perl' | 'elixir' | 'erlang'
  | 'dart' | 'zig' | 'hcl' | 'proto' | 'sql' | 'graphql' | 'shell'

const LANGUAGE_BY_EXTENSION = new Map<string, Language>([
  // JavaScript / TypeScript family (also the single-file component formats).
  ['.ts', 'ts'], ['.tsx', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'],
  ['.js', 'ts'], ['.jsx', 'ts'], ['.mjs', 'ts'], ['.cjs', 'ts'],
  ['.vue', 'ts'], ['.svelte', 'ts'], ['.astro', 'ts'],
  // Python
  ['.py', 'python'], ['.pyi', 'python'],
  // Go
  ['.go', 'go'],
  // Rust
  ['.rs', 'rust'],
  // JVM family
  ['.java', 'java'], ['.kt', 'kotlin'], ['.kts', 'kotlin'], ['.scala', 'scala'],
  // C family
  ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cxx', 'cpp'],
  ['.hpp', 'cpp'], ['.hh', 'cpp'],
  ['.cs', 'csharp'], ['.swift', 'swift'],
  // Scripting
  ['.rb', 'ruby'], ['.php', 'php'], ['.lua', 'lua'], ['.r', 'r'], ['.jl', 'julia'],
  ['.pl', 'perl'], ['.pm', 'perl'], ['.ex', 'elixir'], ['.exs', 'elixir'], ['.erl', 'erlang'],
  // Other declaration-style languages
  ['.dart', 'dart'], ['.zig', 'zig'], ['.tf', 'hcl'], ['.proto', 'proto'],
  ['.sql', 'sql'], ['.graphql', 'graphql'],
  // Shell
  ['.sh', 'shell'], ['.bash', 'shell'], ['.zsh', 'shell'], ['.fish', 'shell'],
])

const SOURCE_EXTENSIONS = new Set(LANGUAGE_BY_EXTENSION.keys())

/**
 * The per-file bound, applied by the walk that finds the files.
 *
 * It used to be paired with a *smaller* extraction cap (256 KB), and a file between
 * the two was located by one and refused by the other: nothing read it. That dead
 * zone silently cost this package its own largest module, `src/index.ts`, from its
 * own repository map — while the map still looked like the whole workspace. The
 * walk's caps are what bound the work ({@link MAX_TOTAL_BYTES} bounds the bytes any
 * one map reads), so a second, lower per-file cap bought nothing and cost the
 * largest real modules.
 */
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 4_000
const MAX_TOTAL_BYTES = 48 * 1024 * 1024

/** How many omitted paths a result names before it only counts the rest. */
const UNSCANNED_EXAMPLES = 5

// ─── Definition extraction ──────────────────────────────────────────────────

interface Definition {
  readonly identifier: string
  readonly kind: RepoMapEntry['kind']
  readonly signature: string | undefined
}

const DTS_OR_MIN = /[.-]min\.|\.d\.ts$/u

/** Names that are control-flow keywords in some family and must never be
 * reported as a method/definition, whichever pattern happened to match. */
const NON_DEFINITION_NAMES: ReadonlySet<string> = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'do', 'else', 'case',
  'typeof', 'instanceof', 'await', 'yield', 'throw', 'delete', 'in', 'of', 'with',
  'elif', 'unless', 'when', 'match', 'range', 'select', 'default',
])

/** Comment-only lines are never declarations in any supported family. */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    || trimmed.startsWith('#') || trimmed.startsWith('--') || trimmed.startsWith('%')
}

/**
 * Line-oriented definition extraction, dispatched by the extension's language
 * family. Each family keeps its own ordered pattern list because ordering is
 * load-bearing: TypeScript must test the arrow-function form before the generic
 * `const` form, or `export const handler = () => {}` degrades from `function`
 * to `const` and loses its signature.
 *
 * Extraction is deliberately a *definition surface*: it reports what a file
 * declares, ranked by how the rest of the workspace references it. It is not a
 * parser and does not attempt to resolve types, macros, or generated names.
 * @param content - the file's source text.
 * @param extension - the file extension that selects the language.
 * @returns the definition rows, in backend order.
 */
export function extractDefinitions(content: string, extension: string): readonly Definition[] {
  const language = LANGUAGE_BY_EXTENSION.get(extension.toLowerCase())
  if (language === undefined) return []
  const definitions: Definition[] = []
  const lines = content.split('\n')
  const limit = Math.min(lines.length, 4_000)
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed === '' || isCommentLine(trimmed)) continue
    for (const definition of matchDefinitions(language, line, trimmed)) definitions.push(definition)
  }
  return definitions
}

/** The indentation of a line, used to separate top-level declarations (and
 * therefore `function` vs `method`) in the indentation-significant families. */
function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].replaceAll('\t', '    ').length
}

/** One ordered pattern list per language, each returning zero or more definitions. */
function matchDefinitions(language: Language, line: string, trimmed: string): readonly Definition[] {
  const signature = signatureOf(line)
  const define = (identifier: string, kind: Definition['kind'], hasSignature = true): readonly Definition[] =>
    NON_DEFINITION_NAMES.has(identifier) ? [] : [{ identifier, kind, signature: hasSignature ? signature : undefined }]
  let match: RegExpExecArray | null

  switch (language) {
    // ── JavaScript / TypeScript (+ single-file component formats) ───────────
    case 'ts': {
      if ((match = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'class')
      // Arrow / function-expression bindings must precede the plain const rule.
      if ((match = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*\*?|\([^)]*\)|\w+)\s*(?:=>|\{)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/u.exec(trimmed)) !== null) return define(match[1]!, 'const', false)
      if ((match = /^(?:export\s+)?(?:declare\s+)?(?:type|interface|enum|namespace|module)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      // Indented class body member. `constructor` is intentionally admitted:
      // it is a real, rankable member on the class it belongs to.
      if (indentOf(line) > 0 && (match = /^(?:public|private|protected|readonly|static|async|override|abstract|declare|get|set|\s)*([A-Za-z_$][\w$]*)\s*[(<]/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'method')
      }
      return []
    }

    // ── Python ─────────────────────────────────────────────────────────────
    case 'python': {
      if ((match = /^(?:async\s+)?def\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      if ((match = /^class\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'class')
      return []
    }

    // ── Go ─────────────────────────────────────────────────────────────────
    case 'go': {
      // Receivers make `func (r *T) M()` a method rather than a free function.
      if ((match = /^func\s+(?:\([^)]*\*?\s*(\w+)\s*\)\s*)?(\w+)/u.exec(trimmed)) !== null) {
        return define(match[2]!, match[1] === undefined ? 'function' : 'method')
      }
      if ((match = /^type\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      return []
    }

    // ── Rust ───────────────────────────────────────────────────────────────
    case 'rust': {
      if ((match = /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      if ((match = /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^(?:pub\s+)?impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      return []
    }

    // ── Java ───────────────────────────────────────────────────────────────
    case 'java': {
      if ((match = /^(?:public\s+|private\s+|protected\s+)?(?:final\s+|abstract\s+|static\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'class')
      }
      if (indentOf(line) > 0 && (match = /^(?:public|private|protected)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+|default\s+)*[\w<>\[\],.?\s]+\s+(\w+)\s*\(/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'method')
      }
      return []
    }

    // ── Kotlin ─────────────────────────────────────────────────────────────
    case 'kotlin': {
      if ((match = /^(?:(?:public|private|internal|protected|open|override|suspend|inline|abstract|sealed|data|enum|annotation|value)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      if ((match = /^(?:(?:public|private|internal|open|abstract|sealed|data|enum|annotation|value|inner)\s+)*(?:class|interface|object)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'class')
      }
      if (indentOf(line) === 0 && (match = /^(?:(?:private|public|internal|const|lateinit)\s+)*(?:val|var)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'const', false)
      }
      return []
    }

    // ── Scala ──────────────────────────────────────────────────────────────
    case 'scala': {
      if ((match = /^(?:(?:private|protected|override|implicit|final|lazy)\s+)*(?:def)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      if ((match = /^(?:(?:private|protected|sealed|abstract|final|implicit|case)\s+)*(?:class|object|trait|enum)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'class')
      }
      if ((match = /^(?:(?:private|protected|implicit|lazy|final)\s+)*(?:val|var)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'const', false)
      }
      return []
    }

    // ── C / C++ ────────────────────────────────────────────────────────────
    case 'c':
    case 'cpp': {
      if (language === 'cpp') {
        if ((match = /^(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum(?:\s+class)?|namespace)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      } else if ((match = /^(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'type')
      }
      if ((match = /^typedef\s+.*?\(\s*\*\s*(\w+)\s*\)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^typedef\s+[^;]*?\b(\w+)\s*;/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      // A function *definition* ends in `{` (or is a K&R header); prototypes end in `;`.
      if (!trimmed.endsWith(';') && (match = /^(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|virtual\s+|explicit\s+|friend\s+)*[\w:<>*&,\s]+\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?::[^{]*)?\{?\s*$/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      return []
    }

    // ── C# ─────────────────────────────────────────────────────────────────
    case 'csharp': {
      if ((match = /^(?:(?:public|private|protected|internal|sealed|abstract|static|partial|readonly|ref|record)\s+)*(?:class|interface|struct|enum|record|delegate)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'class')
      }
      if (indentOf(line) > 0 && (match = /^(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|abstract\s+|async\s+|sealed\s+|partial\s+|new\s+|extern\s+)*[\w<>\[\],.?\s]+\s+(\w+)\s*\(/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'method')
      }
      return []
    }

    // ── Swift ──────────────────────────────────────────────────────────────
    case 'swift': {
      if ((match = /^(?:(?:public|private|internal|fileprivate|open|final|static|class|mutating|override|required|convenience|@\w+)\s+)*func\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      if ((match = /^(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'class')
      }
      if (indentOf(line) === 0 && (match = /^(?:(?:public|private|internal|fileprivate|let|var)\s+)*(?:let|var)\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, 'const', false)
      }
      return []
    }

    // ── Ruby ───────────────────────────────────────────────────────────────
    case 'ruby': {
      if ((match = /^def\s+(?:self\.)?([\w?!=]+)/u.exec(trimmed)) !== null) return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      if ((match = /^(?:class|module)\s+([A-Z]\w*)/u.exec(trimmed)) !== null) return define(match[1]!, 'class')
      if (indentOf(line) === 0 && (match = /^([A-Z_][A-Z0-9_]*)\s*=/u.exec(trimmed)) !== null) return define(match[1]!, 'const', false)
      return []
    }

    // ── PHP ────────────────────────────────────────────────────────────────
    case 'php': {
      if ((match = /^(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+(\w+)/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      if ((match = /^(?:final\s+|abstract\s+)*(?:class|interface|trait|enum)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'class')
      return []
    }

    // ── Lua ────────────────────────────────────────────────────────────────
    case 'lua': {
      if ((match = /^local\s+function\s+([\w.:]+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^function\s+([\w.:]+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      return []
    }

    // ── R ──────────────────────────────────────────────────────────────────
    case 'r': {
      if ((match = /^([\w.]+)\s*(?:<-|=)\s*function/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      return []
    }

    // ── Julia ──────────────────────────────────────────────────────────────
    case 'julia': {
      if ((match = /^(?:function|macro)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^(?:mutable\s+)?(?:struct|abstract\s+type|primitive\s+type|module)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^([\w!]+)\s*\([^)]*\)\s*=/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      return []
    }

    // ── Perl ───────────────────────────────────────────────────────────────
    case 'perl': {
      if ((match = /^sub\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^package\s+([\w:]+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      return []
    }

    // ── Elixir ─────────────────────────────────────────────────────────────
    case 'elixir': {
      if ((match = /^def(?:p|macro|macrop)?\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      if ((match = /^defmodule\s+([\w.]+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^defstruct\b/u.exec(trimmed)) !== null) return []
      return []
    }

    // ── Erlang ─────────────────────────────────────────────────────────────
    case 'erlang': {
      if ((match = /^([a-z]\w*)\s*\([^)]*\)\s*(?:when[^-]*)?->/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^-(?:module|record)\s*\(\s*(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      return []
    }

    // ── Dart ───────────────────────────────────────────────────────────────
    case 'dart': {
      if ((match = /^(?:abstract\s+|final\s+|sealed\s+|base\s+|mixin\s+)*(?:class|mixin|enum|extension)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'class')
      if ((match = /^(?:[\w<>?,\s]+\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^;]*\)\s*(?:async\s*)?\{/u.exec(trimmed)) !== null) {
        return define(match[1]!, indentOf(line) > 0 ? 'method' : 'function')
      }
      return []
    }

    // ── Zig ────────────────────────────────────────────────────────────────
    case 'zig': {
      if ((match = /^(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^(?:pub\s+)?const\s+(\w+)\s*=\s*(?:struct|enum|union|opaque)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^(?:pub\s+)?const\s+(\w+)\s*=/u.exec(trimmed)) !== null) return define(match[1]!, 'const', false)
      return []
    }

    // ── Terraform / HCL ────────────────────────────────────────────────────
    case 'hcl': {
      if ((match = /^(?:resource|data|module|variable|output|provider|terraform|locals|moved|import)\s+"?([\w.-]+)"?(?:\s+"([\w.-]+)")?/u.exec(trimmed)) !== null) {
        const identifier = match[2] ?? match[1]!
        return define(identifier, 'definition')
      }
      return []
    }

    // ── Protocol Buffers ───────────────────────────────────────────────────
    case 'proto': {
      if ((match = /^(?:message|enum|service|extend)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^rpc\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'method')
      return []
    }

    // ── SQL ────────────────────────────────────────────────────────────────
    case 'sql': {
      if ((match = /^create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index|trigger|type|schema|sequence|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)/iu.exec(trimmed)) !== null) {
        return define(match[1]!, 'definition')
      }
      return []
    }

    // ── GraphQL ────────────────────────────────────────────────────────────
    case 'graphql': {
      if ((match = /^(?:type|input|enum|interface|union|scalar)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'type')
      if ((match = /^(?:query|mutation|subscription|fragment)\s+(\w+)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      return []
    }

    // ── Shell ──────────────────────────────────────────────────────────────
    case 'shell': {
      if ((match = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      if ((match = /^function\s+([A-Za-z_]\w*)/u.exec(trimmed)) !== null) return define(match[1]!, 'function')
      return []
    }
  }
}

function signatureOf(line: string): string {
  return line.trim().replace(/\s*\{\s*$/, '').slice(0, 160)
}

/** Identifier candidates used as graph references: words not obviously keywords. */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'return', 'const', 'let', 'var', 'function', 'class',
  'import', 'export', 'from', 'default', 'new', 'this', 'super', 'extends', 'implements',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'interface',
  'type', 'enum', 'public', 'private', 'protected', 'static', 'readonly', 'true', 'false',
  'null', 'undefined', 'void', 'never', 'unknown', 'any', 'string', 'number', 'boolean',
  'switch', 'case', 'break', 'continue', 'delete', 'in', 'of', 'as', 'yield', 'def',
  'self', 'None', 'True', 'False', 'elif', 'not', 'and', 'or', 'pass', 'raise', 'with',
])

function referenceTokens(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  const pattern = /[A-Za-z_$][\w$]{2,}/gu
  let match: RegExpExecArray | null
  let iterations = 0
  while ((match = pattern.exec(content)) !== null && iterations < 40_000) {
    iterations += 1
    const token = match[0]
    if (KEYWORDS.has(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

// ─── PageRank ───────────────────────────────────────────────────────────────

/**
 * Weighted PageRank over the reference graph. `nodes` maps identifier →
 * defining file; `edges[node]` maps (referencing file) weight contributions.
 * Following aider: file→identifier edges weigh per reference, identifier→file
 * edges point at the definition, and damping 0.85 with ~20 iterations is
 * plenty at this graph size.
 * @param nodes - the graph's identifiers.
 * @param edges - each identifier's reference weights.
 * @param damping - the damping factor.
 * @param iterations - the number of power iterations to run.
 * @returns each identifier's rank.
 */
export function pagerank(nodes: readonly string[], edges: Map<string, Map<string, number>>, damping = 0.85, iterations = 20): Map<string, number> {
  const rank = new Map<string, number>()
  if (nodes.length === 0) return rank
  const uniform = 1 / nodes.length
  for (const node of nodes) rank.set(node, uniform)
  const outgoing = new Map<string, number>()
  for (const [source, targets] of edges) {
    let total = 0
    for (const weight of targets.values()) total += weight
    if (total > 0) outgoing.set(source, total)
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map<string, number>()
    let dangling = 0
    for (const node of nodes) {
      if (!outgoing.has(node)) dangling += rank.get(node) ?? 0
    }
    for (const node of nodes) next.set(node, (1 - damping) / nodes.length + damping * dangling / nodes.length)
    for (const [source, targets] of edges) {
      const sourceRank = rank.get(source) ?? 0
      const total = outgoing.get(source)
      if (total === undefined || total === 0) continue
      for (const [target, weight] of targets) {
        next.set(target, (next.get(target) ?? 0) + damping * sourceRank * weight / total)
      }
    }
    for (const [node, value] of next) rank.set(node, value)
  }
  return rank
}

// ─── Map construction ───────────────────────────────────────────────────────

/** The workspace and budget one repository-map build runs with. */
export interface RepoMapInput {
  readonly cwd: string
  readonly maxTokens?: number
  readonly focusFiles?: readonly string[]
  /** Set false in tests to force a cold scan; default reads/writes the per-project cache. */
  readonly useCache?: boolean
}

/** Build the ranked repository map for a workspace.
 * @param input - the workspace, token budget, focus files, and cache toggle.
 * @returns the repo Map Result.
 */
export function buildRepoMap(input: RepoMapInput): RepoMapResult {
  const root = resolve(input.cwd)
  const maxTokens = Math.max(256, Math.min(8_192, input.maxTokens ?? 1_024))
  // Sorted, because the first file to declare an identifier owns it and that
  // ownership decides the reference edges: directory order would let the same
  // workspace rank differently on two machines, in a map whose whole purpose is
  // a stable session-start summary.
  const scan = collectSourceFiles(root)
  const files = [...scan.files].sort()
  const definitionsByFile = new Map<string, readonly Definition[]>()
  const identifierOwners = new Map<string, string>()
  const fileReferences = new Map<string, Map<string, number>>()
  const cache = new FileFactsCache()
  if (input.useCache !== false) cache.load(root)
  let scanned = 0
  // The walk's account, extended by the files whose facts the scan itself could not
  // produce. `collectFileFacts` returns `undefined` only for a read that failed:
  // size refusals happen in the walk, which is the one place that can tell a file it
  // refused from a file that is not there.
  const unscannedExamples = [...scan.examples]
  let unreadable = scan.unreadable
  for (const file of files) {
    const facts = collectFileFacts(root, file, cache)
    if (facts === undefined) {
      unreadable += 1
      const omitted = relative(root, file).replaceAll('\\', '/')
      if (unscannedExamples.length < UNSCANNED_EXAMPLES) unscannedExamples.push(omitted)
      continue
    }
    scanned += 1
    const relativeFile = relative(root, file).replaceAll('\\', '/')
    definitionsByFile.set(relativeFile, facts.definitions)
    for (const definition of facts.definitions) {
      if (!identifierOwners.has(definition.identifier)) identifierOwners.set(definition.identifier, relativeFile)
    }
    fileReferences.set(relativeFile, facts.references)
  }
  if (input.useCache !== false && cache.size > 0) {
    // Keep the on-disk cache bounded so a giant workspace cannot write an
    // unbounded JSON file on every map rebuild.
    try { mkdirSync(dirname(path.join(root, CACHE_FILENAME)), { recursive: true }) } catch { /* best effort */ }
    cache.flush(root)
  }
  // Graph edges: file → referenced identifier (weight = reference count),
  // identifier → defining file (weight 1).
  const edges = new Map<string, Map<string, number>>()
  const addEdge = (source: string, target: string, weight: number): void => {
    let targets = edges.get(source)
    if (targets === undefined) {
      targets = new Map()
      edges.set(source, targets)
    }
    targets.set(target, (targets.get(target) ?? 0) + weight)
  }
  for (const [file, tokens] of fileReferences) {
    for (const [identifier, count] of tokens) {
      const owner = identifierOwners.get(identifier)
      if (owner === undefined || owner === file) continue
      addEdge(file, identifier, count)
      addEdge(identifier, owner, 1)
    }
  }
  const nodes = [...identifierOwners.keys(), ...definitionsByFile.keys()]
  const rank = pagerank(nodes, edges)
  // Reference totals per identifier, summed once.
  //
  // The rendered `references` field is a per-identifier total, and deriving it
  // inside the per-definition loop made the whole map O(definitions × files):
  // every definition of every file walked (and copied) the full reference table.
  // On a 1.5k-file repository that dominated the call at ~3s with a warm cache.
  const referenceTotals = new Map<string, number>()
  for (const tokens of fileReferences.values()) {
    for (const [identifier, count] of tokens) referenceTotals.set(identifier, (referenceTotals.get(identifier) ?? 0) + count)
  }
  // Chat-focus boost (aider: mentioned files get a rank multiplier).
  //
  // Each entry is resolved to the relative spelling the map is keyed on rather
  // than compared as typed. A boost that does not apply is invisible — a map that
  // ignored `focus_files` looks exactly like a map whose ranking did not move —
  // and `./src/a.ts`, `C:\repo\src\a.ts` and `src\a.ts` all name one file, of
  // which only the last used to match. Resolving also folds `..` and repeated
  // separators, so two spellings of one path cannot disagree.
  const focus = new Set((input.focusFiles ?? []).map((file) => {
    const normalized = file.trim().replaceAll('\\', '/')
    return relative(root, resolve(root, normalized)).replaceAll('\\', '/')
  }))
  const entries: RepoMapEntry[] = []
  for (const [file, definitions] of definitionsByFile) {
    const fileBoost = focus.has(file) ? 4 : 1
    for (const definition of definitions) {
      const references = referenceTotals.get(definition.identifier) ?? 0
      entries.push({
        file,
        identifier: definition.identifier,
        kind: definition.kind,
        ...(definition.signature !== undefined ? { signature: definition.signature } : {}),
        rank: (rank.get(definition.identifier) ?? 0) * fileBoost,
        references,
      })
    }
  }
  entries.sort((left, right) => right.rank - left.rank || left.file.localeCompare(right.file))
  // Aider-style budget fit: binary-search the ranked prefix length so the map
  // uses as much of the token budget as possible instead of stopping at the
  // first entry that would overflow (a big entry early then wasted the tail).
  const renderEntry = (entry: RepoMapEntry): string => entry.signature !== undefined && entry.kind !== 'const'
    ? `${entry.file}: ${entry.signature}`
    : `${entry.file}: ${entry.kind} ${entry.identifier}`
  const entryCost = (line: string): number => tokensFromChars(line.length)
  const fitPrefixLength = (count: number): number => {
    let budget = maxTokens
    for (let index = 0; index < count; index += 1) {
      budget -= entryCost(renderEntry(entries[index]!))
      if (budget < 0) return index
    }
    return count
  }
  let included = fitPrefixLength(entries.length)
  // Binary search converges when the truncation check above already matches;
  // only when the full list fits (or the first entry alone does not) is the
  // result already final. For genuinely monotone costs the greedy prefix IS
  // the optimum, so the extra search only resolves the grow-able tail.
  if (included < entries.length) {
    let low = 0
    let high = entries.length
    while (low < high) {
      const middle = Math.ceil((low + high + 1) / 2)
      if (fitPrefixLength(middle) === middle) low = middle
      else high = middle - 1
    }
    included = low
  }
  const truncated = included < entries.length
  const map: RepoMapEntry[] = entries.slice(0, included)
  const rendered: string[] = map.map(renderEntry)
  const tokens = rendered.reduce((sum, line) => sum + entryCost(line), 0)
  return {
    projectId: Buffer.from(root).toString('base64url').slice(0, 24),
    filesScanned: scanned,
    tokensEstimate: tokens,
    map,
    graphSummary: rendered.join('\n'),
    truncated,
    unscanned: { oversized: scan.oversized, unreadable, unreached: scan.unreached, examples: unscannedExamples },
  }
}

/** One walk's result: the files it can read, and an account of the rest. */
interface SourceScan {
  readonly files: readonly string[]
  readonly oversized: number
  readonly unreadable: number
  readonly examples: readonly string[]
  readonly unreached: boolean
}

/**
 * Every source file under `root` that the walk can read, plus what it could not.
 *
 * The walk is where the caps live, so it is the only place that can say a file was
 * seen and refused rather than merely absent. The caps are checked before a
 * directory is descended into, which is why a directory can carry the totals past
 * them: the flat cost of stopping mid-directory is a few files more than the cap,
 * while the alternative is a partial listing of whatever happened to be read first.
 */
function collectSourceFiles(root: string): SourceScan {
  const files: string[] = []
  const examples: string[] = []
  let oversized = 0
  let unreadable = 0
  let unreached = false
  if (!existsSync(root)) return { files, oversized, unreadable, examples, unreached }
  const note = (file: string): void => {
    if (examples.length < UNSCANNED_EXAMPLES) examples.push(relative(root, file).replaceAll('\\', '/'))
  }
  let totalBytes = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      // Whatever is still on the stack is a directory tree this map never looked at.
      unreached = true
      break
    }
    const directory = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      if (DTS_OR_MIN.test(entry.name)) continue
      try {
        const size = statSync(full).size
        if (size > MAX_FILE_BYTES) {
          oversized += 1
          note(full)
          continue
        }
        totalBytes += size
      } catch {
        // A file that cannot even be stat'd is located but unreadable, which is the
        // same invisibility as a size refusal and is counted the same way. No case
        // covers this arm: producing it portably needs a permission denial, and a
        // suite that runs as root does not have one. Naming the uncovered arm is the
        // point rather than leaving the count quietly wrong.
        unreadable += 1
        note(full)
        continue
      }
      files.push(full)
    }
  }
  return { files, oversized, unreadable, examples, unreached }
}

// ─── Per-file extraction cache (mtime + size keyed) ─────────────────────────

class FileFactsCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; definitions: readonly Definition[]; references: Map<string, number> }>()
  /** False when the on-disk payload was written by a different extractor
   * version; a stale payload must never be trusted, because mtime+size cannot
   * see a change in *our* extraction logic. */
  private usable = true
  /** False when the on-disk payload was not a whole document. Such a payload is
   * never promoted to a trusted cache by writing this run's extraction over it,
   * because a partially-parsed map would then look authoritative. A payload that
   * is merely *outdated* is complete, so it is replaced — refusing that would
   * leave the cache cold forever, re-extracting the whole workspace on every
   * build after one extractor version bump. */
  private replaceable = true

  load(cwd: string): void {
    let raw: string
    try {
      raw = readFileSync(path.join(cwd, CACHE_FILENAME), 'utf8')
    } catch (error) {
      // A missing cache is a cold start, and writing it back is the point of
      // this class; a cache that exists but cannot be read is not promoted.
      if ((error as { readonly code?: string }).code !== 'ENOENT') this.replaceable = false
      return
    }
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; files?: Record<string, { m: [number, number]; d: [string, string, string][]; r: [string, number][] }> }
      if (parsed === null || typeof parsed !== 'object') {
        this.usable = false
        this.replaceable = false
        return
      }
      if (parsed.v !== CACHE_VERSION) {
        this.usable = false
        return
      }
      if (parsed.files === null || typeof parsed.files !== 'object') {
        this.usable = false
        this.replaceable = false
        return
      }
      for (const [file, entry] of Object.entries(parsed.files)) {
        if (typeof file !== 'string' || !Array.isArray(entry?.m) || !Array.isArray(entry?.d) || !Array.isArray(entry?.r)) continue
        const references = new Map<string, number>()
        for (const [token, count] of entry.r) {
          if (typeof token !== 'string' || typeof count !== 'number' || count < 1) continue
          references.set(token, count)
        }
        this.entries.set(file, {
          mtimeMs: entry.m[0] ?? -1,
          size: entry.m[1] ?? -1,
          definitions: entry.d.map(([identifier, kind, signature]) => ({ identifier, kind: kind as Definition['kind'], signature: signature === '' ? undefined : signature })),
          references,
        })
      }
    } catch {
      // A payload that will not parse at all is not a cold start to be overwritten:
      // this run's extraction may be complete, but the file it came from may also
      // be truncated, and promoting it would make the half-map authoritative.
      this.usable = false
      this.replaceable = false
    }
  }

  flush(cwd: string): void {
    if (this.entries.size === 0) return
    if (!this.replaceable) return
    const files: Record<string, { m: [number, number]; d: [string, string, string][]; r: [string, number][] }> = {}
    for (const [file, entry] of this.entries) {
      files[file] = {
        m: [entry.mtimeMs, entry.size],
        d: entry.definitions.map(definition => [definition.identifier, definition.kind, definition.signature ?? '']),
        r: [...entry.references],
      }
    }
    try {
      writeFileSync(path.join(cwd, CACHE_FILENAME), JSON.stringify({ v: CACHE_VERSION, files }), 'utf8')
    } catch { /* read-only workspace: cache is an optimization only */ }
  }

  /** Cache lookup valid only when the extractor version and the file's stat both match. */
  get(file: string, mtimeMs: number, size: number): { definitions: readonly Definition[]; references: Map<string, number> } | undefined {
    if (!this.usable) return undefined
    const entry = this.entries.get(file)
    if (entry === undefined || entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined
    return entry
  }

  put(file: string, mtimeMs: number, size: number, definitions: readonly Definition[], references: Map<string, number>): void {
    // A plain Map without an eviction policy would grow without bound on very
    // large workspaces; drop the oldest entries past the cap.
    if (this.entries.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(file, { mtimeMs, size, definitions, references })
  }

  get size(): number { return this.entries.size }
}

const CACHE_FILENAME = '.freecodego/repo-map-cache.json'
const CACHE_MAX_ENTRIES = 12_000
/**
 * Extractor generation stamp. Bump this whenever {@link extractDefinitions},
 * {@link referenceTokens}, or the language table changes: the per-file cache is
 * keyed on mtime+size, which cannot detect a change in our own logic, so a
 * stale entry would otherwise survive an upgrade and silently under-report the
 * new surface.
 */
const CACHE_VERSION = 2

function collectFileFacts(root: string, file: string, cache: FileFactsCache): { definitions: readonly Definition[]; references: Map<string, number> } | undefined {
  let stats: import('node:fs').Stats
  let content: string
  try {
    // No size test here: the walk has already applied {@link MAX_FILE_BYTES}, and a
    // second, lower bound would silently drop what this one accepted.
    stats = statSync(file)
    content = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const mtimeMs = Math.floor(stats.mtimeMs)
  const relativeFile = relative(root, file).replaceAll('\\', '/')
  const cached = cache.get(relativeFile, mtimeMs, stats.size)
  if (cached !== undefined) return cached
  const facts = { definitions: extractDefinitions(content, extname(file)), references: referenceTokens(content) }
  cache.put(relativeFile, mtimeMs, stats.size, facts.definitions, facts.references)
  return facts
}
