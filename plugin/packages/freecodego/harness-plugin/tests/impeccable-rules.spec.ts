/**
 * The built-in Impeccable rules: what they catch, and what they refuse to catch.
 *
 * Half of these cases exist to pin a *quiet* result. A design detector's failure
 * mode is not a missed finding — it is a finding on code that was already right,
 * because a rule that cries wolf is switched off and then judges nothing, and the
 * user's only recourse is to stop trusting the scan. So every false-positive case
 * below names the near-miss it separates from the real thing: a comment that
 * mentions Inter, a `width: 100%` that is not a transition, an `<img src={url}>`
 * that a template fills at runtime, `ease-out` beside `ease-in-back`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/impeccable-rules
 */

import { describe, expect, it } from 'vitest'

import { IMPECCABLE_UPSTREAM, scanSource } from '../src/impeccable/rules.ts'

/** The rule ids one source produced, in report order. */
function rulesOf(file: string, text: string): readonly string[] {
  return scanSource(file, text).findings.map(finding => finding.rule)
}

/** A stylesheet with one rule body. */
function stylesheet(body: string): string {
  return `h1 { ${body} }`
}

describe('the built-in subset names its own bound', () => {
  it('cites the upstream release and the rules that ran', () => {
    const report = scanSource('src/app.css', stylesheet('color: red'))
    // A short list that reads as complete is worse than a long list that names
    // its bound: the caller has to be able to tell "clean" from "not checked".
    expect(report.rulesApplied).toContain('overused-font')
    expect(report.rulesApplied).toContain('gradient-text')
    expect(report.rulesApplied).not.toContain('low-contrast')
    expect(report.findings).toEqual([])
    expect(IMPECCABLE_UPSTREAM.ruleCount).toBe(61)
    expect(IMPECCABLE_UPSTREAM.license).toBe('Apache-2.0')
  })

  it('reports a line number and an excerpt a reader can locate', () => {
    const report = scanSource('src/app.css', ['body {', '  font-family: Inter, sans-serif;', '}'].join('\n'))
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ rule: 'overused-font', line: 2, category: 'slop', severity: 'primary' })
    expect(report.findings[0]?.snippet).toContain('Inter')
  })
})

describe('font and palette rules', () => {
  it('flags each face upstream names, in CSS and in a JSX style object', () => {
    for (const face of ['Inter', 'Roboto', 'Fraunces', 'Geist', 'Plus Jakarta Sans', 'Space Grotesk']) {
      expect(rulesOf('a.css', stylesheet(`font-family: "${face}", sans-serif`)), face).toContain('overused-font')
    }
    const jsx = '<div style={{ fontFamily: \'Inter, sans-serif\', fontSize: 16 }} />'
    expect(rulesOf('Card.tsx', jsx)).toContain('overused-font')
  })

  it('stays quiet on a comment that names a banned face, and on a chosen face', () => {
    // The most likely place for "Inter" to appear in a project that avoids it is
    // the comment saying so, and in this file's own documentation.
    const commented = `/* Inter is banned here; we ship Söhne. */\n${stylesheet('font-family: "Söhne", sans-serif')}`
    expect(rulesOf('a.css', commented)).toEqual([])
    expect(rulesOf('a.css', stylesheet('font-family: "Söhne", "Neue Haas Grotesk", sans-serif'))).toEqual([])
  })

  it('flags gradient text only when the clip and the gradient share a rule body', () => {
    expect(rulesOf('a.css', stylesheet('background: linear-gradient(90deg, #ff3399, #8833ff); background-clip: text; color: transparent'))).toContain('gradient-text')
    // Same declarations, two media blocks: that is a gradient background beside
    // a clipped headline, not gradient text.
    const apart = ['h1 { background-clip: text; color: transparent }', 'body { background: linear-gradient(90deg, #c8c8c8, #999999) }'].join('\n')
    expect(rulesOf('a.css', apart)).not.toContain('gradient-text')
  })

  it('reads a prefixed property as the property, because that is how the effect is written', () => {
    // `background-clip: text` alone does not clip text in the engines this rule
    // exists for, so the code a reader has is the `-webkit-` spelling — and the
    // React spelling of it is `WebkitBackgroundClip`. A scanner that needed the
    // unprefixed name would report the canonical gradient headline as clean.
    expect(rulesOf('a.css', stylesheet('background: linear-gradient(90deg, #ff3399, #8833ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent'))).toContain('gradient-text')
    expect(rulesOf('Card.tsx', '<h1 style={{ background: \'linear-gradient(90deg, #ff3399, #8833ff)\', WebkitBackgroundClip: \'text\' }} />')).toContain('gradient-text')
    // A custom property is a name, not a prefixed property: `--brand-clip` must
    // not become `brand-clip`, or a rule would fire on the definition of a token
    // rather than on the declaration that uses it.
    expect(rulesOf('a.css', stylesheet('background: linear-gradient(90deg, #ff3399, #8833ff); --clip: text'))).not.toContain('gradient-text')
  })

  it('reads the gradient hues the palette rule is about, and leaves a brand hue alone', () => {
    expect(rulesOf('a.css', stylesheet('background: linear-gradient(135deg, #7c3aed, #22d3ee)'))).toContain('ai-color-palette')
    // A flat, deliberate color is a palette decision; only a gradient is the tell.
    expect(rulesOf('a.css', stylesheet('background: #7c3aed'))).not.toContain('ai-color-palette')
    expect(rulesOf('a.css', stylesheet('background: linear-gradient(180deg, #1d4ed8, #0f172a)'))).not.toContain('ai-color-palette')
  })
})

