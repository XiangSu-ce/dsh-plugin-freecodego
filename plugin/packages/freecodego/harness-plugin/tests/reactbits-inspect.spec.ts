/**
 * The review a fetched component travels with.
 *
 * The findings are the reason this tool is worth more than a download: upstream
 * publishes the component and nothing about the project it is going into, and the
 * three things that stop a copy from working — a missing `'use client'` directive,
 * a stylesheet that was not fetched, a package that was never declared — all look
 * like a component problem when they surface at runtime.
 *
 * The severities are part of the contract, not decoration: a directive warning is
 * `blocking` under a server-rendering framework and `advisory` under a
 * client-only one, and a review that cried wolf on the second would train the
 * reader to ignore the first.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/reactbits-inspect
 */

import { describe, expect, it } from 'vitest'

import { importSpecifiers, packageOfSpecifier } from '../src/reactbits/imports.ts'
import { inspectVariant, isComponentFile, isStyleFile } from '../src/reactbits/inspect.ts'

/** A component that registers an animation plugin and reads layout on the client. */
const CLIENT_COMPONENT = [
  "import { gsap } from 'gsap'",
  "import { useEffect, useRef } from 'react'",
  '',
  'export function SplitText() {',
  '  const root = useRef<HTMLDivElement>(null)',
  '  useEffect(() => {',
  '    gsap.registerPlugin()',
  '    document.fonts.ready.then(() => undefined)',
  '  }, [])',
  '  return <div ref={root} />',
  '}',
  '',
].join('\n')

/** The findings by id, so a case can assert on one without indexing by position. */
function finding(review: ReturnType<typeof inspectVariant>, id: string) {
  return review.findings.find(entry => entry.id === id)
}

describe('reading a source file\\u2019s imports', () => {
  it('finds a static import, a side-effect import and a require, once each', () => {
    const specifiers = importSpecifiers([
      "import { motion } from 'motion/react'",
      "import 'gsap/dist/ScrollTrigger'",
      "import theme from './theme.css'",
      "const three = require('three')",
      "import { motion as again } from 'motion/react'",
    ].join('\n'))
    expect(specifiers.map(entry => entry.specifier)).toEqual([
      'motion/react', 'gsap/dist/ScrollTrigger', './theme.css', 'three',
    ])
    expect(specifiers.map(entry => entry.external)).toEqual([true, true, false, true])
  })

  it('keeps a scoped package whole and reads a subpath as its package', () => {
    expect(packageOfSpecifier('@react-three/fiber')).toBe('@react-three/fiber')
    expect(packageOfSpecifier('@react-three/fiber/dist/index.js')).toBe('@react-three/fiber')
    expect(packageOfSpecifier('motion/react')).toBe('motion')
    expect(packageOfSpecifier('./theme.css')).toBeUndefined()
    expect(packageOfSpecifier('@/components/Button')).toBeUndefined()
  })

  it('tells a component file from a stylesheet', () => {
    expect(isComponentFile('CountUp/CountUp.tsx')).toBe(true)
    expect(isComponentFile('thing.vue')).toBe(true)
    expect(isComponentFile('thing.css')).toBe(false)
    expect(isStyleFile('SplitText/SplitText.css')).toBe(true)
    expect(isStyleFile('SplitText/SplitText.tsx')).toBe(false)
  })
})

