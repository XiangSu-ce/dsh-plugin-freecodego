/**
 * Durable, locally cancellable engineering jobs. Commands are never resumed
 * after a Host restart.
 *
 * Two registries cooperate here, and the split is deliberate:
 *
 * - The **Harness job registry** (`ctx.jobs`, provided by `dsh-jobs-local` in
 *   the base bundle) owns *live* verification runs. It gives the run a stable
 *   `<kind>-N` id, keeps it visible to the owning agent through the native
 *   `job_output` / `job_list` / `job_kill` tools, and delivers a completion
 *   notice into the session — none of which this plugin would get by rolling
 *   its own scheduler. The summary a run settles with is what `job_output`
 *   renders, so the owning agent reads the same text the settings surface shows.
 *   When `ctx.jobs` is absent (a composition without the
 *   implementation) verification degrades to awaiting the private store, so the
 *   feature never disappears outright.
 * - The **private SQLite store** owns the *audit trail*. It records what ran,
 *   when, and with which redacted summary, survives the process, and is what
 *   the settings surface reads. A job that was live when the Host restarted is
 *   reopened as `interrupted` rather than replayed.
 *
 * The native registry dies with the process, so it is an execution channel
 * only; durability assertions in this module always read the SQLite row.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-jobs
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freeCodeGoDataHome } from './data-home.ts'
import type { FreeCodeGoEngineeringJob, FreeCodeGoEngineeringVerificationResult, FreeCodeGoEngineeringVerificationStage } from './types.ts'
import { readWorkspaceChangeScope, runEngineeringVerification, type EngineeringVerificationProbe } from './engineering-quality.ts'
import { auditVerificationClaim } from './fake-green-audit.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import {
  ARCHITECTURAL_PATH_PATTERNS,
  SECURITY_PATH_PATTERNS,
  changeMetadataFromDiff,
  describeVerificationTier,
  selectVerificationTier,
  testCoverageFromChangedPaths,
  type VerificationTierPlan,
} from './verification-tier.ts'

/**
 * Native job-registry surface consumed by this module. Declared structurally
 * (rather than importing the abstract service) so a composition without a jobs
 * implementation still loads, and so tests can supply a minimal double.
 */
export interface NativeJobRegistry {
  start(spec: {
    readonly kind: string
    readonly label: string
    readonly owner?: Agent
    readonly outputLimitBytes?: number
    readonly run: () => {
      readonly cancel: (reason?: string) => void
      // `output` is the final-output channel for a job that has no `readOutput`,
      // and it is the only one this producer uses: the run has no stream, only a
      // summary written once at settlement. Declaring it here is what keeps the
      // seam honest about what the registry is asked to carry — an outcome field
      // the plugin fills but the seam omits is one a future reader would have to
      // rediscover from the implementation.
      readonly done: Promise<{ readonly status: 'completed' | 'killed' | 'failed'; readonly detail?: string; readonly output?: string }>
    }
  }): string
}

/**
 * Kind prefix used for native registrations (`engineering-N`).
 *
 * The registry documents `JobKindMap` declaration merging as the way plugins
 * claim a namespace. This plugin deliberately does not augment it: that would
 * require declaring `@deepseek-ai/dsh-jobs` as a dependency purely for a
 * type-only merge, widening the published dependency closure for no runtime
 * behaviour. The registry treats every kind value as an opaque id namespace, so
 * the structural {@link NativeJobRegistry} type carries the same guarantee at
 * the boundary that actually matters.
 */
const NATIVE_JOB_KIND = 'engineering'
/** Bound on each model-facing job output read, matching the audit summary cap. */
const NATIVE_JOB_OUTPUT_LIMIT_BYTES = 32 * 1024

type JobRow = {
  readonly id: string
  readonly project_id: string
  readonly kind: string
  readonly state: string
  readonly created_at: number
  readonly started_at?: number | null
  readonly finished_at?: number | null
  readonly summary?: string | null
  readonly verification_json?: string | null
}

