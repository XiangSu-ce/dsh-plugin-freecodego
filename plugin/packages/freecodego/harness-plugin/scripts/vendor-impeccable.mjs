/**
 * Vendor upstream Impeccable's guidance Skill into this package, cleaned for our
 * audits.
 *
 * Why a script rather than a copy
 * ------------------------------
 * Upstream ships a DSH-ready Skill (`.dsh/skills/impeccable/`), so the *data* can
 * be taken as-is. Three of this package's own rules say why it cannot be taken
 * *unchanged*, and each one has to be a decision that survives the next upstream
 * sync:
 *
 * 1. **The launcher does not exist here.** Every playbook, reference and setup step
 *    addresses the model as `<skill-base-dir>/scripts/impeccable <verb>`, a
 *    self-contained binary that is downloaded on first run. This package is
 *    offline by design and answers detection with `freecodego_design_detect`, so
 *    each invocation is either mapped to that tool or replaced by a sentence that
 *    says what this pack has instead — never left in place, because a Skill that
 *    tells the model to run a binary it cannot run is worse than no Skill.
 * 2. **Scripts and binaries are dropped wholesale.** The launcher, its `.cmd`
 *    shim, and the shipped engine are files this pack will never invoke; they are
 *    also what `dangerousCommandFindings` exists to catch.
 * 3. **The 64 KiB body limit.** `inspectSkillRoot()` refuses a larger `SKILL.md`,
 *    and upstream's grows with every release, so the remedy is a rule — move the
 *    widest section into `references/` and leave a pointer — rather than a file
 *    list that would have to be re-derived each time.
 *
 * `THIRD_PARTY_NOTICES.md` and the `PROVENANCE.md` this writes with `--commit` are
 * what a licence audit reads; this file is the pass that produced them, re-runnable
 * after every upstream sync.
 *
 * What it does NOT do
 * -------------------
 * It writes nothing without `--write`. The default is a dry run printing the full
 * plan, because the interesting output is the *findings* — which verbs got a
 * replacement, which sentences are now false, which artifacts the pack cannot
 * write — and a plan is easier to review than a diff over ~50 files.
 *
 * Usage
 * -----
 *   node scripts/vendor-impeccable.mjs --source <upstream-checkout>
 *   node scripts/vendor-impeccable.mjs --source <upstream-checkout> --commit <sha> --write
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// ------------------------------------------------------------------ 清洗表

/**
 * Verdict glyphs become words, matching the vocabulary the vendored Skill packs
 * already use (`THIRD_PARTY_NOTICES.md` records the same substitution for the Matt
 * Pocock and Superpowers packs). A terminal may draw an emoji-presentation glyph
 * at double width or as a box, and a verdict is the one token a reader acts on.
 */
const GLYPH_WORDS = new Map([
  ['\u2705', 'PASS'],
  ['\u274C', 'FAIL'],
  ['\u26A0\uFE0F', 'UNVERIFIABLE'],
  ['\u26A0', 'UNVERIFIABLE'],
])

const EMOJI_WORDS = new RegExp(`(?:${[...GLYPH_WORDS.keys()].join('|')})+`, 'gu')

/**
 * The whitespace a glyph removal may touch: spaces and tabs, never a newline.
 *
 * A Skill body is mostly markdown, and a newline is structural there — indented
 * examples, fenced code and ASCII diagrams depend on it. Collapsing whitespace
 * more broadly is not a tidy-up, it is a reflow of the document, and the earlier
 * vendoring pass shipped exactly that defect once.
 */
const EMOJI_GAP = new RegExp(`[ \\t]*(?:\\p{Emoji_Presentation}|\\uFE0F|\\u200D)+[ \\t]*`, 'gu')

/** The body limit `inspectSkillRoot()` enforces, in bytes. */
const BODY_LIMIT_BYTES = 64 * 1024

/** Where upstream keeps the DSH-shaped Skill, relative to its repository root. */
const SKILL_DIRECTORIES = ['.dsh', 'skills', 'impeccable']

