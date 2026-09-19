/**
 * Headroom 压缩性能基准：对齐原版 README 的场景（10K token 日志、100K
 * token JSON 搜索结果），测量压缩耗时与压缩率。
 */
import { CcrStore } from '../src/headroom/ccr.ts'
import { LogCompressor } from '../src/headroom/log-compressor.ts'
import { SMART_CRUSHER_DEFAULTS, crushJson } from '../src/headroom/smart-crusher.ts'
import { compressSearch, SEARCH_COMPRESSOR_DEFAULTS } from '../src/headroom/search-compressor.ts'
import { compressDiff, DIFF_COMPRESSOR_DEFAULTS } from '../src/headroom/diff-compressor.ts'
import { crushText, TEXT_CRUSHER_DEFAULTS } from '../src/headroom/text-crusher.ts'

function bench(name: string, iterations: number, run: () => number): void {
  // Warmup (JIT).
  for (let i = 0; i < 3; i += 1) run()
  const samples: number[] = []
  let ratio = 0
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint()
    ratio = run()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(iterations / 2)]!
  const p95 = samples[Math.floor(iterations * 0.95)]!
  console.log(`${name}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms compression=${(ratio * 100).toFixed(1)}%`)
}

// ── 场景 1：10K token 日志（原版 demo：10,144 → 1,260） ─────────────────
const logLines: string[] = []
for (let i = 0; i < 700; i += 1) {
  logLines.push(`2026-09-09T10:${String(i % 60).padStart(2, '0')}:00Z INFO worker heartbeat ok iteration=${i} queue_depth=${i % 17}`)
}
logLines[50] = '2026-09-09T10:50:00Z WARN disk usage above 85% on /dev/sda1'
logLines[120] = '2026-09-09T10:12:00Z ERROR failed to connect to upstream: connection refused (0x0000274D)'
logLines[121] = 'Traceback (most recent call last):'
for (let i = 0; i < 15; i += 1) logLines.push(`  File "/usr/lib/python3.11/site-packages/pkg/mod${i}.py", line ${100 + i}, in handler`)
logLines.push('ConnectionRefusedError: [Errno 111] Connection refused')
for (let i = 0; i < 300; i += 1) {
  logLines.push(`2026-09-09T11:${String(i % 60).padStart(2, '0')}:00Z INFO request served status=200 latency_ms=${20 + (i % 40)}`)
}
const logText = logLines.join('\n')
const logCompressor = new LogCompressor()
bench('log 10K-token', 50, () => {
  const result = logCompressor.compress(logText, 1)
  return 1 - Buffer.byteLength(result.compressed, 'utf8') / Buffer.byteLength(logText, 'utf8')
})

// ── 场景 2：100K token JSON 搜索结果（均匀对象数组） ─────────────────────
const searchItems = Array.from({ length: 2_000 }, (_, i) => ({
  path: `src/module${i % 40}/file${i}.ts`,
  line: 1 + (i % 500),
  snippet: `export function handler${i % 23}(input: string) { return input.length > ${i % 100} }`,
  score: 0.1 + (i % 90) / 100,
}))
const searchText = JSON.stringify(searchItems)
bench('json search 100K-token', 20, () => {
  const result = crushJson(searchText, SMART_CRUSHER_DEFAULTS, undefined)
  return 1 - Buffer.byteLength(result.output, 'utf8') / Buffer.byteLength(searchText, 'utf8')
})

// ── 场景 3：超长异构数组（触发有损采样） ────────────────────────────────
const noisyItems = Array.from({ length: 5_000 }, (_, i) => {
  const row: Record<string, unknown> = { id: i, ts: `2026-09-09T10:${String(i % 60).padStart(2, '0')}:00Z` }
  row[`metric_${i % 13}`] = `unique-${i}-${'v'.repeat(20)}`
  return row
})
const noisyText = JSON.stringify(noisyItems)
const noisyStore = new CcrStore()
bench('json lossy 5000-rows', 10, () => {
  const result = crushJson(noisyText, SMART_CRUSHER_DEFAULTS, noisyStore)
  return 1 - Buffer.byteLength(result.output, 'utf8') / Buffer.byteLength(noisyText, 'utf8')
})

console.log(`payloads: log=${(Buffer.byteLength(logText, 'utf8') / 1024).toFixed(0)}KB json=${(Buffer.byteLength(searchText, 'utf8') / 1024).toFixed(0)}KB noisy=${(Buffer.byteLength(noisyText, 'utf8') / 1024).toFixed(0)}KB`)

// ── 场景 4：grep/rg 输出（原版宣称 5-10×） ───────────────────────────────
const grepLines = Array.from({ length: 3_000 }, (_, i) => `src/pkg${i % 60}/module${Math.floor(i / 60)}.ts:${1 + (i % 400)}:export function handler${i % 30}(input: string) { return input.trim().length > ${(i % 50)} }`)
const grepText = grepLines.join('\n')
bench('search grep 3000-matches', 20, () => {
  const result = compressSearch(grepText, SEARCH_COMPRESSOR_DEFAULTS, undefined)
  return 1 - Buffer.byteLength(result.compressed, 'utf8') / Buffer.byteLength(grepText, 'utf8')
})

// ── 场景 5：git diff 输出 ──────────────────────────────────────────────────
const diffLines: string[] = []
for (let file = 0; file < 20; file += 1) {
  diffLines.push(`diff --git a/src/generated/file${file}.ts b/src/generated/file${file}.ts`, '--- a/src/generated/file.ts', '+++ b/src/generated/file.ts')
  for (let hunk = 0; hunk < 6; hunk += 1) {
    diffLines.push(`@@ -${10 + hunk * 60},40 +${10 + hunk * 60},41 @@`)
    for (let i = 0; i < 18; i += 1) diffLines.push(` unchanged context line ${i} in file ${file}`)
    diffLines.push(`-old implementation ${hunk}`)
    diffLines.push(`+new implementation ${hunk} with more detail`)
    for (let i = 0; i < 18; i += 1) diffLines.push(` trailing context ${i} of hunk ${hunk}`)
  }
}
const diffText = diffLines.join('\n')
bench('diff git 20-files', 20, () => {
  const result = compressDiff(diffText, DIFF_COMPRESSOR_DEFAULTS, undefined)
  return 1 - Buffer.byteLength(result.compressed, 'utf8') / Buffer.byteLength(diffText, 'utf8')
})

// ── 场景 6：长散文（生成的报告） ──────────────────────────────────────────
const proseText = Array.from({ length: 800 }, (_, i) =>
  i === 400
    ? 'Critical: the migration failed because the schema lock timed out after 30 seconds. '
    : `Paragraph ${i} of the generated report describes routine step ${i} of the deployment process with detail ${i}. `,
).join('')
bench('prose 800-sentences', 20, () => {
  const result = crushText(proseText, TEXT_CRUSHER_DEFAULTS, undefined)
  return 1 - Buffer.byteLength(result.compressed, 'utf8') / Buffer.byteLength(proseText, 'utf8')
})
