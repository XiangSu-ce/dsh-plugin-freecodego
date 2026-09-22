/**
 * Source text of the plugin's own modules, for gates that read the tree.
 *
 * Some duplications are invisible to behaviour: two copies of a rule that agree
 * produce identical results, so no assertion on output can tell them apart, and
 * the copies only drift the day someone edits one. The gates that catch a
 * re-introduced copy therefore read the source, and they read it through this
 * helper — two copies of *that* would be the same disease one level up.
 */

import { readFile, readdir } from 'node:fs/promises'

/** One module under `src`, with `path` as a reviewer would grep for it. */
export interface SourceFile {
  /** Path relative to `src`, forward-slashed on every platform. */
  readonly path: string
  readonly text: string
}

/**
 * Every TypeScript module under the plugin's `src`.
 *
 * @returns each module's relative path and full text.
 */
export async function sourceFiles(): Promise<readonly SourceFile[]> {
  const root = new URL('../../src/', import.meta.url)
  const entries = await readdir(root, { recursive: true })
  const files: SourceFile[] = []
  for (const entry of entries) {
    const path = entry.replace(/\\/gu, '/')
    if (!path.endsWith('.ts')) continue
    files.push({ path, text: await readFile(new URL(path, root), 'utf8') })
  }
  return files
}
