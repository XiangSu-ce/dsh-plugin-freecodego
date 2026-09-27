/**
 * Vendor the HyperFrames Skill pack into this package, cleaned for our audits.
 *
 * Why a script rather than a copy
 * ------------------------------
 * The upstream pack cannot be copied in. Three of this package's own gates stand
 * in the way, and each one has to be answered by a decision that must be
 * replayable when upstream moves:
 *
 * 1. `inspectSkillRoot()` (`src/engineering.ts`) runs `containsSecret`,
 *    `dangerousCommandFindings`, `PROMPT_BYPASS_PATTERN` and a **64 KiB body
 *    limit** over every bundled `SKILL.md`. The upstream tree carries ~200
 *    script files, which is exactly what `dangerousCommandFindings` is for, and
 *    one body (`talking-head-recut`) is already over the limit.
 * 2. `tests/engineering.spec.ts` sweeps every bundled asset for
 *    `\p{Emoji_Presentation}`. Upstream uses emoji as display punctuation.
 * 3. The rewritten invocation surface. Upstream Skills tell the model to shell
 *    out (`npx hyperframes render …`). This plugin provides in-process tools
 *    instead, and a Skill that names a deferred tool must also say how to load
 *    it (`deferredToolFetchHint`) or the instruction is un-followable.
 *
 * Everything above is a rule, not a one-off edit, so it lives here as code and
 * is re-run after every upstream sync. `THIRD_PARTY_NOTICES.md` records the
 * commit this was vendored from and every local deviation; that file, not this
 * one, is what a licence audit reads.
 *
 * What it does NOT do
 * -------------------
 * It never writes anything unless `--write` is passed. The default is a dry run
 * that prints the full plan, because the interesting output here is the
 * *findings* (which CLI verbs need a mapping, which bodies are over budget,
 * which files are being dropped), and a plan is easier to review than a diff of
 * ~600 files.
 *
 * Usage
 * -----
 *   node scripts/vendor-design-skills.mjs --source <upstream-checkout>
 *   node scripts/vendor-design-skills.mjs --source <upstream-checkout> --write
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// ------------------------------------------------------------------ 清洗表

/**
 * Verdict glyphs whose meaning is a word in the vendored packs.
 *
 * `THIRD_PARTY_NOTICES.md` records this substitution as a local adaptation for both
 * the Matt Pocock and the Superpowers packs (`✅`/`❌`/`⚠️` became
 * `PASS`/`FAIL`/`UNVERIFIABLE`), because a terminal may draw an emoji-presentation
 * glyph at double width or as a box, and a verdict is the one token a reader acts
 * on. Spelling them the same way here keeps one vocabulary across all three packs.
 *
 * The two `⚠` keys are separate entries rather than one optional selector: the key
 * is tried as written, and a key that swallowed its own selector would not match
 * the bare form upstream also uses.
 */
const GLYPH_WORDS = new Map([
  ['\u2705', 'PASS'],
  ['\u274C', 'FAIL'],
  ['\u26A0\uFE0F', 'UNVERIFIABLE'],
  ['\u26A0', 'UNVERIFIABLE'],
])

const EMOJI_WORDS = new RegExp(`(?:${[...GLYPH_WORDS.keys()].join('|')})+`, 'gu')

// ------------------------------------------------------------------ 清单与策略

/**
 * The Skills this pack ships, in the order the design page groups them.
 *
 * Deliberately not "everything under `skills/`": three upstream Skills are left
 * out on purpose, and the reason is per-Skill rather than per-file.
 *
 * - `hyperframes-registry` is a client for a **network** registry (`hyperframes
 *   add <block|component>`). This plugin is offline and deterministic, so the
 *   Skill would point the model at a service it cannot reach.
 * - `media-use` and `figma` need third-party credentials (TTS / background
 *   removal providers; a Figma MCP server). They belong behind the supplier
 *   configuration surface, which this phase does not build.
 * - `hyperframes-cli` documents the CLI this pack removes; there is nothing left
 *   for it to describe.
 *
 * Excluded Skills are still *counted* in the report so the omission stays
 * visible rather than looking like an upstream deletion.
 */
const EXCLUDED_SKILLS = new Map([
  ['hyperframes-registry', 'network registry; this plugin is offline'],
  ['hyperframes-cli', 'documents the CLI this pack replaces with in-process tools'],
  ['media-use', 'needs third-party credentials (TTS / background removal)'],
  ['figma', 'needs a Figma MCP server'],
])

/**
 * File extensions that carry knowledge the model reads.
 *
 * `.html` is in the list rather than out: several Skills ship the composition
 * template they tell the model to copy, and that template is the instruction.
 * Everything not named here is a binary asset or a script — see
 * {@link DROPPED_CLASSES}.
 */
const KEPT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.json', '.txt', '.css', '.svg', '.yaml', '.yml'])

/**
 * Why the binary and script classes are dropped wholesale.
 *
 * 142 binary files (57 `woff2` fonts, 66 `png` textures, 19 `mp3` effects) are
 * ~7.9 MB, and fonts and audio carry **their own licences** — they cannot be
 * folded into this package's notices with a single line the way Apache-2.0 text
 * can. `fonts.css` is the sharpest case: 1.1 MB of `@font-face` rules with 45
 * base64 payloads inlined, which is a font binary wearing a `.css` extension.
 *
 * The 212 script files are dropped for a different reason: they are what
 * `dangerousCommandFindings` exists to catch, and the pack no longer shells out
 * at all, so nothing would invoke them. A Skill that told the model to run one
 * gets that instruction rewritten (see {@link CLI_REWRITES}).
 */
