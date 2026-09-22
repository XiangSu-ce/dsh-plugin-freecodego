/**
 * Every counter the Host reports has to be readable by the person it is for.
 *
 * `HeadroomStats` is a *reporting* surface: its only consumer in this repository is
 * the settings panel, and a field the panel does not render is a number that exists
 * to be asserted on. That is not a hypothetical — `ccrWriteRefusals` shipped with its
 * reader being its own spec, and the provenance triple (`provenance` plus the
 * `portVersion`/`upstreamRevision` it is composed from) shipped with the panel showing
 * a hand-written sentence that named a project and a license but never the upstream
 * ref this build reconciles against, which is the one fact a reader needs when the
 * port and its upstream drift.
 *
 * TypeScript cannot ask this question: the panel is free to ignore any field it is
 * given, and `status()` is free to grow one. So the two halves are compared from
 * source, the way `remote-call-contract.spec.ts` compares the client's calls with the
 * Host's `@Remote` names:
 *
 * 1. every field of `HeadroomStats`, from its declaration in `types.ts`;
 * 2. every `snapshot.<field>` read in `harness-ui`'s settings panel;
 * 3. a field in (1) with no read in (2) fails, printing the field's name.
 *
 * The extraction is pinned so a parser that silently stops matching cannot make this
 * file pass while checking nothing: the field count is asserted, the panel has to be
 * the headroom panel (`foldPolicy` is read there and nowhere else), and the reads have
 * to outnumber the fields — a file that reads nothing cannot agree with a type that
 * declares something. What it deliberately does not check: *how* the panel renders a
 * field (a chip, a headline cell, a sentence), because the answer to "is this number
 * visible" is not a layout question, and pinning the layout here would make every
 * styling change fail a compression gate.
 *
 * Falsified by mutation, each run against this file: deleting the write-refusal chip
 * from the panel takes it red (`ccrWriteRefusals: the Host reports it and the panel
 * never reads it`), and adding a field to `HeadroomStats` that the panel ignores takes
 * it red the same way.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Source with line endings normalised, so a declaration may span lines. */
function source(relative: string): string {
  return readFileSync(join(PACKAGES, relative), 'utf8').replace(/\r\n/gu, '\n')
}

const TYPES = source('harness-plugin/src/types.ts')
const PANEL = source('harness-ui/src/client/settings-tab.tsx')

/** The fields of one exported interface, in declaration order. */
function fieldsOf(interfaceName: string): readonly string[] {
  const body = new RegExp(`export interface ${interfaceName} \\{(.*?)\\n\\}`, 'su').exec(TYPES)?.[1]
  if (body === undefined) throw new Error(`${interfaceName} is no longer declared in types.ts`)
  return [...body.matchAll(/readonly (\w+)\??:/gu)].map(match => match[1]!)
}

describe('the headroom panel reads every counter the Host reports', () => {
  const fields = fieldsOf('HeadroomStats')

  it('extracts the Host surface and the panel it is reported to', () => {
    // Without this the file would agree with a parser that matched nothing: a type
    // with no fields has every field rendered, and so does a panel file that was
    // renamed out from under the path above.
    expect(fields.length).toBeGreaterThan(25)
    expect(fields).toContain('ccrWriteRefusals')
    expect(fields).toContain('foldDeferred')
    // The panel, not a same-named helper: the fold policy and the dedup switch are the
    // two readings that only this section makes, so a rename that left the path above
    // pointing at some other file fails here instead of passing on an empty comparison.
    expect(PANEL).toMatch(/snapshot\??\.foldPolicy/u)
    expect(PANEL).toMatch(/snapshot\??\.dedupEnabled/u)
  })

  it('renders every field of the Host surface', () => {
    const reads = [...PANEL.matchAll(/snapshot\??\.(\w+)/gu)].map(match => match[1]!)
    // A panel that reads nothing cannot agree with a type that declares something, so
    // the comparison is only meaningful in this direction.
    expect(reads.length).toBeGreaterThan(fields.length)

    const unread = fields.filter(field => !reads.includes(field))
    expect(
      unread.map(field => `${field}: the Host reports it and the panel never reads it`),
      'a counter nobody can see is a diagnostic only its own test can read — render it (a chip, a headline cell, a sentence) or drop it from HeadroomStats',
    ).toEqual([])
  })
})

