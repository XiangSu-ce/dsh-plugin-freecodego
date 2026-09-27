/**
 * Vendor OpenDesign's `craft/` layer into this package.
 *
 * Why this layer, and this pass
 * -----------------------------
 * `craft/` is the one axis of upstream's design engine that is neither brand
 * content nor a runtime: eleven short rulebooks that hold *regardless* of the
 * brand ("ALL CAPS always needs tracking", "at most two visible uses of the
 * accent per screen"), each declared opt-in by the Skills and design-system
 * manifests that need it. Upstream's own numbers say the same thing — 22 of its
 * 163 Skills declare a `craft.requires`, 151 of 152 design-system manifests
 * declare the three-field `craft` block, and the whole layer is 108 KB against a
 * catalog that ships 40 MB of brand packages. It is also pure Markdown, so what
 * this pass does is a *copy with rules applied*, not a port.
 *
 * The rules it applies, and why each one is a rule
 * -----------------------------------------------
 * 1. **A section is a file whose name is its slug.** Upstream's loader joins
 *    `craft/<slug>.md` and its lint fails on a malformed slug, so the name is
 *    the contract; this refuses a file that could not be reached by any caller.
 * 2. **Every section opens with a level-1 title.** The tool answers a `list`
 *    with that title, and a section with no title would be a row the model
 *    cannot tell from its neighbours.
 * 3. **Emoji are removed — except where the glyph is the rule's own subject.**
 *    `anti-ai-slop.md` names six glyphs as tells ("Emoji as feature icons —
 *    `✨` `🚀` …"), so deleting them would delete what the rule is about. Those
 *    six become `` `U+2728 SPARKLES` `` — code point plus name — which keeps the
 *    meaning, renders everywhere, and leaves the finding in the report. Any
 *    *other* emoji-presentation glyph is a blocking finding rather than a silent
 *    deletion: this pass has no word table for it, and inventing one is how a
 *    vendored body starts drifting from what the notice attributes.
 * 4. **`FUTURE_SECTIONS.md` must list exactly the slugs that do not ship.** That
 *    file is upstream's forward-reference register, and upstream's `lint:craft`
 *    uses it to keep "a typo" and "a section that is planned" distinguishable.
 *    This pass refuses when a listed slug has a file (a stale register, which
 *    would make the tool tell a caller a shipped section is unavailable) — the
 *    tool reads the same register at runtime.
 *
 * What it does NOT do
 * -------------------
 * It writes nothing without `--write`. The default is a dry run printing the
 * whole plan, because the interesting output is the findings: which file carried
 * glyphs, which one has no title, whether the register is stale.
 *
 * Two sources, one rule table
 * ---------------------------
 * `--source <dir>` reads an upstream checkout — how this layer was vendored, and
 * what the regression spec drives, since a test cannot fetch. Without it the
 * script reads the same paths over the GitHub API (raw.githubusercontent.com is
 * not reachable from every environment; api.github.com is). Both modes run the
 * same rules, because the rules run on the file's text.
 *
 * Usage
 * -----
 *   node scripts/vendor-craft.mjs --source <upstream-checkout>
 *   node scripts/vendor-craft.mjs --commit <sha> --write
 *   node scripts/vendor-craft.mjs --out assets/design/craft --json
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ------------------------------------------------------------------ 上游

/** Upstream, by the facts a provenance file has to cite. */
const UPSTREAM = {
  project: 'OpenDesign',
  repository: 'https://github.com/nexu-io/open-design',
  licence: 'Apache-2.0',
  slug: 'nexu-io/open-design',
  /** The layer this pass takes, and the one it deliberately leaves behind. */
  taken: 'craft/',
}

/** The register of slugs upstream has referenced but not yet shipped. */
const REGISTER = 'FUTURE_SECTIONS.md'

// ------------------------------------------------------------------ 规则表

/** A slug reachable by `craft/<slug>.md`, as upstream's loader spells it. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** The two companions: prose about the layer, not sections of it. */
const COMPANIONS = new Set(['README.md', REGISTER])

/**
 * The six glyphs `anti-ai-slop.md` names as tells, by code point and name.
 *
 * A rule that forbids a glyph has to be able to write the glyph down. The
 * substituted form is what a linter's own source uses — `` `U+2728 SPARKLES` ``
 * — so the rule stays readable and the file ships without an emoji presentation
 * glyph. The names are Unicode's, not invented here.
 */
const NAMED_GLYPHS = new Map([
  ['\u2728', 'U+2728 SPARKLES'],
  ['\u{1F680}', 'U+1F680 ROCKET'],
  ['\u{1F3AF}', 'U+1F3AF DIRECT HIT'],
  ['\u26A1', 'U+26A1 HIGH VOLTAGE'],
  ['\u{1F525}', 'U+1F525 FIRE'],
  ['\u{1F4A1}', 'U+1F4A1 LIGHT BULB'],
])