/** How long a terminal audit row is kept. Exported so a caller can state the window it relies on. */
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
/**
 * Ceiling on retained rows, applied on open and on every new run.
 *
 * Each verification row can carry a ~16KB evidence blob, so the age window alone
 * leaves a heavy install's audit table large inside its window; the cap is what
 * bounds it. Exported because the bound is a claim about the table, and a test
 * that restates the number asserts on its own copy of it.
 */
export const MAX_RETAINED_JOBS = 2_000

/**
 * Runs explicit verification jobs. Persistent state is retained for audit, not replay.
 *
 * Graphify and code-graph builds are deliberately not jobs here: both track their
 * work in memory (`BuildTracker`), so `kind` has values for them that this class
 * never writes. {@link toJob} still has to be able to *name* such a row — see the
 * guard there.
 */
export class EngineeringVerificationJobs {
  private readonly databasePath: string
  private database: DatabaseSync | undefined
  private readonly active = new Map<string, AbortController>()
  private closing = false

  constructor(rootDirectory = defaultJobDirectory(), private readonly nativeJobs?: NativeJobRegistry) {
    this.databasePath = resolve(rootDirectory, 'engineering-jobs.sqlite')
  }

  async open(): Promise<void> {
    const root = dirname(this.databasePath)
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('engineering jobs directory must not be a symlink')
    const database = new DatabaseSync(this.databasePath)
    database.exec(`
      PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS engineering_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        summary TEXT,
        verification_json TEXT
      );
      CREATE INDEX IF NOT EXISTS engineering_jobs_project_time ON engineering_jobs(project_id, created_at DESC);
    `)
    // A child process cannot safely survive the owning Host. Keep its audit record,
    // but require an explicit new run rather than replaying commands after restart.
    database.prepare("UPDATE engineering_jobs SET state = 'interrupted', finished_at = ?, summary = COALESCE(summary, 'Host restarted before the job completed.') WHERE state IN ('queued', 'running')").run(Date.now())
    this.prune(database)
    this.database = database
    // Clear the shutdown latch, now that there is a database to write to.
    //
    // `close()` sets it so that a settlement write arriving after shutdown is
    // skipped instead of touching a closed handle, and the skip is sound *for
    // the rows that existed then*: the reopen below marks them `interrupted`.
    // Leaving it set was not: the next run starts with the store open, settles
    // while it is open, and `settleQuietly` still refused — the row stayed
    // `running` for good, and `awaitSettlement` waited on a state that could
    // never arrive instead of reporting why the run died. `reconcile()` closes
    // and reopens this store on every settings change and workspace switch, so
    // this is the ordinary path rather than a recovery one.
    this.closing = false
  }