/**
 * The files this pack keeps: prose, and nothing else.
 *
 * `.md` only. Upstream also ships `scripts/` (the launcher, its Windows shim, and
 * the engine binary) and a `reference/` tree that is entirely markdown, so the
 * rule keeps every reference document and drops every executable — which is what
 * the launcher's absence means here.
 */
const KEPT_EXTENSIONS = new Set(['.md'])

/** Why a directory never reaches the destination. */
const DROPPED_CLASSES = [
  { what: 'the launcher tree (binaries, shims, and whatever sits beside them)', test: (path) => path.startsWith('scripts/') },
  { what: 'executable scripts', test: (path, extension) => ['.mjs', '.cjs', '.js', '.ts', '.sh', '.bash', '.ps1', '.cmd', '.bat', '.exe'].includes(extension) },
]

/**
 * One launcher invocation, its arguments included.
 *
 * Three spellings reach the model and all three have to be consumed:
 *
 * - `<skill-base-dir>/scripts/impeccable <verb>`, which is how every playbook
 *   addresses the launcher;
 * - `.dsh/skills/impeccable/scripts/impeccable.cmd <verb>`, the Windows fallback
 *   for a shell without `sh`;
 * - a bare `scripts/impeccable <verb>`, which the routing table uses.
 *
 * The trailing run consumes the arguments with it, so a mapped verb cannot leave
 * `--json` or a path behind pointing at a tool whose schema has no such field. It
 * takes flags, quoted strings, `<placeholder>` tokens, and words that look like
 * paths or file names — and stops at anything else, so prose after an invocation
 * survives: `detect src/App.tsx and then reason about it` keeps its second half.
 */
const ARGUMENT = '(?:--?[\\w-]+(?:[= ]\\s*[^\\s`]+)?|"[^"]*"|\'[^\']*\'|<[^>\\s]+>|[^\\s`\'"]*[/\\\\][^\\s`\'"]*|[\\w-]+\\.[A-Za-z]{1,5})'
const INVOCATION = new RegExp('(?:[^\\s`\'"]*\\/)?scripts\\/impeccable(?:\\.cmd)?\\s+(?:[a-z][a-z-]*)\\b(?:\\s+' + ARGUMENT + ')*', 'gu')

/** The verb inside one matched invocation. */
const VERB = /scripts\/impeccable(?:\.cmd)?\s+([a-z][a-z-]*)/u

/**
 * What replaces an invocation whose verb this pack cannot perform.
 *
 * One entry per verb rather than one per site, because the sites collapse: the
 * launcher is addressed by every playbook, and what differs between them is one
 * part of speech. Each sentence has to be **true and useful on its own**, since it
 * replaces a step the reader was about to take: it either names the local
 * substitute that exists, or states plainly that nothing does.
 *
 * No apostrophes, so the entries stay single-quoted and a later edit cannot
 * terminate one by accident.
 */
const PROSE_BY_VERB = new Map([
  ['context', 'This pack has no context launcher: read the project PRODUCT.md and DESIGN.md directly, and never invent the context they are missing.'],
  ['pin', 'This pack has no per-command shortcut mechanism, so the playbook is read on demand instead.'],
  ['unpin', 'This pack has no per-command shortcut mechanism, so there is nothing to remove.'],
  ['hooks', 'The design detector runs when it is switched on and the model calls it, so this pack manages no project hook here.'],
  ['doctor', 'The Design settings page reports the state of this pack, including whether an installed Impeccable engine was found, so there is no separate doctor step.'],
])

/** The one verb that maps to a tool this package registers. */
const DETECT_VERB = 'detect'

/** What a detected invocation becomes. */
const DETECT_REPLACEMENT = 'freecodego_design_detect'

/** What replaces an unknown verb inside a sentence. */
const UNSUPPORTED_INLINE = 'a capability this pack does not provide'

/**
 * A marker that carries the verb from the removal pass to the prose pass.
 *
 * The two passes cannot be merged: removal knows the verb but nothing about the
 * sentence around it, and the prose pass sees a sentence but no longer knows what
 * it used to say. Text rather than a control character so a finding can quote it.
 */
