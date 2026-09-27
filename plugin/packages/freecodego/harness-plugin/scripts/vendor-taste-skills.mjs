/**
 * Vendor the Taste-Skill pack into this package, cleaned for our audits.
 *
 * Why a script rather than a copy
 * ------------------------------
 * Upstream is pure Markdown — 13 `SKILL.md` bodies and one companion document —
 * so the *content* can be taken whole. Two of this package's own rules still have
 * to be answered as rules rather than as edits, so that a re-sync replays them
 * instead of requiring someone to remember what was changed:
 *
 * 1. **`inspectSkillRoot()` warns over a 64 KiB body** (`src/engineering.ts`), and
 *    the two vendoring passes already in this package treat that number as a hard
 *    rule — the HyperFrames pack split one body to meet it. Upstream's flagship
 *    body is 87 KB, so the general remedy is applied rather than a rewrite: the
 *    widest section moves to `references/` and the body links it. Nothing is
 *    deleted, and the move is reported per section.
 * 2. **Bundled prose carries no emoji**, and the substitution vocabulary is the
 *    same across every vendored pack (verdict glyphs become
 *    `PASS`/`FAIL`/`UNVERIFIABLE`). `tests/engineering.spec.ts` sweeps only the
 *    three engineering roots today, so this is convention rather than a gate for
 *    the design pack — which is exactly why it belongs in the script.
 *
 * The 5,000-token `DEFAULT_SKILL_TOKEN_LIMIT` is deliberately **not** applied:
 * it is the budget this package enforces on Skills it *publishes*, and these
 * bodies are vendored upstream text that a user switches on per row and pays for
 * only when a Skill is actually selected. Every body's size is reported instead,
 * so the decision is visible rather than assumed.
 *
 * What it does NOT do
 * -------------------
 * It writes nothing without `--write`. The default is a dry run printing the
 * whole plan, because the interesting output is the findings — which bodies needed
 * a section moved, which files carried glyphs, which Skill cannot be parsed.
 *
 * Two sources, one rule table
 * ----------------------------
 * `--source <dir>` reads an upstream checkout, which is what a maintainer who has
 * cloned the repository will do and what the regression spec drives, since a test
 * cannot fetch. Without it the script reads the same paths over the GitHub API,
 * which is how this pack was vendored: `raw.githubusercontent.com` is not reachable
 * from every environment, while `api.github.com` is, and the contents endpoint
 * returns a file's bytes rather than a base64 envelope. Both paths produce the same
 * plan, because the rules run on the file's text and only the bytes' *origin*
 * differs.
 *
 * Usage
 * -----
 *   node scripts/vendor-taste-skills.mjs --source <upstream-checkout>
 *   node scripts/vendor-taste-skills.mjs --commit <sha> --write
 *   node scripts/vendor-taste-skills.mjs --out assets/design/taste --json
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// ------------------------------------------------------------------ 上游

/** Upstream, by the two facts a provenance file has to cite. */
const UPSTREAM = {
  project: 'Taste-Skill',
  repository: 'https://github.com/Leonxlnx/taste-skill',
  licence: 'MIT',
  copyright: 'Copyright (c) 2026 Leonxlnx',
  slug: 'Leonxlnx/taste-skill',
}

/** The body limit `inspectSkillRoot()` reports, in bytes. */
const BODY_LIMIT_BYTES = 64 * 1024

/** The only upstream tree this pack mounts; anything else is a finding. */
const SOURCE_PREFIX = 'skills/'

/** Where a moved section goes, inside its own Skill directory. */
const REFERENCE_PREFIX = 'references'

/** Upstream's own index of the pack. Kept out: the row's card is our index. */
const UPSTREAM_INDEX = 'skills/llms.txt'

// ------------------------------------------------------------------ 清洗表

/**
 * Verdict glyphs whose meaning is a word in the vendored packs.
 *
 * `THIRD_PARTY_NOTICES.md` records this substitution for the Matt Pocock,
 * Superpowers and HyperFrames packs, because a terminal may draw an
 * emoji-presentation glyph at double width or as a box and a verdict is the one
 * token a reader acts on. Spelling them the same way here keeps one vocabulary
 * across every pack this package ships.
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
 * A Skill body is markdown, and a newline is structural in it — indented examples,
 * fenced code and ASCII diagrams depend on one. Collapsing whitespace more broadly
 * is not a tidy-up, it is a reflow of the document, and an earlier vendoring pass
 * in this package shipped exactly that defect once.
 */
