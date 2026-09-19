/**
 * Code skeletonization — the one compression the port deliberately lacked.
 *
 * Why this module exists
 * ----------------------
 * Every other strategy in this port is shape-routed: logs, JSON, diffs,
 * searches, tables, configs, prose. Source code had no strategy at all, and
 * two independent gates made sure of it:
 *
 *   1. `read` / `read_file` / `view` / `readfile` sit in `DEFAULT_EXCLUDE_TOOLS`
 *      (they *are* {@link READ_LIKE_TOOL_NAMES}, which that list spreads in), so
 *      a read result is classified protected and only ever offered the lossless
 *      folds in `foldGatedTool`.
 *   2. `compressText` returns early on `detection.contentType === 'code'`
 *      ("source code passes through unmangled").
 *
 * That was defensible when reads were assumed small. Measured against real
 * sessions it is not: in a sample of 17 sessions / 133 steps, `read` produced
 * 875,706 tokens of the 1,025,038 tokens of tool output ingested — 85% — and
 * because the Harness re-sends the whole transcript every step (`deriveMessages`
 * does not trim), those bytes were transmitted 21.4M tokens in total.
 *
 * The contract that makes this safe
 * ---------------------------------
 * A skeleton is a **subsequence of the original numbered lines**. Every line
 * that survives is byte-exact, including its `N: ` prefix; nothing is rewritten,
 * reordered, re-indented, or truncated. Only *whole contiguous runs* of body
 * lines are replaced, each by a single marker naming the line range it covers.
 * So an Edit anchored on a retained line still matches, and the model can tell
 * exactly which line numbers it is no longer seeing.
 *
 * The original bytes are handed to the caller to stash in the CCR store, and
 * the marker names the hash — the same lossy-on-the-wire, lossless-end-to-end
 * bargain every other compressor in this port makes.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/code-skeleton
 */

import { detectContentType } from './content-detector.ts'

export interface CodeSkeletonConfig {
  /** Below this many bytes the wrapper declines: a marker costs more than it saves. */
  readonly minChars: number
  /** Adopt only when the skeleton is at most this fraction of the original. */
  readonly maxSizeRatio: number
  /** A run shorter than this is kept verbatim; a marker costs ~30 chars. */
  readonly minRunLines: number
  /** Cap on lines a single multi-line signature may pull in as continuation. */
  readonly maxSignatureLines: number
}

/**
 * Defaults calibrated against two measurements rather than intuition.
 *
 * - `minChars: 2_000` — reading large files is done in offset chunks, so a third
 *   of the reads in the sampled sessions were 2-4 KB. A 4 KB floor skipped them.
 *   The floor is still real: a marker costs ~120 chars, and `minRunLines` means a
 *   small file usually has no run long enough to elide anyway.
 * - `maxSizeRatio: 0.75` — a barrel/`index` module is mostly re-exports and keeps
 *   a genuine 36% reduction after every signature is preserved. Requiring 60%
 *   measured that file as a failure and threw the whole read away.
 */
export const CODE_SKELETON_DEFAULTS: CodeSkeletonConfig = {
  minChars: 2_000,
  maxSizeRatio: 0.75,
  minRunLines: 3,
  maxSignatureLines: 40,
}

export interface CodeSkeletonResult {
  readonly applied: boolean
  /** The rewritten envelope; identical to the input when `applied` is false. */
  readonly output: string
  readonly keptLines: number
  readonly elidedLines: number
  readonly runs: number
  /** `1 - outputBytes/inputBytes`; 0 when not applied. */
  readonly savings: number
  /** Detected language hint for diagnostics; undefined when not code. */
  readonly language?: string
}

/**
 * Content types that already own a dedicated compressor. A file the detector
 * reads as one of these must not be skeletonized: the type-specific path both
 * compresses better and knows the format's semantics.
 */
const NON_CODE_TYPES: ReadonlySet<string> = new Set([
  'json', 'config', 'log', 'search', 'diff', 'html', 'tabular',
])

