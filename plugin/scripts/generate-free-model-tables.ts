/**
 * Regenerate the published free-model tables from the providers' own directories.
 *
 * Why this exists: the same table lives in six source files (the root front page
 * and the two freecodego package READMEs, each with a Chinese half) and four
 * publish-tree mirrors. Hand-maintaining twelve copies failed twice in one day —
 * `gpt-image-2` and `hy3-free` stayed listed after upstream withdrew them, and
 * the counts drifted apart from what the picker actually served. The rows are
 * now derived, through the plugin's own parsers, from the same directories the
 * picker reads (`parseOpenCodeDirectory`, `parseKiloDirectory`, `parseLogfareModel`,
 * the NVIDIA/SenseNova rosters), so a table can only be wrong in the same way the
 * menu is wrong.
 *
 * Three providers have public directories and are read live (OpenCode, Kilo,
 * Logfare). Two ship a roster and expose a directory that needs a key (NVIDIA,
 * SenseNova), so the cross-check uses the key when the environment has one and
 * the last recorded reading otherwise. The account-gated providers (TRAE, Cline,
 * WorkBuddy International, Agnes) and the fixed-route ones (Qoder, VyceAI, Groq)
 * have no readable roster, so their cells state that instead of inventing a list.
 *
 * Usage:
 *   tsx scripts/generate-free-model-tables.ts             # read live, write all targets
 *   tsx scripts/generate-free-model-tables.ts --check     # read live, write nothing, exit 1 on drift
 *   tsx scripts/generate-free-model-tables.ts --offline   # use the recorded snapshot, no network
 *   tsx scripts/generate-free-model-tables.ts --sources-only  # skip the publish-tree mirrors
 *
 * @module scripts/generate-free-model-tables
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { inferMediaCategory } from '../packages/freecodego/harness-plugin/src/media-utils.ts'
import { QODER_FALLBACK_MODEL } from '../packages/freecodego/harness-plugin/src/qoder/rows.ts'
import {
  GROQ_WHISPER_MODEL,
  KILO_ANONYMOUS_API_KEY, KILO_MODELS_URL,
  LOGFARE_BROWSER_USER_AGENT, LOGFARE_MODELS_URL,
  logfareSupportsChat, logfareUsesTrainingData,
  NVIDIA_MODELS, NVIDIA_MODELS_URL,
  OPENCODE_DIRECT_BASE_URL,
  parseKiloDirectory, parseLogfareModel, parseOpenCodeDirectory,
  SENSENOVA_MODELS, SENSENOVA_MODELS_URL,
  type LogfareModel,
  VYCE_MODELS,
} from '../packages/freecodego/harness-plugin/src/managed-catalog-utils.ts'

/** Marker opening the generated region. Anything between the markers is derived. */
export const FREE_MODEL_TABLE_BEGIN = '<!-- generated:free-models:begin by scripts/generate-free-model-tables.ts -->'
/** Marker closing the generated region. */
export const FREE_MODEL_TABLE_END = '<!-- generated:free-models:end -->'

const pluginRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(pluginRoot, '..')
/** Derived readings of the keyed directories, kept outside the published tree. */
const SNAPSHOT_PATH = resolve(workspaceRoot, '.tmp-free-models-snapshot.json')

/** Which document half a target holds. */
type Lang = 'en' | 'zh'
/** One sentence in both published languages. */
interface LangText { readonly en: string; readonly zh: string }
/** One provider's row in the generated table. */
interface ProviderCell {
  readonly label: LangText
  readonly models: LangText
  readonly directory: LangText
  /** Set when the provider publishes no readable roster, so the table says so instead of listing rows. */
  readonly rosterless?: boolean
}