const EMOJI_GAP = /[ \t]*(?:\p{Emoji_Presentation}|\uFE0F\u200D?|\u200D)+[ \t]*/gu

/**
 * Programs a vendored body must not tell the model to run.
 *
 * Upstream's own installer (`skill.sh`, a bash registry that prints a path) and
 * the agent hosts it ships `.claude-plugin` metadata for are not part of this
 * pack: a body that reaches for one is instructing the model to use a program
 * this plugin does not provide, which `THIRD_PARTY_NOTICES.md` records as the
 * reason the HyperFrames pack rewrites invocations at all. Ordinary project
 * tooling (`npx shadcn@latest add …`, `npm i gsap`) is *not* in this list — those
 * are commands the model runs in the user's own project, and they are what the
 * body is for.
 */
const UNAVAILABLE_PROGRAM = /(?:^|[\s`"'(])(?:\.\/)?skill\.sh\b|\bclaude\s+(?:plugin|marketplace)\b|~\/\.claude\//gu

/** The heading levels a section may be lifted from, deepest first. */
const MOVABLE_HEADINGS = ['####', '###', '##']

// ------------------------------------------------------------------ 工具

const slash = (value) => value.split('\\').join('/')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Price a body the way `token-estimate.ts` does, for the plan table. */
const tokens = (text) => Math.ceil([...text].length / 4)

/**
 * Ask the GitHub API for one path, through the contents endpoint.
 *
 * `Accept: application/vnd.github.raw` returns the file's bytes rather than a
 * base64 envelope, so what lands on disk is what upstream publishes — and the
 * tree API's `size` is then an independent check that nothing was truncated.
 */
async function github(path, accept = 'application/vnd.github+json') {
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM.slug}/${path}`, {
    headers: { accept, 'user-agent': 'dsh-freecodego-vendor-taste-skills', 'x-github-api-version': '2022-11-28' },
  })
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`)
  }
  return accept === 'application/vnd.github.raw' ? Buffer.from(await response.arrayBuffer()) : response.json()
}

/** Remove emoji-presentation glyphs without reflowing the text. */
function stripEmoji(text) {
  let removed = 0
  const output = text
    .replace(EMOJI_WORDS, (match) => {
      removed += 1
      return GLYPH_WORDS.get(match) ?? ''
    })
    .replace(EMOJI_GAP, (match, offset, whole) => {
      if (!/\p{Emoji_Presentation}|\uFE0F/u.test(match)) return match
      removed += 1
      const previous = whole[offset - 1]
      return previous === undefined || previous === '\n' ? '' : ' '
    })
  return { text: output, removed }
}

/** The frontmatter fields a Skill the parser can read must carry. */
function frontmatter(text) {
  if (!text.startsWith('---\n')) return { ok: false, reason: 'no frontmatter block' }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { ok: false, reason: 'frontmatter block is not closed' }
  const block = text.slice(4, end)
  const name = /^name:\s*(\S.*)$/mu.exec(block)?.[1]?.trim()
  const description = /^description:\s*(\S.*)$/mu.exec(block)?.[1]?.trim()
  if (name === undefined) return { ok: false, reason: 'frontmatter has no `name`' }
  if (description === undefined) return { ok: false, reason: 'frontmatter has no `description`' }
  return { ok: true, name, description }
}

/**
 * Lift the widest section out of a body until it fits the engineering limit.
 *
 * The rule is general rather than a list of sections: a body over the limit gives
 * up its widest section, repeatedly, until it fits. A body is loaded whenever the
 * Skill is selected, while a linked reference is read only when the reader
 * follows it — so the split is where the detail belongs, and the link is left in
 * the exact place the section was.
 */
function enforceBodyLimit(text) {
  const moved = []
  let output = text
  for (let attempt = 0; attempt < 12 && Buffer.byteLength(output, 'utf8') > BODY_LIMIT_BYTES; attempt += 1) {
    const lines = output.split('\n')
    let best
    for (const heading of MOVABLE_HEADINGS) {
      const prefix = `${heading} `
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].startsWith(prefix)) continue
        let end = index + 1
        const wider = new RegExp(`^#{1,${heading.length}} `, 'u')
        while (end < lines.length && !wider.test(lines[end])) end += 1
        const bytes = Buffer.byteLength(lines.slice(index, end).join('\n'), 'utf8')
        if (best === undefined || bytes > best.bytes) best = { index, end, bytes, heading }
      }
      if (best !== undefined) break
    }
    if (best === undefined) break
    const title = lines[best.index].slice(best.heading.length + 1).trim()
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)
    const file = `${REFERENCE_PREFIX}/${slug}.md`
    const section = lines.slice(best.index, best.end).join('\n').replace(`${best.heading} `, '## ')
    const document = `# ${title}\n\n${section.replace(/^## [^\n]*\n+/u, '')}`
    moved.push({ file, title, level: best.heading, bytes: Buffer.byteLength(section, 'utf8'), text: document })
    const pointer = `${best.heading} ${title}\n\nThis section is kept in [\`${file}\`](${file}) — read it before acting on it.`
    output = [...lines.slice(0, best.index), ...pointer.split('\n'), ...lines.slice(best.end)].join('\n')
  }
  return { text: output, moved, over: Buffer.byteLength(output, 'utf8') > BODY_LIMIT_BYTES }
}

