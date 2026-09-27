/**
 * Placing a fetched React Bits component in the caller's project.
 *
 * The other half of the row: `get` hands the source over, and `apply` writes it
 * where the caller said. Writing is the step that cannot be taken back — an
 * existing file's content is gone once replaced — so this module is built around
 * two rules rather than around convenience.
 *
 * **Two alterations, and only two, each recorded.** Upstream's source is written
 * as it arrived except for:
 *
 *  - a leading `'use client'` directive, because without it the file does not
 *    render at all under a server-rendering framework, and the directive is the
 *    one edit that cannot change what the component does; and
 *  - a `prefers-reduced-motion` block appended to a stylesheet that animates
 *    without one, because that is a real accessibility gap and the stylesheet is
 *    the one place it can be closed without touching the component's logic.
 *
 * The second edit is written as *duration*, not as `animation: none`, and the
 * difference is the whole reason this is defensible: an entrance animation often
 * starts at `opacity: 0`, so removing it outright leaves the content invisible —
 * a worse outcome than the motion it was meant to spare. `0.01ms` runs the
 * animation to its final state within a frame, and `iteration-count: 1` stops an
 * infinite loop after one pass. Anything else a caller wants — a different easing,
 * a shorter piece of the animation, a prop wired through — is theirs to write,
 * because a mechanical patch that guessed at it would be a port of the component,
 * which is the thing the licence quoted in `registry.ts` forbids.
 *
 * **Every path is checked before anything is written.** The destination is the
 * caller's own directory inside the session working directory, the file names are
 * upstream's own names taken from the last path segment, and a path that climbs
 * out of the working directory is refused rather than normalized into something
 * nearby. Conflicts are reported per file: the default is to leave an existing file
 * alone and say so, and replacing it takes an explicit word from the caller.
 *
 * @module reactbits/apply
 */

/** One mechanical change this module made to a file, and why. */
export interface ReactBitsTransformation {
  readonly id: 'client-directive' | 'reduced-motion'
  /** One line, so the difference from upstream is auditable without a diff. */
  readonly reason: string
}

/** One file the caller is about to receive, with its final content. */
export interface ReactBitsPlannedFile {
  /** The path as the registry named it, for the report. */
  readonly path: string
  /** The file name to write, taken from the path's last segment. */
  readonly writeAs: string
  readonly kind: 'component' | 'style' | 'other'
  readonly content: string
  readonly bytes: number
  readonly transformations: readonly ReactBitsTransformation[]
}

/** How the caller wants an existing file treated. */
export type ReactBitsConflictPolicy = 'skip' | 'replace'

/** When the `'use client'` directive is added. */
export type ReactBitsDirectivePolicy = 'auto' | 'always' | 'never'

/** What to plan a write from. */
export interface ReactBitsWritePlanInput {
  readonly files: readonly { readonly path: string; readonly content: string }[]
  /** Whether the component's own source would be rendered on the server. */
  readonly serverRendered: boolean
  readonly directive: ReactBitsDirectivePolicy
  /** Whether a stylesheet's motion may be bounded. Defaults to on. */
  readonly reducedMotion?: boolean
}

/** The plans, plus the things a write cannot do for the caller. */
export interface ReactBitsWritePlan {
  readonly files: readonly ReactBitsPlannedFile[]
  /** Steps left to the caller, each with the reason it was not automated. */
  readonly followUps: readonly { readonly id: string; readonly message: string }[]
}

/** Whether a path is a stylesheet. */
function isStyle(path: string): boolean {
  return /\.css$/u.test(path)
}

/** Whether a path is a component source. */
function isComponent(path: string): boolean {
  return /\.[jt]sx?$/u.test(path) || /\.vue$/u.test(path)
}

