/**
 * Static animation catalog: what a composition moves, and when.
 *
 * This is the one capability in the design pack that needs no browser at all —
 * GSAP calls and CSS animation rules are declarative, so the answer is decidable
 * from the file's text. That makes it the cheapest way for a model to answer
 * "what does this composition actually animate?" before deciding to render
 * anything, and the only one that works with the render engine switched off.
 *
 * What it is not: a GSAP interpreter. It does not resolve `+=` relative values
 * against a starting state, does not follow a tween's target through the DOM,
 * and does not know what a `scrollTrigger` will bind to. It reports the
 * *declared* animation surface, which is what a reader of the file can see and
 * what a review of the motion design is actually about.
 *
 * The numbers it does compute — timeline positions and durations — come only from
 * literal values. A computed position is reported as written rather than guessed:
 * a wrong duration is worse than an unevaluated one, because it silently feeds
 * the next decision.
 *
 * @module design/keyframes
 */

/** GSAP properties that move something in space rather than change its look. */
const TRANSFORM_PROPERTIES: readonly string[] = [
  'x', 'y', 'z', 'xPercent', 'yPercent',
  'scale', 'scaleX', 'scaleY', 'scaleZ',
  'rotation', 'rotationX', 'rotationY', 'rotationZ', 'rotate',
  'skewX', 'skewY', 'skew',
  'motionPath', 'transformOrigin', 'transform',
]

/** CSS properties that can move an element through space. */
const CSS_SPATIAL_PROPERTIES: readonly string[] = [
  'transform', 'translate', 'rotate', 'scale',
  'offset-path', 'offset-distance', 'offset-rotate',
  'top', 'right', 'bottom', 'left',
]

/** CSS transform properties, kept separate for the GSAP-oriented aggregate. */
const CSS_TRANSFORM_PROPERTIES: readonly string[] = ['transform', 'translate', 'rotate', 'scale']

/** CSS properties and their closest GSAP transform equivalent for reports. */
const CSS_TRANSFORM_LABELS: Readonly<Record<string, string>> = {
  transform: 'transform',
  translate: 'x',
  rotate: 'rotation',
  scale: 'scale',
}

/** CSS comments and strings are not declarations and must not imply motion. */
function stripCssCommentsAndStrings(source: string): string {
  let output = ''
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? ''
    const next = source[index + 1]
    if (quote !== undefined) {
      if (char.charCodeAt(0) === 92) { output += '  '; index += 1; continue }
      if (char === quote) quote = undefined
      output += char.charCodeAt(0) === 10 ? String.fromCharCode(10) : ' '
      continue
    }
    if (char === '"' || char === "'") { quote = char; output += ' '; continue }
    if (char === '/' && next === '*') {
      output += '  '
      index += 1
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index]?.charCodeAt(0) === 10 ? String.fromCharCode(10) : ' '
        index += 1
      }
      if (index + 1 < source.length) { output += '  '; index += 1 }
      continue
    }
    output += char
  }
  return output
}

/** Read CSS property names from declaration blocks without mistaking text for declarations. */
function cssPropertiesIn(source: string, candidates: readonly string[]): readonly string[] {
  const declarations = stripCssCommentsAndStrings(source)
  const present = new Set<string>()
  for (const match of declarations.matchAll(/\{\s*([^{}]*)\}/gu)) {
    for (const declaration of (match[1] ?? '').split(';')) {
      const separator = declaration.indexOf(':')
      if (separator < 0) continue
      present.add(declaration.slice(0, separator).trim().toLowerCase())
    }
  }
  return candidates.filter(property => present.has(property))
}

/** One declared animation, from either language. */
export interface DesignAnimationEntry {
  readonly kind: 'gsap' | 'css-animation'
  /** The GSAP call, when this is a GSAP entry. */
  readonly method?: 'to' | 'from' | 'fromTo' | 'set' | 'timeline'
  /** The selector or scope the animation targets, as written. */
  readonly target?: string
  /** Declared properties, values verbatim (a relative `+=20` stays `+=20`). */
  readonly properties: Readonly<Record<string, string>>
  /** A timeline position, when written as a literal or a label. */
  readonly position?: string
  readonly ease?: string
  readonly repeat?: string
  readonly duration?: string
  /** For a CSS animation, the `@keyframes` block its declaration names. */
  readonly keyframes?: string
  /** True when a transform or spatial position property is animated. */
  readonly moves: boolean
  /** The transform properties this entry animates. */
  readonly transforms: readonly string[]
  /** The declaration's text, bounded — context for a model reading the answer. */
  readonly source: string
}

/** A `@keyframes` block. */
export interface DesignCssKeyframes {
  readonly name: string
  readonly stops: readonly string[]
}