/**
 * The `PROVENANCE.md` this run records, in the shape the catalogue already uses.
 *
 * Per-file SHA-256 rather than a tree digest, because these are the files a
 * licence audit opens one at a time, and the bytes cited are the bytes shipped:
 * the digest of the *written* file, taken after the two adaptations above.
 */
function provenanceDocument(options, snapshot, rows, moved) {
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const body = [
    '# Taste-Skill provenance',
    '',
    'The Markdown under this directory is vendored third-party prose from',
    `[${UPSTREAM.slug}](${UPSTREAM.repository}). It is not covered by this package's`,
    'AGPL-3.0-only license; this directory\'s `LICENSE` carries the upstream MIT terms.',
    '',
    '## Source and snapshot',
    '',
    '| | |',
    '|---|---|',
    `| Project | ${UPSTREAM.project} |`,
    `| Repository | ${UPSTREAM.repository} |`,
    `| Snapshot commit | \`${options.commit}\` |`,
    `| Snapshot commit date | ${snapshot.date} |`,
    `| License | ${UPSTREAM.licence} |`,
    `| Copyright | ${UPSTREAM.copyright} |`,
    `| Vendored files | ${String(rows.length)} |`,
    '',
    '## What was adapted, and why',
    '',
    'The text is upstream. Two adaptations are applied by',
    '`scripts/vendor-taste-skills.mjs` as rules, so a re-sync replays them rather',
    'than requiring anyone to remember them:',
    '',
    '- **Emoji are removed.** A terminal may draw an emoji-presentation glyph at',
    '  double width or as a box, and these bodies are rendered in the Skills page,',
    '  copied into a workspace and read as prompt text. Verdict glyphs keep their',
    '  meaning as words (`PASS` / `FAIL` / `UNVERIFIABLE`), matching the',
    '  substitution the other vendored packs record; every other glyph is dropped,',
    '  and only the whitespace immediately around it is collapsed, so indented',
    '  examples and ASCII diagrams survive.',
    '- **Bodies are split, never shortened.** `inspectSkillRoot()` reports a body',
    '  over 64 KiB, and the remedy used here is the one the HyperFrames pack',
    '  already uses: the widest section moves into the Skill\'s own `references/`',
    '  directory and the body links it where it stood. No sentence is cut.',
    '',
    'The 5,000-token budget this package enforces on Skills it publishes is **not**',
    'applied to these bodies. They are opt-in per row and a body is paid for only',
    'when its Skill is selected, which is the trade the design page states on the',
    'row itself; the sizes are recorded below so the choice is visible.',
    '',
  ]
  if (moved.length > 0) {
    body.push('| Body | Section moved to | Bytes moved |', '|---|---|---|')
    for (const entry of moved) body.push(`| \`${entry.body}\` | \`${entry.file}\` | ${String(entry.bytes)} |`)
    body.push('')
  }
  body.push('| Vendored file | Bytes | SHA-256 |', '|---|---|---|')
  for (const row of rows) body.push(`| \`${row.file}\` | ${String(row.bytes)} | \`${row.sha256}\` |`)
  body.push('')
  return body.join('\n')
}

// ------------------------------------------------------------------ 主流程

function parseArguments(argv) {
  const options = { source: undefined, ref: 'main', commit: undefined, date: undefined, out: undefined, write: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') options.source = resolve(argv[++index] ?? '')
    else if (argument === '--ref') options.ref = argv[++index]
    else if (argument === '--commit') options.commit = argv[++index]
    else if (argument === '--date') options.date = argv[++index]
    else if (argument === '--out') options.out = resolve(argv[++index] ?? '')
    else if (argument === '--write') options.write = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
  }
  return options
}

