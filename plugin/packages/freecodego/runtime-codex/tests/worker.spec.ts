import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cwd, env as processEnv, execPath } from 'node:process'
import { describe, expect, it, vi } from 'vitest'

const fakeServer = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialized')continue;let result={};if(m.method==='thread/start')result={thread:{id:'thread-1'}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')}})"

// The fake App Server echoes the approval response it received back as the
// assistant message, so the text a test asserts on *is* the response the worker
// sent — the one place the approval contract is visible from the outside.
const interactiveServer = "process.stdin.setEncoding('utf8');let b='';let turn=0;const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialized')continue;if(m.method==='initialize'){out({id:m.id,result:{}});continue}if(m.method==='thread/start'){out({id:m.id,result:{thread:{id:'thread-interactive'}}});continue}if(m.method==='thread/resume'){out({id:m.id,result:{thread:{id:'thread-interactive'}}});continue}if(m.method==='turn/start'){turn++;out({id:m.id,result:{turn:{id:'turn-'+turn,items:[],status:'inProgress'}}});out({id:9000+turn,method:'item/commandExecution/requestApproval',params:{command:'echo test'}});continue}if(m.id>=9001&&m.result){const text=JSON.stringify(m.result);out({method:'item/agentMessage/delta',params:{delta:text}});out({method:'item/completed',params:{item:{type:'agentMessage',text}}});continue}if(m.method==='turn/interrupt'){out({method:'fixture/turnInterrupt',params:{threadId:m.params.threadId,turnId:m.params.turnId}});out({id:m.id,result:{}});out({method:'turn/completed',params:{turn:{status:'interrupted'}}});continue}out({id:m.id,result:{}})}})"
// Emits the App Server's real user-input request — the method name and params
// `ToolRequestUserInputParams.json` declares — and echoes the response the worker
// sends back as the assistant message. The echoed text therefore *is* the payload
// the App Server would have to deserialize, which is the only place the question
// contract is visible from the outside: an earlier version of this stub used an
// invented method name and ignored the response, so a shape the published schema
// rejects passed here unnoticed.
const questionServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
const questions = ids => ids.map(id => ({ header: 'Scope', id, question: 'Which ' + id + '?', options: [{ label: 'small', description: 'small scope' }] }))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-question' } } }); continue }
    if (m.method === 'turn/start') {
      out({ id: m.id, result: {} })
      out({ id: 88, method: 'item/tool/requestUserInput', params: { isBlocking: true, itemId: 'item-1', threadId: 'thread-question', turnId: 'turn-1', questions: questions(['scope']) } })
      continue
    }
    if (m.id === 88) {
      const text = JSON.stringify(m.error === undefined ? m.result : { error: m.error })
      out({ method: 'item/agentMessage/delta', params: { delta: text } })
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } })
      out({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
// The same request with more questions than the Claude SDK's tool schema allows.
// `ToolRequestUserInputParams.questions` declares no `maxItems`, so the count is
// the App Server's business and this transport must not invent a ceiling: a
// refused request becomes a -32601 that names a feature the worker implements.
const manyQuestionsServer = questionServer.replace("questions(['scope'])", "questions(['a', 'b', 'c', 'd', 'e'])")
// Echoes the routing fields the worker put on the wire, together with the
// thread-level provider the thread was opened with. Every provider field is
// reported with an explicit presence flag, because `JSON.stringify` drops an
// `undefined` key: without one, "sent as undefined" and "never sent" are
// indistinguishable, and the two provider fields live on different methods.
const routingServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
const seen = x => x === undefined ? null : x
let threadStart = null
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') {
      threadStart = {
        hasModelProvider: Object.prototype.hasOwnProperty.call(m.params, 'modelProvider'),
        modelProvider: seen(m.params.modelProvider),
        model: seen(m.params.model),
        hasEphemeral: Object.prototype.hasOwnProperty.call(m.params, 'ephemeral'),
        ephemeral: seen(m.params.ephemeral),
      }
      out({ id: m.id, result: { thread: { id: 'thread-routing' } } })
      continue
    }
    if (m.method === 'turn/start') {
      const text = JSON.stringify({
        model: seen(m.params.model),
        hasModelProvider: Object.prototype.hasOwnProperty.call(m.params, 'modelProvider'),
        modelProvider: seen(m.params.modelProvider),
        effort: seen(m.params.effort),
        threadStart,
      })
      out({ id: m.id, result: {} })
      out({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'reason-' + m.params.effort } })
      out({ method: 'item/completed', params: { item: { type: 'reasoning', summary: [{ text: 'reason-' + m.params.effort }] } } })
      out({ method: 'item/agentMessage/delta', params: { delta: text } })
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } })
      out({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
// Answers both kinds of server request in one turn and echoes what the worker
// sent back, so a test can read the two responses side by side: a protocol
// handshake (`attestation/generate`) that must not become a user prompt, and a
// permission escalation that must be answered with the profile it asked for.
const serverRequestShapes = `
const seen = {}
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-shapes' } } }); continue }
    if (m.method === 'turn/start') {
      out({ id: m.id, result: {} })
      out({ id: 9300, method: 'attestation/generate', params: {} })
      out({ id: 9301, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/work/out' } }] } } } })
      continue
    }
    if (m.id === 9300 || m.id === 9301) {
      seen[m.id] = m.error === undefined ? { result: m.result } : { error: m.error }
      if (seen[9300] !== undefined && seen[9301] !== undefined) {
        out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify(seen) } } })
        out({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      }
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`

// Echoes the two thread sandbox fields back through the returned thread id, so a
// test reads the values the worker actually put on the wire rather than the ones
// it meant to. `undefined` comes back as null, so "left to the engine's default"
// is distinguishable from "sent as a value".
const threadSandboxEcho = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'thread/start' || m.method === 'thread/resume') {
      out({ id: m.id, result: { thread: { id: JSON.stringify({ sandbox: m.params.sandbox === undefined ? null : m.params.sandbox, approvalPolicy: m.params.approvalPolicy === undefined ? null : m.params.approvalPolicy }) } } })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`

// Records the `turn/interrupt` the worker sends and echoes it back through a
// notification the worker forwards verbatim, so a test reads the params that
// actually went on the wire. `refusal` makes the App Server answer the way it
// does when the turn cannot be interrupted — a different outcome from a cancel.
const cancelEcho = (refusal: boolean): string => `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-cancel' } } }); continue }
    if (m.method === 'turn/start') { out({ id: m.id, result: { turn: { id: 'turn-77', items: [], status: 'inProgress' } } }); continue }
    if (m.method === 'turn/interrupt') {
      const p = m.params === undefined ? {} : m.params
      out({ method: 'fixture/turnInterrupt', params: { threadId: p.threadId === undefined ? null : p.threadId, turnId: p.turnId === undefined ? null : p.turnId } })
      if (${String(refusal)}) { out({ id: m.id, error: { code: -32000, message: 'turn is not interruptible' } }); continue }
      out({ id: m.id, result: {} })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`

// Records how the worker stopped it. An orderly stop closes stdin, and the
// App Server sees `end`; a forced tree kill cannot run this handler at all, so
// the marker file existing is the whole difference between the two endings.
// That matters because the App Server flushes the thread rollout on its way
// out: force-killing it leaves the rollout at 0 bytes, and the conversation the
// Host holds a thread id for can then never be reopened.
const disposeWitness = (marker: string): string => `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'eof')
  process.exit(0)
})
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-dispose' } } }); continue }
    out({ id: m.id, result: {} })
  }
})
`
// Reports a turn the App Server could not finish, in the shape it publishes:
// `turn/completed` carrying `status: 'failed'` with `turn.error` beside it.
// That reason is the only one the protocol offers -- there is no `turn/failed`
// notification to read it from -- so relaying it is the whole of what the
// worker can do for a failed turn. The message also quotes this process's own
// provider key, which the worker has to strip before the Host sees it.
const failureServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-failure' } } }); continue }
    if (m.method === 'turn/start') {
      out({ id: m.id, result: { turn: { id: 'turn-failure', status: 'inProgress' } } })
      const key = process.env.OPENAI_API_KEY ?? ''
      out({
        method: 'turn/completed',
        params: { threadId: 'thread-failure', turn: { id: 'turn-failure', status: 'failed', error: {
          message: 'stream closed while authorizing ' + key,
          additionalDetails: 'request timed out',
        } } },
      })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
// Accepts `turn/start` and then goes silent. The worker used to disarm its
// watchdog on that first acknowledgement, so a hung-but-alive App Server after
// the first frame left the Host waiting forever. Echoing `turn/interrupt` is
// how this stub proves the watchdog also stopped the generation it gave up on.
const silentAfterStartServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-silent' } } }); continue }
    if (m.method === 'turn/start') {
      out({ id: m.id, result: { turn: { id: 'turn-silent', status: 'inProgress' } } })
      continue
    }
    if (m.method === 'turn/interrupt') {
      out({ method: 'fixture/turnInterrupt', params: { threadId: m.params.threadId, turnId: m.params.turnId } })
      out({ id: m.id, result: {} })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
// Emits a delta, then completes, each after a gap shorter than the idle
// window. A watchdog that is an absolute budget from `turn/start` would kill
// this turn; an idle window that resets on every frame must not.
const healthySlowServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
const gap = Number(process.env.FREECODEGO_CODEX_TURN_IDLE_MS || 0) * 0.6
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-slow' } } }); continue }
    if (m.method === 'turn/start') {
      out({ id: m.id, result: { turn: { id: 'turn-slow', status: 'inProgress' } } })
      setTimeout(() => {
        out({ method: 'item/agentMessage/delta', params: { delta: 'still generating' } })
        setTimeout(() => {
          out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'still generating' } } })
          out({ method: 'turn/completed', params: { turn: { id: 'turn-slow', status: 'completed' } } })
        }, gap)
      }, gap)
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
// A cancel is the one path that stops the watchdog and then keeps working: the
// `turn/interrupt` round trip is awaited with `turnId` still set, because the
// request has to name the turn. A frame arriving inside that round trip is
// liveness by the idle rule, so it re-arms the timer — for a turn the worker is
// about to report as cancelled. Emitting a trailing delta before acknowledging
// the interrupt is what cancelling a *streaming* turn actually looks like.
const cancelRaceServer = `
const out = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10))
let b = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  b += c
  for (;;) {
    const i = b.indexOf(String.fromCharCode(10))
    if (i < 0) break
    const m = JSON.parse(b.slice(0, i))
    b = b.slice(i + 1)
    if (m.method === 'initialized') continue
    if (m.method === 'initialize') { out({ id: m.id, result: {} }); continue }
    if (m.method === 'thread/start') { out({ id: m.id, result: { thread: { id: 'thread-cancel-race' } } }); continue }
    if (m.method === 'turn/start') { out({ id: m.id, result: { turn: { id: 'turn-cancel-race', status: 'inProgress' } } }); continue }
    if (m.method === 'turn/interrupt') {
      out({ method: 'item/agentMessage/delta', params: { delta: 'still streaming' } })
      out({ id: m.id, result: {} })
      continue
    }
    out({ id: m.id, result: {} })
  }
})
`
const workerArgs = ['--import', 'tsx/esm', 'packages/freecodego/runtime-codex/src/worker.ts']

/** The checkout every stub App Server and session in this file runs against. */
const TEST_WORKSPACE = cwd()

/** One frame on the worker's stdout: a Host acknowledgement, or a worker event. */
interface WorkerFrame {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
}

/** One worker process talking to a stub App Server, with its frames collected. */
interface WorkerHarness {
  /** Write one Host→worker frame. */
  readonly send: (frame: unknown) => void
  /** Resolve with the first frame matching `predicate`, running `action` first. */
  readonly waitFor: (predicate: (frame: WorkerFrame) => boolean, action?: () => void) => Promise<WorkerFrame>
  /**
   * Every frame received so far, in order.
   *
   * A protocol fix often has to prove a request was *not* sent, and "no frame
   * arrived" is not something `waitFor` can express.
   */
  readonly frames: readonly WorkerFrame[]
}

/**
 * Read one nested field out of a parsed frame.
 *
 * The frames are `JSON.parse` output, so every field is `unknown` until it is
 * checked; reading through one function keeps the assertions from turning into
 * chains of unsafe member access on `any`.
 */
function field(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Spawn one worker against `stub`, run `body`, and always kill the child.
 *
 * `env` is applied over the baseline environment, so a case that turns on one
 * bridge flag does not have to restate the whole spawn.
 */
async function withWorker(
  stub: string,
  body: (harness: WorkerHarness) => Promise<void>,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  // The `stdio` triple is a literal, so `spawn` resolves to the overload whose
  // child has all three streams typed.
  const child = spawn(execPath, workerArgs, {
    cwd: TEST_WORKSPACE,
    env: {
      PATH: processEnv.PATH ?? '',
      FREECODEGO_CODEX_APP_SERVER: execPath,
      FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', stub].join('\u001f'),
      FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: WorkerFrame[] = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line !== '') frames.push(JSON.parse(line) as WorkerFrame)
    }
  })
  const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
  const waitFor = (predicate: (frame: WorkerFrame) => boolean, action?: () => void): Promise<WorkerFrame> => {
    action?.()
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('timed out waiting for Codex worker frame')) }, 5_000)
      const timer = setInterval(() => {
        const frame = frames.find(predicate)
        if (frame === undefined) return
        clearTimeout(deadline)
        clearInterval(timer)
        resolve(frame)
      }, 5)
      deadline.unref?.()
    })
  }
  try {
    await body({ send, waitFor, frames })
  } finally {
    child.kill()
  }
}

/** Open a session and prompt it, and hand back the question request it answered with. */
async function promptForQuestion({ send, waitFor }: WorkerHarness): Promise<WorkerFrame> {
  await waitFor(frame => frame.id === 'create', () => {
    send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-question', workspace: TEST_WORKSPACE } })
  })
  return await waitFor(frame => frame.method === 'question/requested', () => {
    send({ id: 'prompt', method: 'session/prompt', params: { content: 'ask before continuing' } })
  })
}

/** Answer the pending question, and hand back the frame the App Server echoed it in. */
function answerQuestion(harness: WorkerHarness, requested: WorkerFrame, response: unknown): Promise<WorkerFrame> {
  return harness.waitFor(frame => frame.method === 'assistant/final', () => {
    harness.send({ id: 'answer', method: 'question/respond', params: { requestId: field(requested, 'params', 'requestId'), response } })
  })
}

describe('Codex worker', () => {
  it('creates an app-server thread and projects the runtime session identity', async () => {
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', fakeServer].join('\u001f'),
        FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const lines: any[] = []
    const completed = new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) return
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          lines.push(JSON.parse(line))
          if (lines.some(item => item.id === 'create')) resolve()
        }
      })
      child.once('error', reject)
    })
    child.stdin.write(`${JSON.stringify({ id: 'create', method: 'session/create', params: { harnessSessionId: 'harness-1', workspace: TEST_WORKSPACE } })}\n`)
    await completed
    expect(lines.find(item => item.id === 'create')).toMatchObject({ result: { runtimeSessionId: 'thread-1' } })
    expect(lines.find(item => item.method === 'session/started')).toMatchObject({ params: { runtimeSessionId: 'thread-1', harnessSessionId: 'harness-1', sequence: 1 } })
    child.kill()
  })

  it('redacts app-server stderr before returning a failed Host request', async () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', `process.stderr.write('Authorization: Bearer ${secret}\\n'); process.exit(1)`].join('\u001f'),
        FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const reply = new Promise<any>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index < 0) return
        resolve(JSON.parse(buffer.slice(0, index)))
      })
      child.once('error', reject)
    })
    try {
      child.stdin.write(`${JSON.stringify({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-stderr', workspace: TEST_WORKSPACE } })}\n`)
      await expect(reply).resolves.toMatchObject({ id: 'create', error: { message: 'Codex app-server exited: Authorization: Bearer <redacted>' } })
    } finally {
      child.kill()
    }
  })

  it('opens a council child with the official read-only sandbox and no approvals', async () => {
    const server = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialized')continue;const result=m.method==='thread/start'?{thread:{id:m.params.sandbox+'-'+m.params.approvalPolicy}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')}})"
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', server].join(String.fromCharCode(31)),
        FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const frames: any[] = []
    const completed = new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) return
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          frames.push(JSON.parse(line))
          if (frames.some(item => item.id === 'create')) resolve()
        }
      })
      child.once('error', reject)
    })
    try {
      child.stdin.write(JSON.stringify({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-read-only', workspace: TEST_WORKSPACE, readOnly: true } }) + String.fromCharCode(10))
      await completed
      expect(frames.find(item => item.id === 'create')).toMatchObject({ result: { runtimeSessionId: 'read-only-never' } })
    } finally {
      child.kill()
    }
  })

  it.each([
    ['a user-chosen read-only mode', { sandboxMode: 'read-only' }, { sandbox: 'read-only', approvalPolicy: 'on-request' }],
    ['the default workspace-write mode', { sandboxMode: 'workspace-write' }, { sandbox: 'workspace-write', approvalPolicy: null }],
    ['an explicitly unconfined mode', { sandboxMode: 'danger-full-access' }, { sandbox: 'danger-full-access', approvalPolicy: null }],
    ['the council floor', { readOnly: true }, { sandbox: 'read-only', approvalPolicy: 'never' }],
    ['no policy at all', {}, { sandbox: null, approvalPolicy: null }],
    ['a mode the protocol cannot read', { sandboxMode: 'read_only' }, { sandbox: null, approvalPolicy: null }],
  ])('opens the App Server thread under %s', async (_label, policy, expected) => {
    const session = await openCodexThread({ ...policy })
    expect(JSON.parse(session)).toEqual(expected)
  })

  it('applies the mode on thread resume as well as thread start', async () => {
    // Both calls carry the policy. A probe that reverted only this one would
    // otherwise pass every test in the suite.
    const resumed = await openCodexThread({ sandboxMode: 'read-only' }, 'resume')
    expect(JSON.parse(resumed)).toEqual({ sandbox: 'read-only', approvalPolicy: 'on-request' })
  })

  /** Spawn the real worker against a fake App Server and read the echoed policy back. */
  async function openCodexThread(params: Record<string, unknown>, method: 'create' | 'resume' = 'create'): Promise<string> {
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', threadSandboxEcho].join(String.fromCharCode(31)),
        FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const frames: any[] = []
    const answer = new Promise<any>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) return
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          frames.push(JSON.parse(line))
          if (frames.some(item => item.id === 'create')) resolve(frames.find(item => item.id === 'create'))
        }
      })
      child.once('error', reject)
    })
    try {
      child.stdin.write(JSON.stringify({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-sandbox', workspace: TEST_WORKSPACE, ...params } }) + String.fromCharCode(10))
      await answer
      if (method === 'create') return String((await answer).result.runtimeSessionId)
      const resumed = await new Promise<any>((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('timed out waiting for the Codex worker')) }, 10_000)
        const poll = setInterval(() => {
          const frame = frames.find(item => item.id === 'resume')
          if (frame === undefined) return
          clearInterval(poll)
          clearTimeout(deadline)
          resolve(frame)
        }, 20)
        child.stdin.write(JSON.stringify({ id: 'resume', method: 'session/resume', params: { harnessSessionId: 'codex-sandbox', runtimeSessionId: 'thread-sandbox', workspace: TEST_WORKSPACE, ...params } }) + String.fromCharCode(10))
      })
      return String(resumed.result.runtimeSessionId)
    } finally {
      child.kill()
    }
  }

  it('maps approval, cancel, and thread resume through the real worker process', async () => {
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', interactiveServer].join('\u001f'),
        FREECODEGO_CODEX_HOME: TEST_WORKSPACE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== '') frames.push(JSON.parse(line))
      }
    })
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
    // This test drives two turns through one worker, so frames are consumed in
    // order: an earlier permission request must not answer for a later one.
    let cursor = 0
    const awaitFrame = (predicate: (frame: any) => boolean, action?: () => void): Promise<any> => {
      action?.()
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('timed out waiting for Codex worker frame')) }, 5_000)
        const timer = setInterval(() => {
          for (let index = cursor; index < frames.length; index += 1) {
            const frame = frames[index]
            if (frame === undefined || !predicate(frame)) continue
            cursor = index + 1
            clearTimeout(deadline)
            clearInterval(timer)
            resolve(frame)
            return
          }
        }, 5)
        deadline.unref?.()
      })
    }
    try {
      await expect(awaitFrame(frame => frame.id === 'create', () => { send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-e2e', workspace: TEST_WORKSPACE } }) }))
        .resolves.toMatchObject({ result: { runtimeSessionId: 'thread-interactive' } })
      const requested = await awaitFrame(
        frame => frame.method === 'permission/requested',
        () => { send({ id: 'prompt', method: 'session/prompt', params: { content: 'run command' } }) },
      )
      expect(requested.params).toMatchObject({ approvalId: 'approval-9001' })
      await expect(awaitFrame(
        frame => frame.id === 'approval',
        () => { send({ id: 'approval', method: 'permission/respond', params: { requestId: 'approval-9001', response: { type: 'approved' } } }) },
      )).resolves.toMatchObject({ result: null })
      // The App Server's own vocabulary, not the Host's `{ type: 'approved' }`.
      await expect(awaitFrame(frame => frame.method === 'assistant/final'))
        .resolves.toMatchObject({ params: { text: '{"decision":"accept"}' } })
      const second = await awaitFrame(
        frame => frame.method === 'permission/requested',
        () => { send({ id: 'prompt-2', method: 'session/prompt', params: { content: 'run another command' } }) },
      )
      expect(second.params).toMatchObject({ approvalId: 'approval-9002' })
      await awaitFrame(
        frame => frame.id === 'approval-2',
        () => { send({ id: 'approval-2', method: 'permission/respond', params: { requestId: 'approval-9002', response: { type: 'rejected' } } }) },
      )
      // A refusal is the decision that lets the agent keep the turn.
      await expect(awaitFrame(frame => frame.method === 'assistant/final'))
        .resolves.toMatchObject({ params: { text: '{"decision":"decline"}' } })
      // `TurnInterruptParams` marks `turnId` required beside `threadId`, so a
      // cancel has to name the turn `turn/start` handed back. An interrupt that
      // names only the thread is a request the App Server rejects — and the
      // refusal used to be swallowed, so the Host was told `cancelled` while the
      // turn kept generating.
      const interrupt: unknown = await awaitFrame(
        frame => field(frame, 'method') === 'tool/progress' && field(frame, 'params', 'method') === 'fixture/turnInterrupt',
        () => { send({ id: 'cancel', method: 'session/cancel', params: { reason: 'user' } }) },
      )
      expect(field(interrupt, 'params', 'detail')).toEqual({ threadId: 'thread-interactive', turnId: 'turn-2' })
      await expect(awaitFrame(frame => frame.id === 'cancel')).resolves.toMatchObject({ result: null })
      // Two reports end this turn: the App Server's own word for the interrupted
      // turn (`turn/completed { status: 'interrupted' }`, the fixture's answer to
      // `turn/interrupt`) and the worker's report of the cancel. The Host reads
      // one terminal vocabulary and discards the runtime session over a status it
      // cannot place, so both must arrive as a word it accepts. Counted rather
      // than position-matched because the two frames race.
      const completions = await vi.waitFor(() => {
        const found = frames.filter(frame => frame.method === 'session/completed') as { params: { status?: unknown } }[]
        expect(found).toHaveLength(2)
        return found
      }, { timeout: 5_000 })
      expect(completions.map(frame => frame.params.status)).toEqual(['cancelled', 'cancelled'])
      await expect(awaitFrame(frame => frame.id === 'resume', () => { send({ id: 'resume', method: 'session/resume', params: { harnessSessionId: 'codex-e2e', runtimeSessionId: 'thread-interactive', workspace: TEST_WORKSPACE } }) }))
        .resolves.toMatchObject({ result: { runtimeSessionId: 'thread-interactive' } })
      await expect(awaitFrame(frame => frame.id === 'dispose', () => { send({ id: 'dispose', method: 'session/dispose', params: {} }) }))
        .resolves.toMatchObject({ result: null })
    } finally {
      child.kill()
    }
  })

  it('names the turn it interrupts, because the App Server marks both ids required', async () => {
    await withWorker(cancelEcho(false), async ({ send, waitFor }) => {
      await waitFor(frame => frame.id === 'create', () => { send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-cancel', workspace: TEST_WORKSPACE } }) })
      await waitFor(frame => frame.id === 'prompt', () => { send({ id: 'prompt', method: 'session/prompt', params: { content: 'work' } }) })
      const interrupt = await waitFor(
        frame => field(frame, 'method') === 'tool/progress' && field(frame, 'params', 'method') === 'fixture/turnInterrupt',
        () => { send({ id: 'cancel', method: 'session/cancel', params: {} }) },
      )
      // `TurnInterruptParams.required` is `["threadId","turnId"]`. The turn id is
      // not the thread id and is not derivable from it: it only exists in the
      // `turn/start` response, so a worker that drops that response cannot send
      // a request the App Server accepts.
      expect(field(interrupt, 'params', 'detail')).toEqual({ threadId: 'thread-cancel', turnId: 'turn-77' })
      await expect(waitFor(frame => frame.id === 'cancel')).resolves.toMatchObject({ result: null })
      await expect(waitFor(frame => field(frame, 'method') === 'session/completed')).resolves.toMatchObject({ params: { status: 'cancelled' } })
    })
  })

  it('sends no interrupt when no turn is in flight, and still reports the cancel', async () => {
    await withWorker(cancelEcho(false), async ({ send, waitFor, frames }) => {
      await waitFor(frame => frame.id === 'create', () => { send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-idle', workspace: TEST_WORKSPACE } }) })
      await expect(waitFor(frame => frame.id === 'cancel', () => { send({ id: 'cancel', method: 'session/cancel', params: {} }) }))
        .resolves.toMatchObject({ result: null })
      await expect(waitFor(frame => field(frame, 'method') === 'session/completed')).resolves.toMatchObject({ params: { status: 'cancelled' } })
      // With no turn running there is nothing to interrupt, and the request would
      // be one the App Server rejects for a missing `turnId`; the cancel is
      // accepted without inventing a turn to name.
      expect(frames.filter(frame => field(frame, 'params', 'method') === 'fixture/turnInterrupt')).toHaveLength(0)
    })
  })

  it('reports a refused interrupt as a failure instead of claiming the turn was cancelled', async () => {
    await withWorker(cancelEcho(true), async ({ send, waitFor }) => {
      await waitFor(frame => frame.id === 'create', () => { send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-refused', workspace: TEST_WORKSPACE } }) })
      await waitFor(frame => frame.id === 'prompt', () => { send({ id: 'prompt', method: 'session/prompt', params: { content: 'work' } }) })
      // The turn is still generating on the App Server, so a `cancelled` report
      // would settle the Host's turn as stopped while the work continues. The
      // Host rejects a status it cannot place, which is the honest outcome.
      const completed = waitFor(
        frame => field(frame, 'method') === 'session/completed',
        () => { send({ id: 'cancel', method: 'session/cancel', params: {} }) },
      )
      await expect(completed).resolves.toMatchObject({ params: { status: 'failed' } })
      expect(field(await completed, 'params', 'message')).toContain('not interruptible')
    })
  })

  it('leaves no watchdog armed behind a turn it has already cancelled', async () => {
    const idleMs = 400
    await withWorker(cancelRaceServer, async ({ send, waitFor, frames }) => {
      await waitFor(frame => frame.id === 'create', () => { send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-cancel-race', workspace: TEST_WORKSPACE } }) })
      await waitFor(frame => frame.id === 'prompt', () => { send({ id: 'prompt', method: 'session/prompt', params: { content: 'work' } }) })
      // The interrupt reply is sent after the cancelled report, so waiting for
      // the reply means the report is already in `frames`.
      await expect(waitFor(frame => frame.id === 'cancel', () => { send({ id: 'cancel', method: 'session/cancel', params: {} }) }))
        .resolves.toMatchObject({ result: null })
      await expect(waitFor(frame => frame.method === 'session/completed')).resolves.toMatchObject({ params: { status: 'cancelled' } })
      // Past the idle window. A timer that survived the cancel fires here and
      // reports a failure for a turn that is over, with no turn in flight — and
      // the Host answers a failed completion by disposing the whole runtime, so
      // this is the session being torn down after the user stopped it.
      await new Promise((resolve) => { setTimeout(resolve, idleMs * 3) })
      const completions = frames.filter(frame => frame.method === 'session/completed')
      expect(completions.map(frame => field(frame, 'params', 'status'))).toEqual(['cancelled'])
    }, { FREECODEGO_CODEX_TURN_IDLE_MS: String(idleMs) })
  }, 15_000)

  it('answers the app-server question request in the shape its own schema declares', async () => {
    await withWorker(questionServer, async (harness) => {
      const requested = await promptForQuestion(harness)
      expect(field(requested, 'params', 'request')).toMatchObject({ questions: [{ id: 'scope', question: 'Which scope?' }] })
      const answered = answerQuestion(harness, requested, { answers: [{ id: 'scope', selected: ['small'] }] })
      // `ToolRequestUserInputResponse` keys its answers by question id and holds
      // one string array per question. The Host's array-of-records is a different
      // shape, and forwarding it is a deserialization failure in the App Server —
      // so this asserts the payload the App Server actually receives.
      expect(field(await answered, 'params', 'text')).toBe(JSON.stringify({ answers: { scope: { answers: ['small'] } } }))
      await expect(harness.waitFor(frame => frame.id === 'answer')).resolves.toMatchObject({ result: null })
      await expect(harness.waitFor(frame => frame.id === 'prompt')).resolves.toMatchObject({ result: null })
    })
  })

  it('carries a free-text answer alongside the selection, and keeps both for a multi-select question', async () => {
    await withWorker(questionServer, async (harness) => {
      const requested = await promptForQuestion(harness)
      const answered = answerQuestion(harness, requested, { answers: [{ id: 'scope', selected: ['small', 'large'], custom: 'exactly 3 files' }] })
      expect(field(await answered, 'params', 'text')).toBe(JSON.stringify({ answers: { scope: { answers: ['small', 'large', 'exactly 3 files'] } } }))
    })
  })

  it('surfaces an app-server question request that carries more questions than the Claude SDK allows', async () => {
    await withWorker(manyQuestionsServer, async (harness) => {
      const requested = await promptForQuestion(harness)
      // Five questions is not a protocol error: `ToolRequestUserInputParams`
      // declares no `maxItems`, and refusing the request produced a -32601 that
      // named a feature this worker implements.
      const questions = field(requested, 'params', 'request', 'questions')
      expect(Array.isArray(questions) ? questions.map(question => field(question, 'id')) : []).toEqual(['a', 'b', 'c', 'd', 'e'])
    })
  })

  it('applies model and reasoning changes on the next turn and publishes reasoning events', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-codex-routing-'))
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', routingServer].join('\u001f'),
        FREECODEGO_CODEX_HOME: home,
        FREECODEGO_CODEX_PROVIDER_OVERRIDE: 'openai',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== '') frames.push(JSON.parse(line))
      }
    })
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
    const waitFor = (predicate: (frame: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('timed out waiting for Codex routing frame')) }, 5_000)
      const timer = setInterval(() => {
        const frame = frames.find(predicate)
        if (frame === undefined) return
        clearTimeout(deadline)
        clearInterval(timer)
        resolve(frame)
      }, 5)
      deadline.unref?.()
    })
    const encoded = (provider: string, model: string, effort: string): string =>
      `freecodego-route:${Buffer.from(provider).toString('base64url')}.${Buffer.from(model).toString('base64url')}.${effort}`
    try {
      send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-routing', workspace: TEST_WORKSPACE, provider: 'freecodego', modelId: 'initial', reasoningEffort: 'high' } })
      await expect(waitFor(frame => frame.id === 'create')).resolves.toMatchObject({ result: { runtimeSessionId: 'thread-routing' } })

      send({ id: 'first', method: 'session/prompt', params: { content: 'first', provider: 'freecodego', modelId: 'hy3', reasoningEffort: 'high' } })
      const first = await waitFor(frame => frame.method === 'assistant/final' && frame.params.text.includes('"effort":"high"'))
      // The provider rides on the thread, where the App Server reads it;
      // the turn carries the model and the effort only.
      expect(JSON.parse(first.params.text)).toEqual({
        model: encoded('freecodego', 'hy3', 'high'),
        hasModelProvider: false,
        modelProvider: null,
        effort: 'high',
        threadStart: {
          hasModelProvider: true,
          modelProvider: 'openai',
          model: encoded('freecodego', 'initial', 'high'),
          hasEphemeral: false,
          ephemeral: null,
        },
      })
      await expect(waitFor(frame => frame.method === 'assistant/reasoning/delta' && frame.params.text === 'reason-high')).resolves.toBeTruthy()
      await expect(waitFor(frame => frame.method === 'assistant/reasoning/final' && frame.params.text === 'reason-high')).resolves.toBeTruthy()

      send({ id: 'second', method: 'session/prompt', params: { content: 'second', provider: 'agnes', modelId: 'agnes-3.0-flash', reasoningEffort: 'low' } })
      const second = await waitFor(frame => frame.method === 'assistant/final' && frame.params.text.includes('"effort":"low"'))
      expect(JSON.parse(second.params.text)).toEqual({
        model: encoded('agnes', 'agnes-3.0-flash', 'low'),
        hasModelProvider: false,
        modelProvider: null,
        effort: 'low',
        threadStart: {
          hasModelProvider: true,
          modelProvider: 'openai',
          model: encoded('freecodego', 'initial', 'high'),
          hasEphemeral: false,
          ephemeral: null,
        },
      })
    } finally {
      child.kill()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('stops the App Server with a clean EOF, so the rollout it was writing survives the dispose', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-codex-dispose-'))
    const marker = join(home, 'stopped')
    try {
      await withWorker(disposeWitness(marker), async (harness) => {
        await harness.waitFor(frame => frame.id === 'create', () => {
          harness.send({
            id: 'create',
            method: 'session/create',
            params: { harnessSessionId: 'codex-dispose', workspace: TEST_WORKSPACE },
          })
        })
        const disposed = await harness.waitFor(frame => frame.id === 'dispose', () => {
          harness.send({ id: 'dispose', method: 'session/dispose', params: {} })
        })
        expect(disposed).toMatchObject({ result: null })
        // The App Server reached EOF and exited on its own terms. A forced
        // tree kill would have left this file unwritten, and the rollout it
        // was holding would have been discarded with it.
        await expect(readFile(marker, 'utf8')).resolves.toBe('eof')
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('relays the reason the App Server gives for a failed turn, with its credentials stripped', async () => {
    // The protocol declares no `turn/failed` notification, so a turn that dies
    // arrives as `turn/completed` with `status: 'failed'` and `turn.error`
    // beside it. The Host rejects the turn with whatever message it is handed,
    // and falls back to the bare `native turn finished with status "failed"`
    // when there is none -- so a dropped reason is a failure the user cannot
    // act on. `additionalDetails` is kept alongside the message because it is
    // the more specific half in practice.
    const secret = 'sk-failure-probe-0123456789abcdef'
    await withWorker(failureServer, async (harness) => {
      await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-failure', workspace: TEST_WORKSPACE },
        })
      })
      const completed = await harness.waitFor(frame => frame.method === 'session/completed', () => {
        harness.send({ id: 'prompt', method: 'session/prompt', params: { content: 'run' } })
      })
      expect(completed.params).toMatchObject({ status: 'failed' })
      const message = (completed.params as { message?: unknown }).message
      expect(typeof message).toBe('string')
      expect(message).toContain('request timed out')
      expect(message).toContain('<redacted>')
      expect(message).not.toContain(secret)
    }, { OPENAI_API_KEY: secret })
  })

  it('fails a turn that goes silent after its first app-server frame, and interrupts that turn', async () => {
    // The previous watchdog disarmed on the `turn/start` acknowledgement, so
    // silence after that first frame was unprotected. The idle window has to
    // keep resetting for the whole turn, and giving up has to name the turn
    // the App Server is still generating.
    const idleMs = 400
    await withWorker(silentAfterStartServer, async (harness) => {
      await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-silent', workspace: TEST_WORKSPACE },
        })
      })
      const completed = await harness.waitFor(frame => frame.method === 'session/completed', () => {
        harness.send({ id: 'prompt', method: 'session/prompt', params: { content: 'run' } })
      })
      expect(completed.params).toMatchObject({
        status: 'failed',
        message: 'Codex turn produced no events within the watchdog window',
      })
      await harness.waitFor(frame =>
        frame.method === 'tool/progress' && field(frame, 'params', 'method') === 'fixture/turnInterrupt')
      const interrupt = harness.frames.find(frame =>
        frame.method === 'tool/progress' && field(frame, 'params', 'method') === 'fixture/turnInterrupt')
      expect(field(interrupt, 'params', 'detail', 'turnId')).toBe('turn-silent')
    }, { FREECODEGO_CODEX_TURN_IDLE_MS: String(idleMs) })
  }, 15_000)

  it('does not arm a turn watchdog on session setup, when no turn is in flight', async () => {
    const idleMs = 400
    await withWorker(silentAfterStartServer, async (harness) => {
      await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-no-turn', workspace: TEST_WORKSPACE },
        })
      })
      await new Promise((resolve) => { setTimeout(resolve, idleMs * 3) })
      expect(harness.frames.some(frame => frame.method === 'session/completed')).toBe(false)
    }, { FREECODEGO_CODEX_TURN_IDLE_MS: String(idleMs) })
  }, 15_000)

  it('keeps a slow but healthy turn alive by resetting the idle window on each frame', async () => {
    const idleMs = 400
    await withWorker(healthySlowServer, async (harness) => {
      await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-slow', workspace: TEST_WORKSPACE },
        })
      })
      const completed = await harness.waitFor(frame => frame.method === 'session/completed', () => {
        harness.send({ id: 'prompt', method: 'session/prompt', params: { content: 'run' } })
      })
      expect(completed.params).toMatchObject({ status: 'completed' })
    }, { FREECODEGO_CODEX_TURN_IDLE_MS: String(idleMs) })
  }, 15_000)

  it('opens a thread the Host can resume, because an ephemeral thread is never written to the rollout store', async () => {
    // The Host persists the thread id this call returns and reopens the
    // conversation through session/resume. An ephemeral thread is not written
    // to the rollout store, so resuming one answers "no rollout found for
    // thread id ..." -- even after a completed turn, since the rollout is what
    // persistence consists of. ThreadResumeParams declares no ephemeral field,
    // so a thread started ephemeral can never be made resumable later: this
    // call is the only place the choice exists.
    await withWorker(routingServer, async (harness) => {
      await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-resumable', workspace: TEST_WORKSPACE, provider: 'codex', modelId: 'codex-auto' },
        })
      })

      const turn = await harness.waitFor(frame => frame.method === 'assistant/final', () => {
        harness.send({ id: 'prompt', method: 'session/prompt', params: { content: 'go' } })
      })
      expect(JSON.parse(String(field(turn, 'params', 'text')))).toMatchObject({
        threadStart: { hasEphemeral: false, ephemeral: null },
      })
    })
  })
  it('opens a session on the Host Codex route without offering that route to the App Server as a provider', async () => {
    // The App Server provider registry is not the Host route namespace. It
    // holds the names the binary was built with (openai, ollama, lmstudio),
    // and thread/start reads modelProvider -- an unknown name there is a hard
    // error, unlike turn/start, which drops unknown fields. Forwarding the
    // Host route label therefore aborted the whole session with
    // "Model provider codex not found", and because every test opened a
    // session without a provider, nothing here ever noticed.
    await withWorker(routingServer, async (harness) => {
      // The exact pair nativeAgentOptionsAlpha produces for the Codex engine:
      // the route label is codex, and an unset model arrives as its private
      // codex-auto sentinel, which the worker strips before the wire.
      const created = await harness.waitFor(frame => frame.id === 'create', () => {
        harness.send({
          id: 'create',
          method: 'session/create',
          params: { harnessSessionId: 'codex-provider', workspace: TEST_WORKSPACE, provider: 'codex', modelId: 'codex-auto' },
        })
      })
      expect(created).toMatchObject({ result: { runtimeSessionId: 'thread-routing' } })
      // The route label is still reported back to the Host verbatim; it is
      // only the App Server that must never be handed it.
      await expect(harness.waitFor(frame => frame.method === 'session/started')).resolves.toMatchObject({ params: { provider: 'codex' } })

      const turn = await harness.waitFor(frame => frame.method === 'assistant/final', () => {
        harness.send({ id: 'prompt', method: 'session/prompt', params: { content: 'go' } })
      })
      expect(JSON.parse(String(field(turn, 'params', 'text')))).toEqual({
        model: null,
        hasModelProvider: false,
        modelProvider: null,
        effort: 'high',
        threadStart: { hasModelProvider: false, modelProvider: null, model: null, hasEphemeral: false, ephemeral: null },
      })
    })
  })

  it('keeps third-party MCP connection data in the Host and projects only the Harness bridge into Codex', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-codex-capabilities-'))
    await writeFile(join(home, 'config.toml'), [
      'model = "global-model"',
      '',
      // The same table can be defined by a dotted assignment instead of a header.
      // It sits at the root, before any table, so the strip's assignment branch
      // is what has to catch it rather than an enclosing MCP section.
      'mcp_servers.dotted.url = "https://dotted.example.test/mcp"',
      '',
      '[mcp_servers.leaked]',
      'url = "https://stale.example.test/mcp"',
      '',
      '[mcp_servers.leaked.env]',
      'TOKEN = "stale-token"',
      '',
      // TOML ignores whitespace around the dots of a dotted key, so this line
      // names the very same `mcp_servers.spaced` table as the tight spelling.
      '[mcp_servers . spaced]',
      'url = "https://spaced.example.test/mcp"',
      '',
      '[projects]',
      'trust_level = "trusted"',
      '',
    ].join('\n'), 'utf8')
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', fakeServer].join('\u001f'),
        FREECODEGO_CODEX_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== '') frames.push(JSON.parse(line))
      }
    })
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
    const waitFor = (predicate: (frame: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('timed out waiting for Codex capability frame')) }, 5_000)
      const timer = setInterval(() => {
        const frame = frames.find(predicate)
        if (frame === undefined) return
        clearTimeout(deadline)
        clearInterval(timer)
        resolve(frame)
      }, 5)
      deadline.unref?.()
    })
    try {
      send({
        id: 'configure',
        method: 'host/configure',
        params: {
          mcpEnabled: true,
          skillEnabled: true,
          skillRoots: ['C:/shared-skills'],
          mcpTools: [{ name: 'mcp__docs__search', description: 'Search docs', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
          mcpServers: [{
            transport: 'streamable-http',
            serverName: 'docs',
            command: '', args: [], env: {}, cwd: '',
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer test-token', 'X-Client': 'FreeCodeGo' },
          }],
        },
      })
      await expect(waitFor(frame => frame.id === 'configure')).resolves.toMatchObject({ result: null })
      send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-capabilities', workspace: TEST_WORKSPACE } })
      await expect(waitFor(frame => frame.id === 'create')).resolves.toMatchObject({ result: { runtimeSessionId: 'thread-1' } })
      const config = await readFile(join(home, 'config.toml'), 'utf8')
      expect(config).toContain('# freecodego-managed-mcp:start')
      expect(config).toContain('[mcp_servers.freecodego-harness]')
      expect(config).toContain('bearer_token_env_var = "FREECODEGO_CODEX_HARNESS_MCP_TOKEN"')
      expect(config).not.toContain('freecodego-docs')
      expect(config).not.toContain('https://mcp.example.test/mcp')
      expect(config).not.toContain('test-token')
      expect(config).not.toContain('X-Client')
      expect(config).not.toContain('stale.example.test')
      expect(config).not.toContain('stale-token')
      // A strip that matched only the tight spelling would leave a user MCP
      // definition behind and hand Codex a tool the Host never approved.
      expect(config).not.toContain('spaced.example.test')
      expect(config).not.toContain('[mcp_servers . spaced]')
      expect(config).not.toContain('dotted.example.test')
      expect(config).toContain('model = "global-model"')
      expect(config).toContain('[projects]')
    } finally {
      child.kill()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('answers only the server requests a user can decide, and in the App Server vocabulary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-codex-shapes-'))
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', serverRequestShapes].join('\u001f'),
        FREECODEGO_CODEX_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== '') frames.push(JSON.parse(line))
      }
    })
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
    const waitFor = (predicate: (frame: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('timed out waiting for a Codex request-shape frame')) }, 5_000)
      const timer = setInterval(() => {
        const frame = frames.find(predicate)
        if (frame === undefined) return
        clearTimeout(deadline)
        clearInterval(timer)
        resolve(frame)
      }, 5)
      deadline.unref?.()
    })
    try {
      send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-shapes', workspace: TEST_WORKSPACE } })
      await expect(waitFor(frame => frame.id === 'create')).resolves.toMatchObject({ result: { runtimeSessionId: 'thread-shapes' } })
      send({ id: 'prompt', method: 'session/prompt', params: { content: 'go' } })
      // The escalation is the only one of the two that reaches the user.
      const requested = await waitFor(frame => frame.method === 'permission/requested')
      expect(requested.params).toMatchObject({ approvalId: 'approval-9301', method: 'item/permissions/requestApproval' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(frames.filter(frame => frame.method === 'permission/requested')).toHaveLength(1)
      send({ id: 'approval', method: 'permission/respond', params: { requestId: 'approval-9301', response: { type: 'approved' } } })
      const reply = await waitFor(frame => frame.method === 'assistant/final')
      const seen = JSON.parse(reply.params.text) as Record<string, any>
      // The handshake is refused explicitly, because no approval outcome could
      // ever have produced the `token` its response schema requires.
      expect(seen['9300']?.error?.message).toContain('attestation/generate')
      // The escalation grants exactly what was asked, for this turn only.
      expect(seen['9301']?.result).toEqual({
        permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/work/out' } }] } },
        scope: 'turn',
      })
    } finally {
      child.kill()
      await rm(home, { recursive: true, force: true })
    }
  })

  // The loopback MCP bridge is the only route a Harness tool has into Codex, and
  // its result projection is what the model actually reads. Driving one real
  // `tools/call` end to end is what proves the bridge is connected: a unit test
  // of the projection cannot see whether anything calls it.
  it('serves a Harness tool over the loopback bridge and projects its result', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-codex-bridge-'))
    const tokenPath = join(home, 'mcp-token.txt')
    // The app-server is the only process that receives the bridge token, so the
    // test reads it from there — the same place a real Codex would.
    const tokenServer = [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(tokenPath)}, String(process.env.FREECODEGO_CODEX_HARNESS_MCP_TOKEN ?? ''))`,
      "process.stdin.setEncoding('utf8');let b=''",
      "process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialized')continue;let result={};if(m.method==='thread/start')result={thread:{id:'thread-mcp'}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')}})",
    ].join(';')
    const child = spawn(execPath, workerArgs, {
      cwd: TEST_WORKSPACE,
      env: {
        PATH: processEnv.PATH ?? '',
        FREECODEGO_CODEX_APP_SERVER: execPath,
        FREECODEGO_CODEX_APP_SERVER_ARGS: ['-e', tokenServer].join('\u001f'),
        FREECODEGO_CODEX_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== '') frames.push(JSON.parse(line))
      }
    })
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`) }
    const waitFor = (predicate: (frame: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('timed out waiting for a Codex bridge frame')) }, 10_000)
      const timer = setInterval(() => {
        const frame = frames.find(predicate)
        if (frame === undefined) return
        clearTimeout(deadline)
        clearInterval(timer)
        resolve(frame)
      }, 5)
      deadline.unref?.()
    })
    try {
      send({
        id: 'configure',
        method: 'host/configure',
        params: {
          mcpEnabled: false,
          skillEnabled: false,
          harnessTools: [{ name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { queries: { type: 'array' } }, required: ['queries'] } }],
        },
      })
      await expect(waitFor(frame => frame.id === 'configure')).resolves.toMatchObject({ result: null })
      send({ id: 'create', method: 'session/create', params: { harnessSessionId: 'codex-bridge', workspace: TEST_WORKSPACE } })
      await expect(waitFor(frame => frame.id === 'create')).resolves.toMatchObject({ result: { runtimeSessionId: 'thread-mcp' } })
      const config = await readFile(join(home, 'config.toml'), 'utf8')
      const url = /url = "([^"]+)"/.exec(config)?.[1]
      expect(url).toBeDefined()
      const token = (await readFile(tokenPath, 'utf8')).trim()
      expect(token).not.toBe('')

      // Answer each bridge request in turn, the way the Host does.
      // Every id answered so far, not just the last one: a predicate like
      // `requestId !== answered` re-answers the *first* frame as soon as a third
      // call arrives, which leaves that call unanswered and hangs the fetch.
      const answered = new Set<string>()
      const answerNextBridge = (payload: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('timed out waiting for a bridge request')) }, 10_000)
        const timer = setInterval(() => {
          const frame = frames.find(item => item.method === 'bridge/requested' && !answered.has(item.params.requestId))
          if (frame === undefined) return
          clearTimeout(deadline)
          clearInterval(timer)
          answered.add(frame.params.requestId)
          send({ id: `respond-${frame.params.requestId}`, method: 'bridge/respond', params: { requestId: frame.params.requestId, ...payload } })
          resolve(frame)
        }, 5)
        deadline.unref?.()
      })
      const callTool = async (id: number, queries: string[], payload: Record<string, unknown>): Promise<any> => {
        const answering = answerNextBridge(payload)
        const response = await fetch(url as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'web_search', arguments: { queries } } }),
          // Without a deadline an unanswered bridge hangs the test until the
          // whole-test timeout, which says nothing about which call stalled.
          signal: AbortSignal.timeout(10_000),
        })
        expect(await answering).toMatchObject({ params: { bridge: 'tool', op: 'execute', input: { name: 'web_search', arguments: { queries } } } })
        return await response.json()
      }

      // The result must arrive as its own text, not as one JSON document
      // wrapping another, and a successful call must not carry the error flag.
      expect(await callTool(1, ['x'], { result: { content: [{ type: 'text', text: 'first result' }] } }))
        .toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'first result' }] } })
      expect(await callTool(2, ['y'], { result: { content: [{ type: 'text', text: 'denied' }], isError: true } }))
        .toMatchObject({ result: { content: [{ type: 'text', text: 'denied' }], isError: true } })

      // A *rejecting* bridge is the path the Host takes when the tool itself
      // failed: it rethrows that tool's own error text, which then becomes an
      // MCP error result — text the Codex model reads. The second call carries
      // the bridge token, a value only this process holds, so it pins the
      // known-secret half of the masker rather than its shape rules.
      expect(await callTool(3, ['z'], { error: 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuv failed' }))
        .toMatchObject({ result: { content: [{ type: 'text', text: 'Authorization: Bearer <redacted> failed' }], isError: true } })
      expect(await callTool(4, ['z'], { error: `tool echoed ${token} and Basic dXNlcjpwYXNzd29yZA==` }))
        .toMatchObject({ result: { content: [{ type: 'text', text: 'tool echoed <redacted> and Basic <redacted>' }], isError: true } })

      // The other exit is a malformed request, whose JSON.parse failure quotes
      // the text it choked on. Asserted as "the token is absent" rather than as
      // an exact message, because how much of the input Node quotes varies by
      // version — what must not vary is the token leaving.
      const malformed = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: `{"jsonrpc":"2.0","id":9,"token":"${token}",`,
      })
      const malformedBody = await malformed.text()
      expect(malformedBody).toContain('-32000')
      expect(malformedBody).not.toContain(token)

      // A notification carries no id, and JSON-RPC forbids answering one. The
      // App Server sends notifications/cancelled when it abandons a tool call
      // -- the name is in its own binary -- so a reply here is protocol noise it
      // cannot route. 202 with an empty body is the acknowledgement.
      const notification = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user' } }),
      })
      expect(notification.status).toBe(202)
      expect(await notification.text()).toBe('')

      // An unknown *request* is answered, with JSON-RPC's method-not-found code
      // rather than the -32000 this server reserves for a body it could not read.
      const unknownMethod = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'resources/list' }),
      })
      expect(await unknownMethod.json()).toMatchObject({ id: 11, error: { code: -32601 } })
    } finally {
      child.kill()
      await rm(home, { recursive: true, force: true })
    }
    // Explicit, and above the 10s `waitFor` deadlines inside: under the 5s
    // default the test reported its own timeout before either deadline could
    // describe which frame never arrived.
  }, 30_000)
})
