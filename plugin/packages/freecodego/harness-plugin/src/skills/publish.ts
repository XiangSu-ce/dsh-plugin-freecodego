/**
 * Publishing a skill: the checks that should run before it leaves the machine.
 *
 * A dry-run validator rather than a publish pipeline, because the expensive
 * mistake is not a failed upload — it is a skill that uploads successfully with a
 * description that never triggers, a body that overflows every context window it
 * is loaded into, or a command that a reviewing human would have caught.
 *
 * Four checks, and each one exists because of a specific way a skill goes wrong:
 *
 * - **Name** — has to be usable as a directory and as a lookup key, and a name
 *   that only *looks* right (uppercase, spaces, a leading dash) breaks discovery
 *   quietly.
 * - **Description** — an empty one is useless, and so is one that describes the
 *   skill without describing when to use it. The second is a judgement call and
 *   is reported as a warning rather than an error, because a validator that
 *   refuses something correct is a validator people route around.
 * - **Size** — priced through the plugin's single estimator, so the number a
 *   publisher sees is the number the context breakdown will show.
 * - **Dangerous commands** — the same audit the plugin already runs over
 *   installed assets, imported from `dangerous-command-patterns.ts` rather than
 *   restated here. A command *shape* is an error and a command *word* is a
 *   warning: `rm -rf /` is the operation, while `sudo` and `eval(` are words a
 *   sentence about the guard uses too, and a validator that refuses those is a
 *   validator people route around. This bullet used to describe that reuse while the file held a
 *   second list of its own, and the two disagreed in both directions: `mkfs`,
 *   `dd if=`, `chmod -R 777` and `git push --force` were errors here and invisible
 *   to the audit, while `rm -fr` was refused by the audit and missed here. Two
 *   lists mean a command can be dangerous in one surface and fine in the other,
 *   which is the failure this bullet exists to prevent.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/publish
 */

import { dangerousCommandFindings } from '../dangerous-command-patterns.ts'
import { tokensFromChars } from '../token-estimate.ts'
import { isUsableSkillName } from './collisions.ts'

/** Default maximum body size, in tokens. */
export const DEFAULT_SKILL_TOKEN_LIMIT = 5_000

/** The frontmatter fields a skill may declare. */
export interface SkillFrontmatter {
  readonly name?: string
  readonly description?: string
}

/** A finding from the pre-flight. */
export interface PublishFinding {
  readonly severity: 'error' | 'warning'
  readonly code: 'name' | 'description' | 'size' | 'dangerous-command'
  readonly message: string
}

/** What the pre-flight concluded. */
export interface PublishReport {
  readonly ok: boolean
  readonly name?: string
  readonly description?: string
  readonly tokens: number
  readonly limitTokens: number
  readonly findings: readonly PublishFinding[]
}

/**
 * Split a `SKILL.md` into its frontmatter and body.
 *
 * A hand-written block rather than a YAML parser, for the same reason the persona
 * TOML subset is hand-written: five scalar fields do not justify a dependency,
 * and the subset is refusable. Anything that is not `key: value` inside the
 * delimiters is reported rather than ignored.
 * @param markdown - the file's text.
 * @returns the frontmatter, the body, and any lines that could not be read.
 */
export function parseSkillDocument(markdown: string): {
  readonly frontmatter: SkillFrontmatter
  readonly body: string
  readonly unreadable: readonly string[]
} {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized, unreadable: [] }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, body: normalized, unreadable: ['the frontmatter block is never closed'] }
  const block = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  const frontmatter: { name?: string; description?: string } = {}
  const unreadable: string[] = []
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) {
      unreadable.push(`frontmatter line ${JSON.stringify(trimmed)} is not "key: value"`)
      continue
    }
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'name') frontmatter.name = value
    else if (key === 'description') frontmatter.description = value
  }
  return { frontmatter, body, unreadable }
}

/**
 * Run the publish pre-flight.
 * @param input - the skill's markdown and the fallback name (its directory).
 * @returns the report; `ok` is false only when an error-severity finding exists.
 */
export function checkSkillForPublish(input: {
  readonly markdown: string
  readonly directoryName: string
  readonly limitTokens?: number
}): PublishReport {
  const limitTokens = input.limitTokens ?? DEFAULT_SKILL_TOKEN_LIMIT
  const { frontmatter, body, unreadable } = parseSkillDocument(input.markdown)
  const findings: PublishFinding[] = []
  for (const line of unreadable) {
    findings.push({ severity: 'error', code: 'description', message: `${line}; the field will not be read` })
  }

  const name = frontmatter.name ?? input.directoryName
  if (!isUsableSkillName(name)) {
    findings.push({
      severity: 'error',
      code: 'name',
      message: `"${name}" is not a usable skill name: lowercase letters, digits and dashes only, at most 64 characters, no leading dash`,
    })
  }

  const description = frontmatter.description
  if (description === undefined || description.trim() === '') {
    findings.push({ severity: 'error', code: 'description', message: 'the skill has no description, so nothing can decide when to use it' })
  } else if (!/when|use (?:this|it)|if the user|before|after|for tasks/i.test(description)) {
    findings.push({
      severity: 'warning',
      code: 'description',
      message: 'the description says what the skill is but not when to reach for it; a description that names the trigger is what makes a skill selectable',
    })
  }

  const tokens = tokensFromChars(body.length)
  if (tokens > limitTokens) {
    findings.push({
      severity: 'error',
      code: 'size',
      message: `the body is about ${tokens} tokens, over the ${limitTokens}-token limit; a skill this large is loaded into every window it is selected for`,
    })
  }

  // One finding per pattern that matched, so a body with three of them names all
  // three instead of whichever one the scan happened to reach first. A *shape*
  // (`rm -rf /`) is the operation itself and refuses the publish; a *word*
  // (`sudo`, `eval(`) is reported and does not, because a skill that documents
  // the guard — or tells the reader to install something themselves — writes the
  // same word without instructing anybody to run anything. See
  // {@link DANGEROUS_COMMAND_MENTION_PATTERNS}.
  for (const finding of dangerousCommandFindings(body)) {
    findings.push({
      severity: finding.mention ? 'warning' : 'error',
      code: 'dangerous-command',
      message: finding.mention
        ? `the body mentions "${finding.command}"; confirm the skill never asks for it to be run`
        : `the body contains "${finding.command}", which needs a reviewer's sign-off before it ships`,
    })
  }

  return {
    ok: findings.every(finding => finding.severity !== 'error'),
    name,
    ...(description === undefined ? {} : { description }),
    tokens,
    limitTokens,
    findings,
  }
}