function usage() {
  return [
    'Vendor the Taste-Skill pack into this package, cleaned for its audits.',
    '',
    '  --source <dir>   upstream checkout to read instead of the GitHub API',
    '  --ref <ref>      upstream ref to snapshot over the API (default: main)',
    '  --commit <sha>   skip resolution and use this commit',
    '  --date <date>    snapshot date for PROVENANCE.md (default: today, UTC)',
    '  --out <dir>      destination (default: assets/design/taste)',
    '  --write          actually write; without it this is a dry run',
    '  --json           machine-readable report on stdout',
  ].join('\n')
}

/**
 * Say something about the run without corrupting the machine-readable output.
 *
 * Under `--json`, stdout carries the report and nothing else, so every human
 * sentence goes to stderr — the test suite is the first consumer that would
 * otherwise have to guess where the JSON stops.
 */
function note(options, message) {
  if (options.json === true) console.error(message)
  else console.log(message)
}

/**
 * The same file list, read from an upstream checkout rather than from the API.
 *
 * The shape matches the API's: a path, its blob id (unavailable locally, so the
 * placeholder says so rather than inventing one) and its size, which is the check
 * that a read was complete in both modes.
 */
function localWanted(root) {
  const skills = join(root, 'skills')
  if (!existsSync(skills)) throw new Error(`no skills/ under ${root}`)
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = slash(relative(root, full))
      if (path === UPSTREAM_INDEX) continue
      found.push({ path, blob: 'local', size: statSync(full).size })
    }
  }
  walk(skills)
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

async function plan(options) {
  const fromDisk = options.source !== undefined
  const commit = options.commit ?? (fromDisk ? 'unrecorded' : (await github(`commits/${options.ref}`)).sha)
  const snapshot = fromDisk
    ? (options.date ?? new Date().toISOString().slice(0, 10))
    : (await github(`commits/${commit}`)).commit.committer.date
  const wanted = fromDisk
    ? localWanted(options.source)
    : (await github(`git/trees/${commit}?recursive=1`)).tree
      .filter((entry) => entry.type === 'blob' && entry.path.startsWith(SOURCE_PREFIX) && entry.path.endsWith('.md') && entry.path !== UPSTREAM_INDEX)
      .map((entry) => ({ path: entry.path, blob: entry.sha, size: entry.size }))
      .sort((left, right) => left.path.localeCompare(right.path))
  const read = fromDisk
    ? (path) => readFileSync(join(options.source, path))
    : (path) => github(`contents/${path}?ref=${commit}`, 'application/vnd.github.raw')

  const findings = []
  const files = []
  const moved = []
  const names = new Map()

  for (const entry of wanted) {
    const raw = await read(entry.path)
    // The tree's own `size` is the independent check: a truncated download is the
    // one failure that would otherwise ship a body whose tail is missing.
    if (raw.length !== entry.size) throw new Error(`${entry.path}: got ${String(raw.length)} bytes, the tree says ${String(entry.size)}`)

    const relative = entry.path.slice(SOURCE_PREFIX.length)
    const directory = slash(relative).split('/')[0]
    const isBody = relative === `${directory}/SKILL.md`
    const cleaned = stripEmoji(raw.toString('utf8'))
    if (cleaned.removed > 0) findings.push({ kind: 'emoji-removed', file: entry.path, text: `${String(cleaned.removed)} glyph(s)` })

    let text = cleaned.text
    if (isBody) {
      const parsed = frontmatter(text)
      if (!parsed.ok) {
        findings.push({ kind: 'unreadable-skill', file: entry.path, text: parsed.reason })
        continue
      }
      const seen = names.get(parsed.name)
      if (seen !== undefined) findings.push({ kind: 'duplicate-name', file: entry.path, text: `${parsed.name} also used by ${seen}` })
      else names.set(parsed.name, entry.path)

      const budget = enforceBodyLimit(text)
      text = budget.text
      if (budget.moved.length > 0) {
        for (const section of budget.moved) {
          findings.push({ kind: 'section-moved', file: entry.path, text: `${section.level} ${section.title} -> ${section.file} (${String(section.bytes)} bytes)` })
          files.push({ file: `${directory}/${section.file}`, bytes: Buffer.byteLength(section.text, 'utf8'), sha256: sha256(Buffer.from(section.text)), text: section.text })
          moved.push({ body: entry.path, file: `${directory}/${section.file}`, bytes: section.bytes })
        }
      }
      if (budget.over) findings.push({ kind: 'over-body-limit', file: entry.path, text: `${String(Buffer.byteLength(text, 'utf8'))} bytes remain` })
    }

    for (const match of text.matchAll(UNAVAILABLE_PROGRAM)) {
      findings.push({ kind: 'unavailable-program', file: entry.path, text: match[0].trim() })
    }

    const bytes = Buffer.byteLength(text, 'utf8')
    files.push({ file: relative, bytes, sha256: sha256(Buffer.from(text)), text, tokens: tokens(text), upstream: entry.blob, adapted: text !== raw.toString('utf8') })
  }

  const licence = fromDisk ? readFileSync(join(options.source, 'LICENSE')) : await github(`contents/LICENSE?ref=${commit}`, 'application/vnd.github.raw')
  return { commit, snapshot, files: files.sort((left, right) => left.file.localeCompare(right.file)), moved, findings, licence }
}