/**
 * Source extensions accepted when the language detector is unsure. Kept as an
 * explicit list rather than "everything not prose" so a `.txt`, `.md`, or
 * unknown extension is skipped instead of mangled.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'swift', 'm', 'mm', 'cs', 'fs', 'vb', 'php', 'pl', 'lua', 'r',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'hh', 'mpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'dart', 'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'edn', 'hs', 'ml', 'mli', 'fsx', 'nim', 'zig', 'v', 'sol', 'asm', 's',
])

/**
 * Declaration, import, and signature forms kept regardless of nesting depth.
 *
 * Written as one pattern over optional modifiers so a `private static async
 * create(...)` reads the same as a bare `def create(...)`. Deliberately
 * language-agnostic: the port cannot ship a parser per language, and a false
 * positive (keeping one body line) costs a line of context, while a false
 * negative (eliding a signature) costs the reader the file's interface.
 */
const STRUCTURAL_RE = new RegExp(
  '^\\s*(?:@[\\w.$]+|#!|#\\[|\\[\\[|"use [\\w-]+")'
  + '|^\\s*(?:export\\s+|default\\s+|declare\\s+|public\\s+|private\\s+|protected\\s+|internal\\s+|static\\s+|abstract\\s+|final\\s+|open\\s+|override\\s+|sealed\\s+|async\\s+|pub\\s+|extern\\s+|inline\\s+|unsafe\\s+|virtual\\s+|partial\\s+|readonly\\s+)*'
  + '(?:import|export\\s+(?:type\\s+)?(?:const|let|var|function|class|interface|type|enum|default|\\{)|from|require|include|use|package|module|namespace|mod\\b|class|interface|type\\s+\\w|enum|struct|union|trait|impl\\b|record|protocol|extension|object|mixin|fn\\b|func\\b|def\\b|function\\b|sub\\b|proc\\b|constructor|get\\b|set\\b|operator|delegate|event|macro|typedef|using\\b)',
)

/**
 * Value bindings. Kept only where they are *interface*: a module-level
 * `export const CONFIG = …` or a class field, never a local `const x = …`
 * inside a function body.
 *
 * That distinction is exactly why a bare brace depth is not enough — a class
 * field and a function-local both sit one level inside their `{` — so the
 * enclosing block's kind has to be tracked.
 */
const BINDING_RE = /^\s*(?:(?:export|declare|public|private|protected|internal|static|abstract|final|readonly|open|const|val|var|let)\s+)*(?:const|let|var|val|final|static)\s+[\w$]/u

/** Class/interface fields declared with a modifier: `private readonly root: string`. */
const FIELD_RE = /^\s*(?:public|private|protected|internal|readonly|static|declare|override|abstract|final|val|var|const)\s+[\w$]+\s*(?::[^=]+)?(?:=.*)?;?\s*$/u

/** Blocks that hold *interface* rather than implementation. */
const TYPE_BLOCK_RE = /\b(?:class|interface|enum|struct|trait|namespace|module|impl|object|record|protocol|extension|mixin|declare\s+module)\b/u

/**
 * Signatures that carry no declaration keyword: `bar() {`, `async run(): T {`.
 *
 * This is the pattern that makes a class useful — its members are the interface,
 * and in TypeScript most of them are written without `function`. Distinguished
 * from a *call* by the trailing `{`, which a statement-level call does not have.
 */
