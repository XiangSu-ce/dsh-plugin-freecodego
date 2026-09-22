// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

const CLIENT_ROOT = resolve(import.meta.dirname, '../src/client')

// Context members that are framework plumbing rather than injectable services.
// `get` is the documented escape hatch for optional services, and `inject` is
// cordis's own declaration array, so neither belongs in the comparison.
const CORDIS_BUILTINS = new Set(['get', 'effect', 'inject', 'on'])

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry)
    if (statSync(absolute).isDirectory()) found.push(...sourceFiles(absolute))
    else if (/\.tsx?$/u.test(entry)) found.push(absolute)
  }
  return found
}

/** Every `ctx.<name>` a client module reads, mapped to the files reading it. */
function accessedContextMembers(): Map<string, string[]> {
  const accesses = new Map<string, string[]>()
  for (const file of sourceFiles(CLIENT_ROOT)) {
    const relative = file.slice(CLIENT_ROOT.length + 1).replace(/\\/gu, '/')
    for (const match of readFileSync(file, 'utf8').matchAll(/\bctx\.([A-Za-z_$][\w$]*)/gu)) {
      const name = match[1]!
      if (CORDIS_BUILTINS.has(name)) continue
      const readers = accesses.get(name) ?? []
      if (!readers.includes(relative)) readers.push(relative)
      accesses.set(name, readers)
    }
  }
  return accesses
}

describe('FreeCodeGo alpha.1 client injection', () => {
  it('declares sessions before reading the current session from the root context', () => {
    expect(inject).toContain('sessions')
  })

  // An undeclared `ctx.<service>` read is not a soft failure. The Context getter
  // throws, `apply` aborts mid-way, and the Loader marks the whole entry FAILED —
  // which the boot page renders as `freecodego: failed` with the entire UI gone.
  // That happened once (`ctx.uiSession` in the companion status rows), and the
  // only signal was inside a browser console. This gate keeps the declaration
  // list and the read surface in step from the source side.
  it('declares every Context service its client modules read', () => {
    const undeclared = [...accessedContextMembers()]
      .filter(([name]) => !inject.includes(name))
      .map(([name, readers]) => `ctx.${name} (read by ${readers.join(', ')})`)
    expect(undeclared).toEqual([])
  })

  it('finds the read surface it is meant to police', () => {
    // Guards against the scan silently matching nothing (moved directory,
    // renamed accessor), which would turn the assertion above into a no-op.
    const accessed = [...accessedContextMembers().keys()]
    expect(accessed).toContain('sessions')
    expect(accessed).toContain('uiSession')
  })
})