  /**
   * Enforce the age window and the row ceiling.
   *
   * Called on open *and* on every start, because open happens once per process:
   * pruning only there meant a Host that stayed up for weeks never applied either
   * bound, while each new run kept adding a row that can carry a ~16KB evidence
   * blob. Two statements against a table this call just grew by one row, next to a
   * run that spawns a whole build, is not a cost worth a second schedule.
   *
   * Neither statement can reach a live run: the age window is thirty days against
   * runs that settle in minutes, and the ceiling keeps the newest rows, of which a
   * run just started is one.
   */
  private prune(database: DatabaseSync): void {
    database.prepare('DELETE FROM engineering_jobs WHERE created_at < ?').run(Date.now() - JOB_RETENTION_MS)
    database.prepare('DELETE FROM engineering_jobs WHERE id IN (SELECT id FROM engineering_jobs ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(MAX_RETAINED_JOBS)
  }

  close(): void {
    this.closing = true
    for (const controller of this.active.values()) controller.abort('engineering jobs closed')
    this.active.clear()
    this.database?.close()
    this.database = undefined
  }

  /** Start a durable audit row and begin executing the verification. */
  start(cwd: string, stages: readonly FreeCodeGoEngineeringVerificationStage[] | undefined, probes: readonly EngineeringVerificationProbe[] = []): FreeCodeGoEngineeringJob {
    const database = this.requireDatabase()
    const id = `job_${randomUUID().replaceAll('-', '')}`
    const createdAt = Date.now()
    const projectId = projectIdFor(cwd)
    database.prepare('INSERT INTO engineering_jobs(id, project_id, kind, state, created_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, 'verification', 'queued', createdAt)
    this.prune(database)
    const controller = new AbortController()
    this.active.set(id, controller)
    // close() can abort this job while the store shuts down; the settlement
    // writes then hit a closed database and must not crash the Host.
    void this.execute(id, cwd, stages, controller.signal, probes).catch(() => undefined)
    return { id, projectId, kind: 'verification', state: 'queued', createdAt }
  }

  /**
   * Await one job for Agent tools while preserving the same durable audit
   * record.
   *
   * When a native registry is present the run is registered there first, which
   * is what makes it visible to `job_list` and cancellable through `job_kill`.
   * The native id is only an execution handle — every durable read below still
   * goes through this store's own id.
   */
  async run(
    cwd: string,
    stages: readonly FreeCodeGoEngineeringVerificationStage[] | undefined,
    externalSignal?: AbortSignal,
    owner?: Agent,
    probes: readonly EngineeringVerificationProbe[] = [],
  ): Promise<FreeCodeGoEngineeringVerificationResult> {
    const job = this.start(cwd, stages, probes)
    const cancel = (): void => { this.cancel(job.id) }
    // An already-cancelled caller must not be made to wait out a multi-minute
    // build: a listener attached after the signal aborted never fires, so the
    // pre-check is the only thing that stops the work. Every other spawn path in
    // this plugin (and `runProcess` itself) guards the same way.
    if (externalSignal?.aborted === true) cancel()
    else externalSignal?.addEventListener('abort', cancel, { once: true })
    const unregister = this.registerNative(cwd, job, stages, owner, cancel)
    try {
      while (true) {
        const current = this.get(job.id)
        if (current.verification !== undefined) return current.verification
        // Exhaustive over the type, not over what this build happens to write —
        // the doctrine `toJob` states for this same column, and the list
        // `awaitSettlement` already uses. This loop named three of the four
        // terminal states, and the missing one was `completed`, the state a
        // *successful* run produces: a row that says `completed` without a
        // `verification_json` (a build whose shape differed, a settlement write
        // that lost the JSON) spun here forever at 100ms with no deadline, and
        // the caller was told nothing at all.
        if (current.state === 'cancelled' || current.state === 'interrupted' || current.state === 'failed' || current.state === 'completed') {
          return { id: `verify_${randomUUID().replaceAll('-', '')}`, checkedAt: Date.now(), stages: [{ id: 'scope', state: current.state === 'cancelled' ? 'cancelled' : 'unavailable', durationMs: 0, summary: current.summary ?? 'Verification did not complete.' }] }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally {
      externalSignal?.removeEventListener('abort', cancel)
      unregister()
    }
  }

  /**
   * Publish the run to the Harness job registry so the owning agent can list,
   * read, and kill it with the native tools. Best-effort in every direction: a
   * registry that rejects the start, or that is absent entirely, must not stop
   * verification from running — the audit row already exists by this point.
   *
   * @returns a disposer that retires any live native handle for this run.
   */
  private registerNative(
    cwd: string,
    job: FreeCodeGoEngineeringJob,
    stages: readonly FreeCodeGoEngineeringVerificationStage[] | undefined,
    owner: Agent | undefined,
    cancel: () => void,
  ): () => void {
    const registry = this.nativeJobs
    if (registry === undefined) return () => undefined
    let nativeId: string
    try {
      nativeId = registry.start({
        kind: NATIVE_JOB_KIND,
        // The label is written before execution, so a caller that named no stages
        // gets an honest "selected at run time" rather than a stage list the tier
        // has not chosen yet.
        label: `engineering verification (${stages === undefined ? 'tier-selected stages' : stages.join(', ')}) in ${cwd}`,
        outputLimitBytes: NATIVE_JOB_OUTPUT_LIMIT_BYTES,
        ...(owner === undefined ? {} : { owner }),
        run: () => ({
          cancel,
          // The durable row is the source of truth for settlement; this promise
          // only tells the registry when the run stopped, so it resolves from
          // the row rather than from the verification call itself.
          done: this.awaitSettlement(job.id),
        }),
      })
    } catch {
      // No controller attached, or the registry refused the registration.
      return () => undefined
    }
    if (nativeId === '') return () => undefined
    return () => { /* the registry retires the record on settlement */ }
  }

  /**
   * Resolve once the durable row reaches a terminal state. Never rejects.
   *
   * The row's outcome is its state *and* the summary it settled with, so both
   * travel. This value is what the native registry hands the owning agent, and a
   * settlement that carried only the state left `job_output` — the tool the module
   * header names as how that agent sees the run — rendering `(no new output)`
   * under a completion notice that says "Read its output with job_output." The
   * summary is where the fake-green audit reports scope drift, so the empty body
   * was the difference between the agent being told and not being told that the
   * verdict it is about to relay was measured against a different change.
   *
   * The summary is already capped at 1,000 characters by {@link redactJobSummary},
   * so it fits inside the `outputLimitBytes` the registration sets.
   */
  private async awaitSettlement(id: string): Promise<{ readonly status: 'completed' | 'killed' | 'failed'; readonly output?: string }> {
    while (true) {
      let job: FreeCodeGoEngineeringJob
      try {
        job = this.get(id)
      } catch {
        // The store closed under us; report the only honest outcome.
        return { status: 'failed' }
      }
      // Every terminal write sets a summary — the settlement UPDATE writes both
      // columns at once, and both cancel paths COALESCE a default in — so the
      // guard is for a store that closed between the read and this line, not for
      // a normal run.
      const settled = job.summary === undefined ? {} : { output: job.summary }
      if (job.state === 'completed') return { status: 'completed', ...settled }
      if (job.state === 'cancelled') return { status: 'killed', ...settled }
      if (job.state === 'failed' || job.state === 'interrupted') return { status: 'failed', ...settled }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  cancel(id: string): FreeCodeGoEngineeringJob {
    const controller = this.active.get(id)
    controller?.abort('cancelled by user')
    if (controller !== undefined) return this.get(id)
    const database = this.requireDatabase()
    const result = database.prepare("UPDATE engineering_jobs SET state = 'cancelled', finished_at = ?, summary = COALESCE(summary, 'Cancelled by user.') WHERE id = ? AND state = 'queued'").run(Date.now(), id)
    if (result.changes !== 1) return this.get(id)
    return this.get(id)
  }

  get(id: string): FreeCodeGoEngineeringJob {
    if (!/^job_[a-f0-9]{32}$/i.test(id)) throw new Error('engineering job id is invalid')
    const row = this.requireDatabase().prepare('SELECT id, project_id, kind, state, created_at, started_at, finished_at, summary, verification_json FROM engineering_jobs WHERE id = ?').get(id) as JobRow | undefined
    if (row === undefined) throw new Error('engineering job was not found')
    return toJob(row)
  }

  private async execute(id: string, cwd: string, stages: readonly FreeCodeGoEngineeringVerificationStage[] | undefined, signal: AbortSignal, probes: readonly EngineeringVerificationProbe[] = []): Promise<void> {
    const database = this.requireDatabase()
    database.prepare("UPDATE engineering_jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'").run(Date.now(), id)
    try {
      // When the caller names no stages, the tier decides them from the size and
      // shape of the change instead of a fixed default: a two-file fix should not
      // pay for a full pipeline, and a broad or security-relevant change should
      // not be checked like a small one. The plan travels into the summary,
      // because a verdict scoped to a tier means nothing once the scope is
      // dropped — "no failures" and "no failures among the checks we ran" are
      // different claims and only one of them is true here.
      const plan = stages === undefined ? await planVerificationTier(cwd, signal) : undefined
      const requested = stages ?? plan?.stages
      // The change scope the verdict is about to be measured against, captured
      // before the run rather than after it. The audit's headline case is that a
      // record can be about a *different* change than the workspace has now, and
      // a verification run is exactly where that happens: it takes time, and work
      // can land while it runs. Reading the scope once, afterwards, makes the two
      // path sets the same read and the comparison tautologically empty — which is
      // why the rule never fired here even though the summary below has always
      // claimed the verdict says nothing about work that landed during the run.
      const before = await readWorkspaceChangeScope(cwd, signal).catch(() => undefined)
      // The tier's probe floor travels with its stage list: a `thorough` scope
      // that ran one probe would otherwise pass at a breadth nobody established.
      const result = await runEngineeringVerification({ cwd, ...(requested === undefined ? {} : { stages: requested }), probes, signal, ...(plan === undefined ? {} : { minProbes: plan.expectedProbes }) })
      // Stage summaries carry raw command-output tails; redact them the same
      // way as failure summaries before anything reaches the audit record.
      const redacted = (summary: string): string => redactJobSummary(summary)
      const view: FreeCodeGoEngineeringVerificationResult = {
        id: `verify_${randomUUID().replaceAll('-', '')}`,
        checkedAt: Date.now(),
        stages: result.stages.map(stage => ({ ...stage, summary: redacted(stage.summary) })),
        probes: result.probes.map(entry => ({ ...entry, summary: redacted(entry.summary) })),
        verdict: result.verdict,
        unmet: result.unmet.map(redacted),
      }
      // What the verdict is *about*, asked again after the run: a verdict scoped
      // to the change the run saw says nothing about work that landed while it
      // was running, and nothing at all about a path no stage or probe named. The
      // audit cannot fail the job — the verdict owns that — so it is reported in
      // the summary instead, which is the one place both readers look before
      // trusting a green: the settings surface renders that column, and
      // `awaitSettlement` hands the same string to the native job registry, so
      // `job_output` on this run carries it to the owning agent.
      const audited = await readWorkspaceChangeScope(cwd, signal).catch(() => undefined)
      // An unreadable workspace means no audit, not a clean one: the summary says
      // nothing rather than implying the claim was checked and held.
      const audit = audited === undefined
        ? undefined
        : auditVerificationClaim({
            verification: view,
            // Absent when the scope could not be read before the run: the audit
            // then reports the comparison as unstated rather than assuming the
            // sets match, which is the difference between "no drift" and "nobody
            // looked".
            ...(before === undefined ? {} : { verifiedPaths: before.changedPaths }),
            changedPaths: audited.changedPaths,
          })
      const auditNote = audit === undefined || audit.holds || audit.findings.length === 0
        ? ''
        : ` ${audit.findings.filter(finding => finding.severity === 'high' || finding.severity === 'critical').slice(0, 2).map(finding => finding.message).join(' ')}`
      const cancelled = result.verdict === 'unverified' && (result.stages.some(stage => stage.state === 'cancelled') || result.probes.some(entry => entry.state === 'cancelled')) || signal.aborted
      // The verdict, not a re-derived per-stage scan, decides the job state: a
      // run whose probes were refused or never offered is not a clean pass.
      const failed = result.verdict === 'failed'
      const outcome = cancelled
        ? 'Verification cancelled.'
        : failed
          ? `Verification failed: ${result.unmet.slice(0, 3).join(' ')}`.trim()
          : result.verdict === 'unverified'
            ? `Verification is not confirmed: ${result.unmet.slice(0, 3).join(' ')}`.trim()
            : 'Verification passed with a falsifiable probe.'
      const summary = `${plan === undefined ? outcome : `${outcome} ${describeVerificationTier(plan)}.`}${auditNote}`
      database.prepare('UPDATE engineering_jobs SET state = ?, finished_at = ?, summary = ?, verification_json = ? WHERE id = ?').run(cancelled ? 'cancelled' : failed ? 'failed' : 'completed', Date.now(), redacted(summary), JSON.stringify(view), id)
    } catch (error) {
      // Job summaries are rendered in the settings UI; raw command output can
      // carry secrets or provider credentials, so it is redacted before it is
      // persisted, and bounded the same way the media detail path is.
      const rawMessage = signal.aborted ? 'Verification cancelled.' : error instanceof Error ? error.message : String(error)
      // A store close() between the abort and this settlement write lands here
      // with the database already closed; swallow it so the floating promise
      // this method is awaited by never becomes an unhandled rejection that
      // would terminate the Host.
      this.settleQuietly(database, () => database.prepare('UPDATE engineering_jobs SET state = ?, finished_at = ?, summary = ? WHERE id = ?').run(signal.aborted ? 'cancelled' : 'failed', Date.now(), redactJobSummary(rawMessage), id))
    } finally {
      this.active.delete(id)
    }
  }

  /** Run the settlement write without letting a closed/failed store crash the Host. */
  private settleQuietly(database: DatabaseSync, write: () => void): void {
    try {
      if (this.closing || this.database !== database) {
        // The store shut down before settlement; the reopen path marks stale
        // running rows interrupted, so there is nothing further to do here.
        return
      }
      write()
    } catch {
      // Settlement is best-effort: losing the terminal row state must never
      // surface as an unhandled rejection from a fire-and-forget job.
    }
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error('engineering job store is not open')
    return this.database
  }
}

/**
 * Choose a verification tier from what the workspace actually changed.
 *
 * `undefined` when git cannot report the change: an unreadable diff must leave
 * the caller's own stages in place rather than select a tier from a guess. The
 * coverage figure is the path-list proxy, so a change that touches no test file
 * can never reach the light tier no matter how small it is.
 */
async function planVerificationTier(cwd: string, signal: AbortSignal): Promise<VerificationTierPlan | undefined> {
  const scope = await readWorkspaceChangeScope(cwd, signal)
  if (scope === undefined) return undefined
  return selectVerificationTier(changeMetadataFromDiff({
    changedPaths: scope.changedPaths,
    linesChanged: scope.linesChanged,
    testCoverage: testCoverageFromChangedPaths(scope.changedPaths),
    securityPaths: SECURITY_PATH_PATTERNS,
    architecturalPaths: ARCHITECTURAL_PATH_PATTERNS,
  }))
}

function toJob(row: JobRow): FreeCodeGoEngineeringJob {
  const verification = parseVerification(row.verification_json)
  const state = row.state === 'queued' || row.state === 'running' || row.state === 'completed' || row.state === 'cancelled' || row.state === 'interrupted' || row.state === 'failed' ? row.state : 'failed'
  // Exhaustive over the type, not over what this build happens to write. The
  // table has no CHECK constraint on `kind` and the file outlives the build that
  // wrote it, so a row can name a kind with no producer here — and folding those
  // into `'verification'` would not lose the name, it would substitute a
  // different and more specific one, because `verification` is the kind whose
  // rows carry a verdict. The guard named two of the type's four members, so
  // `council` was silently renamed while `graph-build` and `graph-update` were
  // kept. `state`, directly above, already reads this way.
  const kind = row.kind === 'verification' || row.kind === 'graph-build' || row.kind === 'graph-update' || row.kind === 'council' ? row.kind : 'verification'
  return {
    id: row.id,
    projectId: row.project_id,
    kind,
    state,
    createdAt: row.created_at,
    ...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
    ...(typeof row.finished_at === 'number' ? { finishedAt: row.finished_at } : {}),
    ...(typeof row.summary === 'string' && row.summary !== '' ? { summary: row.summary } : {}),
    ...(verification === undefined ? {} : { verification }),
  }
}

function parseVerification(value: unknown): FreeCodeGoEngineeringVerificationResult | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.checkedAt !== 'number' || !Array.isArray(record.stages)) return undefined
    return record as unknown as FreeCodeGoEngineeringVerificationResult
  } catch { return undefined }
}

function defaultJobDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'jobs')
}

function projectIdFor(cwd: string): string {
  const normalized = resolve(cwd).replaceAll('\\', '/').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

/** Strip credentials and collapse command noise before a job summary is persisted. */
function redactJobSummary(value: string): string {
  // Curated shapes first: a job summary quotes command output, which is exactly
  // where a pasted token with a vendor prefix turns up.
  return redactCredentialShapes(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|key|token)[-_][a-z0-9._-]{12,}\b/gi, '<redacted>')
    .replace(/\b(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)\S+/gi, '$1$2<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1_000)
}