/** A directory reading kept from an earlier run, for the keyed providers. */
interface KeylessSnapshot {
  readonly checkedAt: string
  readonly directoryIds: readonly string[]
}
/** The whole recorded reading file. */
interface Snapshot {
  /** The local date the rows were read — the same value the table states. */
  observedAt?: string
  opencodeRows?: readonly unknown[]
  kiloRows?: readonly unknown[]
  logfareRows?: readonly unknown[]
  nvidia?: KeylessSnapshot
  sensenova?: KeylessSnapshot
}

/** Everything the renderer needs, in the order the rows appear. */
interface Section {
  readonly observedAt: string
  readonly cells: readonly ProviderCell[]
  readonly footnotes: readonly LangText[]
}

/** Today's date where the reader lives, which is the date the table claims. */
function localDate(at: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The date a recording may claim for its rows.
 *
 * The date is stored next to the rows, taken from the same value the table was
 * rendered with, and it is the only source an offline run may use. It cannot be
 * derived from a frame timestamp: an instant in UTC is not a date where the
 * reader lives, so slicing one dates a reading made just after local midnight to
 * the previous day — a reading the directories answered on the 23rd would be
 * republished as the 22nd, and the next live `--check` would then call all
 * twelve tables stale for a reason that is not a roster change.
 *
 * A recording without this field is one whose date cannot be known, so it says
 * so rather than guessing.
 * @param snapshot - the recorded reading.
 * @returns the recorded date, or undefined when the recording carries none.
 */
export function recordedObservedAt(snapshot: Snapshot): string | undefined {
  const recorded = snapshot.observedAt
  return recorded === undefined || recorded === '' ? undefined : recorded
}

/**
 * Order ids so the table only moves when the roster does.
 *
 * The directories return their rows in popularity order, which shuffles between
 * reads; the picker keeps that order, but a published table that reorders itself
 * on every run hides the changes worth seeing (and would make `--check` fail on
 * churn alone). Sorting here, and saying so in the intro, keeps both true.
 */
function sorted(ids: readonly string[]): readonly string[] {
  return [...ids].sort((left, right) => left.localeCompare(right))
}

const SEPARATOR: Record<Lang, string> = { en: ', ', zh: '、' }
const CONJUNCTION: Record<Lang, string> = { en: ' and ', zh: ' 与 ' }

/** Render backticked ids with the language's list separator. */
function codeList(ids: readonly string[], lang: Lang): string {
  return ids.map(id => `\`${id}\``).join(SEPARATOR[lang])
}

/** Render backticked ids with the language's "a and b" conjunction. */
function andList(ids: readonly string[], lang: Lang): string {
  const coded = ids.map(id => `\`${id}\``)
  if (coded.length < 2) return coded.join('')
  return `${coded.slice(0, -1).join(SEPARATOR[lang])}${CONJUNCTION[lang]}${coded[coded.length - 1]}`
}

/** Format a token budget the way the rosters state it (`1_000_000` → `1M`). */
function compactTokens(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/** Fetch one directory payload, failing loudly with its URL. */
async function fetchDirectory(url: string, headers: Record<string, string>, label: string): Promise<readonly unknown[]> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${label} directory failed with HTTP ${response.status}`)
  const payload = await response.json() as { data?: unknown }
  const data: unknown = payload.data
  return Array.isArray(data) ? (data as readonly unknown[]) : []
}

/** Read the recorded snapshot, or an empty one when nothing has been recorded. */
async function readSnapshot(): Promise<Snapshot> {
  if (!existsSync(SNAPSHOT_PATH)) return {}
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')) as Snapshot
  } catch {
    return {}
  }
}

/**
 * Read an optional directory, falling back to the last recording.
 *
 * Returns `undefined` when neither the live directory nor a recording answered,
 * which is the caller's signal to drop the cross-check clause from the row
 * rather than to state a stale reading as if it were current.
 * @param url - the directory endpoint.
 * @param headers - request headers, key included only when the caller has one.
 * @param options - the recorded reading, the label for diagnostics, and the offline switch.
 * @returns the directory ids and the date they were read, or undefined.
 */
async function readDirectory(
  url: string,
  headers: Record<string, string>,
  options: { readonly recorded: KeylessSnapshot | undefined; readonly label: string; readonly offline: boolean },
): Promise<{ ids: readonly string[]; observedAt: string } | undefined> {
  if (!options.offline) {
    try {
      const rows = await fetchDirectory(url, headers, options.label)
      const ids = rows.flatMap((value) => {
        const row = value as { id?: unknown }
        return typeof row.id === 'string' && row.id.trim() !== '' ? [row.id.trim()] : []
      })
      return { ids, observedAt: localDate() }
    } catch (error) {
      if (options.recorded === undefined) {
        process.stderr.write(`! ${options.label}: ${String(error).slice(0, 160)} — no recording to fall back to, the cross-check is left out\n`)
        return undefined
      }
      process.stderr.write(`! ${options.label}: ${String(error).slice(0, 160)} — falling back to the recorded reading of ${options.recorded.checkedAt}\n`)
    }
  }
  if (options.recorded === undefined) return undefined
  return { ids: options.recorded.directoryIds, observedAt: options.recorded.checkedAt }
}

/** OpenCode's public free roster, as the picker sees it. */
function openCodeCell(rows: readonly unknown[]): ProviderCell {
  const free = parseOpenCodeDirectory(rows)
  return {
    label: { en: 'OpenCode', zh: 'OpenCode' },
    models: {
      en: codeList(sorted(free.map(model => model.upstreamId)), 'en'),
      zh: codeList(sorted(free.map(model => model.upstreamId)), 'zh'),
    },
    directory: {
      en: `${free.length} of ${rows.length} rows; public, no sign-in`,
      zh: `${rows.length} 行中的 ${free.length} 行；公开，无需登录`,
    },
  }
}

/** Kilo Gateway's anonymous free roster. */
function kiloCell(rows: readonly unknown[]): ProviderCell {
  const free = parseKiloDirectory(rows)
  return {
    label: { en: 'Kilo', zh: 'Kilo' },
    models: {
      en: codeList(sorted(free.map(model => model.upstreamId)), 'en'),
      zh: codeList(sorted(free.map(model => model.upstreamId)), 'zh'),
    },
    directory: {
      en: `${free.length} of ${rows.length} rows; public, 200 requests/hour per egress IP`,
      zh: `${rows.length} 行中的 ${free.length} 行；公开，每个出口 IP 每小时 200 次`,
    },
  }
}

/** Logfare's public directory, grouped by what each row does. */
function logfareCell(rows: readonly unknown[]): ProviderCell {
  const models = rows.map(parseLogfareModel).filter((model): model is LogfareModel => model !== undefined)
  const chat = models.filter(model => logfareSupportsChat(model))
  const media = models.filter(model => !logfareSupportsChat(model))
  const group = (category: 'image' | 'video' | 'audio'): string[] =>
    media.filter(model => inferMediaCategory(model.id) === category).map(model => model.id)
  const optIn = models.filter(model => logfareUsesTrainingData(model)).length
  // A non-chat row whose id names no medium would otherwise vanish from the
  // table while still being listed: `phoenix-1.0` and `lucid-origin` are image
  // routes the category patterns do not recognise, so they get their own group.
  const classified = new Set<string>([...group('image'), ...group('video'), ...group('audio')])
  const unclassified = media.map(model => model.id).filter(id => !classified.has(id))
  const groups: ReadonlyArray<{ readonly ids: readonly string[]; readonly label: LangText }> = [
    { ids: chat.map(model => model.id), label: { en: 'chat', zh: '对话' } },
    { ids: group('image'), label: { en: 'images', zh: '图片' } },
    { ids: group('video'), label: { en: 'video', zh: '视频' } },
    { ids: group('audio'), label: { en: 'audio', zh: '音频' } },
    { ids: unclassified, label: { en: 'other routes', zh: '其他路由' } },
  ]
  const written = groups.filter(entry => entry.ids.length > 0)
  const sentence = (lang: Lang): string =>
    written.map(entry => `${entry.label[lang]} ${codeList(sorted(entry.ids), lang)}`).join(lang === 'en' ? '; ' : '；')
  return {
    label: { en: 'Logfare', zh: 'Logfare' },
    models: { en: sentence('en'), zh: sentence('zh') },
    directory: {
      en: `${models.length} rows; ${optIn} need a training-data opt-in, the other ${models.length - optIn} do not`,
      zh: `${models.length} 行；${optIn} 行需要训练数据授权，其余 ${models.length - optIn} 行不需要`,
    },
  }
}

/** Qoder's free route, which its directory announces before sign-in. */
function qoderCell(): ProviderCell {
  return {
    label: { en: 'Qoder', zh: 'Qoder' },
    models: {
      en: `\`${QODER_FALLBACK_MODEL.displayName.replace(/\s*\(free\)$/iu, '')}\` (route \`${QODER_FALLBACK_MODEL.id}\`)`,
      zh: `\`${QODER_FALLBACK_MODEL.displayName.replace(/\s*\(free\)$/iu, '')}\`（路由 \`${QODER_FALLBACK_MODEL.id}\`）`,
    },
    directory: {
      en: 'the free flash route, plus daily check-in campaigns',
      zh: '免费 flash 路由，另有每日签到活动',
    },
  }
}