const MEMBER_SIGNATURE_RE = /^\s*(?:(?:public|private|protected|static|async|abstract|readonly|override|get|set|declare|final|export|default|virtual|inline|synchronized|internal|open|sealed|unsafe)\s+)*[\w$]+\s*(?:<[^<>]*>)?\s*\([^;{}]*\)\s*(?::\s*[^{;]+)?\{\s*$/u

/** Class fields initialized with an arrow function: `onChange = (e) => {`. */
const ARROW_FIELD_RE = /^\s*(?:(?:public|private|protected|static|readonly|declare|override)\s+)*[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^={]+)?=>\s*\{?\s*$/u

/**
 * Control-flow heads share the `<name>(…) {` shape with a method signature but
 * are statements, not interface. Keeping them would leak one body line per
 * branch while still eliding the branch itself.
 */
const CONTROL_FLOW_RE = /^\s*(?:if|for|while|switch|catch|do|else|elif|return|new|await|throw|yield|typeof|delete|void|case|default|assert|expect)\b/u

/** Brace/indent depth at or below which a closing delimiter is still structure. */
const TOP_LEVEL_DEPTH = 1

interface Envelope {
  readonly head: string
  readonly body: string
  readonly tail: string
  readonly path: string
}

interface NumberedLine {
  readonly number: number
  /** The original line exactly as it appeared, `N: text` included. */
  readonly raw: string
  /** Text after the `N: ` prefix — the code the heuristics read. */
  readonly text: string
}

/**
 * Split the `read` tool's envelope into head / numbered body / footer.
 *
 * Only this exact envelope is accepted. A result shaped differently (an image
 * read, a patched-file confirmation, an error) is left alone: the heuristics
 * below assume `N: ` line numbering, and running them over unnumbered text
 * would either do nothing useful or corrupt it.
 */
function splitEnvelope(text: string): Envelope | undefined {
  const open = text.indexOf('<content>\n')
  if (!open || !text.startsWith('<path>') || !text.endsWith('</content>')) return undefined
  const pathMatch = /^<path>([\s\S]*?)<\/path>\n/.exec(text)
  if (pathMatch === null) return undefined
  const bodyStart = open + '<content>\n'.length
  const bodyEnd = text.length - '</content>'.length
  const body = text.slice(bodyStart, bodyEnd)
  // The body closes with "\n\n<footer>\n"; the footer names the file's total
  // length, so it stays verbatim even after lines are elided — it describes the
  // file, not the excerpt.
  const footerAt = body.lastIndexOf('\n\n(')
  if (footerAt === -1) return { head: text.slice(0, bodyStart), body, tail: '', path: pathMatch[1] ?? '' }
  return {
    head: text.slice(0, bodyStart),
    body: body.slice(0, footerAt),
    tail: body.slice(footerAt),
    path: pathMatch[1] ?? '',
  }
}

/**
 * Split a numbered body into parsed lines, or undefined when it is unnumbered.
 *
 * The window may start anywhere: `read` with `offset` renders its first line as
 * `200: …`, and requiring the body to begin at 1 rejected every chunked read —
 * which is how agents read large files. The invariant that matters is internal
 * consecutiveness, not an origin of 1.
 */
function parseNumbered(body: string): NumberedLine[] | undefined {
  const out: NumberedLine[] = []
  let expected: number | undefined
  for (const raw of body.split('\n')) {
    const match = /^(\d+): (.*)$/.exec(raw)
    if (match === null) {
      // A stray blank line inside the body is tolerated; anything else means
      // this is not the numbered format the heuristics expect.
      if (raw.trim() === '') continue
      return undefined
    }
    const number = Number(match[1])
    if (expected !== undefined && number !== expected) return undefined
    expected = number + 1
    out.push({ number, raw, text: match[2] ?? '' })
  }
  return out.length > 0 ? out : undefined
}

/** Language hint from the display path's extension. */
function extensionOf(path: string): string {
  const base = path.replace(/\\/gu, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Whether a line is worth keeping on its own merits: a declaration, import,
 * signature, decorator, or attribute.
 */
function isStructural(line: string, enclosing: BlockKind | undefined): boolean {
  if (CONTROL_FLOW_RE.test(line)) return false
  if (STRUCTURAL_RE.test(line) || MEMBER_SIGNATURE_RE.test(line) || ARROW_FIELD_RE.test(line)) return true
  // Bindings and modifier-declared fields only read as interface at module level
  // or directly inside a type block.
  const interfaceScope = enclosing === undefined || enclosing === 'type'
  if (!interfaceScope) return false
  return BINDING_RE.test(line) || FIELD_RE.test(line)
}

/** What a `{` block holds — it decides whether a binding line is interface. */
type BlockKind = 'type' | 'function' | 'other'

/** Classify the block a line opens, from the line's own shape. */
function blockKindOf(line: string): BlockKind {
  if (CONTROL_FLOW_RE.test(line)) return 'other'
  if (TYPE_BLOCK_RE.test(line)) return 'type'
  return 'function'
}

/** A closing delimiter that still reads as structure at low nesting depth. */
function isCloser(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '}' || trimmed === '};' || trimmed === '});' || trimmed === ')' || trimmed === '];'
    || trimmed === 'end' || trimmed === 'fi' || trimmed === 'done'
    || /^(?:\}\s*)?(?:else|elif|except|finally|catch|then|do)\b/u.test(trimmed)
}

/** Net `(`/`[` balance — the delimiter families a signature spans. */
function parenDelta(line: string): number {
  let delta = 0
  let inString: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    if (inString !== undefined) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === '(' || ch === '[') delta += 1
    else if (ch === ')' || ch === ']') delta -= 1
  }
  return delta
}

/** Net `{`/`}` balance, used only to track nesting depth. */
function braceDelta(line: string): number {
  let delta = 0
  let inString: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    if (inString !== undefined) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === '{') delta += 1
    else if (ch === '}') delta -= 1
  }
  return delta
}