describe('the directive finding', () => {
  it('is blocking under a server-rendering framework, and says which APIs need it', () => {
    const review = inspectVariant({
      name: 'SplitText-TS-TW',
      style: 'tailwind',
      target: 'next',
      dependencies: ['gsap@^3.13.0'],
      files: [{ path: 'SplitText/SplitText.tsx', content: CLIENT_COMPONENT }],
    })
    const directive = finding(review, 'client-directive')
    expect(directive?.severity).toBe('blocking')
    expect(directive?.message).toContain('React 状态与副作用')
    expect(directive?.message).toContain('document')
    expect(directive?.evidence).toBe('SplitText/SplitText.tsx')
    expect(review.ready).toBe(false)
  })

  it('is advisory under a client-only framework, because the line is not needed there', () => {
    const review = inspectVariant({
      name: 'SplitText-TS-TW',
      style: 'tailwind',
      target: 'vite',
      dependencies: ['gsap@^3.13.0'],
      files: [{ path: 'SplitText/SplitText.tsx', content: CLIENT_COMPONENT }],
    })
    expect(finding(review, 'client-directive')?.severity).toBe('advisory')
    expect(review.ready).toBe(true)
  })

  it('is absent when the file already carries the directive under its comments', () => {
    const withComments = [
      '/* Ported from React Bits. */',
      '// Chosen for the heading reveal.',
      '',
      "'use client'",
      '',
      CLIENT_COMPONENT,
    ].join('\n')
    const review = inspectVariant({
      name: 'SplitText-TS-TW',
      style: 'tailwind',
      target: 'next',
      dependencies: ['gsap@^3.13.0'],
      files: [{ path: 'SplitText/SplitText.tsx', content: withComments }],
    })
    expect(finding(review, 'client-directive')).toBeUndefined()
  })

  it('still reports a directive that arrives after the imports, which is not a directive', () => {
    const tooLate = `${CLIENT_COMPONENT}\n'use client'\n`
    const review = inspectVariant({
      name: 'SplitText-TS-TW',
      style: 'tailwind',
      target: 'next',
      dependencies: ['gsap@^3.13.0'],
      files: [{ path: 'SplitText/SplitText.tsx', content: tooLate }],
    })
    expect(finding(review, 'client-directive')?.severity).toBe('blocking')
  })
})

describe('what the file needs beside it', () => {
  it('reports a stylesheet that has to be written too, as blocking', () => {
    const review = inspectVariant({
      name: 'SplitText-TS-CSS',
      style: 'css',
      files: [
        { path: 'SplitText/SplitText.tsx', content: "'use client'\n\nexport function SplitText() { return null }\n" },
        { path: 'SplitText/SplitText.css', content: '.split { display: block }\n' },
      ],
      dependencies: [],
    })
    const styles = finding(review, 'needs-style-file')
    expect(styles?.severity).toBe('blocking')
    expect(styles?.message).toContain('SplitText/SplitText.css')
  })

  it('says a Tailwind variant assumes Tailwind, and offers the other variant', () => {
    const review = inspectVariant({
      name: 'CountUp-TS-TW',
      style: 'tailwind',
      files: [{ path: 'CountUp/CountUp.tsx', content: "'use client'\n\nexport function CountUp() { return null }\n" }],
      dependencies: [],
    })
    expect(finding(review, 'needs-tailwind')?.severity).toBe('advisory')
    expect(finding(review, 'needs-tailwind')?.message).toContain('-CSS')
    // The plain-CSS variant carries a stylesheet instead, so the two hints are
    // mutually exclusive rather than both firing on one fetch.
    expect(finding(review, 'needs-style-file')).toBeUndefined()
  })

  it('reports a package the source imports but the registry never declared', () => {
    const review = inspectVariant({
      name: 'Weird-TS-TW',
      style: 'tailwind',
      files: [{ path: 'Weird/Weird.tsx', content: "'use client'\n\nimport { clsx } from 'clsx'\n\nexport function Weird() { return <p className={clsx()} /> }\n" }],
      dependencies: [],
    })
    const undeclared = finding(review, 'undeclared-imports')
    expect(undeclared?.severity).toBe('blocking')
    expect(undeclared?.message).toContain('`clsx`')
  })

  it('does not report a declared package, a React import, or a local file', () => {
    const review = inspectVariant({
      name: 'Fine-TS-TW',
      style: 'tailwind',
      files: [{
        path: 'Fine/Fine.tsx',
        content: [
          "'use client'",
          "import { useState } from 'react'",
          "import { motion } from '@react-three/fiber'",
          "import { helper } from './helper'",
          '',
          'export function Fine() { const [x] = useState(1); return <motion.p>{x}{helper()}</motion.p> }',
        ].join('\n'),
      }],
      dependencies: ['@react-three/fiber@^8.17.10'],
    })
    expect(finding(review, 'undeclared-imports')).toBeUndefined()
    // And a local path is still reported as something the caller has to place.
    expect(review.localImports).toEqual(['./helper'])
  })
})