/**
 * NVIDIA's roster, cross-checked against its live catalogue when one is readable.
 * @param live - the directory reading, when the key or a recording supplied one.
 * @returns the row, naming any roster id the live catalogue has dropped.
 */
function nvidiaCell(live: { ids: readonly string[]; observedAt: string } | undefined): ProviderCell {
  const roster = sorted(NVIDIA_MODELS.map(model => model.id))
  const present = live === undefined ? roster : roster.filter(id => live.ids.includes(id))
  const missing = live === undefined ? [] : roster.filter(id => !live.ids.includes(id))
  const tail = (lang: Lang): string => {
    if (live === undefined || missing.length === 0) return ''
    const rows = live.ids.length
    return lang === 'en'
      ? ` — the roster also names ${andList(missing, 'en')}, which ${missing.length === 1 ? 'is' : 'are'} gone from NVIDIA's live catalogue of ${rows} rows`
      : ` —— 名单里另有 ${andList(missing, 'zh')}，${missing.length === 1 ? '这个名字' : '这两个名字'}已不在 NVIDIA 实时目录（${rows} 行）中`
  }
  const crossCheck = (lang: Lang): string =>
    live === undefined ? '' : lang === 'en' ? `; cross-checked ${live.observedAt}` : `；核对于 ${live.observedAt}`
  return {
    label: { en: 'NVIDIA', zh: 'NVIDIA' },
    models: {
      en: `${codeList(present, 'en')}${tail('en')}`,
      zh: `${codeList(present, 'zh')}${tail('zh')}`,
    },
    // NVIDIA's `/models` answers without a credential, so this row is always
    // cross-checked live unless the request itself fails.
    directory: {
      en: `an API key is required to call them${crossCheck('en')}`,
      zh: `调用需要 API key${crossCheck('zh')}`,
    },
  }
}