/** What the catalog found. */
export interface DesignKeyframesReport {
  readonly entries: readonly DesignAnimationEntry[]
  readonly timelines: readonly { readonly target?: string; readonly repeat?: string; readonly defaults: Readonly<Record<string, string>> }[]
  readonly cssKeyframes: readonly DesignCssKeyframes[]
  /** Every distinct target, in first-seen order. */
  readonly targets: readonly string[]
  /** Every transform property used anywhere, deduplicated and ordered. */
  readonly transformProperties: readonly string[]
  /** True when anything moves in space, rather than only fading or recolouring. */
  readonly hasMotion: boolean
  /** Nothing animated: the composition is a still. */
  readonly still: boolean
}

/** Longest source excerpt an entry carries. */
const SOURCE_MAX_CHARS = 160

/** Bounded one-line excerpt of a declaration. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > SOURCE_MAX_CHARS ? `${flat.slice(0, SOURCE_MAX_CHARS - 3)}...` : flat
}

/**
 * Split on a separator at bracket depth zero, respecting quotes.
 *
 * Depth zero is the whole point: `{ a: { b: 1 }, c: 2 }` has one top-level
 * comma, and a plain `split(',')` would report three pairs and a mangled value.
 */
function splitTopLevel(text: string, separator: string): readonly string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      current += char
      if (char === '\\') { current += text[index + 1] ?? ''; index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; current += char; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === separator && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts
}

/**
 * Read the text between a bracket and its match, or undefined if unbalanced.
 *
 * The opener decides the closer, because both languages need this: `gsap.to(` is
 * balanced by parentheses, while an `@keyframes` body is a brace block with
 * declaration blocks nested inside it. Counting only parentheses returned
 * `undefined` for every CSS block — which read as "no keyframes" rather than as
 * a parser that could not see them.
 */
function balancedBlock(source: string, open: number): { readonly args: string; readonly end: number } | undefined {
  const opener = source[open]
  if (opener !== '(' && opener !== '{' && opener !== '[') return undefined
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : ']'
  let depth = 0
  let quote: string | undefined
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== undefined) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; continue }
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return { args: source.slice(open + 1, index), end: index }
    }
  }
  return undefined
}