describe('motion rules', () => {
  it('flags overshoot from the bezier points and from upstream\'s keyword list', () => {
    expect(rulesOf('a.css', stylesheet('transition: transform .3s cubic-bezier(.68, -0.55, .27, 1.55)'))).toContain('bounce-easing')
    expect(rulesOf('a.css', stylesheet('animation: pop 1s ease-in-back'))).toContain('bounce-easing')
  })

  it('stays quiet on the decelerating curves it recommends', () => {
    for (const easing of ['ease-out', 'cubic-bezier(0.22, 1, 0.36, 1)', 'linear', 'cubic-bezier(0.4, 0, 0.2, 1)']) {
      expect(rulesOf('a.css', stylesheet(`transition: transform .3s ${easing}`)), easing).not.toContain('bounce-easing')
    }
  })

  it('flags a transitioned layout property, not the word appearing anywhere', () => {
    expect(rulesOf('a.css', stylesheet('transition: width .3s ease-out'))).toContain('layout-transition')
    expect(rulesOf('a.css', stylesheet('transition-property: height, opacity'))).toContain('layout-transition')
    // `width: 100%` is a layout declaration, not an animated one.
    const layoutOnly = stylesheet('width: 100%; max-width: 72ch; color: #111')
    expect(rulesOf('a.css', layoutOnly)).not.toContain('layout-transition')
    // And the recommended replacement must not trip it.
    expect(rulesOf('a.css', stylesheet('transition: transform .3s ease-out, opacity .3s ease-out'))).not.toContain('layout-transition')
  })
})

describe('typography rules', () => {
  it('flags body-sized text below the floor and leaves larger text alone', () => {
    expect(rulesOf('a.css', stylesheet('font-size: 10px'))).toContain('tiny-text')
    expect(rulesOf('a.css', stylesheet('font-size: 11px; line-height: 1.5'))).toContain('tiny-text')
    expect(rulesOf('a.css', stylesheet('font-size: 14px; line-height: 1.5'))).not.toContain('tiny-text')
    // A size that arrives from a token is not guessed at.
    expect(rulesOf('a.css', stylesheet('font-size: var(--step--1)'))).not.toContain('tiny-text')
  })

  it('flags a tight line height, including one that only a declared size makes tight', () => {
    expect(rulesOf('a.css', stylesheet('line-height: 1.1; font-size: 16px'))).toContain('tight-leading')
    expect(rulesOf('a.css', stylesheet('line-height: 16px; font-size: 16px'))).toContain('tight-leading')
    expect(rulesOf('a.css', stylesheet('line-height: 1.6; font-size: 16px'))).not.toContain('tight-leading')
    // An absolute line height with no declared font size in the same body is not
    // measurable, so it is left alone rather than reported at a guessed ratio.
    expect(rulesOf('a.css', stylesheet('line-height: 16px'))).not.toContain('tight-leading')
  })

  it('flags crushed tracking and leaves ordinary optical tightening alone', () => {
    expect(rulesOf('a.css', stylesheet('letter-spacing: -0.08em'))).toContain('extreme-negative-tracking')
    expect(rulesOf('a.css', stylesheet('letterSpacing: -2'))).toContain('extreme-negative-tracking')
    expect(rulesOf('a.css', stylesheet('letter-spacing: -0.01em'))).not.toContain('extreme-negative-tracking')
    expect(rulesOf('a.css', stylesheet('letter-spacing: 0.08em'))).not.toContain('extreme-negative-tracking')
  })
})