async function main(argv) {
  const options = parseArguments(argv)
  if (options.help === true) { console.log(usage()); return 0 }

  const ran = await plan(options)
  const out = options.out ?? join(process.cwd(), 'assets', 'design', 'taste')
  const bodies = ran.files.filter((file) => file.file.endsWith('SKILL.md'))
  const summary = {
    commit: ran.commit,
    snapshot: ran.snapshot,
    skills: bodies.length,
    files: ran.files.length,
    bytes: ran.files.reduce((total, file) => total + file.bytes, 0),
    tokens: ran.files.reduce((total, file) => total + (file.tokens ?? 0), 0),
    adapted: ran.files.filter((file) => file.adapted).length,
    moved: ran.moved.length,
    findings: ran.findings,
  }

  if (options.json === true) console.log(JSON.stringify({ summary, files: ran.files.map(({ text: _text, ...rest }) => rest) }, null, 2))
  else {
    console.log(`upstream     : ${UPSTREAM.slug} @ ${ran.commit} (${ran.snapshot})`)
    console.log(`skills       : ${String(summary.skills)} bodies, ${String(summary.files)} files, ${(summary.bytes / 1024).toFixed(1)} KB`)
    console.log(`tokens       : ${String(summary.tokens)} across the pack (not trimmed; paid only when a Skill is selected)`)
    console.log(`adapted      : ${String(summary.adapted)} file(s) differ from upstream`)
    console.log(`sections moved: ${String(summary.moved)}`)
    console.log('')
    console.log('PLAN')
    for (const file of ran.files) {
      const size = `${String((file.bytes / 1024).toFixed(1))} KB`.padStart(8)
      const note = file.file.endsWith('SKILL.md') ? `${String(file.tokens).padStart(6)} tokens` : 'companion'.padStart(12)
      console.log(`  ${size}  ${note}  ${file.file}${file.adapted ? '  [adapted]' : ''}`)
    }
    if (ran.findings.length > 0) {
      console.log('')
      console.log(`FINDINGS (${String(ran.findings.length)})`)
      for (const finding of ran.findings) console.log(`  ${finding.kind}: ${finding.file}: ${finding.text}`)
    }
  }

  if (options.write !== true) { note(options, 'dry run — pass --write to materialise'); return 0 }
  const blocking = ran.findings.filter((finding) => ['unreadable-skill', 'duplicate-name', 'over-body-limit'].includes(finding.kind))
  if (blocking.length > 0) {
    console.error('refusing to write: an unreadable or oversized Skill would mount as a silently missing entry')
    return 1
  }

  rmSync(out, { recursive: true, force: true })
  for (const file of ran.files) {
    const destination = join(out, file.file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.text)
  }
  writeFileSync(join(out, 'LICENSE'), ran.licence)
  writeFileSync(join(out, 'PROVENANCE.md'), provenanceDocument({ ...options, commit: ran.commit }, { date: ran.snapshot }, ran.files, ran.moved))
  note(options, `wrote ${String(ran.files.length)} files to ${slash(out)} (LICENSE + PROVENANCE.md included)`)
  return 0
}

if (!existsSync(resolve('package.json'))) console.error('note: run this from the package directory it writes into')
process.exitCode = await main(process.argv.slice(2))