/** Parse a shallow object literal's top-level `key: value` pairs. */
function objectEntries(text: string): Readonly<Record<string, string>> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {}
  const body = trimmed.slice(1, -1)
  const result: Record<string, string> = {}
  for (const part of splitTopLevel(body, ',')) {
    const pair = splitTopLevel(part, ':')
    if (pair.length < 2) continue
    const key = pair[0]?.trim().replace(/^['"`]|['"`]$/gu, '')
    if (key === undefined || key === '') continue
    result[key] = pair.slice(1).join(':').trim()
  }
  return result
}

/** The selector a first argument names, when it is a string literal. */
function targetOf(argument: string): string | undefined {
  return /^\s*['"`]([^'"`]+)['"`]/u.exec(argument)?.[1]
}

/** Build one entry from a method, its arguments, and the call text. */
function gsapEntry(method: DesignAnimationEntry['method'], args: readonly string[], text: string): DesignAnimationEntry {
  const target = targetOf(args[0] ?? '')
  const vars = method === 'fromTo' ? objectEntries(args[2] ?? '') : objectEntries(args[1] ?? '')
  // `gsap.set` applies a state immediately; it may position an element, but it is
  // not a tween and must not turn a still composition into an animated one.
  const transforms = method === 'set' ? [] : TRANSFORM_PROPERTIES.filter(property => vars[property] !== undefined)
  // A timeline's own chain position is the argument after the vars object.
  const position = method === 'timeline' ? undefined : (args[2] === undefined || method === 'fromTo' ? args[3] : args[2])?.trim()
  return {
    kind: 'gsap',
    ...method === undefined ? {} : { method },
    ...target === undefined ? {} : { target },
    properties: vars,
    ...position === undefined || position === '' ? {} : { position },
    ...vars.ease === undefined ? {} : { ease: vars.ease },
    ...vars.repeat === undefined ? {} : { repeat: vars.repeat },
    ...vars.duration === undefined ? {} : { duration: vars.duration },
    moves: transforms.length > 0,
    transforms,
    source: excerpt(text),
  }
}

/**
 * Catalog the animation surface of one composition source.
 *
 * @param source - the composition file's text.
 * @returns entries, keyframe blocks, and the aggregate motion facts.
 */
export function catalogKeyframes(source: string): DesignKeyframesReport {
  const entries: DesignAnimationEntry[] = []
  const timelines: { target?: string; repeat?: string; defaults: Record<string, string> }[] = []

  // GSAP: the global form and the chained timeline form. Both are covered by
  // looking for the method name followed by `(`, because a chain reads as
  // `.to(...)` and the namespace reads as `gsap.to(...)`.
  const call = /(?:\bgsap|\btl|\btimeline|\bTimeline)\s*\.\s*(to|from|fromTo|set|timeline)\s*\(|\.\s*(to|from|fromTo|set)\s*\(/gu
  for (const match of source.matchAll(call)) {
    const method = (match[1] ?? match[2]) as DesignAnimationEntry['method']
    if (method === undefined) continue
    const open = (match.index ?? 0) + match[0].length - 1
    const extracted = balancedBlock(source, open)
    if (extracted === undefined) continue
    const text = source.slice(match.index ?? 0, extracted.end + 1)
    const args = splitTopLevel(extracted.args, ',').map(argument => argument.trim())
    if (method === 'timeline') {
      const defaults = objectEntries(args[0] ?? '')
      timelines.push({
        ...targetOf(args[0] ?? '') === undefined ? {} : { target: targetOf(args[0] ?? '') as string },
        ...defaults.repeat === undefined ? {} : { repeat: defaults.repeat },
        defaults,
      })
      // Timeline configuration is reported in `timelines`; creating an empty
      // timeline, even one with repeat/defaults, does not animate a composition.
      continue
    }
    entries.push(gsapEntry(method, args, text))
  }

  // CSS: the keyframe blocks and the rules that reference them. A composition
  // that bobs something with a CSS animation never touches GSAP, and reporting
  // only GSAP would call it a still.
  const cssKeyframes: DesignCssKeyframes[] = []
  const cssKeyframeTransforms = new Map<string, readonly string[]>()
  const cssKeyframeMotion = new Map<string, boolean>()
  const styleText = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(match => match[1] ?? '').join('\n')
  for (const match of styleText.matchAll(/@keyframes\s+([\w-]+)\s*\{/gu)) {
    // `balancedBlock` does the work here too: an `@keyframes` body nests
    // declaration blocks, so a regex that stops at the first `}` returns one stop
    // and silently drops the rest.
    const open = (match.index ?? 0) + match[0].length - 1
    const body = balancedBlock(styleText, open)?.args ?? ''
    const stops = [...body.matchAll(/(?:^|[\s}])([\d.]+%|from|to)\s*\{/gu)].flatMap(stop => stop[1] === undefined ? [] : [stop[1]])
    const transforms = cssPropertiesIn(body, CSS_TRANSFORM_PROPERTIES)
    const moves = cssPropertiesIn(body, CSS_SPATIAL_PROPERTIES).length > 0
    if (match[1] !== undefined) {
      cssKeyframes.push({ name: match[1], stops })
      cssKeyframeTransforms.set(match[1], transforms)
      cssKeyframeMotion.set(match[1], moves)
    }
  }
  for (const match of styleText.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{([^{}]*\banimation(?:-name)?\s*:[^{}]*)\}/gu)) {
    const selector = (match[1] ?? '').trim()
    const declarations = match[2] ?? ''
    const shorthand = /animation\s*:\s*([^;}]+)/iu.exec(declarations)?.[1]?.trim()
    const name = /animation-name\s*:\s*([^;}]+)/iu.exec(declarations)?.[1]?.trim()
    const referenced = name ?? shorthand
    if (referenced === undefined) continue
    // A shorthand arms several animations; the first name it matches is the one
    // whose keyframes we can point at, which is what a reader wants to open next.
    const known = cssKeyframes.find(block => new RegExp(`(?:^|\\s)${block.name}(?:\\s|$)`, 'u').test(referenced))
    const cssTransforms = known === undefined ? [] : [...(cssKeyframeTransforms.get(known.name) ?? [])]
    const transforms = cssTransforms.flatMap(property => CSS_TRANSFORM_LABELS[property] ?? [])
    const moves = known === undefined ? false : cssKeyframeMotion.get(known.name) ?? false
    entries.push({
      kind: 'css-animation',
      ...selector === '' ? {} : { target: selector },
      properties: { animation: referenced },
      ...known === undefined ? {} : { keyframes: known.name },
      .../(?:^|\s)infinite(?:\s|$)/u.test(referenced) ? { repeat: 'infinite' } : {},
      moves,
      transforms,
      source: excerpt(`${selector} { ${declarations.trim()} }`),
    })
  }

  const targets = [...new Set(entries.map(entry => entry.target).filter((value): value is string => value !== undefined))]
  const transformProperties = [...new Set(entries.flatMap(entry => entry.transforms))]
  return {
    entries,
    timelines,
    cssKeyframes,
    targets,
    transformProperties,
    hasMotion: entries.some(entry => entry.moves),
    still: !entries.some(entry => entry.kind === 'css-animation' || entry.method !== 'set'),
  }
}