/**
 * SenseNova's bundle roster, with the shared window stated once.
 * @param live - the directory reading, when the key or a recording supplied one.
 * @returns the row.
 */
function sensenovaCell(live: { ids: readonly string[]; observedAt: string } | undefined): ProviderCell {
  const contexts = new Set(SENSENOVA_MODELS.map(model => model.contextWindow))
  const outputs = new Set(SENSENOVA_MODELS.map(model => model.maxTokens))
  const uniform = contexts.size === 1 && outputs.size === 1
  const [contextWindow] = [...contexts]
  const [maxTokens] = [...outputs]
  const shape = (lang: Lang): string => {
    if (!uniform || contextWindow === undefined || maxTokens === undefined) return ''
    return lang === 'en'
      ? ` — ${compactTokens(contextWindow)} context and ${compactTokens(maxTokens)} output each`
      : ` —— 均为 ${compactTokens(contextWindow)} 上下文 / ${compactTokens(maxTokens)} 输出`
  }
  const crossCheck = (lang: Lang): string =>
    live === undefined ? '' : lang === 'en' ? `; directory read ${live.observedAt}` : `；目录读取于 ${live.observedAt}`
  return {
    label: { en: 'SenseNova', zh: 'SenseNova' },
    models: {
      en: `${codeList(sorted(SENSENOVA_MODELS.map(model => model.id)), 'en')}${shape('en')}`,
      zh: `${codeList(sorted(SENSENOVA_MODELS.map(model => model.id)), 'zh')}${shape('zh')}`,
    },
    directory: {
      en: `roster ships in the bundle; an API key is required${crossCheck('en')}`,
      zh: `名单随 bundle 内置；需要 API key${crossCheck('zh')}`,
    },
  }
}