const DROPPED_CLASSES = [
  { what: 'binary assets (fonts / images / audio)', test: (ext) => ['.woff2', '.woff', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.m4a', '.psd', '.sketch'].includes(ext) },
  { what: 'executable scripts', test: (ext) => ['.mjs', '.cjs', '.js', '.ts', '.tsx', '.sh', '.bash', '.py', '.ps1', '.cmd', '.bat'].includes(ext) },
]

/** A `.css` file this large is a font/asset payload, not styling rules. */
const CSS_ASSET_BYTES = 64 * 1024

/**
 * CLI invocation → in-process tool, applied to Skill text.
 *
 * The replacements are ordered longest-first at use time, so `hyperframes skills
 * update` cannot be eaten by a shorter prefix rule. A form that matches nothing
 * here is reported as unmapped rather than left in place silently: an unmapped
 * `npx hyperframes …` in a shipped Skill is the failure this whole pass exists to
 * prevent.
 *
 * The replacements carry **no `tool_search` hint**, and that is a decision rather
 * than an omission. Every tool named here is deferred — the `freecodego_` prefix
 * puts it in `deferred-tools.ts`'s set — so a body that names one is naming a
 * schema the model may not have. This script used to claim it appended the hint
 * (`deferredToolFetchHint()`'s sentence) after each rewrite; it never did, and no
 * bundled asset in this package carries one, the engineering pack's 23 Skills
 * included. The hint lives where the *plugin* injects a tool name into a turn
 * (`engineering.ts`, `memory/manifest.ts`, `review/gate.ts`, `verify-on-stop.ts`),
 * which is the one place that knows whether the tool is on the wire. Spelling it
 * here instead would put a second copy of the sentence in the repository and give
 * it to every session that merely *loads* a Skill, whether or not the model then
 * calls anything.
 */
/**
 * A trailing run of command-line arguments, consumed along with the verb.
 *
 * An in-process tool takes named arguments, not CLI flags or positional paths, so
 * `render --quality high` has to become `freecodego_design_render` and not
 * `freecodego_design_render --quality high` — the latter names a tool and then hands
 * it an argument its schema rejects. The run stops at the first bare word, so
 * `lint --json and then read it` keeps `and then read it` as prose.
 *
 * Two shapes belong to the run, and the second is the one that kept escaping it:
 *
 * - **flags**, `--quality high` and `-q high`;
 * - **quoted arguments**, `"$PROJECT_DIR"`, `'<dir>'`. Upstream writes the project
 *   path quoted, and without this the run stopped at the quote: `preview
 *   "$PROJECT_DIR" --background` shipped as a tool name followed by a shell path
 *   and a flag, which is the same defect one token further along. A bare word is
 *   still a stop, so the prose case above is unchanged.
 *
 * A flag value excludes backticks, and that exclusion is the difference between a
 * working rewrite and a broken document. Upstream writes these calls inside code
 * spans, and the closing backtick is **not** preceded by whitespace: with a plain
 * `\S+` the value of `--at <frame-midpoints>` swallowed the closer, and the shipped
 * line began with a backtick that was never closed — invisible in the report, and
 * only found by reading the output.
 *
 * What this deliberately does **not** consume: a bare positional word. `render public`,
 * `snapshot public --at 5` and `keyframes . --json` are still left with arguments,
 * because the same rule that would take them would take `render and then read it`.
 * Those sites are the hand-rewrite track (see the plan's CLI tally), and the flag is
 * that they are visible in the diff rather than silently half-fixed.
 *
 * @param verbs the verb alternation to match after `npx hyperframes`
 * @returns a global pattern for one whole invocation, its arguments included
 */
const invocation = (verbs) => new RegExp(`\\b(?:npx\\s+(?:-y\\s+)?)?hyperframes\\s+(?:${verbs})\\b(?:\\s+(?:--?[\\w-]+(?:[= ]\\s*[^\\s\`]+)?|"[^"]*"|'[^']*'))*`, 'gu')

/**
 * The replacements carry **no backticks**, and that is a correctness rule rather than
 * a style one. Upstream writes these calls inside code spans (`\`npx hyperframes
 * lint\``), so a replacement that supplied its own would nest: the shipped text read
 * `` `the `freecodego_design_lint` tool` ``, which renders as garbage in every markdown
 * consumer and was caught only by reading the output by hand.
 */
const CLI_REWRITES = [
  { pattern: invocation('render'), replacement: 'freecodego_design_render' },
  { pattern: invocation('preview'), replacement: 'freecodego_design_preview' },
  { pattern: invocation('lint|validate|check'), replacement: 'freecodego_design_lint' },
  // `snapshot` and `keyframes` survive as capabilities, not as conveniences.
  // `snapshot` grabs the frames the render path already produces, at named
  // timeline points, so an agent can *look* at what it wrote — the whole reason
  // upstream calls it a visual-audit path. `keyframes` parses the composition's
  // GSAP/CSS animation statically and lists keyframes with their motion paths;
  // it needs no browser at all, so it is the cheapest real capability in the set.
  // Upstream's own `--json` examples say "machine-readable output for an agent",
  // which is what a tool call is.
  { pattern: invocation('snapshot'), replacement: 'freecodego_design_snapshot' },
  { pattern: invocation('keyframes'), replacement: 'freecodego_design_keyframes' },
  // `play` and `present` are the same capability at two settings: start a
  // loopback server over the composition and open it. `present` serves the deck
  // view, `play` the player, and both are what the plugin's preview slot already
  // does — so they collapse rather than becoming two more tools.
  { pattern: invocation('play|present'), replacement: 'freecodego_design_preview' },
  { pattern: invocation('doctor'), replacement: 'the design engine self-check in the Design settings page' },
  { pattern: invocation('skills\\s+update'), replacement: 'this pack is bundled offline and is not updated at runtime' },
]

/**
 * Verbs that name a capability this pack does **not** provide.
 *
 * Reported rather than rewritten: each one is a sentence that has to be deleted
 * or replaced by hand, because the surrounding paragraph usually explains a
 * workflow that no longer exists. A silent rewrite here would leave prose
 * describing a tool nobody can call.
 */
const UNSUPPORTED_VERBS = /\bnpx\s+(?:-y\s+)?hyperframes(?:@[\w.]+)?\s+(add|catalog|init|info|upgrade|compare|batch|cloud|deploy|login|auth|skills|capture|timeline|publish|feedback|transcribe|remove-background|normalize-audio|--help)\b[^\n]*/gu

/** The same verbs, as a bare word list, for the whole-line test. */
const UNSUPPORTED_VERB_WORDS = 'add|catalog|init|info|upgrade|compare|batch|cloud|deploy|login|auth|skills|capture|timeline|publish|feedback|transcribe|remove-background|normalize-audio|--help'

/**
 * The same verbs as {@link UNSUPPORTED_VERBS}, used to decide which *lines* to drop.
 *
 * Kept separate from the reporting pattern because the two answer different
 * questions: one asks "is this a capability we lack" (report it), the other asks
 * "is this line nothing but that call" (delete the line). A line that is only an
 * invocation has no prose to preserve, so deleting it is the whole remedy; a line
 * that mentions one in passing keeps its sentence and has the fragment replaced.
 */
const UNSUPPORTED_INVOCATION = new RegExp(`^[>$]?\\s*npx\\s+(?:-y\\s+)?hyperframes(?:@[\\w.]+)?\\s+(?:${UNSUPPORTED_VERB_WORDS})\\b`, 'u')

/** What replaces an unsupported invocation that sits inside a sentence. */
const UNSUPPORTED_INLINE = 'a capability this plugin does not provide'

/**
 * A marker that carries the verb from the removal pass to the prose pass.
 *
 * The two passes cannot be merged, and the reason is the whole difficulty of this
 * file. Removal sees an invocation and knows its verb but nothing about the sentence
 * around it; the prose pass sees a sentence but, once the invocation is gone, no
 * longer knows what it used to say. A bare placeholder therefore loses exactly the
 * information the rewrite needs — 54 sites were reported as needing review while 50
 * of them were six recurring shapes, each of which has one correct replacement.
 *
 * Text rather than a control character so that a finding can quote it readably, and
 * shaped so that nothing in a Skill body can plausibly contain it.
 */
const MARK_OPEN = '<<FCG-UNSUPPORTED:'
const MARK_CLOSE = '>>'
const MARK = /<<FCG-UNSUPPORTED:([a-z-]+)>>/gu

/**
 * The sentence an unsupported verb's instruction becomes.
 *
 * One entry per verb rather than one per site, because the sites collapse: `add`
 * appeared 17 times and `catalog` 16, all saying the same thing (consult, or install
 * from, a hosted registry this plugin does not ship). Spelling the replacement once
 * per verb means the 54 review items become seven decisions, and a future upstream
 * sync that adds a fortieth `add` is handled without anyone noticing it happened.
 *
 * Each sentence has to be **true and useful on its own**, because it replaces an
 * instruction the reader was about to follow: it either names the local substitute
 * that exists, or states plainly that nothing does. A sentence that only apologised
 * would leave the reader with a hole where a step used to be.
 *
 * No apostrophes, so the entries stay single-quoted and a future edit cannot
 * accidentally terminate one.
 */
const PROSE_BY_VERB = new Map([
  ['add', 'This plugin ships no hosted block registry, so the effect is built from the local materials this skill carries.'],
  ['catalog', 'This plugin ships no hosted look registry, so the local materials this skill carries are the catalogue.'],
  ['init', 'Create the project directory and its composition file directly; this pack needs no scaffolding step.'],
  ['auth', 'This pack has no hosted account, so voice and music come from a provider the user configured or are omitted.'],
  ['skills', 'This pack bundles its design Skills offline, so there is no runtime refresh step.'],
  ['upgrade', 'This pack bundles its design Skills offline, so there is no project upgrade step.'],
  ['info', 'Read the version from this package: the design Skills are bundled, not installed per project.'],
  ['timeline', 'Use the freecodego_design_preview tool to list the tracks and clips of the project, rather than reading index.html and every sub-composition file.'],
  ['capture', 'This pack cannot capture a website, so the composition is authored from supplied media or local files.'],
  ['publish', 'This pack does not publish to a hosted URL; hand over the rendered file instead.'],
  ['feedback', 'This pack collects no telemetry.'],
  ['remove-background', 'This pack cannot remove a background, so the footage has to already carry an alpha channel.'],
  ['transcribe', 'This pack cannot transcribe audio, so the transcript has to arrive as a local file.'],
  ['normalize-audio', 'This pack cannot normalise audio levels, so loudness has to be prepared before the composition sees the audio.'],
])

/**
 * Sentences the substitution itself makes false.
 *
 * A CLI rewrite is mechanical and the pack's prose is not: some sentences do not
 * just *name* a command, they explain what it does, and that explanation is a
 * claim about upstream's mechanism rather than about the capability. Upstream's
 * `preview` occupies the shell — it prints a URL and stays attached, which is why
 * one flow warns that it blocks and another needs a flag to stop it. The tool here
 * returns as soon as its listener is up and is released by calling it again with
 * `stop: true`, so both sentences now describe something that does not happen.
 *
 * Where the invocation pass consumed the verb and left the arguments (see
 * {@link invocation}), the sentence around it is the instruction and only the call
 * needed fixing; where the sentence states the *reason*, the reason is what is
 * wrong. Both are sentences, so both are repaired here rather than by a rule over
 * a token run.
 *
 * Keyed by **pattern rather than by file**, because a false claim is false wherever
 * it appears, and a file-keyed table could not be exercised by a fixture — the
 * suite would have to have the real pack's identity to test the rule that protects
 * the real pack.
 *
 * Two rules this table has to keep:
 *
 * - **The pattern may consume the enclosing code span.** That is what lets the
 *   replacement carry its own backticks: the nesting defect recorded on
 *   {@link CLI_REWRITES} is a replacement landing *inside* a span, and a pattern
 *   that takes the backticks with it puts the replacement back at the top level.
 * - **No `g` flag.** `test` and `replace` have to agree on what they matched, and a
 *   global pattern advances `lastIndex` on `test` so the second call sees a
 *   different document than the first.
 *
 * A replacement has to be true on its own and has to keep the instruction the
 * reader was about to follow — the reader loses nothing when a claim is corrected,
 * only when a step disappears.
 */
const CLAIM_REPAIRS = [
  {
    id: 'preview-stop-flag',
    // Upstream: `npx hyperframes preview "$PROJECT_DIR" --stop`. The flag survived
    // the invocation rewrite because the path sits between it and the verb, so the
    // shipped text named a tool and then handed it a path and a flag its schema
    // rejects — the same defect the flag run prevents, one token further along.
    pattern: /stop only this project's background server: `[^`]*`\./u,
    replacement: 'stop only this preview by calling `freecodego_design_preview` again with `stop: true`.',
    reason: 'the tool has no `--stop` flag and keeps no background server',
  },
  {
    id: 'preview-blocks-claim',
    // Upstream: `Do NOT use npx hyperframes preview for the picker — it blocks.`
    // The prohibition still holds and the reason does not: see the replacement.
    pattern: /Do NOT use `[^`]*` for the picker — it blocks\./u,
    replacement: 'Do NOT use `freecodego_design_preview` for the picker: it serves a composition, while this step wants a plain static server it can verify with curl and kill by pid. It never blocks — the tool returns as soon as the listener is up.',
    reason: 'the tool does not block; the picker step needs a server it can verify and kill by pid',
  },
]

/**
 * Why `capture` and `timeline` are in {@link PROSE_BY_VERB} rather than rewritten
 * to a tool.
 *
 * (Named rather than left to adjacency: this comment sits below the claim-repair
 * table, so a reader arriving at it has to be told which table it is about.)
 *
 * `capture` fetches a live website and builds a composition from it
 * (`hyperframes capture https://stripe.com` → `./capture/` plus a video
 * manifest). That needs general network egress and an arbitrary-site fetcher,
 * which is the opposite of what this plugin is: an offline, deterministic local
 * renderer. There is no tool to point it at.
 *
 * `timeline` is here for a narrower reason. Its *read* form (describe the tracks
 * and clips) is information the preview surface should carry, but its mutation
 * verbs (`move`, `delete`, `split`, with `--plan`/`--overwrite`) edit the user's
 * composition source. A model that wants to change a composition can edit the
 * file with the tools it already has, under the same review and checkpoint
 * machinery as any other edit; a second, parallel mutation surface with its own
 * semantics would be a way around those guards rather than through them. The
 * read half is answered by preview, so nothing is lost that the pack needs.
 */

/** Invocation forms worth reporting even when they are rewritten. */
const CLI_PROBE = /\bnpx\s+(?:-y\s+)?hyperframes\b[^\n`]*/gu

/** The body limit `inspectSkillRoot()` enforces, in bytes. */
const BODY_LIMIT_BYTES = 64 * 1024

/**
 * Characters `tests/engineering.spec.ts` refuses in a bundled asset.
 *
 * The variation selector and the zero-width joiner are included because they
 * exist only to shape an emoji: keeping either one would leave invisible bytes in
 * a shipped asset while removing the glyph they were shaping.
 */
const EMOJI = /\p{Emoji_Presentation}|\uFE0F|\u200D/gu

/**
 * The whitespace the removal of a glyph is allowed to touch.
 *
 * Spaces and tabs only — never a newline. A Skill body is mostly markdown, and a
 * newline is structural there: indented code blocks, fenced examples and ASCII
 * diagrams all depend on it. Collapsing whitespace more broadly is not a tidy-up,
 * it is a reflow of the document.
 */
const EMOJI_GAP = new RegExp(`[ \\t]*(?:\\p{Emoji_Presentation}|\\uFE0F|\\u200D)+[ \\t]*`, 'gu')

// ------------------------------------------------------------------ 工具

const slash = (value) => value.split(sep).join('/')

/** Walk a directory, returning every file path, relative to `root`. */
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
 * A content digest of the upstream `skills/` tree, as the vendoring's provenance.
 *
 * Upstream ships no version field and this pack is vendored from a source archive
 * rather than a checkout, so **there is no commit to cite** and "vendored from
 * heygen-com/hyperframes" would not say which state. The digest is the citable
 * fact instead: a future sync recomputes it and knows immediately whether anything
 * upstream moved.
 *
 * It covers **every** upstream file, excluded Skills included. The digest identifies
 * the *source state*, not this pack's selection from it — a selection-sensitive
 * digest would change whenever the exclusion list changed, and would then no longer
 * say whether the source itself moved.
 *
 * Path and content are hashed separately (the path, a NUL, then the file's own
 * SHA-256) so that a rename cannot be cancelled out by an offsetting edit.
 *
 * The trailing `sort()` is load-bearing rather than tidy: `readdirSync` makes no
 * ordering guarantee, so without it the same tree could digest differently on two
 * machines and the value cited in `THIRD_PARTY_NOTICES.md` would mean nothing.
 *
 * @param skillsRoot the upstream `skills/` directory
 * @returns the digest and what it was computed over
 */
function digestUpstreamTree(skillsRoot) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  for (const entry of walk(skillsRoot).sort()) {
    const buffer = readFileSync(join(skillsRoot, entry))
    files += 1
    bytes += buffer.length
    hash.update(entry)
    hash.update('\0')
    hash.update(createHash('sha256').update(buffer).digest())
  }
  return { digest: hash.digest('hex'), files, bytes }
}

/**
 * Strip emoji-presentation characters from Skill text without reflowing it.
 *
 * Two rules, and the second one is the whole difficulty:
 *
 * 1. **A glyph at the start of a line disappears; anywhere else it becomes one
 *    space.** Upstream uses emoji as trailing punctuation (`**PASS** ✅`) and as a
 *    bullet marker (`❓ Question`). Deleting a trailing glyph outright is correct;
 *    deleting a *leading* one is too, because the line's own markup already
 *    labels it. Deleting a glyph that sits *between* two words would join them,
 *    so that case becomes a space.
 * 2. **Only the glyph's own neighbourhood is collapsed.** This function used to
 *    run a global `[ \t]{2,}` collapse as a tidy-up, and that was a defect: it
 *    silently reflowed 8.7 KB of `talking-head-recut` alone — table alignment,
 *    indented examples and ASCII diagrams included. Worse, it made the 64 KiB body
 *    audit pass for a reason nobody had chosen. The audit must see the text the
 *    Skill will actually be read as, so the only whitespace this touches is the
 *    run immediately around a removed glyph.
 *
 * This follows the convention `THIRD_PARTY_NOTICES.md` already records for the
 * vendored packs: a dropped glyph is dropped (the `❓` case), and a verdict marker
 * becomes a word rather than a space. The word substitutions live in
 * {@link GLYPH_WORDS} so the two vendored packs and this one cannot drift into
 * three different spellings of the same verdict.
 */
function stripEmoji(text) {
  // Order matters and is not a style choice: EMOJI_GAP removes `\uFE0F` as an
  // orphaned selector, so running it first would leave `⚠` behind and the
  // `UNVERIFIABLE` substitution could never fire. Words first, then whatever
  // glyphs are left over.
  return text
    .replace(EMOJI_WORDS, (match) => GLYPH_WORDS.get(match) ?? '')
    .replace(EMOJI_GAP, (match, offset, whole) => {
      const previous = whole[offset - 1]
      return previous === undefined || previous === '\n' ? '' : ' '
    })
}

/**
 * Correct the sentences the CLI substitution falsified.
 *
 * Runs after {@link CLI_REWRITES} and before everything else, because what it
 * matches is the *substituted* text: the first pattern's span holds whichever name
 * is there when this runs, so it cannot depend on the rewrite having already
 * happened. That is also why the span is matched as `[^`]*` rather than as the
 * tool name — the rule is about the sentence, not about the spelling in it.
 *
 * @param text the text after the invocation rewrites
 * @param skill the Skill directory name, for the finding record
 * @param file the path within the pack, for the finding record
 * @param applied collects the repairs that fired, so the run can report the ones
 *                that did not
 * @returns the corrected text and the findings this file produced
 */
function repairFalseClaims(text, skill, file, applied) {
  const findings = []
  let output = text
  for (const repair of CLAIM_REPAIRS) {
    if (!repair.pattern.test(output)) continue
    output = output.replace(repair.pattern, repair.replacement)
    applied.add(repair)
    findings.push({ kind: 'claim-repaired', skill, file, text: `${repair.id}: ${repair.reason}` })
  }
  return { text: output, findings }
}

/**
 * Rewrite CLI invocations to the in-process tools, and collect what else is named.
 *
 * @param text the Skill body or reference document
 * @param skill the Skill directory name, for the finding record
 * @param file the path within the pack, for the finding record
 * @param applied collects the claim repairs that fired
 * @returns the rewritten text and the findings this file produced
 */
function rewriteInvocations(text, skill, file, applied) {
  const findings = []
  let output = text
  const names = new Set()

  // Order is the contract: map what has a capability, then dispose of what does
  // not, then probe for leftovers. A different order produces wrong reports — doing
  // the probe first called every unsupported verb "unmapped", and reporting the
  // unsupported set separately from the removal double-counted each site.
  for (const { pattern, replacement } of CLI_REWRITES) {
    for (const match of output.matchAll(pattern)) names.add(match[0].trim())
    output = output.replace(pattern, replacement)
  }

  const claims = repairFalseClaims(output, skill, file, applied)
  findings.push(...claims.findings)
  output = claims.text

  const removed = removeUnsupportedInvocations(output, skill, file)
  findings.push(...removed.findings)
  output = removed.text

  const prose = rewriteProseSentences(output, skill, file)
  findings.push(...prose.findings)
  output = prose.text.replace(MARK, UNSUPPORTED_INLINE)

  // Whatever the probe still finds is a CLI form with no mapping and no removal
  // rule. Naming it is the point: this is the set a future upstream sync adds to,
  // and an unmapped form that ships is a Skill instructing a command that does not
  // exist.
  for (const match of output.matchAll(CLI_PROBE)) {
    findings.push({ kind: 'unmapped-cli', skill, file, text: match[0].trim() })
  }

  if (names.size > 0) findings.push({ kind: 'rewritten', skill, file, text: [...names].join(' | ') })
  return { text: output, findings }
}

/** One `SKILL.md` body that has to be split before it can ship. */
function bodyBudgetFinding(skill, file, bytes) {
  return { kind: 'over-body-budget', skill, file, text: `${bytes} bytes (limit ${BODY_LIMIT_BYTES})` }
}

/**
 * Remove invocations of capabilities this pack does not provide.
 *
 * Two shapes, two remedies, and the difference is whether the line has anything
 * other than the call on it:
 *
 * - **A line that is only an invocation disappears, indentation and all.** These
 *   sit in fenced command blocks ("`hyperframes init "videos/<project>"`"), where
 *   the surrounding prose introduces the block rather than the line, so removing
 *   the line leaves the block readable and the workflow honestly shorter.
 * - **An invocation inside a sentence keeps its sentence**, with the fragment
 *   replaced by a phrase. Deleting it would leave "Run  to scaffold", and because
 *   the surrounding paragraph usually explains a workflow that no longer exists,
 *   every one of these is reported as `needs-review` rather than treated as done.
 *   That is the honest split: the mechanical half can be automated, the prose
 *   cannot, and pretending otherwise would ship instructions nobody can follow.
 *
 * @param text the cleaned Skill text
 * @param skill the Skill directory name, for the finding record
 * @param file the path within the pack, for the finding record
 * @returns the text without those invocations, and what was done
 */
function removeUnsupportedInvocations(text, skill, file) {
  const findings = []
  const kept = []
  for (const line of text.split('\n')) {
    if (UNSUPPORTED_INVOCATION.test(line.trim())) {
      findings.push({ kind: 'removed-line', skill, file, text: line.trim() })
      continue
    }
    kept.push(line)
  }
  // The marker, not the placeholder: the verb has to survive to the prose pass.
  const output = kept.join('\n').replace(UNSUPPORTED_VERBS, (match, verb) => `${MARK_OPEN}${verb}${MARK_CLOSE}`)
  return { text: output, findings }
}

/**
 * Replace the sentence around an unsupported invocation, verb by verb.
 *
 * Sentence level, not fragment level. The fragment is the reason the instruction
 * cannot be followed, but the sentence is the unit a reader acts on: `npx hyperframes
 * catalog --query "<the look>" --json` and read the top results BEFORE you write that
 * look into `STORYBOARD.md` is unusable in full, and usable once the whole sentence
 * becomes the catalogue sentence. Swapping only the fragment leaves "Run a capability
 * this plugin does not provide and read the top results", which is worse than either.
 *
 * Fenced code blocks are skipped. A command block is not prose, its lines are the
 * instruction, and a sentence substitution there would quietly turn an example into a
 * paragraph. Inline code spans on a prose line are fair game, because the sentence
 * around them is where the meaning lives.
 *
 * A sentence whose verb has no entry is **deleted**, not left with a placeholder, and
 * reported: an unsupported instruction that nobody has written a replacement for is
 * a step the reader would try to follow and fail at.
 *
 * @param text the text after invocations were replaced by markers
 * @param skill the Skill directory name, for the finding record
 * @param file the path within the pack, for the finding record
 * @returns the rewritten text and what was done to it
 */
function rewriteProseSentences(text, skill, file) {
  const findings = []
  let inFence = false
  const output = text.split('\n').map((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; return line }
    if (inFence || !line.includes(MARK_OPEN)) return line
    return line
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => {
        const match = new RegExp(MARK.source, 'u').exec(sentence)
        if (match === null) return sentence
        const replacement = PROSE_BY_VERB.get(match[1])
        if (replacement === undefined) {
          findings.push({ kind: 'needs-review', skill, file, text: sentence.trim().slice(0, 200) })
          return ''
        }
        findings.push({ kind: 'prose-rewritten', skill, file, text: `${match[1]}: ${replacement}` })
        return replacement
      })
      .filter((sentence) => sentence !== '')
      .join(' ')
  })
  return { text: output.join('\n'), findings }
}

/**
 * Move the largest section out of a body that is over budget, and point at it.
 *
 * The rule is general rather than a list of files: any `SKILL.md` over the limit
 * gives up its widest `####` section to `references/`, repeatedly, until it fits.
 * A per-file exception table would have to be re-derived on every upstream sync,
 * and the reason the pack is over budget in the first place is that upstream keeps
 * growing these bodies — so the remedy has to be a rule.
 *
 * The extracted section keeps its own heading, and the body keeps a one-line
 * pointer plus the sentence that says why the reader should follow it. This is the
 * shape `THIRD_PARTY_NOTICES.md` already records for `subagent-driven-development`
 * ("its body was split: … moved into `process-diagrams.md`, … each linked from the
 * body where it is used"), including the reason: a body is loaded into context
 * whenever the Skill is selected, so its size is paid in every window it is chosen
 * for, while a linked reference is paid only when the reader follows it.
 *
 * @param skill the Skill directory name
 * @param text the cleaned body
 * @returns the possibly-shortened body and the files it produced
 */
function enforceBodyBudget(skill, text) {
  const extracted = []
  let output = text
  for (let attempt = 0; attempt < 8 && Buffer.byteLength(output, 'utf8') > BODY_LIMIT_BYTES; attempt += 1) {
    const lines = output.split('\n')
    // Candidate sections: a `#### ` heading and everything up to the next heading
    // of the same or a shallower level. Sections rather than paragraphs, because a
    // moved paragraph leaves the section it belonged to unreadable.
    let best = undefined
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
    const name = `references/${slug}.md`
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
  const options = { source: undefined, out: join(process.cwd(), 'assets', 'design', 'skills'), write: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') options.source = argv[++index]
    else if (argument === '--out') options.out = resolve(argv[++index] ?? '')
    else if (argument === '--write') options.write = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
  }
  return options
}

/**
 * Say something about the run without corrupting the machine-readable output.
 *
 * Under `--json`, `stdout` carries the report and nothing else, and every human
 * sentence goes to `stderr`. The alternative — a report followed by a status line —
 * means every consumer has to find where the JSON stops, and the first consumer to
 * guess wrong is the test suite, which is exactly what happened: `--write` ends with
 * `wrote N files` rather than `dry run`, so a parser keyed to the dry-run trailer read
 * the status line as part of the document. A mode called `--json` should not need to be
 * told where its JSON ends.
 *
 * @param options the parsed arguments
 * @param message the sentence to emit
 */
function note(options, message) {
  if (options.json === true) console.error(message)
  else console.log(message)
}

function usage() {
  return [
    'Vendor the HyperFrames Skill pack into this package, cleaned for its audits.',
    '',
    '  --source <dir>   upstream checkout containing `skills/` (required)',
    '  --out <dir>      destination (default: assets/design/skills)',
    '  --write          actually write; without it this is a dry run',
    '  --json           machine-readable report on stdout',
  ].join('\n')
}

function main(argv) {
  const options = parseArguments(argv)
  if (options.help === true) { console.log(usage()); return 0 }
  if (options.source === undefined) { console.error(`--source is required\n\n${usage()}`); return 2 }

  const skillsRoot = join(resolve(options.source), 'skills')
  if (!existsSync(skillsRoot)) { console.error(`no skills/ under ${resolve(options.source)}`); return 2 }

  const allSkills = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const included = allSkills.filter((name) => !EXCLUDED_SKILLS.has(name) && existsSync(join(skillsRoot, name, 'SKILL.md')))

  const findings = []
  const plan = []
  const dropped = []
  /** The claim repairs that actually fired, so the rest can be reported as moved. */
  const appliedClaims = new Set()

  for (const skill of included) {
    const root = join(skillsRoot, skill)
    for (const file of walk(root).sort()) {
      const source = join(root, file)
      const bytes = statSync(source).size
      const extension = extensionOf(file)

      const droppedClass = DROPPED_CLASSES.find((entry) => entry.test(extension))
      if (droppedClass !== undefined) { dropped.push({ skill, file, bytes, reason: droppedClass.what }); continue }
      if (!KEPT_EXTENSIONS.has(extension)) { dropped.push({ skill, file, bytes, reason: `extension ${extension || '(none)'} is not a knowledge file` }); continue }
      // `.css` past the threshold is a font payload wearing a styling extension.
      if (extension === '.css' && bytes > CSS_ASSET_BYTES) { dropped.push({ skill, file, bytes, reason: 'css file carries inlined binary assets' }); continue }

      const raw = readFileSync(source, 'utf8')
      const cleaned = stripEmoji(raw)
      // Rewrites precede the budget pass, not the other way round: the budget is a
      // constraint on what will actually be written, and a rewrite changes the
      // length. Extracting first would let a later rewrite shorten the body below
      // the limit while a section had already been moved out of it.
      const { text: rewritten, findings: local } = rewriteInvocations(cleaned, skill, file, appliedClaims)
      findings.push(...local)
      let text = rewritten
      if (file === 'SKILL.md') {
        const budget = enforceBodyBudget(skill, text)
        text = budget.text
        for (const extra of budget.extracted) {
          if (extra.path === undefined) { findings.push(bodyBudgetFinding(skill, file, extra.text)); continue }
          findings.push({ kind: 'extracted', skill, file: extra.path, text: `${Buffer.byteLength(extra.text, 'utf8')} bytes` })
          plan.push({ skill, file: extra.path, source, destination: join(options.out, skill, extra.path), bytes: Buffer.byteLength(extra.text, 'utf8'), writtenBytes: Buffer.byteLength(extra.text, 'utf8'), text: extra.text, changed: true })
        }
      }
      plan.push({ skill, file, source, destination: join(options.out, skill, file), bytes, writtenBytes: Buffer.byteLength(text, 'utf8'), text, changed: text !== raw })
    }
  }

  // ---------------------------------------------------------------- 报告

  const byKind = (kind) => findings.filter((finding) => finding.kind === kind)
  const summary = {
    upstream: {
      skills: allSkills.length,
      excluded: allSkills.filter((name) => EXCLUDED_SKILLS.has(name)),
      included: included.length,
      tree: digestUpstreamTree(skillsRoot),
    },
    excludedReasons: [...EXCLUDED_SKILLS.entries()].map(([skill, reason]) => ({ skill, reason })),
    kept: { files: plan.length, bytes: plan.reduce((total, entry) => total + entry.writtenBytes, 0) },
    dropped: {
      files: dropped.length,
      bytes: dropped.reduce((total, entry) => total + entry.bytes, 0),
      byReason: Object.entries(dropped.reduce((counts, entry) => { counts[entry.reason] = (counts[entry.reason] ?? 0) + 1; return counts }, {})),
    },
    findings: {
      rewritten: byKind('rewritten').length,
      extracted: byKind('extracted'),
      'unmapped-cli': byKind('unmapped-cli'),
      'removed-line': byKind('removed-line'),
      'prose-rewritten': byKind('prose-rewritten'),
      'needs-review': byKind('needs-review'),
      'over-body-budget': byKind('over-body-budget'),
      'claim-repaired': byKind('claim-repaired'),
    },
    /**
     * The claim audit, kept beside `findings` rather than inside it.
     *
     * `findings` records what this pass *did* to a file, and every kind in it is
     * discovered by scanning the text. This one is the other direction: the list of
     * sentences known to be false here is written down first, and the question is
     * whether each one was still there to fix. A repair that could not fire means
     * upstream reworded the sentence, so a reviewer has to read it again — the text
     * that was there is gone, but nothing says what replaced it.
     *
     * Not a write blocker, unlike `unmapped-cli`. That kind proves an instruction
     * cannot be followed; this one proves only that a decision was made against text
     * that has moved, which is the `needs-review` shape — a human sentence is owed,
     * and refusing to write until then would mean nothing is ever vendored.
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
    console.log(`upstream skills   : ${summary.upstream.skills}`)
    console.log(`upstream tree     : sha256:${summary.upstream.tree.digest}`)
    console.log(`                    ${summary.upstream.tree.files} files, ${summary.upstream.tree.bytes} bytes`)
    console.log('                    (cite this in THIRD_PARTY_NOTICES.md — upstream ships no version)')
    console.log(`excluded          : ${summary.upstream.excluded.join(', ')}`)
    for (const entry of summary.excludedReasons) console.log(`                    - ${entry.skill}: ${entry.reason}`)
    console.log(`included skills   : ${summary.upstream.included}`)
    console.log(`kept              : ${summary.kept.files} files, ${kb(summary.kept.bytes)}`)
    console.log(`dropped           : ${summary.dropped.files} files, ${kb(summary.dropped.bytes)}`)
    for (const [reason, count] of summary.dropped.byReason) console.log(`                    - ${count} × ${reason}`)
    console.log(`files changed     : ${summary.changedFiles}`)
    console.log(`rewritten files   : ${summary.findings.rewritten}`)
    console.log('')
    const list = (title, rows) => {
      console.log(`${title} (${rows.length})`)
      if (rows.length === 0) console.log('  (none)')
      for (const row of rows.slice(0, 40)) console.log(`  ${row.skill}/${row.file}: ${row.text}`)
      if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`)
      console.log('')
    }
    list('OVER BODY BUDGET — still over after extraction, needs a hand split', summary.findings['over-body-budget'])
    list('EXTRACTED — moved out of a body that was over budget', summary.findings.extracted)
    list('REMOVED LINES — invocations of capabilities this pack does not provide', summary.findings['removed-line'])
    console.log(`PROSE REWRITTEN — a sentence around a missing capability, replaced (${summary.findings['prose-rewritten'].length})`)
    if (summary.findings['prose-rewritten'].length > 0) {
      const byVerb = new Map()
      for (const row of summary.findings['prose-rewritten']) {
        const verb = row.text.slice(0, row.text.indexOf(':'))
        byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1)
      }
      for (const [verb, count] of [...byVerb.entries()].sort((left, right) => right[1] - left[1])) console.log(`  ${verb} × ${count}`)
    }
    console.log('')
    console.log(`CLAIMS REPAIRED — a sentence the substitution falsified, corrected (${summary.claims.repaired.length})`)
    if (summary.claims.repaired.length === 0) console.log('  (none)')
    for (const row of summary.claims.repaired) console.log(`  ${row.skill}/${row.file}: ${row.text}`)
    console.log('')
    console.log(`CLAIM REPAIR DID NOT APPLY — re-read the sentence before shipping (${summary.claims.unmatched.length})`)
    if (summary.claims.unmatched.length === 0) console.log('  (none)')
    for (const row of summary.claims.unmatched) console.log(`  ${row.id}: ${row.pattern}`)
    console.log('')
    list('NEEDS REVIEW — a sentence mentions a missing capability and still reads wrong', summary.findings['needs-review'])
    list('UNMAPPED CLI — add a mapping or the Skill names a missing command', summary.findings['unmapped-cli'])
  }

  if (options.write !== true) { note(options, 'dry run — pass --write to materialise'); return 0 }
  // Only the two hard invariants refuse a write. `over-body-budget` is the audit in
  // `inspectSkillRoot()` that the Skill cannot pass as written; `unmapped-cli` is a
  // Skill instructing a command that does not exist. `needs-review` prose is a
  // warning rather than a blocker on purpose: it needs a human sentence, and
  // refusing to write until every one is rewritten would mean nothing is ever
  // vendored — the pack would sit in review forever instead of being testable.
  if (findings.some((finding) => finding.kind === 'over-body-budget' || finding.kind === 'unmapped-cli')) {
    console.error('refusing to write: unresolved body-budget and unmapped-CLI findings above')
    return 1
  }

  rmSync(options.out, { recursive: true, force: true })
  for (const entry of plan) {
    mkdirSync(dirname(entry.destination), { recursive: true })
    writeFileSync(entry.destination, entry.text)
  }
  note(options, `wrote ${plan.length} files to ${slash(options.out)}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
