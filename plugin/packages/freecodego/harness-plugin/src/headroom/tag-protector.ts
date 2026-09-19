/**
 * Custom/workflow XML tag protection — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/tag_protector.rs` (single-pass
 * walker with the offset-stitched placeholder emission), © Headroom
 * Maintainers, Apache-2.0.
 *
 * `<system-reminder>`-style custom tags must survive prose compression: a
 * dropped directive word inverts the instruction. `protectTags` replaces
 * known-HTML-free custom tag blocks (or, in marker mode, only the tag
 * markers) with `{{HEADROOM_TAG_N}}` placeholders; `restoreTags` swaps the
 * originals back after the compressor runs. Unknown/orphan opens fall
 * through as raw bytes, matching the original.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/tag-protector
 */

/** HTML5 tags that are NOT protected (the extractor handles real HTML). */
const HTML5_TAGS: ReadonlySet<string> = new Set([
  'html', 'base', 'head', 'link', 'meta', 'style', 'title', 'body',
  'address', 'article', 'aside', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'main', 'nav', 'section', 'search',
  'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'area', 'audio', 'img', 'map', 'track', 'video',
  'embed', 'iframe', 'object', 'param', 'picture', 'portal', 'source',
  'svg', 'math', 'canvas', 'noscript', 'script',
  'del', 'ins',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'button', 'datalist', 'fieldset', 'form', 'input', 'label', 'legend', 'meter', 'optgroup', 'option', 'output', 'progress', 'select', 'textarea',
  'details', 'dialog', 'summary', 'slot', 'template',
])

const DEFAULT_PREFIX = '{{HEADROOM_TAG_'
const PLACEHOLDER_SUFFIX = '}}'

function isNameStart(b: number): boolean {
  return (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || b === 0x5f
}
function isNameCont(b: number): boolean {
  return isNameStart(b) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2e || b === 0x3a
}

function isKnownHtmlTag(name: string): boolean {
  return HTML5_TAGS.has(name) || HTML5_TAGS.has(name.toLowerCase())
}

type TagParse =
  | { readonly kind: 'not' }
  | { readonly kind: 'open'; readonly nameEnd: number; readonly tagEnd: number; readonly selfClosing: boolean }
  | { readonly kind: 'close'; readonly nameEnd: number; readonly tagEnd: number }

/** Parse the tag starting at `start` (text[start] === '<'), original lexer rules. */
function parseTagAt(text: string, start: number): TagParse {
  const n = text.length
  let i = start + 1
  if (i >= n) return { kind: 'not' }
  const isClose = text[i] === '/'
  if (isClose) i += 1
  if (i >= n) return { kind: 'not' }
  const nameStart = i
  if (!isNameStart(text.charCodeAt(i))) return { kind: 'not' }
  i += 1
  while (i < n && isNameCont(text.charCodeAt(i))) i += 1
  const nameEnd = i
  if (nameEnd === nameStart) return { kind: 'not' }

  if (isClose) {
    while (i < n && /\s/.test(text[i]!)) i += 1
    if (i >= n || text[i] !== '>') return { kind: 'not' }
    return { kind: 'close', nameEnd, tagEnd: i + 1 }
  }

  // Opening tag: skip attributes until `>` (quoted values may contain `>`).
  let selfClosing = false
  while (i < n) {
    const c = text[i]!
    if (c === '>') return { kind: 'open', nameEnd, tagEnd: i + 1, selfClosing }
    if (c === '/') {
      selfClosing = true
      i += 1
    } else if (c === '"' || c === "'") {
      i += 1
      while (i < n && text[i] !== c) i += 1
      if (i >= n) return { kind: 'not' }
      i += 1
      selfClosing = false
    } else {
      if (/\s/.test(c)) selfClosing = false
      i += 1
    }
  }
  return { kind: 'not' }
}

interface Span {
  readonly start: number
  readonly end: number
}

interface OpenTag {
  readonly nameLower: string
  readonly openStart: number
}

/** Salt the placeholder prefix when the input itself contains the default. */
function pickPlaceholderPrefix(text: string): string {
  if (!text.includes(DEFAULT_PREFIX)) return DEFAULT_PREFIX
  for (let salt = 1; salt < 64; salt += 1) {
    const candidate = `{{HEADROOM_TAG${salt}_`
    if (!text.includes(candidate)) return candidate
  }
  return '{{HEADROOM_TAGX_'
}

function identifySpans(text: string, compressTaggedContent: boolean): readonly Span[] {
  const n = text.length
  const spans: Span[] = []
  const stack: OpenTag[] = []
  let i = 0
  while (i < n) {
    if (text[i] !== '<') {
      const next = text.indexOf('<', i)
      i = next < 0 ? n : next
      continue
    }
    const parsed = parseTagAt(text, i)
    if (parsed.kind === 'not') {
      i += 1
      continue
    }
    if (parsed.kind === 'open') {
      const name = text.slice(i + 1, parsed.nameEnd)
      if (isKnownHtmlTag(name)) {
        i = parsed.tagEnd
        continue
      }
      if (parsed.selfClosing) {
        spans.push({ start: i, end: parsed.tagEnd })
        i = parsed.tagEnd
        continue
      }
      if (compressTaggedContent) {
        spans.push({ start: i, end: parsed.tagEnd })
      }
      stack.push({ nameLower: name.toLowerCase(), openStart: i })
      i = parsed.tagEnd
      continue
    }
    // Close tag.
    const closeName = text.slice(i + 2, parsed.nameEnd)
    if (isKnownHtmlTag(closeName)) {
      i = parsed.tagEnd
      continue
    }
    const closeNameLower = closeName.toLowerCase()
    let stackIdx = -1
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s]!.nameLower === closeNameLower) {
        stackIdx = s
        break
      }
    }
    if (stackIdx >= 0) {
      if (compressTaggedContent) {
        // Truncating to `stackIdx` already drops the matched entry; popping here
        // as well would discard its parent and leave that parent's close tag
        // unprotected when it is reached.
        stack.length = stackIdx
        spans.push({ start: i, end: parsed.tagEnd })
      } else {
        const openStart = stack[stackIdx]!.openStart
        stack.length = stackIdx
        // Nested custom tags collapse into the outermost block span.
        const retained = spans.filter(span => span.start < openStart)
        spans.length = 0
        spans.push(...retained)
        spans.push({ start: openStart, end: parsed.tagEnd })
      }
      i = parsed.tagEnd
      continue
    }
    // Orphan close — emitted verbatim.
    i = parsed.tagEnd
  }
  return spans
}

