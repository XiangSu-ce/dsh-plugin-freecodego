/**
 * Sanitization and screening for everything about to become durable memory.
 *
 * Why this is a module of its own
 * -------------------------------
 * `secret-scan.ts` already answers "does this text contain a credential with a
 * recognizable vendor prefix". That is necessary and not sufficient for memory,
 * for three reasons OpenClaude's `src/memdir/memorySecurity.ts` names:
 *
 * 1. **A memory is re-injected into later prompts.** A credential captured once
 *    does not leak once; it leaks on every future conversation that recalls the
 *    entry, and with team memory it leaves the machine. So the screen has to run
 *    on *write*, not on recall.
 * 2. **A memory outlives the workspace it came from.** The identifier becomes a
 *    filename or key, so it must be reduced to a shape that cannot traverse a
 *    path or collide with a sibling.
 * 3. **A memory is deduplicated against its own history.** Two records written
 *    from the same evidence must normalize to the same text, or the store grows
 *    a near-duplicate every turn. Normalization therefore happens before the
 *    hash, not after.
 *
 * The one rule this module is built to respect: **a finding never contains the
 * secret.** `describeSecretFindings` reports the rule id and a redacted prefix;
 * the screen copies that discipline into its verdict, so a UI that renders the
 * verdict cannot become the leak.
 *
 * A fourth difference from a transient scan, and the one this module got wrong
 * until it was probed: **the shape-only tier blocks here.** `scanForSecrets`
 * blocks only the vendor-prefix tier by default, which is correct for text that
 * is about to be displayed. This screen feeds writers whose output outlives the
 * session — a document exported to plaintext outside the workspace, a decision
 * promoted into the store — so a match that merely looks like a credential is a
 * refusal, not a note. `engineering-memory.ts` already held that standard by
 * redacting the shape-only tier; the screen disagreed with it, and the export
 * path inherited the disagreement and wrote the key verbatim.
 *
 * @see shapeOnly on {@link MemoryScreenVerdict}
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-security
 */

import { describeSecretFindings, scanForSecrets, type SecretFinding } from '../secret-scan.ts'

/** Marker `redactSecretSpans` writes. Recognized so an already-scrubbed entry
 * is reported as redacted rather than re-flagged on every rewrite. */
export const MEMORY_REDACTION_MARKER = '[redacted credential]'

/** Longest identifier kept after sanitization. */
export const MAX_MEMORY_IDENTIFIER_CHARS = 64

/** Longest body kept after normalization. */
export const MAX_MEMORY_TEXT_CHARS = 64 * 1024

/**
 * A value with no recognizable vendor prefix that is still overwhelmingly
 * likely to be a secret rather than a word: a long hex blob (a digest, a key,
 * a session id).
 */
const HEX_BLOB = /^[a-f0-9]{32,}$/iu

/**
 * A long token that carries upper case, lower case, and a digit. This is the
 * shape of a generated key or a base64 secret; prose, a path, or an identifier
 * a human typed never has all three at this length.
 */
const OPAQUE_TOKEN = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9+/_=-]{24,}$/u

/**
 * Reduce an arbitrary string to a safe identifier.
 *
 * Non-ASCII input normalizes away entirely, which is deliberate: a Chinese or
 * accented title becomes an empty identifier and the caller is told rather than
 * handed a path with characters its filesystem may not accept. The trailing
 * dash strip runs *after* truncation, because cutting a long name at the limit
 * is exactly what leaves a trailing separator.
 * @param value - the raw string to reduce.
 * @param maxLength - the maximum identifier length to keep.
 * @returns the normalized identifier.
 */
export function sanitizeMemoryIdentifier(value: string, maxLength: number = MAX_MEMORY_IDENTIFIER_CHARS): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, maxLength)
    .replace(/-+$/u, '')
  if (normalized === '') throw new Error('memory identifier has no characters that can be used in an identifier')
  return normalized
}