const MARK_OPEN = '<<FCG-IMPECCABLE:'
const MARK_CLOSE = '>>'
const MARK = /<<FCG-IMPECCABLE:([a-z-]+)>>/gu

/**
 * Sentences the launcher's removal falsifies.
 *
 * Upstream's Setup step ends by describing what to do when the launcher refuses
 * or fails, which is a claim about a program this pack does not have. The
 * prohibition and the intent are kept and the mechanism is corrected, because the
 * reader loses nothing when a claim is corrected and everything when a step
 * disappears.
 *
 * Keyed by pattern rather than by file, and **without the `g` flag**: `test` and
 * `replace` have to agree on what they matched, and a global pattern advances
 * `lastIndex` so the second call would see a different document than the first.
 */
const CLAIM_REPAIRS = [
  {
    id: 'launcher-unavailable',
    pattern: /\*\*Launcher unavailable:\*\*[^\n]*/u,
    replacement: '**No launcher here:** this pack reads the project context directly — PRODUCT.md, DESIGN.md, and the surface briefs when they exist — and never invents what they are missing.',
    reason: 'this pack ships no launcher, so the failure path it describes cannot happen',
  },
]

/**
 * Project artifacts this pack does not write.
 *
 * Upstream's commands record what they learned in `.impeccable/` (config,
 * per-surface briefs, critique history) and beside DESIGN.md. A vendored playbook
 * that tells the model to write one of them is naming a step this pack cannot
 * take, so each mention is reported with the line that makes it. Reported rather
 * than rewritten because the remedy is a sentence about *this pack's* artifacts,
 * and the surrounding paragraph usually explains a workflow that has changed.
 */
const UNAVAILABLE_ARTIFACT = /\.impeccable\/|DESIGN\.md\.json|PRODUCT\.md\.json/gu

// ------------------------------------------------------------------ 工具

const slash = (value) => value.split(sep).join('/')

/** Walk a directory, returning every file path relative to `root`, forward-slashed. */
function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else if (entry.isFile()) out.push(slash(relative(root, full)))
  }
  return out
}

const extensionOf = (name) => {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index).toLowerCase()
}

/**
 * A content digest of the whole upstream Skill tree, as the vendoring provenance.
 *
 * Upstream has no commit to cite unless one is passed in, so the digest is the
 * citable fact: a future sync recomputes it and knows immediately whether anything
 * moved. Path and content are hashed separately (the path, a NUL, then the file's
 * own SHA-256) so a rename cannot be cancelled out by an offsetting edit, and the
 * `sort()` is load-bearing — `readdirSync` makes no ordering guarantee, so without
 * it the same tree could digest differently on two machines.
 *
 * @param root the upstream Skill directory
 * @returns the digest and what it was computed over
 */
function digestTree(root) {
  const hash = createHash('sha256')
  const entries = walk(root).sort()
  let bytes = 0
  for (const entry of entries) {
    const buffer = readFileSync(join(root, entry))
    bytes += buffer.length
    hash.update(entry)
    hash.update('\0')
    hash.update(createHash('sha256').update(buffer).digest())
  }
  return { digest: hash.digest('hex'), files: entries.length, bytes }
}

/** The SHA-256 of one file, for the provenance table. */
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * Strip emoji-presentation characters without reflowing the text.
 *
 * A glyph at the start of a line disappears; anywhere else it becomes one space,
 * because deleting a glyph that sits between two words would join them. Only the
 * glyph's own neighbourhood is collapsed — see {@link EMOJI_GAP}.
 */
function stripEmoji(text) {
  // Order matters: EMOJI_GAP removes a lone variation selector, so running it
  // first would leave the glyph behind and no word substitution could fire.
  return text
    .replace(EMOJI_WORDS, (match) => GLYPH_WORDS.get(match) ?? '')
    .replace(EMOJI_GAP, (match, offset, whole) => {
      const previous = whole[offset - 1]
      return previous === undefined || previous === '\n' ? '' : ' '
    })
}

