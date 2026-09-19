// @vitest-environment node
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILL_ZH, capabilityText, hasLocalizedSkillDescription, localizedSkillDescription, skillPageText, upstreamEnglishHint } from '../src/client/capability-locale.ts'
import { githubReadmeCandidates } from '../src/client/plugin-readme.ts'

/**
 * The bundled Skill library is the subject of the Chinese catalog. The library
 * ships in three asset roots (the default-on starter set, the opt-in
 * engineering pack, and the vendored superpowers pack); a Skill in any of them
 * reaches the same Skills page, so all three must be covered.
 */
const bundledSkillNames = ['skills-starter', 'skills', 'skills-superpowers'].flatMap(directory =>
  readdirSync(new URL(`../../harness-plugin/assets/engineering/${directory}`, import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name),
).sort()

describe('capability Chinese catalog', () => {
  it('covers every Skill the plugin ships, so none silently falls back to English', () => {
    expect(bundledSkillNames.length).toBeGreaterThan(0)
    expect(bundledSkillNames.filter(name => !hasLocalizedSkillDescription(name))).toEqual([])
    expect(Object.keys(BUILTIN_SKILL_ZH).sort()).toEqual(bundledSkillNames)
  })

  it('localizes only for Chinese and always falls back to the upstream description', () => {
    const upstream = 'A relentless interview to sharpen a plan or design.'
    expect(localizedSkillDescription('grill-me', upstream, 'zh')).toMatch(/[\u4e00-\u9fff]/u)
    expect(localizedSkillDescription('grill-me', upstream, 'en')).toBe(upstream)
    expect(localizedSkillDescription('a-user-installed-skill', upstream, 'zh')).toBe(upstream)
    expect(hasLocalizedSkillDescription('a-user-installed-skill')).toBe(false)
  })

  it('states that third-party directory entries are English instead of implying they were translated', () => {
    expect(upstreamEnglishHint('zh')).toMatch(/英文/u)
    expect(upstreamEnglishHint('en')).toMatch(/English/u)
  })

  it('follows the language switch across the Skill library and marketplace copy', () => {
    expect(skillPageText('zh').skillsTitle).toBe('已发现 Skills')
    expect(skillPageText('en').skillsTitle).toBe('Discovered Skills')
    expect(skillPageText('zh').sectionName).not.toBe(skillPageText('en').sectionName)
    expect(capabilityText('zh').details).toBe('详情')
    expect(capabilityText('en').details).toBe('Details')
    expect(capabilityText('zh').openInBrowser).toMatch(/浏览器/u)
  })

  it('names each row invocation, the dialog, and the packs that are off in the active language', () => {
    // Every row now says whether the model may fire it on its own, because the
    // list keeps the rows the model cannot.
    expect(skillPageText('zh').invocationManual).toBe('仅手动调用')
    expect(skillPageText('en').invocationManual).toBe('Manual only')
    expect(skillPageText('zh').invocationHint).toMatch(/点名/u)
    expect(skillPageText('en').invocationHint).toMatch(/by name/u)
    expect(skillPageText('zh').openDetail).toBe('查看内容')
    expect(skillPageText('en').openDetail).toBe('View contents')
    expect(skillPageText('zh').detailCompanion).toBe('附带文件')
    expect(skillPageText('en').detailCompanion).toBe('Companion files')
    // The off-pack line has to carry both numbers the user needs: how many and
    // which pack they would come from.
    expect(skillPageText('zh').packsOffTitle(8, 'Superpowers')).toBe('还有 8 个内置技能未启用（Superpowers）')
    expect(skillPageText('en').packsOffTitle(8, 'Superpowers')).toBe('8 bundled Skills are still off (Superpowers)')
    expect(skillPageText('zh').packEnable).not.toBe(skillPageText('en').packEnable)
  })
})

describe('upstream README candidates', () => {
  it('prefers the Chinese README names and keeps English as the fallback', () => {
    const chinese = githubReadmeCandidates('https://github.com/example/plugin', 'zh')
    const english = githubReadmeCandidates('https://github.com/example/plugin', 'en')
    expect(chinese[0]?.localized).toBe(true)
    expect(chinese.some(candidate => candidate.url.endsWith('/README.zh.md'))).toBe(true)
    expect(chinese[chinese.length - 1]?.url).toContain('/README.md')
    expect(chinese[chinese.length - 1]?.localized).toBe(false)
    expect(english).toHaveLength(2)
    expect(english.every(candidate => ! candidate.localized)).toBe(true)
  })

  it('keeps the pinned branch and subdirectory for a tree URL', () => {
    const candidates = githubReadmeCandidates('https://github.com/example/monorepo/tree/release-1/packages/plugin', 'zh')
    expect(candidates[0]?.url).toBe('https://raw.githubusercontent.com/example/monorepo/release-1/packages/plugin/README.zh.md')
    expect(candidates.some(candidate => candidate.url.includes('/packages/plugin/README.md'))).toBe(true)
  })

  it('yields no candidates for a non-GitHub source', () => {
    expect(githubReadmeCandidates('https://mcp.so/server/example', 'zh')).toEqual([])
    expect(githubReadmeCandidates('not a url', 'zh')).toEqual([])
  })
})
