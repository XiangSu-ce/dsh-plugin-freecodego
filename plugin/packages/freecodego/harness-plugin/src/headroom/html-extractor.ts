/**
 * HTML main-content extraction — lightweight TypeScript port of Headroom's
 * `headroom/transforms/html_extractor.py` detection gates, © Headroom
 * Maintainers, Apache-2.0. The original delegates extraction to trafilatura;
 * this port uses structural tag stripping (scripts, styles, comments, nav
 * chrome, then all markup) which reaches similar reductions for tool-fetched
 * pages without adding a dependency. Adoption is result-driven: the extracted
 * text must be substantially smaller than the source.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/html-extractor
 */

const DOCTYPE_RE = /^\s*<!doctype\s+html/i
const HTML_TAG_RE = /<html[\s>]/
const HEAD_RE = /<head[\s>]/
const BODY_RE = /<body[\s>]/
const STRUCTURAL_TAGS_RE = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi

export interface HtmlResult {
  readonly output: string
  readonly applied: boolean
}

/** Original confidence model; the router only claims content at ≥0.7. */
export function detectHtml(content: string): boolean {
  const sample = content.slice(0, 3000)
  const hasDoctype = DOCTYPE_RE.test(sample)
  const hasHtmlTag = HTML_TAG_RE.test(sample)
  const structural = (sample.match(STRUCTURAL_TAGS_RE) ?? []).length
  if (!hasDoctype && !hasHtmlTag && structural < 3) return false
  let confidence = 0
  if (hasDoctype) confidence += 0.5
  if (hasHtmlTag) confidence += 0.3
  if (HEAD_RE.test(sample)) confidence += 0.1
  if (BODY_RE.test(sample)) confidence += 0.1
  confidence += Math.min(0.3, structural * 0.03)
  return Math.min(1, confidence) >= 0.7
}

const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
]

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m === null ? undefined : m[1]!.replace(/\s+/g, ' ').trim()
}

/** Strip scripts/styles/comments/nav chrome, then all tags; collapse whitespace. */
export function extractHtmlText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nav|header|footer|aside|menu)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Nav menus rendered as plain <ul> lists: every item short (<20 chars)
    // is site chrome, not content (the original's trafilatura drops these).
    .replace(/<ul\b[^>]*>(?:\s*<li\b[^>]*>\s*[^<]{1,20}\s*<\/li>\s*)+<\/ul\s*>/gi, '')
  const title = extractTitle(text)
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  for (const [re, replacement] of ENTITIES) text = text.replace(re, replacement)
  text = text
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
  return title === undefined ? text : `# ${title}\n\n${text}`
}

/** Extract the main text of a detected HTML payload. */
export function compressHtml(html: string): HtmlResult {
  if (!detectHtml(html)) return { output: html, applied: false }
  const extracted = extractHtmlText(html)
  if (extracted.length < 200) return { output: html, applied: false }
  if (Buffer.byteLength(extracted, 'utf8') / Math.max(1, Buffer.byteLength(html, 'utf8')) > 0.5) {
    return { output: html, applied: false }
  }
  return { output: extracted, applied: true }
}