/** Correct the sentences the launcher's removal falsifies. */
function repairFalseClaims(text, file, applied) {
  const findings = []
  let output = text
  for (const repair of CLAIM_REPAIRS) {
    if (!repair.pattern.test(output)) continue
    output = output.replace(repair.pattern, repair.replacement)
    applied.add(repair)
    findings.push({ kind: 'claim-repaired', file, text: `${repair.id}: ${repair.reason}` })
  }
  return { text: output, findings }
}

/**
 * Rewrite every launcher invocation, and report what else the file still says.
 *
 * Prose and code are treated differently, and the difference is the whole reason
 * this is one pass rather than a global substitution:
 *
 * - **In prose**, an invocation is named in passing, so what changes is the
 *   sentence around it. A mapped verb becomes the tool, and any other verb becomes
 *   a marker the sentence pass replaces with a sentence naming what this pack has
 *   instead — or, where nobody has written one, with a deletion that has to be
 *   reviewed by hand.
 * - **In a fenced code block**, the command *is* the instruction. `detect` is
 *   rewritten in place, because this pack answers it, and every other verb is left
 *   exactly as it is and reported as unmapped: replacing a command with a sentence
 *   inside a code fence would ship a block that is no longer runnable and no
 *   longer honest. Those findings refuse the write, so a person decides.
 *
 * @param text the already-cleaned file text
 * @param file the path within the pack, for the finding record
 * @param applied collects the claim repairs that fired
 * @returns the rewritten text and the findings this file produced
 */
function rewriteInvocations(text, file, applied) {
  const findings = []
  const kept = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; kept.push(line); continue }
    const pattern = new RegExp(INVOCATION.source, 'gu')
    const matches = [...line.matchAll(pattern)]
    if (matches.length === 0) { kept.push(line); continue }
    if (inFence) {
      // Inside a fence the command is the instruction, so the fragment handling is
      // different in one way: a whole-line invocation loses the whole line, because
      // what is left otherwise is a tool name followed by a shell argument list —
      // the defect that shipped `render --quality high` as a tool name and a flag in
      // the sibling pass. The finding carries the original text, so a reviewer can
      // rewrite the block as a tool call.
      const verb = VERB.exec(matches[0][0])?.[1] ?? ''
      if (verb !== DETECT_VERB) {
        findings.push({ kind: 'unmapped-invocation', file, text: `${matches[0][0].trim()} (${verb})` })
        kept.push(line)
        continue
      }
      findings.push({ kind: 'mapped', file, text: `${matches[0][0].trim()} -> ${DETECT_REPLACEMENT}` })
      const indent = line.slice(0, line.length - line.trimStart().length)
      const wholeLine = line.trim().replace(/^\$\s*/u, '').replace(new RegExp(`^${INVOCATION.source}$`, 'u'), '') === ''
      kept.push(wholeLine
        ? `${indent}${DETECT_REPLACEMENT}`
        : line.replace(new RegExp(INVOCATION.source, 'gu'), DETECT_REPLACEMENT))
      continue
    }
    const verbs = matches.map((match) => VERB.exec(match[0])?.[1]).filter(Boolean)
    // A line that is nothing but an invocation has no prose to keep, so mapping it
    // to the tool (or deleting it) is the whole remedy. A line with prose around it
    // carries the marker to the sentence pass instead, and is handled there.
    const bare = line.trim().replace(new RegExp(`^${INVOCATION.source}$`, 'u'), '')
    if (bare === '' && verbs.every((verb) => verb === DETECT_VERB)) {
      findings.push({ kind: 'removed-line', file, text: line.trim() })
      continue
    }
    kept.push(line.replace(new RegExp(INVOCATION.source, 'gu'), (match) => {
      const verb = VERB.exec(match)?.[1] ?? ''
      if (verb === DETECT_VERB) {
        findings.push({ kind: 'mapped', file, text: `${match.trim()} -> ${DETECT_REPLACEMENT}` })
        return DETECT_REPLACEMENT
      }
      findings.push({ kind: 'replaced-invocation', file, text: `${match.trim()} (${verb})` })
      return `${MARK_OPEN}${verb}${MARK_CLOSE}`
    }))
  }

  const claims = repairFalseClaims(kept.join('\n'), file, applied)
  findings.push(...claims.findings)
  const prose = rewriteProseSentences(claims.text, file)
  findings.push(...prose.findings)

  // A defensive probe, and the reason it is here rather than in the passes above:
  // an invocation that survived all three is one no rule knows, and shipping it is
  // a Skill instructing a program that does not exist.
  //
  // It reads prose only, because the fence branch above has already reported every
  // fenced invocation it left alone: a probe that read the code blocks too would
  // describe each of those sites twice, which is the defect the sibling pass shipped
  // once and its spec now pins.
  for (const match of unfencedText(prose.text).matchAll(new RegExp(INVOCATION.source, 'gu'))) {
    findings.push({ kind: 'unmapped-invocation', file, text: match[0].trim() })
  }
  for (const match of prose.text.matchAll(UNAVAILABLE_ARTIFACT)) {
    findings.push({ kind: 'project-artifacts', file, text: match[0] })
  }
  return { text: prose.text, findings }
}