describe('markup rules', () => {
  it('flags a heading level that skips, and not a level that descends', () => {
    const skipped = ['<h1>Title</h1>', '<h3>Section</h3>'].join('\n')
    const report = scanSource('page.html', skipped)
    expect(report.findings.map(finding => finding.rule)).toContain('skipped-heading')
    expect(report.findings.find(finding => finding.rule === 'skipped-heading')?.line).toBe(2)
    expect(rulesOf('page.html', ['<h1>Title</h1>', '<h2>Section</h2>', '<h3>Sub</h3>', '<h2>Next</h2>'].join('\n'))).not.toContain('skipped-heading')
  })

  it('flags an image with no usable source and leaves a runtime-filled one alone', () => {
    expect(rulesOf('page.html', '<img alt="hero">')).toContain('broken-image')
    expect(rulesOf('page.html', '<img src="" alt="hero">')).toContain('broken-image')
    expect(rulesOf('page.html', '<img src="#" alt="hero">')).toContain('broken-image')
    expect(rulesOf('page.html', '<img src={hero.src} alt="hero">')).not.toContain('broken-image')
    expect(rulesOf('page.html', '<img src="/hero.png" alt="hero">')).not.toContain('broken-image')
  })
})

describe('copy rules', () => {
  it('flags em-dash saturation and never a long article with a few', () => {
    const saturated = Array.from({ length: 10 }, () => 'A clause — another clause.').join(' ')
    expect(rulesOf('page.html', `<p>${saturated}</p>`)).toContain('em-dash-overuse')
    // Eight dashes spread over 5,000 characters is a writer, not a cadence.
    const spread = `${'x'.repeat(900)} — ${'y'.repeat(900)} — ${'z'.repeat(900)} — ${'w'.repeat(900)} — tail`
    expect(rulesOf('page.html', `<p>${spread}</p>`)).not.toContain('em-dash-overuse')
  })

  it('flags a buzzword in visible prose and not one in markup or code', () => {
    expect(rulesOf('page.html', '<p>We streamline your workflow.</p>')).toContain('marketing-buzzword')
    expect(rulesOf('page.html', '<div class="streamline-grid"></div>')).not.toContain('marketing-buzzword')
    expect(rulesOf('page.html', '<script>const streamline = 1;</script>')).not.toContain('marketing-buzzword')
  })

  it('marks the advisory rules as advisories', () => {
    const report = scanSource('page.html', '<p>We streamline the world-class, enterprise-grade experience.</p>')
    const buzzword = report.findings.find(finding => finding.rule === 'marketing-buzzword')
    // An advisory must not decide a scan's outcome, which is what the severity is
    // for: a caller that counted it as a defect would fail a build on prose.
    expect(buzzword?.severity).toBe('advisory')
  })
})

describe('styles are read where they actually live', () => {
  it('reads a <style> element, a style attribute, and a JSX style object', () => {
    expect(rulesOf('page.html', '<style>\nh1 { font-family: Inter }\n</style>')).toContain('overused-font')
    expect(rulesOf('page.html', '<div style="font-size:10px">x</div>')).toContain('tiny-text')
    expect(rulesOf('Card.tsx', '<div style={{ fontSize: 10 }} />')).toContain('tiny-text')
  })

  it('reads declarations nested one level down, as a media query puts them', () => {
    const nested = '<style>\n@media (min-width: 600px) {\n  h1 { font-size: 10px }\n}\n</style>'
    const report = scanSource('page.html', nested)
    expect(report.findings.map(finding => finding.rule)).toContain('tiny-text')
    expect(report.findings[0]?.line).toBe(3)
  })

  it('keeps a gradient whole instead of splitting it at its commas', () => {
    // A splitter that broke values at commas would see two color stops as two
    // declarations and match neither rule.
    const body = 'background: linear-gradient(135deg, #7c3aed, #22d3ee)'
    expect(rulesOf('a.css', stylesheet(body))).toContain('ai-color-palette')
  })
})