export interface ProtectResult {
  /** Text with protected spans replaced by placeholders. */
  readonly cleaned: string
  /** (placeholder, original) pairs for restoreTags. */
  readonly blocks: readonly (readonly [string, string])[]
}

/**
 * Protect custom XML tag blocks (or just the tag markers when
 * `compressTaggedContent`) from compression via placeholders.
 */
export function protectTags(text: string, compressTaggedContent = false): ProtectResult {
  if (text === '' || !text.includes('<')) return { cleaned: text, blocks: [] }
  const prefix = pickPlaceholderPrefix(text)
  const spans = identifySpans(text, compressTaggedContent)
  let out = ''
  const blocks: [string, string][] = []
  let cursor = 0
  for (const [counter, span] of spans.entries()) {
    if (span.start < cursor) return { cleaned: text, blocks: [] }
    out += text.slice(cursor, span.start)
    const placeholder = `${prefix}${counter}${PLACEHOLDER_SUFFIX}`
    blocks.push([placeholder, text.slice(span.start, span.end)])
    out += placeholder
    cursor = span.end
  }
  out += text.slice(cursor)
  return { cleaned: out, blocks }
}

/**
 * Swap placeholders back to the original tag blocks.
 *
 * The replacement is a **function**, not the block itself, and that is
 * load-bearing: `String.prototype.replaceAll` expands `$&`, `` $` ``, `$'` and
 * `$$` inside a *string* replacement. A protected block is arbitrary tool
 * output, so a file that merely *documents* a replacement — `s.replace(x, "$&")`,
 * a sed one-liner, a regex tutorial — was rewritten on the way back out: the
 * `$&` became the placeholder token itself and `$$` collapsed to `$`. The
 * corruption is silent and it is not a truncation, so nothing downstream could
 * notice. A function replacement is returned verbatim, which is the only
 * spelling that restores bytes.
 *
 * @param text - the compressed text carrying placeholders.
 * @param blocks - the placeholder/original pairs from {@link protectTags}.
 * @returns the text with every block put back byte-for-byte.
 */
export function restoreTags(text: string, blocks: readonly (readonly [string, string])[]): string {
  let out = text
  for (const [placeholder, original] of blocks) out = out.replaceAll(placeholder, () => original)
  return out
}