/**
 * The same text with every fenced line blanked out.
 *
 * Blanked rather than removed so that line numbering survives, and used by the
 * passes whose question is about *prose*: a fence holds instructions, and a rule
 * that reads one as a sentence tells the reader something about a document that is
 * not there.
 */
function unfencedText(text) {
  let inFence = false
  return text.split('\n').map((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; return '' }
    return inFence ? '' : line
  }).join('\n')
}

/**
 * Replace the sentence around an invocation, verb by verb.
 *
 * Sentence level rather than fragment level: the fragment is the reason the
 * instruction cannot be followed, but the sentence is the unit a reader acts on,
 * and a sentence that keeps a placeholder reads as a step nobody can take. A
 * sentence whose verb has no entry is **deleted** and reported, because an
 * unsupported step nobody has written a replacement for is one the reader would
 * fail at.
 *
 * Only lines carrying a marker are touched, and a marker is only ever put into
 * prose (see {@link rewriteInvocations}), so a fenced code block cannot be reflowed
 * by this pass even though it does not test for one.
 */
function rewriteProseSentences(text, file) {
  const findings = []
  const output = text.split('\n').map((line) => {
    if (!line.includes(MARK_OPEN)) return line
    return line
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => {
        const match = new RegExp(MARK.source, 'u').exec(sentence)
        if (match === null) return sentence
        const replacement = PROSE_BY_VERB.get(match[1])
        if (replacement === undefined) {
          findings.push({ kind: 'needs-review', file, text: sentence.trim().slice(0, 200) })
          return ''
        }
        findings.push({ kind: 'prose-rewritten', file, text: `${match[1]}: ${replacement}` })
        return replacement
      })
      .filter((sentence) => sentence !== '')
      .join(' ')
  })
  return { text: output.join('\n').replace(MARK, UNSUPPORTED_INLINE), findings }
}

/**
 * Move the largest section out of a body that is over budget, and point at it.
 *
 * The rule is general rather than a list of files: any body over the limit gives
 * up its widest `####` section to `references/`, repeatedly, until it fits. A body
 * is loaded whenever the Skill is selected, so its size is paid in every window it
 * is chosen for, while a linked reference is paid only when the reader follows it.
 */
