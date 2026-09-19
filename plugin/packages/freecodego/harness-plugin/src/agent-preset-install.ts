/**
 * Installs the bundled FreeCodeGo agent presets into the harness user roster.
 *
 * The harness discovers agent presets (the 极简/标准/PTC/创造 mode selector)
 * by re-scanning `<DSH_HOME>/.agent-presets/` on every roster read, so a
 * directory written here appears in the mode picker without touching harness
 * source or requiring a restart. This module keeps those directories in sync
 * with the presets bundled inside the plugin package (one directory per
 * preset id, see {@link BUNDLED_PRESET_IDS}): it writes when absent,
 * overwrites when it recognizes its own version marker (a plugin update),
 * and leaves a directory alone when the user hand-edited it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/agent-preset-install
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { harnessHomeDirectory } from './data-home.ts'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
// The bundled npm artifact ships assets inside its dist/ directory next to
// bootstrap.js; the source package keeps them at the package root.
const BUNDLED_PRESETS_ROOT = [
  resolve(MODULE_DIRECTORY, 'assets/presets'),
  resolve(MODULE_DIRECTORY, '../assets/presets'),
  resolve(MODULE_DIRECTORY, '../../assets/presets'),
  resolve(MODULE_DIRECTORY, '../../../assets/presets'),
].find(existsSync) ?? resolve(MODULE_DIRECTORY, '../assets/presets')

/** The preset id this module owns for the Claude-style mode. */
export const FREECODEGO_AGENT_PRESET_ID = 'freecodego'
/** The preset id this module owns for the Augment-Code-style mode. */
export const AUGMENTCODE_AGENT_PRESET_ID = 'augmentcode'
/** Every preset this module syncs into the harness user roster. */
export const BUNDLED_PRESET_IDS = [FREECODEGO_AGENT_PRESET_ID, AUGMENTCODE_AGENT_PRESET_ID] as const
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const
/** Every file this module writes starts with this marker line. */
const OWNERSHIP_MARKER = 'freecodego-agent-preset'

/**
 * The roster directory the harness scans for user-authored presets.
 *
 * `.agent-presets/` is Host-owned (the Host re-scans it), so this resolves
 * against the harness home rather than `FREECODEGO_HOME` — the single resolver
 * in `data-home.ts` is what keeps that distinction in one place.
 */
export function agentPresetDirectory(presetId: string): string {
  return join(harnessHomeDirectory(), '.agent-presets', presetId)
}

/** The FreeCodeGo preset's roster directory (kept for callers keyed to one id). */
export function freeCodeGoAgentPresetDirectory(): string {
  return agentPresetDirectory(FREECODEGO_AGENT_PRESET_ID)
}

/**
 * The bundled source/bundle directory for one preset id, when this package
 * ships it. A preset with no bundled directory is simply not installed.
 */
function presetSourceDirectory(presetId: string): string | undefined {
  const directory = join(BUNDLED_PRESETS_ROOT, presetId)
  return existsSync(directory) ? directory : undefined
}

/**
 * Copy one bundled preset file into the roster directory.
 *
 * Missing → write. Identical → no-op. Bearing our marker but outdated →
 * overwrite (a plugin update shipped a newer composition). Present without
 * our marker → the user hand-edited the copy; leave their version alone.
 */
async function syncFile(source: string, target: string): Promise<void> {
  const bundled = await readFile(source, 'utf8')
  let existing: string | undefined
  try {
    existing = await readFile(target, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === bundled) return
  if (existing !== undefined && !existing.startsWith(`# ${OWNERSHIP_MARKER}`)) return
  // A crash mid-write must not leave a half-file the roster reports as broken.
  // The shared writer is what makes that true on Windows too — its bounded
  // retry over transient `EACCES`/`EBUSY`/`EPERM` covers the antivirus and
  // indexer interference that a bare `rename` loses to.
  // 0600: the roster copy is the user's own composition, never world-readable.
  await writeFileAtomic(target, bundled, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Ensure every bundled FreeCodeGo agent preset is present in the user roster.
 * Best-effort: a read-only home or a locked file must never block boot.
 * @returns true when at least one bundled preset is in place afterwards.
 */
export async function ensureFreeCodeGoAgentPreset(): Promise<boolean> {
  try {
    let installedAny = false
    for (const presetId of BUNDLED_PRESET_IDS) {
      const source = presetSourceDirectory(presetId)
      if (source === undefined) continue
      installedAny = true
      const target = agentPresetDirectory(presetId)
      for (const file of PRESET_FILES) {
        await syncFile(join(source, file), join(target, file))
      }
    }
    // False when no preset ships in this layout, matching the previous
    // absent-directory answer so callers keep their existing fallbacks.
    return installedAny
  } catch {
    // The mode selector simply keeps whatever roster state is on disk.
    return false
  }
}