describe('the advisories about cost', () => {
  it('notes browser globals, naming them', () => {
    const review = inspectVariant({
      name: 'Scroll-TS-TW',
      style: 'tailwind',
      files: [{ path: 'S/Scroll.tsx', content: "'use client'\n\nexport function S() { return <div>{window.innerWidth}</div> }\n" }],
      dependencies: [],
    })
    expect(finding(review, 'browser-globals')?.message).toContain('window')
  })

  it('notes a missing reduced-motion branch only for something that animates', () => {
    const animated = inspectVariant({
      name: 'A-TS-TW',
      style: 'tailwind',
      files: [{ path: 'A/A.tsx', content: "'use client'\nimport { motion } from 'motion/react'\nexport function A() { return <motion.p animate={{ opacity: 1 }} /> }\n" }],
      dependencies: ['motion@^12.23.12'],
    })
    expect(finding(animated, 'reduced-motion')?.severity).toBe('advisory')

    const still = inspectVariant({
      name: 'B-TS-TW',
      style: 'tailwind',
      files: [{ path: 'B/B.tsx', content: "'use client'\nexport function B() { return <p>static</p> }\n" }],
      dependencies: [],
    })
    expect(finding(still, 'reduced-motion')).toBeUndefined()

    const handled = inspectVariant({
      name: 'C-TS-TW',
      style: 'tailwind',
      files: [{ path: 'C/C.tsx', content: "'use client'\nconst q = window.matchMedia('(prefers-reduced-motion: reduce)')\nimport { motion } from 'motion/react'\nexport function C() { return <motion.p animate={{}} /> }\n" }],
      dependencies: ['motion@^12.23.12'],
    })
    expect(finding(handled, 'reduced-motion')).toBeUndefined()
  })

  it('notes WebGL from the declared packages and from the source', () => {
    const byPackage = inspectVariant({
      name: 'Beam-TS-TW',
      style: 'tailwind',
      files: [{ path: 'Beam/Beam.tsx', content: "'use client'\nexport function Beam() { return null }\n" }],
      dependencies: ['three@^0.170.0', 'postprocessing@^6.36.0'],
    })
    expect(finding(byPackage, 'webgl-context')?.message).toContain('空白')

    const bySource = inspectVariant({
      name: 'Odd-TS-TW',
      style: 'tailwind',
      files: [{ path: 'Odd/Odd.tsx', content: "'use client'\nconst r = new WebGLRenderer()\nexport function Odd() { return null }\n" }],
      dependencies: [],
    })
    expect(finding(bySource, 'webgl-context')).toBeDefined()
  })

  it('names which of this package\\u2019s own rules the code would trip', () => {
    const review = inspectVariant({
      name: 'Gradient-TS-TW',
      style: 'tailwind',
      files: [{
        path: 'G/G.tsx',
        content: [
          "'use client'",
          "import { motion } from 'motion/react'",
          'export function G() {',
          "  return <motion.h1 className=\"bg-clip-text\" transition={{ ease: 'bounce', height: 40 }} />",
          '}',
        ].join('\n'),
      }],
      dependencies: ['motion@^12.23.12'],
    })
    const conflicts = finding(review, 'conflicts-with-own-rules')
    expect(conflicts?.message).toContain('`bounce-easing`')
    expect(conflicts?.message).toContain('`layout-transition`')
    expect(conflicts?.message).toContain('freecodego_design_detect')
  })
})