/** The rows no one can list from outside: the account-gated providers. */
function accountGatedCells(): readonly ProviderCell[] {
  const rosterless = true as const
  return [
    {
      label: { en: 'TRAE', zh: 'TRAE' },
      models: { en: 'the rows its directory lists', zh: '其目录列出的那些行' },
      directory: { en: 'free credits reset daily, per account', zh: '免费额度每日重置，按账号' },
      rosterless,
    },
    {
      label: { en: 'Cline', zh: 'Cline' },
      models: { en: 'the rows the directory marks `×0 · 官方免费模型`', zh: '目录标记 `×0 · 官方免费模型` 的那些行' },
      directory: { en: 'an account pool', zh: '账号池' },
      rosterless,
    },
    {
      label: { en: 'WorkBuddy International', zh: 'WorkBuddy 国际版' },
      models: { en: 'the rows a credit package marks `x0`', zh: '积分包标记 `x0` 的那些行' },
      directory: { en: 'device login, several accounts', zh: '设备登录，可放多个账号' },
      rosterless,
    },
    {
      label: { en: 'Agnes', zh: 'Agnes' },
      models: { en: 'chat and image/video rows', zh: '对话与图片/视频行' },
      directory: { en: 'a control-plane account', zh: '控制面账号' },
      rosterless,
    },
  ]
}

/** VyceAI and Groq: fixed routes rather than free rosters. */
function fixedRouteCells(): readonly ProviderCell[] {
  // An absent price is "no stated price", not "costs nothing": VyceAI's only
  // unstated row is metered by its own account, so it must not be counted as free.
  const metered = VYCE_MODELS.filter(model => model.inputPricePerMillion === 0 && model.outputPricePerMillion === 0)
  return [
    {
      label: { en: 'VyceAI', zh: 'VyceAI' },
      models: {
        en: metered.length === 0 ? 'no free roster' : `the rows its pricing does not meter (${codeList(metered.map(model => model.id), 'en')})`,
        zh: metered.length === 0 ? '没有免费名单' : `其定价不计量的行（${codeList(metered.map(model => model.id), 'zh')}）`,
      },
      directory: { en: 'the daily check-in credit pays its metered rows', zh: '每日签到额度支付其计量行' },
    },
    {
      label: { en: 'Groq', zh: 'Groq' },
      models: { en: `\`${GROQ_WHISPER_MODEL}\``, zh: `\`${GROQ_WHISPER_MODEL}\`` },
      directory: { en: 'transcription, not a chat route', zh: '仅转写，不是对话路由' },
    },
  ]
}