/**
 * Decide which numbered lines survive.
 *
 * Keep set, in one pass:
 *   - structural lines (declarations, signatures, imports, decorators) at any
 *     depth — a method inside a class inside a namespace is still interface;
 *   - signature continuations, i.e. lines inside an unbalanced `(`/`[` opened
 *     by a structural line, bounded by `maxSignatureLines`;
 *   - closing delimiters at nesting depth ≤ 1, so blocks keep their shape;
 *   - comment and blank lines immediately preceding a kept line, so a
 *     signature keeps its doc comment.
 */
function selectKept(lines: readonly NumberedLine[], config: CodeSkeletonConfig): boolean[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  // Enclosing block kinds, pushed on every `{` and popped on every `}`. Tracked
  // for *all* lines, not just kept ones, or the stack desynchronises from the
  // brace depth and a local `const` inside a method reads as a class field.
  const blocks: BlockKind[] = []
  let depth = 0
  let signatureDepth = 0
  let signatureLines = 0

  for (const [index, line] of lines.entries()) {
    const text = line.text
    const structural = isStructural(text, blocks.at(-1))
    let selected = false

    if (signatureDepth > 0 && signatureLines < config.maxSignatureLines) {
      selected = true
      signatureLines += 1
    } else if (structural) {
      selected = true
    } else if (isCloser(text) && depth <= TOP_LEVEL_DEPTH) {
      selected = true
    }

    // A kept structural line that opens a parenthesised list keeps its
    // continuation lines: `function foo(` / `a: string,` / `): void {` is one
    // signature, and eliding its middle leaves an unreadable stub.
    const delta = parenDelta(text)
    if (selected && structural && delta > 0) {
      signatureDepth += delta
      signatureLines = 1
    } else if (signatureDepth > 0) {
      signatureDepth += delta
      if (signatureDepth <= 0) { signatureDepth = 0; signatureLines = 0 }
    }

    if (selected) keep[index] = true
    const braces = braceDelta(text)
    if (braces > 0) for (let opened = 0; opened < braces; opened += 1) blocks.push(blockKindOf(text))
    else for (let closed = 0; closed < -braces; closed += 1) blocks.pop()
    depth = Math.max(0, depth + braces)
  }

  // Context pass: a comment or blank line directly above a kept line belongs
  // with it (doc comments, section separators). Walked backwards so a two-line
  // doc comment above a signature is fully retained.
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (keep[index] === true) continue
    const text = lines[index]?.text ?? ''
    const isComment = /^\s*(?:\/\/|\/\*|\*|#|--|<!--)/u.test(text)
    const isBlank = text.trim() === ''
    if (!isComment && !isBlank) continue
    if (keep[index + 1] === true) keep[index] = true
  }

  // A short run is cheaper to keep than to mark: a marker line plus the reader
  // wondering what is missing costs more than the lines themselves.
  let run = 0
  for (let index = 0; index <= lines.length; index += 1) {
    if (index < lines.length && keep[index] !== true) { run += 1; continue }
    if (run > 0 && run < config.minRunLines) {
      for (let fill = index - run; fill < index; fill += 1) keep[fill] = true
    }
    run = 0
  }
  return keep
}

