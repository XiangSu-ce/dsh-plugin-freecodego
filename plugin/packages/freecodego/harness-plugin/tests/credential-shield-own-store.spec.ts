/**
 * The shield's own store.
 *
 * The credential shield is a list of creditor-shaped basenames, and the list was
 * written by looking at *other* tools' stores: `.aws/credentials`, `.kube/config`,
 * `.docker/config.json`, `gh`, gcloud and Azure all appear. The one it missed is
 * the host's own credential document — `$DSH_HOME/.credentials.yaml`, whose module
 * header says it "holds nothing but credentials" — and that is the file this
 * plugin's own secrets land in: the Agnes account and apiKey, the account
 * coordinator's access/refresh tokens, the VYCE and Kling keys.
 *
 * The gap survived because the eval's own coverage probe listed thirteen
 * hand-written basenames that did not include it, so the claim ("every
 * credential-shaped basename is refused") was always larger than its corpus.
 * These cases pin the file by name in every spelling a reader can reach it with,
 * including the temp sibling the atomic write creates beside it.
 */

import { describe, expect, it } from 'vitest'
import { isCredentialPath } from '../src/tool-guards.ts'

describe('the credential shield and the host\'s own store', () => {
  it('refuses the host credential document in every spelling a reader could use', () => {
    // POSIX absolute, bare basename, home-relative, and the Windows spelling of
    // the same path: the guard reads the path as written, so every spelling a
    // model can produce is a separate bypass if only one is listed.
    for (const path of [
      '~/.dsh/.credentials.yaml',
      '.dsh/.credentials.yaml',
      '/home/me/.dsh/.credentials.yaml',
      '.credentials.yaml',
      'C:\\Users\\me\\.dsh\\.credentials.yaml',
      '.credentials.yml',
    ]) {
      expect(isCredentialPath(path), `${path} must be refused`).toBe(true)
    }
  })

  it('refuses the temp sibling the atomic write creates beside it', () => {
    // `writeFileAtomic` writes `<name>.<uuid>.tmp` and renames it: the temp file
    // holds the same bytes as the document it is about to become, so a guard that
    // knows only the final name is one suffix away from being bypassed.
    for (const path of ['.credentials.yaml.9f2c41ab.tmp', '/home/me/.dsh/.credentials.yaml.9f2c41ab.tmp']) {
      expect(isCredentialPath(path), `${path} must be refused`).toBe(true)
    }
  })

  it('still admits the templates and the neighbours that hold no secret', () => {
    // The control. A list that grows by matching the shape "`.credentials`" would
    // refuse the documented template a repository commits on purpose — the same
    // false positive the `.env` family already carries an allow-list for — and a
    // guard whose hits stop meaning anything is a guard nobody reads.
    for (const path of [
      '.credentials.yaml.example',
      '.credentials.yaml.template',
      '.credentials.yaml.sample',
      '.aws/config',
      'notes.md',
      '.dsh/settings.yaml',
      '.dsh/settings.json',
    ]) {
      expect(isCredentialPath(path), `${path} must stay readable`).toBe(false)
    }
  })
})