/** The prose under the table, so the counts it repeats cannot go stale. */
function footnotes(cells: readonly ProviderCell[], optInRows: number | undefined): readonly LangText[] {
  const rosterless = cells.filter(cell => cell.rosterless === true).map(cell => cell.label)
  const names = (lang: Lang): string => rosterless.map(label => label[lang]).join(SEPARATOR[lang])
  const notes: LangText[] = [
    {
      en: 'These lists follow their directories: a route upstream retires leaves the table on the next read, which is why it is generated by `scripts/generate-free-model-tables.ts` rather than remembered.',
      zh: '这些清单跟随各自的目录：上游下架的路由会在下次读取时从表中消失 —— 这正是本表由 `scripts/generate-free-model-tables.ts` 生成、而不是凭记忆维护的原因。',
    },
  ]
  if (rosterless.length > 0) {
    notes.push({
      en: `${names('en')} publish no stable roster, so their rows are counted when they arrive rather than listed here.`,
      zh: `${names('zh')} 不公布固定名单，因此它们的行在到达时计数，而不在此列名。`,
    })
  }
  if (optInRows !== undefined && optInRows > 0) {
    notes.push({
      en: `${optInRows} Logfare rows sit behind a training-data opt-in, which the picker labels rather than hides.`,
      zh: `Logfare 有 ${optInRows} 行位于训练数据授权之后，选择器会标注而不是隐藏它们。`,
    })
  }
  return notes
}

/**
 * Render the marked region for one language.
 * @param section - the collected rows, markers excluded.
 * @param lang - which half to render.
 * @param eol - the target's line ending, so the region lands without rewriting the file.
 * @returns the region, markers included, ending with a newline.
 */
export function renderFreeModelRegion(section: Section, lang: Lang, eol: string): string {
  const intro = lang === 'en'
    ? `Every free row below comes from the provider's own directory, read when you open the picker, so this is what those directories returned on ${section.observedAt} (sorted, where the picker keeps directory order) — and the picker is the count that is true when you look.`
    : `下面每一行都来自各提供商自己的目录，在你打开选择器时读取；也就是说，这是那些目录在 ${section.observedAt} 返回的结果（按名称排序，选择器里保持目录顺序），而选择器里的数量才是你查看时真正成立的数量。`
  const header = lang === 'en'
    ? ['| Provider | Free models | Directory |', '|---|---|---|']
    : ['| 提供商 | 免费模型 | 目录 |', '|---|---|---|']
  const rows = section.cells.map(cell => `| **${cell.label[lang]}** | ${cell.models[lang]} | ${cell.directory[lang]} |`)
  // Footnotes are paragraphs, and `verify-md-wrap` reads consecutive physical
  // lines as one hard-wrapped paragraph — so each note gets its own line and a
  // blank line of its own.
  const notes = section.footnotes.flatMap((note, index) => (index === 0 ? [note[lang]] : ['', note[lang]]))
  const body = [FREE_MODEL_TABLE_BEGIN, intro, '', ...header, ...rows, '', ...notes, '', FREE_MODEL_TABLE_END]
  return `${body.join(eol)}${eol}`
}

/**
 * Swap the marked region in one document.
 * @param source - the complete file.
 * @param region - the freshly rendered region.
 * @returns the file with its region replaced.
 */
export function replaceFreeModelRegion(source: string, region: string): string {
  const begin = source.indexOf(FREE_MODEL_TABLE_BEGIN)
  const end = source.indexOf(FREE_MODEL_TABLE_END)
  if (begin === -1 || end === -1 || end < begin) throw new Error('the generated free-model markers are missing from this file')
  const afterEnd = source.indexOf('\n', end + FREE_MODEL_TABLE_END.length)
  return `${source.slice(0, begin)}${region}${afterEnd === -1 ? '' : source.slice(afterEnd + 1)}`
}

/** Where the region lives, and which language half each file holds. */
interface Target { readonly file: string; readonly lang: Lang }