/** Every glyph this pass knows how to name, as one alternation. */
const NAMED_GLYPH = new RegExp([...NAMED_GLYPHS.keys()].join('|'), 'gu')

/** What the test suite sweeps for, and what must not survive this pass. */
const EMOJI = /[\p{Emoji_Presentation}\uFE0F]/gu

// ------------------------------------------------------------------ 工具

const slash = (value) => value.split('\\').join('/')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Price a section the way `token-estimate.ts` does, for the plan table. */
const tokens = (text) => Math.ceil([...text].length / 4)

/**
 * Ask the GitHub API for one path, through the contents endpoint.
 *
 * `Accept: application/vnd.github.raw` returns the file's bytes rather than a
 * base64 envelope, so what lands on disk is what upstream publishes — and the
 * tree's `size` is then an independent check that nothing was truncated.
 */
async function github(path, accept = 'application/vnd.github+json') {
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM.slug}/${path}`, {
    headers: { accept, 'user-agent': 'dsh-freecodego-vendor-craft', 'x-github-api-version': '2022-11-28' },
  })
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${String(response.status)} ${response.statusText}: ${(await response.text()).slice(0, 200)}`)
  }
  return accept === 'application/vnd.github.raw' ? Buffer.from(await response.arrayBuffer()) : response.json()
}

/** Replace the six named glyphs with their code point and name. */
function nameGlyphs(text) {
  const named = []
  const output = text.replace(NAMED_GLYPH, (match) => {
    const name = NAMED_GLYPHS.get(match)
    if (name === undefined) return match
    named.push(name)
    return `\`${name}\``
  })
  return { text: output, named }
}

/** The level-1 title a section must carry, or `undefined`. */
function sectionTitle(text) {
  return /^# (.+)$/mu.exec(text)?.[1]?.trim()
}

/** The slugs `FUTURE_SECTIONS.md` registers, in the order it lists them. */
function registeredSlugs(text) {
  return [...text.matchAll(/^-[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*$/gmu)].map(match => match[1])
}

/**
 * The `PROVENANCE.md` this run records.
 *
 * Per-file SHA-256 rather than a tree digest, because these are the files a
 * licence audit opens one at a time, and the digest cited is of the bytes
 * shipped — taken after the one adaptation above.
 */
function provenanceDocument(options, snapshot, rows, named, forward) {
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const body = [
    '# OpenDesign craft provenance',
    '',
    'The Markdown under this directory is vendored third-party prose from',
    `[${UPSTREAM.slug}](${UPSTREAM.repository}). It is not covered by this package's`,
    'AGPL-3.0-only license; this directory\'s `LICENSE` carries the upstream terms,',
    'and two of the sections carry a second, nested attribution they state',
    'themselves (`color.md`, `anti-ai-slop.md`: adapted from `refero_skill`, MIT).',
    '',
    '## Source and snapshot',
    '',
    '| | |',
    '|---|---|',
    `| Project | ${UPSTREAM.project} |`,
    `| Repository | ${UPSTREAM.repository} |`,
    `| Upstream version | ${snapshot.version} |`,
    `| Snapshot commit | ${snapshot.commit} |`,
    `| Snapshot date | ${date} |`,
    `| License | ${UPSTREAM.licence} (no NOTICE file upstream) |`,
    `| Vendored files | ${String(rows.length)} |`,
    `| Craft sections | ${String(rows.filter(row => !COMPANIONS.has(row.file)).length)} |`,
    '',
    '## What was adapted, and why',
    '',
    'The text is upstream. One adaptation is applied by',
    '`scripts/vendor-craft.mjs` as a rule, so a re-sync replays it rather than',
    'requiring anyone to remember it:',
    '',
  ]
  if (named.length === 0) {
    body.push('- **Nothing.** Every file shipped is byte-identical to upstream.', '')
  } else {
    body.push(
      '- **Six glyphs are named rather than drawn.** `anti-ai-slop.md` forbids',
      '  emoji as feature icons and therefore writes six of them down. Those are',
      '  replaced by their code point and Unicode name, so the rule still says',
      '  which glyphs it means while no emoji-presentation glyph ships. No other',
      '  change was made to any file; the substitution is listed below.',
      '',
      '| Glyph as named | In |',
      '|---|---|',
    )
    for (const entry of named) body.push(`| \`${entry.name}\` | \`${entry.file}\` |`)
    body.push('')
  }
  body.push(
    '## References to upstream paths',
    '',
    'Several sections cite upstream\'s own repository where a rule is auto-checked or a',
    'sibling layer is described — `apps/daemon/src/lint-artifact.ts` for the rules the',
    'linter enforces, `design-systems/` for the brand packages craft sits on top of.',
    'Those paths do not exist in this package: they are kept because they say *where*',
    'upstream enforces a rule, which is the difference between a hard rule and guidance',
    '— and rewriting upstream prose to hide its own layout is the kind of edit that',
    'makes a notice untrue.',
    '',
    '## Forward references',
    '',
    `${REGISTER} lists slugs upstream has referenced but not yet shipped. The tool`,
    'reads that file rather than a copy of it, so an unknown slug and a *planned*',
    'slug give different answers. Registered at this snapshot:',
    '',
  )
  for (const slug of forward) body.push(`- \`${slug}\``)
  body.push('')
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
    "Vendor OpenDesign's craft layer into this package.",
    '',
    '  --source <dir>   upstream checkout to read instead of the GitHub API',
    '  --ref <ref>      upstream ref to snapshot over the API (default: main)',
    '  --commit <sha>   skip resolution and use this commit',
    '  --date <date>    snapshot date for PROVENANCE.md (default: today, UTC)',
    '  --out <dir>      destination (default: assets/design/craft)',
    '  --write          actually write; without it this is a dry run',
    '  --json           machine-readable report on stdout',
  ].join('\n')
}