/**
 * Cut `value` at `maxLength` without splitting a character.
 *
 * Every other cap in this plugin measures UTF-16 code units, so a boundary can
 * land between the two halves of a surrogate pair. The surviving half is not a
 * character: a JSON encoder writes it as an unpaired escape, every reader shows a
 * replacement glyph, and the damage is visible in the stored body, in the excerpt
 * injected into the prompt, and in the export file the user opens.
 * @param value - the string to cut.
 * @param maxLength - the maximum number of UTF-16 units to keep.
 * @returns the prefix, ending on a whole code point.
 */
export function cutAtCodePointBoundary(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (maxLength >= value.length) return value
  const last = value.charCodeAt(maxLength - 1)
  const splitsPair = last >= 0xd800 && last <= 0xdbff && maxLength < value.length
    && value.charCodeAt(maxLength) >= 0xdc00 && value.charCodeAt(maxLength) <= 0xdfff
  return value.slice(0, splitsPair ? maxLength - 1 : maxLength)
}

/** Keep at most `maxLength` units from the **end**, without starting on the
 *  second half of a pair — the same damage as {@link cutAtCodePointBoundary}, on
 *  the tail slices that keep the newest part of a message.
 * @param value - the string to slice.
 * @param maxLength - the maximum number of UTF-16 units to keep.
 * @returns the tail, starting on a whole code point.
 */
export function tailAtCodePointBoundary(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (maxLength >= value.length) return value
  const start = value.length - maxLength
  const first = value.charCodeAt(start)
  return first >= 0xdc00 && first <= 0xdfff ? value.slice(start + 1) : value.slice(start)
}

/**
 * Normalize memory text so the same evidence always produces the same bytes.
 *
 * Newlines are unified, control characters are dropped (they corrupt a
 * terminal, an XML tag, and a JSON string alike), trailing whitespace on each
 * line is removed, and runs of blank lines collapse to one. The result is
 * trimmed and truncated at a hard character limit.
 * @param value - the raw text to normalize.
 * @param maxLength - the maximum character length to keep.
 * @returns the normalized text.
 */
export function sanitizeMemoryText(value: string, maxLength: number = MAX_MEMORY_TEXT_CHARS): string {
  const normalized = value
    // CRLF and a lone CR both become LF, so a file read on Windows and the same
    // file read on Linux hash identically.
    .replace(/\r\n?/gu, '\n')
    // Keep tab (0x09) and LF (0x0a); drop the rest of C0, DEL, and the C1 range.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return normalized.length > maxLength ? cutAtCodePointBoundary(normalized, maxLength) : normalized
}

/** Whether text already carries the redaction marker this plugin writes.
 * @param text - the text to process.
 * @returns true when the text already contains the redaction marker.
 */
export function containsMemoryRedaction(text: string): boolean {
  return text.includes(MEMORY_REDACTION_MARKER)
}

/**
 * The tag shape the store and the document view both accept.
 *
 * One pattern, two readers — the same treatment `bashCommandOf` and
 * `PATH_ARGUMENT_KEYS` get, and for the same reason. They used to carry separate
 * copies that had drifted by a single character: `{0,63}` in
 * `engineering-memory.ts`'s `normalizeTags`, `{0,62}` in
 * `memory-document.ts`'s `DOCUMENT_TAG_PATTERN`. A 64-character tag therefore
 * passed the store and was then refused by the parser that reads the store's own
 * export — a document the module wrote and could not read back, which is exactly
 * what its "round-tripping is the whole contract" header forbids.
 *
 * The tighter of the two is the one that survives. Shrinking what the store
 * accepts cannot invalidate a document already on disk (the document view was
 * already refusing those tags); widening the parser to match the store would
 * have blessed a shape nothing had ever read.
 */
export const MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u