const SOURCE_TARGETS: readonly Target[] = [
  { file: resolve(workspaceRoot, 'public/README.md'), lang: 'en' },
  { file: resolve(workspaceRoot, 'public/README.zh.md'), lang: 'zh' },
  { file: resolve(pluginRoot, 'packages/freecodego/bundle-latest/README.md'), lang: 'en' },
  { file: resolve(pluginRoot, 'packages/freecodego/bundle-latest/README.zh.md'), lang: 'zh' },
  { file: resolve(pluginRoot, 'packages/freecodego/harness-plugin/README.md'), lang: 'en' },
  { file: resolve(pluginRoot, 'packages/freecodego/harness-plugin/README.zh.md'), lang: 'zh' },
]

/**
 * The publish-tree mirror of each source target, joined the way the mirror script joins them.
 *
 * The two joinings differ on purpose: `plugin/` is published under its own name,
 * while `public/` is the publish repository's *root* face, so `public/README.md`
 * becomes `publish-repo/README.md`. Joining that one as a plain relative path
 * would write a second front page into `publish-repo/public/` and leave the real
 * one stale.
 */
function mirrorTargets(): readonly Target[] {
  return SOURCE_TARGETS.map((target) => {
    const insidePlugin = target.file.startsWith(pluginRoot)
    const relative = insidePlugin
      ? `plugin/${target.file.slice(pluginRoot.length + 1)}`
      // The workspace-relative slice keeps the platform separator, so both are accepted here.
      : target.file.slice(workspaceRoot.length + 1).replace(/^public[\\/]/u, '')
    return { file: resolve(workspaceRoot, 'publish-repo', relative), lang: target.lang }
  })
}