/**
 * Say something about the run without corrupting the machine-readable output.
 *
 * Under `--json`, stdout carries the report and nothing else, so every human
 * sentence goes to stderr — the regression spec is the first consumer that would
 * otherwise have to guess where the JSON stops.
 */
function note(options, message) {
  if (options.json === true) console.error(message)
  else console.log(message)
}

/** The same file list, read from an upstream checkout rather than from the API. */
function localWanted(root) {
  const where = join(root, UPSTREAM.taken)
  if (!existsSync(where)) throw new Error(`no ${UPSTREAM.taken} under ${root}`)
  return readdirSync(where)
    .filter(name => name.endsWith('.md'))
    .map(name => ({ path: `${UPSTREAM.taken}${name}`, blob: 'local', size: statSync(join(where, name)).size }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function plan(options) {
  const fromDisk = options.source !== undefined
  const commit = options.commit ?? (fromDisk ? undefined : (await github(`commits/${options.ref}`)).sha)
  const version = fromDisk
    ? (JSON.parse(readFileSync(join(options.source, 'package.json'), 'utf8'))).version
    : (await github(`contents/package.json?ref=${commit}`, 'application/vnd.github.raw')).toString('utf8')
      .match(/"version":\s*"([^"]+)"/u)?.[1]
  const wanted = fromDisk
    ? localWanted(options.source)
    : (await github(`git/trees/${commit}?recursive=1`)).tree
      .filter((entry) => entry.type === 'blob' && entry.path.startsWith(UPSTREAM.taken) && entry.path.endsWith('.md'))
      .map((entry) => ({ path: entry.path, blob: entry.sha, size: entry.size }))
      .sort((left, right) => left.path.localeCompare(right.path))
  if (wanted.length === 0) throw new Error(`no ${UPSTREAM.taken}*.md found to vendor`)
  const read = fromDisk
    ? (path) => readFileSync(join(options.source, path))
    : (path) => github(`contents/${path}?ref=${commit}`, 'application/vnd.github.raw')

  const findings = []
  const files = []
  const named = []

  for (const entry of wanted) {
    const raw = await read(entry.path)
    // The tree's own `size` is the independent check: a truncated download is the
    // one failure that would otherwise ship a section whose tail is missing.
    if (raw.length !== entry.size) throw new Error(`${entry.path}: got ${String(raw.length)} bytes, the tree says ${String(entry.size)}`)

    const file = entry.path.slice(UPSTREAM.taken.length)
    const substituted = nameGlyphs(raw.toString('utf8'))
    for (const name of substituted.named) {
      named.push({ name, file })
      findings.push({ kind: 'glyph-named', file, text: name })
    }

    // Anything the six-glyph table does not cover is blocking rather than dropped:
    // a silent deletion is a body that no longer says what the notice attributes.
    for (const match of substituted.text.matchAll(EMOJI)) {
      findings.push({ kind: 'unnamed-emoji', file, text: `U+${match[0].codePointAt(0).toString(16).toUpperCase()}` })
    }

    if (!COMPANIONS.has(file)) {
      const slug = file.replace(/\.md$/u, '')
      if (!SLUG_PATTERN.test(slug)) findings.push({ kind: 'unreachable-slug', file, text: slug })
      const title = sectionTitle(substituted.text)
      if (title === undefined) findings.push({ kind: 'no-title', file, text: 'no level-1 heading' })
    }

    const bytes = Buffer.byteLength(substituted.text, 'utf8')
    if (bytes === 0) findings.push({ kind: 'empty-file', file, text: 'zero bytes' })
    files.push({ file, bytes, sha256: sha256(Buffer.from(substituted.text)), text: substituted.text, tokens: tokens(substituted.text), upstream: entry.blob })
  }

  // The register has to be one of the files, or the runtime's forward-reference
  // answer and this pass's check would disagree about what "planned" means.
  const register = files.find(file => file.file === REGISTER)
  const forward = register === undefined ? [] : registeredSlugs(register.text)
  const shipped = files.filter(file => !COMPANIONS.has(file.file)).map(file => file.file.replace(/\.md$/u, ''))
  for (const slug of forward) {
    if (shipped.includes(slug)) findings.push({ kind: 'stale-register', file: REGISTER, text: `${slug} is registered but ships` })
  }
  if (register === undefined) findings.push({ kind: 'missing-register', file: REGISTER, text: 'the forward-reference register did not ship' })

  const licence = fromDisk ? readFileSync(join(options.source, 'LICENSE')) : await github(`contents/LICENSE?ref=${commit}`, 'application/vnd.github.raw')
  return {
    snapshot: { commit: commit ?? 'unrecorded (source tree carries no .git)', version: version ?? 'unknown' },
    files: files.sort((left, right) => left.file.localeCompare(right.file)),
    named,
    forward,
    findings,
    licence,
  }
}

async function main(argv) {
  const options = parseArguments(argv)
  if (options.help === true) { console.log(usage()); return 0 }

  const ran = await plan(options)
  const sections = ran.files.filter(file => !COMPANIONS.has(file.file))
  const summary = {
    version: ran.snapshot.version,
    commit: ran.snapshot.commit,
    sections: sections.length,
    files: ran.files.length,
    bytes: ran.files.reduce((total, file) => total + file.bytes, 0),
    tokens: ran.files.reduce((total, file) => total + file.tokens, 0),
    glyphsNamed: ran.named.length,
    forward: ran.forward,
    findings: ran.findings,
  }

  if (options.json === true) console.log(JSON.stringify({ summary, files: ran.files.map(({ text: _text, ...rest }) => rest) }, null, 2))
  else {
    console.log(`upstream     : ${UPSTREAM.slug} ${ran.snapshot.version} @ ${ran.snapshot.commit}`)
    console.log(`sections     : ${String(summary.sections)} sections, ${String(summary.files)} files, ${(summary.bytes / 1024).toFixed(1)} KB`)
    console.log(`tokens       : ${String(summary.tokens)} if every file were read at once (each section is paid for on its own)`)
    console.log(`glyphs named : ${String(summary.glyphsNamed)}`)
    console.log(`forward refs : ${summary.forward.length === 0 ? 'none' : summary.forward.join(', ')}`)
    console.log('')
    console.log('PLAN')
    for (const file of ran.files) {
      const size = `${(file.bytes / 1024).toFixed(1)} KB`.padStart(8)
      const slug = COMPANIONS.has(file.file) ? 'companion' : file.file.replace(/\.md$/u, '')
      console.log(`  ${size}  ${String(file.tokens).padStart(6)} tokens  ${slug}`)
    }
    if (ran.findings.length > 0) {
      console.log('')
      console.log(`FINDINGS (${String(ran.findings.length)})`)
      for (const finding of ran.findings) console.log(`  ${finding.kind}: ${finding.file}: ${finding.text}`)
    }
  }

  if (options.write !== true) { note(options, 'dry run — pass --write to materialise'); return 0 }
  const blocking = ran.findings.filter(finding => finding.kind !== 'glyph-named')
  if (blocking.length > 0) {
    console.error('refusing to write: a finding this pass cannot resolve would ship a section no caller can reach or trust')
    return 1
  }

  const out = options.out ?? join(process.cwd(), 'assets', 'design', 'craft')
  rmSync(out, { recursive: true, force: true })
  for (const file of ran.files) {
    const destination = join(out, file.file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.text)
  }
  writeFileSync(join(out, 'LICENSE'), ran.licence)
  writeFileSync(join(out, 'PROVENANCE.md'), provenanceDocument(options, ran.snapshot, ran.files, ran.named, ran.forward))
  note(options, `wrote ${String(ran.files.length)} files to ${slash(out)} (LICENSE + PROVENANCE.md included)`)
  return 0
}

if (!existsSync(resolve('package.json'))) console.error('note: run this from the package directory it writes into')
process.exitCode = await main(process.argv.slice(2))