/** A leading `'use client'` directive, comments allowed above it. */
const LEADING_DIRECTIVE = /^\s*(?:(?:\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)\s*)*['"]use client['"]/u

/** Where one block's prelude begins, for the stylesheet scan. */
const BLOCK = /([^{}]*)\{([^{}]*)\}/gu

/** The declarations that mean a rule animates something. */
const ANIMATION_DECLARATION = /(?:^|;)\s*(?:-\w+-)?(?:animation|transition)(?:-[\w-]+)?\s*:/iu

/** A keyframe selector, which is not a selector anything can be told to slow down. */
const KEYFRAME_PRELUDE = /^\s*(?:from|to|\d+(?:\.\d+)?%)\s*(?:,|$)/u

/**
 * Selectors in a stylesheet that animate, in the order they appear, deduplicated.
 *
 * @param sheet - the stylesheet's contents.
 * @returns the selectors whose block declares an animation or a transition.
 */
export function animatingSelectors(sheet: string): readonly string[] {
  // Comments first: a comment explaining an animation would otherwise be read as
  // one, and a rule commented out would be handed back as a selector to patch.
  const source = sheet.replace(/\/\*[\s\S]*?\*\//gu, ' ')
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of source.matchAll(BLOCK)) {
    const prelude = (match[1] ?? '').trim()
    const body = match[2] ?? ''
    if (prelude === '' || prelude.startsWith('@') || KEYFRAME_PRELUDE.test(prelude)) continue
    if (!ANIMATION_DECLARATION.test(body)) continue
    // Nested preludes (`@media x { .a { … } }`) come back as `.a`, because the outer
    // block contains braces and this pattern only matches innermost ones.
    const selector = prelude.split(/[,;]/u).map(part => part.trim()).filter(part => part !== '')
    for (const one of selector) {
      if (seen.has(one)) continue
      seen.add(one)
      found.push(one)
    }
  }
  return found
}

/**
 * The reduced-motion block for one stylesheet, or `undefined` when there is nothing
 * to bound.
 *
 * @param sheet - the stylesheet's contents.
 * @returns the text to append, or `undefined` when the sheet does not animate or
 *          already handles the setting.
 */
export function reducedMotionBlock(sheet: string): string | undefined {
  if (/prefers-reduced-motion/u.test(sheet)) return undefined
  const selectors = animatingSelectors(sheet)
  if (selectors.length === 0) return undefined
  return [
    '',
    '/* Added by freecodego_reactbits: honour the system motion setting. */',
    '@media (prefers-reduced-motion: reduce) {',
    `  ${selectors.join(',\n  ')} {`,
    '    animation-duration: 0.01ms !important;',
    '    animation-iteration-count: 1 !important;',
    '    transition-duration: 0.01ms !important;',
    '    scroll-behavior: auto !important;',
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * The file name to write, taken from the path's own last segment.
 *
 * Upstream's `path` carries a directory (`CountUp/CountUp.tsx`) that belongs to its
 * own layout rather than to the caller's, so the destination is the caller's
 * directory plus this name.
 *
 * @param path - the path as the registry spells it.
 * @returns the name to write the file under.
 */
export function writeAsName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name === '' ? path : name
}

/** The directive line, and the blank line after it. */
const DIRECTIVE_PREFIX = "'use client'\n\n"

/**
 * Plan the files a caller would receive, without touching anything.
 *
 * Split from the writing so the decision can be shown before it is taken: the
 * refusal a caller gets for a destination that leaves the working directory names
 * the same files this returns, and the `get` action reports the same names without
 * a destination at all.
 *
 * @param input - the fetched files, the framework they are going to, and the two
 *                alteration policies.
 * @returns the files with their final content, and the steps left to the caller.
 */
export function planReactBitsWrites(input: ReactBitsWritePlanInput): ReactBitsWritePlan {
  const files: ReactBitsPlannedFile[] = []
  const followUps: { id: string; message: string }[] = []
  const wantsMotion = input.reducedMotion !== false
  let directiveAdded = false
  let motionBounded = false
  let motionSkippedForLogic = false

  for (const file of input.files) {
    const transformations: ReactBitsTransformation[] = []
    let content = file.content

    if (isComponent(file.path) && !LEADING_DIRECTIVE.test(content)) {
      const wanted = input.directive === 'always' || (input.directive === 'auto' && input.serverRendered)
      if (wanted) {
        content = `${DIRECTIVE_PREFIX}${content}`
        directiveAdded = true
        transformations.push({
          id: 'client-directive',
          reason: 'upstream ships no directive and this component needs the client; the line cannot change what it renders',
        })
      }
    }

    if (isStyle(file.path) && wantsMotion) {
      const block = reducedMotionBlock(content)
      if (block !== undefined) {
        content = `${content.replace(/\s*$/u, '')}\n${block}`
        motionBounded = true
        transformations.push({
          id: 'reduced-motion',
          reason: 'the sheet animates and ignored the system setting; duration rather than removal, so an entrance animation still reaches its end state',
        })
      }
    }

    files.push({
      path: file.path,
      writeAs: writeAsName(file.path),
      kind: isStyle(file.path) ? 'style' : isComponent(file.path) ? 'component' : 'other',
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      transformations,
    })
  }

  if (directiveAdded) {
    followUps.push({
      id: 'client-directive',
      message: "A leading `'use client'` line was added to each component file. The component still has to be imported from a client boundary — a server component's import of it is what the directive is protecting.",
    })
  }
  const animated = files.some(file => file.kind === 'component' && /\b(?:gsap|motion|animate|requestAnimationFrame|useEffect)\b/u.test(file.content))
  if (animated && !motionBounded) {
    motionSkippedForLogic = true
    followUps.push({
      id: 'reduced-motion-manual',
      message: 'This component animates in JavaScript, so no stylesheet rule can bound it. Add a `prefers-reduced-motion` branch where its animation is started — a mechanical patch would have to guess at which part of the motion is decorative, and disabling an entrance animation outright can leave content invisible.',
    })
  }
  if (motionBounded) {
    followUps.push({
      id: 'reduced-motion-bounded',
      message: 'A `prefers-reduced-motion` block was appended to the stylesheet. It bounds duration rather than removing the animation; review it if a rule there is load-bearing for layout instead of motion.',
    })
  }
  if (motionSkippedForLogic && input.directive === 'never') {
    followUps.push({
      id: 'directive-off',
      message: 'The `\'use client\'` line was left out on request. Under a server-rendering framework this file will fail to render until it has one.',
    })
  }

  return { files, followUps }
}

/**
 * Whether a destination directory may be written into.
 *
 * The check is on the caller's own argument rather than on a resolved path, so it
 * can be made before any service is asked to resolve anything: a destination that
 * climbs out of the session working directory is refused whether or not the host's
 * file service would have caught it.
 *
 * @param directory - the caller's destination, relative to the session working directory.
 * @param cwd - the session working directory, when the host supplies one.
 * @returns `undefined` when the directory is usable, else the reason to refuse.
 */
export function directoryRefusal(directory: string, cwd: string | undefined): string | undefined {
  const trimmed = directory.trim()
  if (trimmed === '') return 'The destination directory is empty.'
  // A Windows drive letter or a leading separator: the destination has to be inside
  // the project, and an absolute path is a claim about a place this tool cannot check.
  if (/^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return `"${trimmed}" is an absolute path. Name a directory relative to the session working directory, such as "src/components/reactbits".`
  }
  const segments = trimmed.split(/[\\/]+/u)
  if (segments.includes('..')) {
    return `"${trimmed}" climbs out of the working directory. Name a directory inside it.`
  }
  if (cwd === undefined) return undefined
  const normalizedCwd = cwd.replace(/[\\/]+$/u, '')
  if (/[\\/]\.\.[\\/]|\.\.$/u.test(normalizedCwd)) {
    return `The session working directory "${cwd}" itself climbs, so a destination inside it cannot be checked.`
  }
  return undefined
}

/**
 * The absolute path one planned file would be written to.
 *
 * @param cwd - the session working directory.
 * @param directory - the caller's destination, already checked by {@link directoryRefusal}.
 * @param writeAs - the file name.
 * @returns the path, with no doubled separator on either platform's usual spelling.
 */
export function destinationPath(cwd: string, directory: string, writeAs: string): string {
  const base = `${cwd.replace(/[\\/]+$/u, '')}/${directory.replace(/^[\\/]+|[\\/]+$/gu, '')}`
  return `${base}/${writeAs}`
}

/**
 * Whether every name in a plan is one a registry row could honestly have produced.
 *
 * Checked before anything is written, because the input is a public document: a name
 * carrying a separator or `..` would be a registry row aiming a write outside the
 * destination the caller named, which is the one place this module promises to stay.
 *
 * @param files - the planned files.
 * @returns whether every file name is a plain name.
 */
export function plannedNamesAreSafe(files: readonly ReactBitsPlannedFile[]): boolean {
  return files.every(file => file.writeAs !== '' && !file.writeAs.includes('..') && !/[\\/]/u.test(file.writeAs))
}