/** Read the three public directories and assemble every row. */
async function collect(offline: boolean, snapshot: Snapshot): Promise<{ section: Section; next: Snapshot }> {
  const recorded = snapshot
  const opencodeRows = offline ? recorded.opencodeRows : await fetchDirectory(`${OPENCODE_DIRECT_BASE_URL}/models`, { authorization: 'Bearer public', accept: 'application/json', 'x-opencode-client': 'desktop', 'user-agent': 'opencode/freecodego' }, 'OpenCode')
  const kiloRows = offline ? recorded.kiloRows : await fetchDirectory(KILO_MODELS_URL, { authorization: `Bearer ${KILO_ANONYMOUS_API_KEY}`, accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' }, 'Kilo')
  const logfareRows = offline ? recorded.logfareRows : await fetchDirectory(LOGFARE_MODELS_URL, { accept: 'application/json', 'user-agent': LOGFARE_BROWSER_USER_AGENT }, 'Logfare')
  if (opencodeRows === undefined || kiloRows === undefined || logfareRows === undefined) throw new Error('no network reading and no recorded snapshot — run without --offline first')

  const nvidiaKey = process.env.NVIDIA_API_KEY
  const nvidia = await readDirectory(NVIDIA_MODELS_URL, { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness', ...(nvidiaKey === undefined || nvidiaKey === '' ? {} : { authorization: `Bearer ${nvidiaKey}` }) }, { recorded: recorded.nvidia, label: 'NVIDIA', offline })
  const sensenovaKey = process.env.SENSENOVA_API_KEY
  const sensenova = await readDirectory(SENSENOVA_MODELS_URL, { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness', ...(sensenovaKey === undefined || sensenovaKey === '' ? {} : { authorization: `Bearer ${sensenovaKey}` }) }, { recorded: recorded.sensenova, label: 'SenseNova', offline })

  const logfareModels = logfareRows.map(parseLogfareModel).filter((model): model is LogfareModel => model !== undefined)
  const optInRows = logfareModels.filter(model => logfareUsesTrainingData(model)).length
  // The date the live directories answered. A recording carries its own date,
  // so an offline run states when the data was actually read.
  const observedAt = offline ? recordedObservedAt(snapshot) : localDate()
  if (observedAt === undefined) {
    throw new Error('the recorded snapshot carries no reading date — run this once without --offline to record one')
  }
  const cells: ProviderCell[] = [
    openCodeCell(opencodeRows),
    kiloCell(kiloRows),
    logfareCell(logfareRows),
    qoderCell(),
    nvidiaCell(nvidia),
    sensenovaCell(sensenova),
    ...accountGatedCells(),
    ...fixedRouteCells(),
  ]
  const next: Snapshot = {
    observedAt,
    opencodeRows,
    kiloRows,
    logfareRows,
    ...(nvidia === undefined ? {} : { nvidia: { checkedAt: nvidia.observedAt, directoryIds: nvidia.ids } }),
    ...(sensenova === undefined ? {} : { sensenova: { checkedAt: sensenova.observedAt, directoryIds: sensenova.ids } }),
  }
  return { section: { observedAt, cells, footnotes: footnotes(cells, optInRows) }, next }
}

/** Report what each row came out as, so a silent roster change is visible. */
function report(section: Section): void {
  for (const cell of section.cells) {
    const count = cell.models.en.split('`').length >> 1
    process.stdout.write(`  ${cell.label.en.padEnd(24)} ${String(count).padStart(3)} id(s)  ${cell.directory.en}\n`)
  }
}

/** Run the generator, or the drift check when `--check` is passed. */
async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2))
  const check = argv.has('--check')
  const offline = argv.has('--offline')
  const sourcesOnly = argv.has('--sources-only')
  const snapshot = await readSnapshot()
  const { section, next } = await collect(offline, snapshot)
  const targets = sourcesOnly ? SOURCE_TARGETS : [...SOURCE_TARGETS, ...mirrorTargets()]
  const pending: { target: Target; region: string; source: string }[] = []
  const drifted: string[] = []

  for (const target of targets) {
    if (!existsSync(target.file)) {
      // A missing target is a mapping bug, not an absence of work: the publish
      // root face is `publish-repo/README.md`, and a wrong join silently writes
      // a second front page while leaving the real one stale.
      drifted.push(`${target.file} (missing)`)
      process.stderr.write(`! target does not exist: ${target.file}\n`)
      continue
    }
    const source = await readFile(target.file, 'utf8')
    const region = renderFreeModelRegion(section, target.lang, source.includes('\r\n') ? '\r\n' : '\n')
    if (check) {
      const replaced = replaceFreeModelRegion(source, region)
      if (replaced !== source) {
        drifted.push(target.file)
        // Show what moved, in a window around the first differing character: a
        // stale table is either upstream roster churn or a rule change, and the
        // changed words say which (the rows are long, so a prefix would only
        // print the part that agreed).
        let at = 0
        while (at < source.length && source[at] === replaced[at]) at += 1
        const from = Math.max(0, at - 60)
        process.stderr.write(`  ${target.file}\n    - …${source.slice(from, at + 140).replaceAll('\n', '⏎')}\n    + …${replaced.slice(from, at + 140).replaceAll('\n', '⏎')}\n`)
      }
      continue
    }
    const replaced = replaceFreeModelRegion(source, region)
    if (replaced !== source) pending.push({ target, region, source: replaced })
  }

  if (check) {
    report(section)
    if (drifted.length > 0) {
      process.stderr.write(`free-model tables are stale in ${drifted.length} file(s):\n${drifted.map(file => `  ${file}`).join('\n')}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`free-model tables match all ${targets.length} targets\n`)
    return
  }

  for (const item of pending) await writeFile(item.target.file, item.source, 'utf8')
  // The recording is only worth rewriting when a live read produced it: an
  // offline run would otherwise date old directory rows as today's.
  if (!offline) await writeFile(SNAPSHOT_PATH, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
  report(section)
  process.stdout.write(`wrote ${pending.length} of ${targets.length} targets${offline ? ' (from the recorded snapshot)' : ''}\n`)
  if (drifted.length > 0) process.exitCode = 1
}

// Only a direct run may touch the network and the documents: the spec imports
// the renderer, and an unguarded `main()` would make a unit test rewrite the
// published tables and the snapshot they are checked against.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
