import { mkdtemp, mkdir, readFile, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRepoMap, extractDefinitions, pagerank } from '../src/engineering-repo-map.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('engineering repo map', () => {
  it('extracts function, class, and method definitions from TypeScript', () => {
    const content = [
      'export class Service {',
      '  private ready = false',
      '  async start(port: number): Promise<void> {',
      '    this.listen(port)',
      '  }',
      '  listen(port: number) {}',
      '}',
      'export function createService(): Service {',
      '  return new Service()',
      '}',
      'export type Handler = (port: number) => void',
    ].join('\n')
    const identifiers = extractDefinitions(content, '.ts').map(definition => definition.identifier)
    expect(identifiers).toContain('Service')
    expect(identifiers).toContain('createService')
    expect(identifiers).toContain('Handler')
    expect(identifiers).toContain('start')
  })

  it('ranks the most-referenced definition highest via pagerank', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'hub.ts'), 'export function hubCore(): number { return 1 }\nexport function lonely(): number { return 2 }\n', 'utf8')
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, 'src', `consumer${index}.ts`), `import { hubCore } from "./hub"\nexport const value${index} = hubCore()\n`, 'utf8')
    }
    const result = buildRepoMap({ cwd: root, maxTokens: 1_024 })
    expect(result.filesScanned).toBe(5)
    const hub = result.map.find(entry => entry.identifier === 'hubCore')
    const lonely = result.map.find(entry => entry.identifier === 'lonely')
    expect(hub).toBeDefined()
    expect(lonely).toBeDefined()
    expect(hub!.rank).toBeGreaterThan(lonely!.rank)
    expect(hub!.references).toBeGreaterThanOrEqual(4)
  })

  it('counts an identifier\'s references as the total across every scanned file', async () => {
    // The rendered `references` field is a per-identifier total. It is summed
    // once now (deriving it per definition made the map quadratic — ~3.5s on a
    // 1.5k-file repository), so this pins the totals the optimization must keep
    // reproducing. The total counts every occurrence in every scanned file,
    // including a second occurrence inside one file and the definition's own
    // line: 3 call sites plus the declaration itself.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-refs-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'hub.ts'), 'export function hubCore(): number { return 1 }\n', 'utf8')
    await writeFile(join(root, 'src', 'one.ts'), 'export const a = hubCore()\nexport const b = hubCore()\n', 'utf8')
    await writeFile(join(root, 'src', 'two.ts'), 'export const c = hubCore()\n', 'utf8')
    const result = buildRepoMap({ cwd: root, maxTokens: 8_192 })
    const hub = result.map.find(entry => entry.identifier === 'hubCore')
    expect(hub?.references).toBe(4)
  })

  it('respects the token budget and reports truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    for (let index = 0; index < 60; index += 1) {
      await writeFile(join(root, 'src', `mod${index}.ts`), `export function feature${index}(alpha: string, beta: number): string { return alpha + beta }\n`, 'utf8')
    }
    const result = buildRepoMap({ cwd: root, maxTokens: 256 })
    expect(result.tokensEstimate).toBeLessThanOrEqual(256)
    expect(result.truncated).toBe(true)
    expect(result.map.length).toBeGreaterThan(0)
    // A generous budget renders everything without truncation.
    const full = buildRepoMap({ cwd: root, maxTokens: 8_192 })
    expect(full.truncated).toBe(false)
    expect(full.map.length).toBe(60)
  })

  it('boosts focused files in the ranking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export function shared(): number { return 1 }\n', 'utf8')
    await writeFile(join(root, 'src', 'b.ts'), 'import { shared } from "./a"\nexport const used = shared()\n', 'utf8')
    const focused = buildRepoMap({ cwd: root, maxTokens: 1_024, focusFiles: ['src/b.ts'] })
    const entry = focused.map.find(candidate => candidate.identifier === 'shared')
    expect(entry).toBeDefined()
    // The rank itself is not asserted absolutely; the boost path must execute.
    expect(focused.map.length).toBeGreaterThan(0)
  })

  it('boosts a focused file however the caller spells its path', async () => {
    // The boost is invisible when it does not apply: a map that ignored
    // `focus_files` entirely is byte-identical to a map whose ranking simply did
    // not move, so nothing but an asserted multiplier catches it. The entry
    // watched here is the one *defined* in the focused file, because that is the
    // file the multiplier is keyed on.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-focus-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export function shared(): number { return 1 }\n', 'utf8')
    await writeFile(join(root, 'src', 'b.ts'), 'import { shared } from "./a"\nexport const used = shared()\n', 'utf8')
    const plain = buildRepoMap({ cwd: root, maxTokens: 1_024 })
    const baseline = plain.map.find(entry => entry.identifier === 'used')
    expect(baseline).toBeDefined()
    expect(baseline!.rank).toBeGreaterThan(0)
    // A leading `./`, an absolute path and Windows separators all name the same
    // file, and all three are what a caller types. The bare relative spelling is
    // the control: it is the one form the raw comparison already matched.
    for (const spelling of ['src/b.ts', './src/b.ts', join(root, 'src', 'b.ts'), 'src\\b.ts']) {
      const focused = buildRepoMap({ cwd: root, maxTokens: 1_024, focusFiles: [spelling] })
      const entry = focused.map.find(candidate => candidate.identifier === 'used')
      expect(entry, `\`${spelling}\` did not reach the entry`).toBeDefined()
      expect(entry!.rank / baseline!.rank, `\`${spelling}\` did not boost the ranking`).toBeCloseTo(4, 8)
    }
  })

  it('pagerank distributes mass over a simple cycle', () => {
    const edges = new Map<string, Map<string, number>>([
      ['a', new Map([['b', 1]])],
      ['b', new Map([['c', 1]])],
      ['c', new Map([['a', 1]])],
    ])
    const rank = pagerank(['a', 'b', 'c'], edges, 0.85, 30)
    for (const node of ['a', 'b', 'c']) {
      expect(rank.get(node)).toBeGreaterThan(0.3)
      expect(rank.get(node)).toBeLessThan(0.4)
    }
  })

  it('prefers the arrow-function reading over the generic const reading', () => {
    // Ordering is load-bearing: the arrow rule must win, or the signature is lost.
    const [definition] = extractDefinitions('export const handler = (event: string) => event', '.ts')
    expect(definition?.identifier).toBe('handler')
    expect(definition?.kind).toBe('function')
    expect(definition?.signature).toBe('export const handler = (event: string) => event')
  })

  it('admits a class constructor as a rankable member', () => {
    const content = ['export class Service {', '  constructor(private readonly port: number) {}', '}'].join('\n')
    const definition = extractDefinitions(content, '.ts').find(candidate => candidate.identifier === 'constructor')
    expect(definition?.kind).toBe('method')
  })

  it('extracts one definition per supported language family', () => {
    const samples: readonly (readonly [string, string, string])[] = [
      ['.py', 'async def fetch_rows(limit: int) -> list:', 'fetch_rows'],
      ['.go', 'func (r *Repo) Save(ctx context.Context) error {', 'Save'],
      ['.go', 'func NewRepo() *Repo {', 'NewRepo'],
      ['.rs', '    pub async fn commit(&self) -> Result<()> {', 'commit'],
      ['.kt', '    suspend fun load(id: String): User {', 'load'],
      ['.scala', '  def parse(input: String): Either[Error, Ast] =', 'parse'],
      ['.cpp', 'int main(int argc, char** argv) {', 'main'],
      ['.cpp', 'class Renderer {', 'Renderer'],
      ['.cs', '    public async Task<Order> SubmitAsync(Order order) {', 'SubmitAsync'],
      ['.swift', '    func apply(to view: UIView) {', 'apply'],
      ['.rb', '  def serialize(options = {})', 'serialize'],
      ['.php', '  public function handle(Request $request): Response', 'handle'],
      ['.lua', 'local function build_router(routes)', 'build_router'],
      ['.r', 'summarise_records <- function(frame) {', 'summarise_records'],
      ['.jl', 'function gradient_descent(f, x0)', 'gradient_descent'],
      ['.pl', 'sub parse_header {', 'parse_header'],
      ['.ex', '  defp validate(changeset) do', 'validate'],
      ['.erl', 'handle_call(Request, _From, State) ->', 'handle_call'],
      ['.dart', '  Future<User> loadProfile(String id) async {', 'loadProfile'],
      ['.zig', 'pub fn deinit(self: *Session) void {', 'deinit'],
      ['.proto', 'message OrderRequest {', 'OrderRequest'],
      ['.proto', '  rpc CreateOrder(OrderRequest) returns (OrderReply);', 'CreateOrder'],
      ['.graphql', 'type Query {', 'Query'],
      ['.sh', 'cleanup_tmpdir() {', 'cleanup_tmpdir'],
    ]
    for (const [extension, line, expected] of samples) {
      const identifiers = extractDefinitions(line, extension).map(definition => definition.identifier)
      expect(identifiers, `${extension} should define ${expected}`).toContain(expected)
    }
  })

  it('records a SQL routine under its qualified name', () => {
    const [definition] = extractDefinitions('CREATE OR REPLACE FUNCTION public.recalc_totals() RETURNS void AS $$', '.sql')
    expect(definition?.identifier).toBe('public.recalc_totals')
    expect(definition?.kind).toBe('definition')
  })

  it('reads a Terraform resource by its name rather than its type', () => {
    const [definition] = extractDefinitions('resource "aws_instance" "web" {', '.tf')
    expect(definition?.identifier).toBe('web')
  })

  it('never reports a control-flow keyword as a definition', () => {
    const content = ['if (ready) {', '  for (const item of items) {', '    while (item) {'].join('\n')
    const identifiers = extractDefinitions(content, '.ts').map(definition => definition.identifier)
    expect(identifiers).not.toContain('if')
    expect(identifiers).not.toContain('for')
    expect(identifiers).not.toContain('while')
  })

  it('ignores hash, dash, and percent comment lines', () => {
    const content = ['# def commented_out(x)', '-- function shadowed()', '% local function alsoShadowed()'].join('\n')
    expect(extractDefinitions(content, '.py')).toHaveLength(0)
    expect(extractDefinitions(content, '.lua')).toHaveLength(0)
  })

  it('returns nothing for an unsupported extension', () => {
    expect(extractDefinitions('export function nope() {}', '.txt')).toHaveLength(0)
  })

  it('discards a cache written by an older extractor generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-cache-'))
    directories.push(root)
    await mkdir(join(root, '.freecodego'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export function currentSurface(): number { return 1 }\n', 'utf8')
    // A v1 payload holding a definition the current extractor would not produce.
    await writeFile(join(root, '.freecodego', 'repo-map-cache.json'), JSON.stringify({
      'src/a.ts': { m: [0, 0], d: [['ghostFromV1', 'function', 'ghostFromV1()']], r: [] },
    }), 'utf8')
    const result = buildRepoMap({ cwd: root, maxTokens: 1_024 })
    const identifiers = result.map.map(entry => entry.identifier)
    expect(identifiers).not.toContain('ghostFromV1')
    expect(identifiers).toContain('currentSurface')
    // The old payload is replaced, not merely ignored: leaving it on disk means
    // every later build of this workspace re-extracts all of it, forever.
    const repaired = JSON.parse(await readFile(join(root, '.freecodego', 'repo-map-cache.json'), 'utf8')) as { readonly files?: Record<string, unknown> }
    expect(repaired.files?.['src/a.ts']).toBeDefined()
    expect(JSON.stringify(repaired)).not.toContain('ghostFromV1')
  })

  it('never promotes an unparseable cache by writing this run over it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-corrupt-'))
    directories.push(root)
    await mkdir(join(root, '.freecodego'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export function currentSurface(): number { return 1 }\n', 'utf8')
    // A half-written payload from a killed process: what survived is not the
    // whole map, so the file is left as the evidence it is.
    const truncated = '{"v":2,"files":{"src/a.ts":{"m":[0,0],"d":[["partial","function","partial()"]]'
    await writeFile(join(root, '.freecodego', 'repo-map-cache.json'), truncated, 'utf8')
    const result = buildRepoMap({ cwd: root, maxTokens: 1_024 })
    expect(result.map.map(entry => entry.identifier)).toContain('currentSurface')
    expect(await readFile(join(root, '.freecodego', 'repo-map-cache.json'), 'utf8')).toBe(truncated)
  })

  it('scans a file the walk accepted, however large that file is', async () => {
    // The shape this was found on is this package's own `src/index.ts`, its largest
    // module: the walk accepted it and a second, lower extraction cap refused it, so
    // nothing read it and the map looked like the whole workspace without it. A
    // per-file cap below the walk's own buys no protection — the walk's total-bytes
    // cap already bounds the work — and costs exactly the modules a reader wants.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-large-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'big.ts'), `export function bigSurface(): number { return 1 }\n// ${'x'.repeat(300_000)}\n`, 'utf8')
    await writeFile(join(root, 'src', 'small.ts'), 'export function smallSurface(): number { return 1 }\n', 'utf8')
    const result = buildRepoMap({ cwd: root, maxTokens: 4_096, useCache: false })
    expect(result.filesScanned).toBe(2)
    expect(result.map.map(entry => entry.identifier)).toContain('bigSurface')
    expect(result.unscanned).toMatchObject({ oversized: 0, unreadable: 0, unreached: false })
  })

  it('counts and names a file it refuses for size, instead of only leaving it out', async () => {
    // The refusal is fine; the silence was not. A map cannot both omit a file and be
    // the caller's picture of the workspace, so the omission is part of the answer.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-oversized-'))
    directories.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'huge.ts'), `export function hugeSurface(): number { return 1 }\n${'// y\n'.repeat(120_000)}`, 'utf8')
    await writeFile(join(root, 'src', 'small.ts'), 'export function smallSurface(): number { return 1 }\n', 'utf8')
    const result = buildRepoMap({ cwd: root, maxTokens: 4_096, useCache: false })
    expect(result.unscanned.oversized).toBe(1)
    expect(result.unscanned.examples).toEqual(['src/huge.ts'])
    expect(result.filesScanned).toBe(1)
    expect(result.map.map(entry => entry.identifier)).not.toContain('hugeSurface')
  })

  it('says when a walk cap ended the enumeration', async () => {
    // The sharper omission: everything the walk never reached is not a file it can
    // count. Two oversized directories are the deterministic fixture — the root pushes
    // both before either is popped, so whichever is scanned first crosses the byte cap
    // with the other still waiting, which is true of no single-directory layout.
    // `truncate` gives each file its size without writing its bytes.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-repo-map-unreached-'))
    directories.push(root)
    for (const directory of ['alpha', 'beta']) {
      await mkdir(join(root, directory), { recursive: true })
      for (let index = 0; index < 101; index += 1) {
        const file = join(root, directory, `f${String(index)}.ts`)
        await writeFile(file, '', 'utf8')
        await truncate(file, 500_000)
      }
    }
    const result = buildRepoMap({ cwd: root, maxTokens: 1_024, useCache: false })
    expect(result.unscanned.unreached).toBe(true)
    expect(result.filesScanned).toBeLessThan(202)
    expect(result.unscanned.oversized).toBe(0)
  })
})