/**
 * Whether a whole value looks like a credential `secret-scan.ts` cannot name.
 *
 * Applied to a *field*, not to prose: a 200-word paragraph containing one long
 * hex string is a legitimate memory with a digest in it, while a title that is
 * nothing but the digest is not a memory at all. The empty string is not a
 * secret — an absent optional field must not make every entry look suspect.
 * @param value - the field value to test.
 * @returns true when the whole value looks like an unnamed credential.
 */
export function looksLikeMemorySecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  return HEX_BLOB.test(trimmed) || OPAQUE_TOKEN.test(trimmed)
}

/** The candidate entry a persistence decision is made about. */
export interface MemoryScreenInput {
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
}

/** The persistence decision for one candidate entry, with the evidence behind it. */
export interface MemoryScreenVerdict {
  /**
   * False when the entry must not be persisted as written.
   *
   * False for **every** named match, including the shape-only tier — see
   * {@link MemoryScreenVerdict.shapeOnly} for why the durable path cannot use
   * the transient default.
   */
  readonly ok: boolean
  /** Named credential matches at the vendor-prefix tier, never carrying the secret. */
  readonly credentials: readonly SecretFinding[]
  /**
   * Named matches that `secret-scan.ts` reports but does not block by default.
   *
   * The scanner's own default blocks only the vendor-prefix tier, and for a
   * transient scan that is the right call: a rule whose false positives annoy
   * people protects nothing. This boundary is the opposite one. A memory is
   * durable, is re-injected into every later conversation that recalls it, and
   * with team memory leaves the machine, so a match that only *looks* like a
   * credential has to be refused here rather than reported and stored. The shape
   * this covers in practice is the `sk-`-prefixed key of the providers this
   * plugin itself runs against, which is a real credential and not a coincidence.
   */
  readonly shapeOnly: readonly SecretFinding[]
  /** Field names whose whole value looks like an unnamed credential. */
  readonly opaqueFields: readonly string[]
  /** Whether the text already contains a redaction marker. */
  readonly redacted: boolean
  /** One-line human summary, safe to log. */
  readonly summary: string
}

/**
 * Decide whether an entry may become durable memory.
 *
 * Order matters: the credential scan runs over the combined text with the
 * title first, so a finding's index points at a position a caller can explain
 * ("in the title" vs "in the body") without re-searching.
 * @param input - the candidate entry to screen.
 * @returns the memory Screen Verdict.
 */
export function screenMemoryForPersistence(input: MemoryScreenInput): MemoryScreenVerdict {
  const combined = `${input.title}\n${input.body}`
  const scan = scanForSecrets(combined)
  const opaqueFields: string[] = []
  if (looksLikeMemorySecretValue(input.title)) opaqueFields.push('title')
  if (looksLikeMemorySecretValue(input.body)) opaqueFields.push('body')
  for (const [index, tag] of (input.tags ?? []).entries()) {
    if (looksLikeMemorySecretValue(tag)) opaqueFields.push(`tags[${index}]`)
  }
  // Split rather than scan twice, and with the same idiom `engineering-memory.ts`
  // uses, so the two writers cannot drift into disagreeing about which tier is a
  // refusal again.
  const shapeOnly = scan.findings.filter(finding => !scan.blocked.includes(finding))
  const ok = scan.blocked.length === 0 && shapeOnly.length === 0 && opaqueFields.length === 0
  const redacted = containsMemoryRedaction(combined)
  const parts: string[] = [describeSecretFindings(scan.findings)]
  if (shapeOnly.length > 0 && scan.blocked.length === 0) {
    parts.push(`${shapeOnly.length} match(es) at the shape-only tier, which a durable entry refuses`)
  }
  if (opaqueFields.length > 0) parts.push(`${opaqueFields.length} field(s) look like a bare credential: ${opaqueFields.join(', ')}`)
  if (redacted) parts.push('the text already contains a redaction marker')
  return { ok, credentials: scan.blocked, shapeOnly, opaqueFields, redacted, summary: parts.join('; ') }
}
