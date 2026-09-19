/**
 * Shared upstream-README reader for the community plugin dialog and the
 * capability detail dialog.
 *
 * GitHub is the only source the browser can read directly, so the hook derives
 * `raw.githubusercontent.com` candidates from a repository URL. When the UI is
 * Chinese it tries the conventional Chinese README names first and falls back
 * to the canonical English one, reporting which file it actually read so the
 * caller can label an English fallback honestly instead of passing it off as
 * localized content.
 */
import { useEffect, useState } from 'react'

/** One raw README candidate plus whether it is expected to hold Chinese text. */
export interface ReadmeCandidate {
  readonly url: string
  readonly localized: boolean
}

/** Result of reading a repository's README. */
export interface ReadmeState {
  readonly loading: boolean
  readonly text?: string
  readonly localized: boolean
  readonly error?: string
}

/** Chinese README file names, most specific first. */
const CHINESE_README_FILES = ['README.zh.md', 'README.zh-CN.md', 'README.zh_CN.md', 'README.zh-Hans.md', 'README_CN.md', 'README-cn.md'] as const

/**
 * Deadline for one raw README fetch.
 *
 * The candidates are tried in order and the dialog reads "loading…" until the
 * loop settles, so this number is what bounds that state: each candidate gets
 * its own deadline, and a name that never answers costs this and nothing more
 * before the next name is tried. Exported so a test can name the deadline
 * instead of restating the number.
 */
export const README_FETCH_TIMEOUT_MS = 10_000

function rawUrl(owner: string, repo: string, branch: string, file: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`
}

/**
 * Derive the raw README candidates for a repository URL.
 * @param url - repository or repository-subdirectory URL.
 * @param language - active UI language; Chinese adds the Chinese file names first.
 * @returns candidates in the order they should be tried, English always last.
 */
export function githubReadmeCandidates(url: string, language: 'zh' | 'en'): readonly ReadmeCandidate[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname !== 'github.com' || parts.length < 2) return []
  const owner = parts[0]
  const rawRepo = parts[1]
  if (owner === undefined || rawRepo === undefined) return []
  const repo = rawRepo.replace(/\.git$/i, '')
  const tree = parts[2]?.toLowerCase() === 'tree' ? parts[3] : undefined
  // A `tree/<branch>/<subpath>` URL pins both the branch and the directory the
  // README belongs to; anything else falls back to the default branch.
  const subpath = tree === undefined ? undefined : parts.slice(4).join('/')
  const branches = tree === undefined ? ['main', 'master'] : [tree, 'main', 'master']
  const prefix = subpath === undefined || subpath === '' ? '' : `${subpath}/`
  const files = language === 'zh' ? [...CHINESE_README_FILES, 'README.md'] : ['README.md']
  const candidates: ReadmeCandidate[] = []
  for (const file of files) {
    for (const branch of branches) {
      candidates.push({ url: rawUrl(owner, repo, branch, `${prefix}${file}`), localized: language === 'zh' && file !== 'README.md' })
    }
  }
  return candidates
}

/**
 * Read a repository's README for display, preferring the active language.
 * @param sourceUrl - the entry's upstream URL; non-GitHub URLs yield no candidates.
 * @param language - active UI language.
 * @returns the loading state, the first README that resolved, and whether it was the Chinese one.
 */
export function usePluginReadme(sourceUrl: string | undefined, language: 'zh' | 'en'): ReadmeState {
  const [state, setState] = useState<ReadmeState>({ loading: false, localized: false })
  useEffect(() => {
    if (sourceUrl === undefined) {
      setState({ loading: false, localized: false })
      return
    }
    const candidates = githubReadmeCandidates(sourceUrl, language)
    if (candidates.length === 0) {
      setState({ loading: false, localized: false, error: 'unsupported-source' })
      return
    }
    let cancelled = false
    // The in-flight request, so leaving the dialog ends the connection rather
    // than merely ignoring its answer.
    let inflight: AbortController | undefined
    setState({ loading: true, localized: false })
    const read = async (): Promise<void> => {
      for (const candidate of candidates) {
        // One candidate at a time, each with its own deadline: a name that never
        // answers costs this deadline and then the next name is tried, instead of
        // pinning the dialog on "loading…" until the browser's own socket timeout
        // decides the question for us. Both the deadline and the unmount path
        // abort the same request, because both mean the answer is no longer wanted.
        const controller = new AbortController()
        inflight = controller
        const deadline = setTimeout(() => { controller.abort() }, README_FETCH_TIMEOUT_MS)
        try {
          const response = await fetch(candidate.url, { cache: 'no-store', signal: controller.signal })
          if (!response.ok) continue
          const text = await response.text()
          // A Chinese file name that resolves to an empty file is not usable.
          if (text.trim() === '') continue
          if (!cancelled) setState({ loading: false, text, localized: candidate.localized })
          return
        } catch {
          // Try the next branch or file name. An aborted candidate is simply one
          // more name that produced no usable README.
        } finally {
          clearTimeout(deadline)
          if (inflight === controller) inflight = undefined
        }
      }
      if (!cancelled) setState({ loading: false, localized: false, error: 'unreadable' })
    }
    void read()
    return () => { cancelled = true; inflight?.abort() }
  }, [sourceUrl, language])
  return state
}