function enforceBodyBudget(text) {
  const extracted = []
  let output = text
  for (let attempt = 0; attempt < 8 && Buffer.byteLength(output, 'utf8') > BODY_LIMIT_BYTES; attempt += 1) {
    const lines = output.split('\n')
    let best
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^#### /.test(lines[index])) continue
      let end = index + 1
      while (end < lines.length && !/^#{1,4} /.test(lines[end])) end += 1
      const bytes = Buffer.byteLength(lines.slice(index, end).join('\n'), 'utf8')
      if (best === undefined || bytes > best.bytes) best = { index, end, bytes }
    }
    if (best === undefined) break
    const title = lines[best.index].replace(/^#### /, '').trim()
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)
    const name = `reference/${slug}.md`
    const section = lines.slice(best.index, best.end).join('\n').replace(/^#### /u, '## ')
    extracted.push({ path: name, text: section })
    const pointer = `#### ${title}\n\nThis section is in [\`${name}\`](${name}) — read it before acting on it.`
    output = [...lines.slice(0, best.index), ...pointer.split('\n'), ...lines.slice(best.end)].join('\n')
  }
  if (Buffer.byteLength(output, 'utf8') > BODY_LIMIT_BYTES) {
    extracted.push({ path: undefined, text: `${Buffer.byteLength(output, 'utf8')} bytes remain over the limit` })
  }
  return { text: output, extracted }
}

// ------------------------------------------------------------------ 主流程

function parseArguments(argv) {
  const options = { source: undefined, out: undefined, commit: undefined, date: undefined, write: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') options.source = argv[++index]
    else if (argument === '--out') options.out = resolve(argv[++index] ?? '')
    else if (argument === '--commit') options.commit = argv[++index]
    else if (argument === '--date') options.date = argv[++index]
    else if (argument === '--write') options.write = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
  }
  return options
}

/**
 * Say something about the run without corrupting the machine-readable output.
 *
 * Under `--json`, stdout carries the report and nothing else, so every human
 * sentence goes to stderr: a report followed by a status line means every consumer
 * has to find where the JSON stops, and the first consumer to guess wrong is the
 * test suite. A mode called `--json` should not need to be told where its JSON ends.
 */
function note(options, message) {
  if (options.json === true) console.error(message)
  else console.log(message)
}

function usage() {
  return [
    'Vendor upstream Impeccable\u2019s guidance Skill into this package, cleaned for its audits.',
    '',
    '  --source <dir>   upstream checkout containing `.dsh/skills/impeccable/` (required)',
    '  --out <dir>      destination (default: assets/design/impeccable)',
    '  --commit <sha>   upstream commit this snapshot came from, written to PROVENANCE.md',
    '  --date <date>    snapshot date for PROVENANCE.md (default: today, UTC)',
    '  --write          actually write; without it this is a dry run',
    '  --json           machine-readable report on stdout',
  ].join('\n')
}

/** The `PROVENANCE.md` this run records, in the shape the catalogue already uses. */
function provenanceDocument(options, tree, rows) {
  return [
    '# Impeccable Skill provenance',
    '',
    'The Skill documents under this directory are vendored third-party prose from',
    '[pbakaus/impeccable](https://github.com/pbakaus/impeccable). They are not covered by',
    'this package\u2019s AGPL-3.0-only license; this directory\u2019s `LICENSE` carries the',
    'upstream Apache-2.0 terms.',
    '',
    '## Source and snapshot',
    '',
    '| | |',
    '|---|---|',
    '| Project | Impeccable |',
    '| Repository | https://github.com/pbakaus/impeccable |',
    `| Snapshot commit | \`${options.commit ?? 'unrecorded'}\` |`,
    `| Snapshot date | ${options.date ?? new Date().toISOString().slice(0, 10)} |`,
    '| License | Apache-2.0 |',
    `| Upstream tree digest | \`sha256:${tree.digest}\` |`,
    `| Upstream tree | ${tree.files} files, ${tree.bytes} bytes |`,
    '',
    'Every file under `reference/` was carried over as prose. The launcher invocations',
    'upstream\u2019s playbooks are written around were rewritten for this pack: `detect`',
    'becomes this plugin\u2019s `freecodego_design_detect`, and the launcher\u2019s other verbs',
    'become a sentence naming what this pack has instead, because nothing here runs a',
    'downloaded binary. The `scripts/` tree (the launcher, its Windows shim and the',
    'packaged engine) is not vendored at all.',
    '',
    '| Vendored file | SHA-256 |',
    '|---|---|',
    ...rows.map((row) => `| \`${row.file}\` | \`${row.sha256}\` |`),
    '',
  ].join('\n')
}

function main(argv) {
  const options = parseArguments(argv)
  if (options.help === true) { console.log(usage()); return 0 }
  if (options.source === undefined) { console.error(`--source is required\n\n${usage()}`); return 2 }

  const skillRoot = join(resolve(options.source), ...SKILL_DIRECTORIES)
  if (!existsSync(skillRoot)) {
    console.error(`no ${slash(join(...SKILL_DIRECTORIES))}/ under ${resolve(options.source)}`)
    return 2
  }
  const out = options.out ?? join(process.cwd(), 'assets', 'design', 'impeccable')

  const findings = []
  const plan = []
  const dropped = []
  const appliedClaims = new Set()

  for (const file of walk(skillRoot).sort()) {
    const source = join(skillRoot, file)
    const bytes = statSync(source).size
    const extension = extensionOf(file)
    const droppedClass = DROPPED_CLASSES.find((entry) => entry.test(file, extension))
    if (droppedClass !== undefined) { dropped.push({ file, bytes, reason: droppedClass.what }); continue }
    if (!KEPT_EXTENSIONS.has(extension)) { dropped.push({ file, bytes, reason: `extension ${extension || '(none)'} is not a knowledge file` }); continue }

    const raw = readFileSync(source, 'utf8')
    // Rewrites precede the budget pass, not the other way round: the budget is a
    // constraint on what will be written, and a rewrite changes the length.
    const { text: rewritten, findings: local } = rewriteInvocations(stripEmoji(raw), file, appliedClaims)
    findings.push(...local)
    let text = rewritten
    if (file === 'SKILL.md') {
      const budget = enforceBodyBudget(text)
      text = budget.text
      for (const extra of budget.extracted) {
        if (extra.path === undefined) { findings.push({ kind: 'over-body-budget', file, text: extra.text }); continue }
        findings.push({ kind: 'extracted', file: extra.path, text: `${Buffer.byteLength(extra.text, 'utf8')} bytes` })
        plan.push({ file: extra.path, source, destination: join(out, extra.path), bytes: Buffer.byteLength(extra.text, 'utf8'), sha256: createHash('sha256').update(extra.text).digest('hex'), text: extra.text, changed: true })
      }
    }
    plan.push({ file, source, destination: join(out, file), bytes, sha256: sha256(source), text, changed: text !== raw })
  }

  // ---------------------------------------------------------------- 报告

  const byKind = (kind) => findings.filter((finding) => finding.kind === kind)
  const tree = digestTree(skillRoot)
  const summary = {
    upstream: { path: slash(join(...SKILL_DIRECTORIES)), tree },
    kept: { files: plan.length, bytes: plan.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0) },
    dropped: {
      files: dropped.length,
      bytes: dropped.reduce((total, entry) => total + entry.bytes, 0),
      byReason: Object.entries(dropped.reduce((counts, entry) => { counts[entry.reason] = (counts[entry.reason] ?? 0) + 1; return counts }, {})),
    },
    findings: {
      mapped: byKind('mapped'),
      'removed-line': byKind('removed-line'),
      'replaced-invocation': byKind('replaced-invocation'),
      'prose-rewritten': byKind('prose-rewritten'),
      'needs-review': byKind('needs-review'),
      'unmapped-invocation': byKind('unmapped-invocation'),
      'project-artifacts': byKind('project-artifacts'),
      extracted: byKind('extracted'),
      'over-body-budget': byKind('over-body-budget'),
      'claim-repaired': byKind('claim-repaired'),
    },
    /**
     * The claim audit, the other direction from `findings`: the false sentences are
     * written down first and the question is whether each was still there to fix. A
     * repair that could not fire means upstream reworded the sentence, so somebody
     * has to read it again — not that the vendoring stops, since the text the
     * decision was made against is provably gone.
     */
    claims: {
      repaired: byKind('claim-repaired'),
      unmatched: CLAIM_REPAIRS
        .filter((repair) => !appliedClaims.has(repair))
        .map((repair) => ({ id: repair.id, pattern: String(repair.pattern), reason: repair.reason })),
    },
    changedFiles: plan.filter((entry) => entry.changed).length,
  }

  if (options.json === true) console.log(JSON.stringify({ summary, dropped }, null, 2))
  else {
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
    console.log(`upstream          : ${summary.upstream.path}`)
    console.log(`upstream tree     : sha256:${tree.digest}`)
    console.log(`                    ${tree.files} files, ${tree.bytes} bytes`)
    console.log('                    (cite this in PROVENANCE.md — upstream ships no version beyond SKILL.md)')
    console.log(`kept              : ${summary.kept.files} files, ${kb(summary.kept.bytes)}`)
    console.log(`dropped           : ${summary.dropped.files} files, ${kb(summary.dropped.bytes)}`)
    for (const [reason, count] of summary.dropped.byReason) console.log(`                    - ${count} x ${reason}`)
    console.log(`files changed     : ${summary.changedFiles}`)
    console.log(`launcher mapped   : ${summary.findings.mapped.length}`)
    console.log(`invocations replaced: ${summary.findings['replaced-invocation'].length}`)
    console.log('')
    const list = (title, rows) => {
      console.log(`${title} (${rows.length})`)
      if (rows.length === 0) console.log('  (none)')
      for (const row of rows.slice(0, 40)) console.log(`  ${row.file}: ${row.text}`)
      if (rows.length > 40) console.log(`  ... and ${rows.length - 40} more`)
      console.log('')
    }
    list('MAPPED TO A TOOL — the detector', summary.findings.mapped)
    list('REMOVED LINES — an invocation with nothing else on the line', summary.findings['removed-line'])
    list('REPLACED INVOCATIONS — a launcher verb this pack answers differently', summary.findings['replaced-invocation'])
    list('PROSE REWRITTEN — the sentence around a replaced invocation', summary.findings['prose-rewritten'])
    list('CLAIMS REPAIRED — a sentence the removal falsified, corrected', summary.findings['claim-repaired'])
    list('CLAIM REPAIR DID NOT APPLY — re-read the sentence before shipping', summary.claims.unmatched)
    list('PROJECT ARTIFACTS — a file this pack does not write', summary.findings['project-artifacts'])
    list('EXTRACTED — moved out of a body that was over budget', summary.findings.extracted)
    list('OVER BODY BUDGET — still over after extraction, needs a hand split', summary.findings['over-body-budget'])
    list('NEEDS REVIEW — a sentence names a launcher verb with no replacement', summary.findings['needs-review'])
    list('UNMAPPED INVOCATION — add a mapping or the Skill names a program that does not exist', summary.findings['unmapped-invocation'])
  }

  if (options.write !== true) { note(options, 'dry run — pass --write to materialise'); return 0 }
  // Two hard invariants refuse a write: an invocation with no mapping is a Skill
  // instructing a program that does not exist, and a body over the audit limit is
  // one `inspectSkillRoot()` will refuse. `needs-review` prose is a warning on
  // purpose — it needs a human sentence, and refusing until every one is rewritten
  // would mean nothing is ever vendored.
  if (findings.some((finding) => finding.kind === 'over-body-budget' || finding.kind === 'unmapped-invocation')) {
    console.error('refusing to write: unresolved body-budget and unmapped-invocation findings above')
    return 1
  }

  rmSync(out, { recursive: true, force: true })
  for (const entry of plan) {
    mkdirSync(dirname(entry.destination), { recursive: true })
    writeFileSync(entry.destination, entry.text)
  }
  if (options.commit !== undefined) {
    const rows = [...plan].sort((left, right) => left.file.localeCompare(right.file))
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'PROVENANCE.md'), provenanceDocument(options, tree, rows))
  }
  note(options, `wrote ${plan.length} files to ${slash(out)}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
