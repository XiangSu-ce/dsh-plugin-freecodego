/**
 * What a fetched React Bits component needs before it will work in the caller's
 * project.
 *
 * The review exists because upstream publishes exactly what is in the registry
 * and nothing about the surroundings. Every finding below was taken from the
 * components upstream publishes rather than invented: none of the four read while
 * wiring this up (`SplitText`, `SpotlightCard`, `BlurText`, `CountUp`) carries a
 * `'use client'` directive, and all four need one, because they register GSAP
 * plugins, read `document.fonts.ready`, attach pointer listeners or observe
 * elements — so a copy pasted into a Next.js App Router server component fails at
 * build or at first render, with a stack trace that points at the component
 * rather than at the missing directive.
 *
 * The findings are advice, never edits. The caller owns the file this lands in;
 * this module only says what it will find there. A finding that made an edit
 * would be a port of the component, which is the thing the licence quoted in
 * `registry.ts` forbids.
 *
 * @module reactbits/inspect
 */

import { importSpecifiers, packageOfSpecifier, type ReactBitsImport } from './imports.ts'

/** One thing worth knowing before the source is used. */
export interface ReactBitsFinding {
  /** Stable id, so a caller can filter without matching prose. */
  readonly id:
    | 'client-directive'
    | 'needs-tailwind'
    | 'needs-style-file'
    | 'browser-globals'
    | 'reduced-motion'
    | 'webgl-context'
    | 'conflicts-with-own-rules'
    | 'undeclared-imports'
  /** `blocking` when the copy cannot render as it stands, `advisory` otherwise. */
  readonly severity: 'blocking' | 'advisory'
  /** One line, addressed to the caller. */
  readonly message: string
  /** Where in the source this came from, when a file or a line can be named. */
  readonly evidence?: string
}

/** The review of one fetched variant. */
export interface ReactBitsInspection {
  /** Whether no blocking finding is present. */
  readonly ready: boolean
  readonly findings: readonly ReactBitsFinding[]
  readonly imports: readonly ReactBitsImport[]
  /** Imports that are neither React nor a bare package, i.e. files the caller must place themselves. */
  readonly localImports: readonly string[]
}

/** The input one variant is reviewed from. */
export interface ReactBitsInspectionInput {
  /** The registry name, e.g. `SplitText-TS-TW`. */
  readonly name: string
  /** The variant's styling approach, which decides whether Tailwind is assumed. */
  readonly style: 'css' | 'tailwind'
  readonly files: readonly { readonly path: string; readonly content: string }[]
  /** The package ranges upstream declares for this variant. */
  readonly dependencies: readonly string[]
  /**
   * The framework the caller's project uses, when they said. It only moves
   * severities: a missing directive is a build error under a server-rendering
   * framework and a harmless extra line under a client-only one, and a reviewer
   * that cannot tell the two apart would either cry wolf or stay quiet where it
   * matters.
   */
  readonly target?: string
}

/**
 * Whether a file is the variant's stylesheet rather than a component.
 *
 * @param path - the file's path as the registry spells it.
 * @returns whether it is a stylesheet the caller has to write as well.
 */
export function isStyleFile(path: string): boolean {
  return /\.css$/u.test(path)
}

/**
 * Whether a path is a component source rather than a stylesheet.
 *
 * @param path - the file's path as the registry spells it.
 * @returns whether it is a component, in any of the shapes upstream publishes.
 */
export function isComponentFile(path: string): boolean {
  return /\.[jt]sx?$/u.test(path) || /\.vue$/u.test(path)
}