/** Render the kept subsequence, collapsing each elided run into one marker. */
function render(lines: readonly NumberedLine[], keep: readonly boolean[]): { body: string; runs: number; elided: number } {
  const parts: string[] = []
  let runs = 0
  let elided = 0
  let cursor = 0
  while (cursor < lines.length) {
    if (keep[cursor] === true) {
      parts.push(lines[cursor]?.raw ?? '')
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < lines.length && keep[cursor] !== true) cursor += 1
    const first = lines[start]
    const last = lines[cursor - 1]
    const count = cursor - start
    runs += 1
    elided += count
    parts.push(`  ${first?.number ?? 0}-${last?.number ?? 0}: [elided ${count} lines]`)
  }
  return { body: parts.join('\n'), runs, elided }
}

/**
 * Skeletonize one `read` result envelope.
 *
 * Pure: the caller owns the CCR store and passes in the hash it will stash the
 * original under, so this module never invents a key it cannot honour.
 *
 * @param text - the full model-facing read result.
 * @param hash - CCR key the original will be retrievable under.
 * @param config - tuning; defaults to {@link CODE_SKELETON_DEFAULTS}.
 * @returns the applied flag plus the rewritten envelope and its statistics.
 */
export function skeletonizeReadOutput(
  text: string,
  hash: string,
  config: CodeSkeletonConfig = CODE_SKELETON_DEFAULTS,
): CodeSkeletonResult {
  const declined: CodeSkeletonResult = { applied: false, output: text, keptLines: 0, elidedLines: 0, runs: 0, savings: 0 }
  const inputBytes = Buffer.byteLength(text, 'utf8')
  if (inputBytes < config.minChars) return declined

  const envelope = splitEnvelope(text)
  if (envelope === undefined) return declined
  const lines = parseNumbered(envelope.body)
  if (lines === undefined) return declined

  // Detect on the *de-numbered* text, never on the envelope body: the read
  // tool's `N: ` prefixes make every line look like a YAML key, so a detector
  // fed the numbered form classifies a TypeScript file as `config` and the
  // skeleton is never reached at all.
  const plain = lines.map(line => line.text).join('\n')
  const detection = detectContentType(plain)
  const extension = extensionOf(envelope.path)
  const knownSourceExtension = CODE_EXTENSIONS.has(extension)
  if (NON_CODE_TYPES.has(detection.contentType) && !knownSourceExtension) return declined
  if (detection.contentType !== 'code' && !knownSourceExtension) return declined

  const keep = selectKept(lines, config)
  const kept = keep.filter(Boolean).length
  if (kept === lines.length) return declined
  const rendered = render(lines, keep)
  if (rendered.runs === 0) return declined

  const marker = `\n[Code skeleton: kept ${kept} of ${lines.length} lines, elided ${rendered.elided} in ${rendered.runs} runs.`
    + ' Elided runs are whole body lines, never rewrites; retained lines are byte-exact.'
    + ` Retrieve the full original with headroom_retrieve hash=${hash}, or re-read a range with read offset/limit.]`
  const output = `${envelope.head}${rendered.body}${envelope.tail}${marker}\n</content>`
  const outputBytes = Buffer.byteLength(output, 'utf8')
  const savings = 1 - outputBytes / inputBytes
  if (outputBytes >= inputBytes * config.maxSizeRatio) return declined

  return {
    applied: true,
    output,
    keptLines: kept,
    elidedLines: rendered.elided,
    runs: rendered.runs,
    savings,
    language: extension !== '' ? extension : 'code',
  }
}

/**
 * Every read-like tool spelling this port knows, lowercased.
 *
 * One list, because it is the read half of **two** facts that have to agree: a
 * tool is protected from lossy compression *and* eligible for the skeleton, and
 * the runtime reaches the skeleton only through the protection gate. Spelled
 * twice, the two lists drifted — `readfile` was eligible here and unprotected
 * there, so its branch could not run at all and its output went to the ordinary
 * pipeline instead. `code-skeleton.spec.ts` pins the agreement, in the case named
 * "protects every spelling the skeleton claims, so none is eligible and
 * unprotected at once".
 */
export const READ_LIKE_TOOL_NAMES: readonly string[] = ['read', 'read_file', 'view', 'readfile']

/** Read-like tools whose results are eligible for skeletonization. */
export function isSkeletonEligibleTool(name: string): boolean {
  return READ_LIKE_TOOL_NAMES.includes(name.toLowerCase())
}