/** A leading `'use client'` directive, comments and blank lines allowed above it. */
const LEADING_DIRECTIVE = /^\s*(?:(?:\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)\s*)*['"]use client['"]/u

/** How the directive is spelled, so the sentences that name it can quote it once. */
const CLIENT_DIRECTIVE = "'use client'"

/**
 * The keywords that mean a source animates something, and the properties that
 * mean it animates layout rather than the compositor.
 *
 * Separate patterns rather than one line-long condition: each is a statement about
 * a different thing, and the pair-check in the layout case is readable only when
 * the two halves are named.
 */
const ANIMATION_KEYWORDS = /\bgsap\b|\banimat\w*\b|\bmotion\b|\btransition\b|\brequestAnimationFrame\b/u
const LAYOUT_PROPERTIES = /\b(?:height|width|top|left|margin|padding)\s*:/u

/** Whether a bare package name is React itself or a framework runtime the project already has. */
function isRuntimeImport(specifier: string): boolean {
  return /^react(-dom)?(\/|$)/u.test(specifier) || /^(?:next|vue|svelte|solid-js|preact)(\/|$)/u.test(specifier)
}

/** The browser APIs a source leans on, for the sentence that explains the directive. */
function describeBrowserUse(source: string): string {
  const used: string[] = []
  if (/\buse(?:State|Effect|Ref|LayoutEffect)\b/u.test(source)) used.push('React 状态与副作用')
  if (/\b(?:mousemove|pointermove|scroll|resize|touchmove)\b/u.test(source)) used.push('鼠标或指针事件')
  if (/IntersectionObserver/u.test(source)) used.push('IntersectionObserver')
  if (/ResizeObserver/u.test(source)) used.push('ResizeObserver')
  if (/document\s*\./u.test(source)) used.push('document')
  if (/window\s*\./u.test(source)) used.push('window')
  if (/requestAnimationFrame/u.test(source)) used.push('requestAnimationFrame')
  if (/\bgsap\b|\bregisterPlugin\b/u.test(source)) used.push('动画库注册')
  return used.length > 0 ? used.join('、') : 'React 客户端 API'
}

/** Packages that need a GPU context, by the names upstream imports them under. */
const WEBGL_PACKAGES = ['three', 'ogl', '@react-three/fiber', '@react-three/drei', 'postprocessing', 'meshline', 'glsl-canvas']

/** Package names of a dependency range, e.g. `motion@^12.23.12` → `motion`. */
function packageOf(range: string): string {
  const scope = range.startsWith('@') ? range.indexOf('/', 1) : 0
  const at = range.indexOf('@', scope + 1)
  return (at === -1 ? range : range.slice(0, at)).trim()
}

/** A line number and the text of the first match, for citing evidence. */
function cite(source: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(source)
  if (match === null) return undefined
  const line = source.slice(0, match.index).split('\n').length
  return `第 ${String(line)} 行：${match[0].trim().slice(0, 120)}`
}

/**
 * Review one fetched variant against the project it is about to land in.
 *
 * The checks are ordered by whether they stop the copy from working at all: a
 * missing `'use client'`, a Tailwind variant in a project without Tailwind, a
 * stylesheet that was not fetched. The rest are advisory and about cost —
 * `prefers-reduced-motion`, WebGL support, and the handful of component choices
 * this package's own detector flags (a bounce easing, a gradient-clipped
 * heading), which is worth saying before the code is written rather than after
 * it has been reviewed.
 *
 * @param input - the variant's identity, files, declared packages and target framework.
 * @returns the findings, the imports, and the local paths the caller must place.
 */
export function inspectVariant(input: ReactBitsInspectionInput): ReactBitsInspection {
  const findings: ReactBitsFinding[] = []
  const components = input.files.filter(file => isComponentFile(file.path))
  const styles = input.files.filter(file => isStyleFile(file.path))
  const source = components.map(file => file.content).join('\n')
  const imports = importSpecifiers(source)
  const serverRendered = input.target === undefined || /next|remix|nuxt|sveltekit|astro|fresh|analog/iu.test(input.target)

  const missingDirective = components.filter(file => !LEADING_DIRECTIVE.test(file.content))
  if (missingDirective.length > 0) {
    findings.push({
      id: 'client-directive',
      severity: serverRendered ? 'blocking' : 'advisory',
      message: serverRendered
        ? `上游源码没有 \`${CLIENT_DIRECTIVE}\` 指令，但它必须在客户端运行（用了${describeBrowserUse(source)}）。在会服务端渲染的框架里直接 import 会在构建或首屏就报错，请把指令加在文件首行。`
        : `上游源码没有 \`${CLIENT_DIRECTIVE}\` 指令。你的目标框架是纯客户端渲染，所以这条不是必须的；一旦换成会服务端渲染的框架，就需要在文件首行补上。`,
      evidence: missingDirective.map(file => file.path).join('、'),
    })
  }

  if (input.style === 'tailwind') {
    findings.push({
      id: 'needs-tailwind',
      severity: 'advisory',
      message: '这是 Tailwind 变体，类名要求项目已配置 Tailwind。若项目用普通 CSS，请改取同一组件的 `-CSS` 变体。',
    })
  }

  if (styles.length > 0) {
    findings.push({
      id: 'needs-style-file',
      severity: 'blocking',
      message: `这一项还带 ${String(styles.length)} 个样式文件（${styles.map(file => file.path).join('、')}），必须一起落盘并引入，否则组件没有样式。`,
    })
  }

  const globals = ['window', 'document', 'navigator', 'IntersectionObserver', 'ResizeObserver', 'requestAnimationFrame']
    .filter(name => new RegExp(`\\b${name}\\b`, 'u').test(source))
  if (globals.length > 0) {
    const cited = cite(source, /\b(?:window|document)\s*\./u)
    findings.push({
      id: 'browser-globals',
      severity: 'advisory',
      message: `源码直接用了浏览器全局对象（${globals.join('、')}），在没有 DOM 的环境里（SSR、构建期预渲染、编辑器侧的静态求值）会抛错——请确认它只在客户端执行。`,
      ...cited === undefined ? {} : { evidence: cited },
    })
  }

  if (!/prefers-reduced-motion/u.test(source) && /\b(?:useEffect|useRef|animate|gsap|motion|requestAnimationFrame)\b/u.test(source)) {
    findings.push({
      id: 'reduced-motion',
      severity: 'advisory',
      message: '源码没有处理 `prefers-reduced-motion`，动效会无视系统里的「减少动态效果」设置。这是上游的现状，属于可访问性缺口，补一个媒体查询分支即可。',
    })
  }

  const webgl = input.dependencies.map(packageOf).filter(name => WEBGL_PACKAGES.includes(name))
  if (webgl.length > 0 || /\b(?:THREE|WebGLRenderer|useFrame|ogl)\b/u.test(source)) {
    findings.push({
      id: 'webgl-context',
      severity: 'advisory',
      message: '这一项需要 WebGL/canvas 上下文，在没有 GPU 或禁用 WebGL 的环境里会渲染成空白，而且不会抛错——请别把这种「空白」当成布局问题去查。',
    })
  }

  const conflicts: string[] = []
  if (/\b(?:bounce|back\.\s*(?:out|in))\b/iu.test(source) && /\b(?:transition|animation|ease)\b/iu.test(source)) {
    conflicts.push('`bounce-easing`（回弹类缓动）')
  }
  if (/GradientText|bg-clip-text|-webkit-background-clip|backgroundClip/u.test(source)) {
    conflicts.push('`gradient-text`（渐变裁切文字，slop 类）')
  }
  if (LAYOUT_PROPERTIES.test(source) && ANIMATION_KEYWORDS.test(source)) {
    conflicts.push('`layout-transition`（对布局属性做动画）')
  }
  if (conflicts.length > 0) {
    findings.push({
      id: 'conflicts-with-own-rules',
      severity: 'advisory',
      message: `这一项的写法会触发本包设计检测的 ${conflicts.join('、')}（用 \`freecodego_design_detect\` 复核即可）。动效值不值这个代价由你定，但先说清楚，免得写完之后被自己的检测挑出来。`,
    })
  }

  const declared = new Set(input.dependencies.map(packageOf))
  const undeclared = imports.filter((entry) => {
    if (!entry.external || isRuntimeImport(entry.specifier)) return false
    const name = packageOfSpecifier(entry.specifier)
    return name !== undefined && !declared.has(name)
  })
  if (undeclared.length > 0) {
    findings.push({
      id: 'undeclared-imports',
      severity: 'blocking',
      message: `源码 import 了 ${undeclared.map(entry => `\`${entry.specifier}\``).join('、')}，但登记表没有为它们声明版本——请按项目自己的包管理器确认后安装。`,
    })
  }

  return {
    ready: findings.every(finding => finding.severity !== 'blocking'),
    findings,
    imports,
    localImports: [...new Set(imports.filter(entry => !entry.external).map(entry => entry.specifier))],
  }
}
