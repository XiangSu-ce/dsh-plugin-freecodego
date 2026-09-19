import { execPath } from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { NativeRuntimeHost, validateRuntimeManifest } from '@deepseek-ai/dsh-freecodego-native-runtime-host'

/** Single lint-checked access to the host Node executable for worker spawns. */
const node = execPath

const worker = (body: string) => [
  '-e',
  `process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data', c => { b += c; for (;;) { const i=b.indexOf('\\n'); if (i<0) break; const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); ${body} } });`,
]

describe('NativeRuntimeHost', () => {
  it('rejects malformed or root-escaping runtime manifests before launch', () => {
    const base = {
      manifestVersion: 1,
      engine: 'codex',
      platform: 'win32-x64',
      protocolAbi: 'freecodego-agent/1',
      runtimeAbi: 'codex/1',
      artifactPath: 'artifacts/runtime.exe',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      sourceRevision: 'source',
      licenseNotice: 'artifacts/NOTICE.md',
      minimumPluginVersion: '0.1.0',
    }
    expect(validateRuntimeManifest(base)).toMatchObject({ engine: 'codex' })
    expect(validateRuntimeManifest({ ...base, platform: 'darwin-x64', args: ['app-server'] })).toMatchObject({ platform: 'darwin-x64', args: ['app-server'] })
    expect(() => validateRuntimeManifest({ ...base, platform: 'freebsd-x64' })).toThrow('platform')
    expect(() => validateRuntimeManifest({ ...base, artifactPath: '../runtime.exe' })).toThrow('artifactPath')
  })

  it('correlates responses and forwards ordered events', async () => {
    const events: unknown[] = []
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n'); process.stdout.write(JSON.stringify({method:'assistant/delta',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence:1,text:'hi'}})+'\\n');"),
      onEvent: event => events.push(event),
    })
    await expect(host.request('initialize', { protocolVersion: '1' })).resolves.toEqual({ ok: true })
    // A single macrotask tick is not an ordering barrier against a child
    // process's stdout: under parallel load the second write can still be in
    // flight, which made this assertion intermittently fail. Poll instead of
    // guessing how long the pipe needs.
    await vi.waitFor(() => { expect(events).toHaveLength(1) }, { timeout: 5_000 })
    await host.dispose()
  })

  it('rejects secret-like fields before writing to the worker', async () => {
    const host = new NativeRuntimeHost({ command: node, args: worker('') })
    await expect(host.request('initialize', { accessToken: 'never-send' })).rejects.toThrow('secret-like')
    await host.dispose()
  })

  it('configures a tool whose parameter NAME is credential-like, and still refuses a credential value', async () => {
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n');"),
    })
    // `nativeConfiguration()` sends `ctx.tools.schemas(agent)`, so this payload
    // carries every tool's JSON schema and `password` below is a parameter name.
    // A screen that refuses the name refuses the whole inventory, and because
    // `prepare` sends it before `session/create`, the session could not open at
    // all — so the capability snapshot stays a payload the Host may write.
    await expect(host.request('host/configure', {
      mcpEnabled: true,
      skillEnabled: false,
      skillRoots: [],
      mcpTools: [],
      harnessTools: [{
        name: 'mcp__postgres__connect',
        description: 'Connect to a database.',
        parameters: { type: 'object', properties: { host: { type: 'string' }, password: { type: 'string' } }, required: ['host'] },
      }],
    })).resolves.toBeNull()
    // What survives the relaxation is the only thing this boundary can actually
    // detect: a credential-shaped VALUE under a secret-named key.
    await expect(host.request('host/configure', {
      harnessTools: [{ name: 'tool', parameters: { properties: { password: '0123456789abcdef' } } }],
    })).rejects.toThrow('credential-shaped')
    await host.dispose()
  })

  it('redacts credentials from worker error responses before rejecting callers', async () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const host = new NativeRuntimeHost({
      command: node,
      args: worker(`process.stdout.write(JSON.stringify({id:m.id,error:{code:'UPSTREAM',message:'Authorization: Bearer ${secret}'}})+'\\n');`),
    })
    await expect(host.request('initialize', {})).rejects.toThrow('Authorization: Bearer <redacted>')
    await expect(host.request('initialize', {})).rejects.not.toThrow(secret)
    await host.dispose()
  })

  it('fails the host on duplicate event sequence', async () => {
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n'); for (const sequence of [1, 1]) process.stdout.write(JSON.stringify({method:'event',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence}})+'\\n');"),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    await expect(host.request('catalog/list', {})).rejects.toThrow()
    await host.dispose()
  })

  it('relays model-content events with secret-like key names verbatim', async () => {
    const events: unknown[] = []
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n'); process.stdout.write(JSON.stringify({method:'tool/progress',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence:1,tool:'mcp',args:{user_password_reset:'x',db_secret_name:'short'}}})+'\\n');"),
      onEvent: event => events.push(event),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    // A single tick is not an ordering barrier against a child's stdout; poll
    // instead of guessing how long the pipe needs. This is the last fixed-delay
    // assertion in this file — the same defect the other cases had.
    await vi.waitFor(() => { expect(events).toHaveLength(1) }, { timeout: 5_000 })
    expect(events[0]).toMatchObject({ method: 'tool/progress', params: { args: { user_password_reset: 'x' } } })
    await host.dispose()
  })

  it('drops non-passthrough events with credential-shaped values and terminates after six', async () => {
    const events: unknown[] = []
    const args = worker([
      'process.stdout.write(JSON.stringify({id:m.id,result:null})+\'\\n\');',
      'for (let sequence = 1; sequence <= 6; sequence++) {',
      'process.stdout.write(JSON.stringify({method:\'event\',params:{runtimeSessionId:\'r\',harnessSessionId:\'h\',sequence,api_key:\'0123456789abcdef\'}})+\'\\n\'); }',
    ].join(' '))
    const host = new NativeRuntimeHost({ command: node, args, onEvent: event => events.push(event) })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    // A negative assertion needs the opposite discipline from a positive one:
    // waiting longer can only make it stronger, so give the child a generous
    // window to emit something before concluding it emitted nothing. A short
    // fixed sleep turns this into a race that passes for the wrong reason.
    await vi.waitFor(() => { expect(events).toHaveLength(0) }, { timeout: 5_000, interval: 200 }).catch(() => undefined)
    expect(events).toHaveLength(0)
    await expect(host.request('catalog/list', {})).rejects.toThrow('secret-like fields')
    await host.dispose()
  })

  it('forwards the approval request the worker is waiting on even when its tool input looks secret-like', async () => {
    const events: unknown[] = []
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n'); process.stdout.write(JSON.stringify({method:'permission/requested',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence:1,requestId:'perm-1',detail:{tool:'mcp',input:{api_key:'0123456789abcdef'}}}})+'\\n');"),
      onEvent: event => events.push(event),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    // Dropping it would leave the worker on an answer nobody was asked for: the
    // prompt has to reach the user, credentials in the pending input included.
    await vi.waitFor(() => { expect(events).toHaveLength(1) }, { timeout: 5_000 })
    expect(events[0]).toMatchObject({ method: 'permission/requested', params: { requestId: 'perm-1', detail: { input: { api_key: '0123456789abcdef' } } } })
    await host.dispose()
  })

  it('does not drop non-passthrough events whose secret-key values are not credential-shaped', async () => {
    const events: unknown[] = []
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n'); process.stdout.write(JSON.stringify({method:'event',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence:1,password:'too short',token:'needs whitespace here'}})+'\\n');"),
      onEvent: event => events.push(event),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    // A single tick is not an ordering barrier against a child's stdout; see
    // the note on the first case in this file.
    await vi.waitFor(() => { expect(events).toHaveLength(1) }, { timeout: 5_000 })
    await host.dispose()
  })

  it('tells the session when the worker dies with a turn still open', async () => {
    const failures: string[] = []
    const host = new NativeRuntimeHost({
      // Answers the prompt, then exits: `session/prompt` resolves as soon as the
      // turn starts, so the exit leaves no in-flight request behind to reject.
      command: node,
      args: worker("if (m.method === 'session/prompt') process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n', () => process.exit(0)); else process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');"),
      onEvent: () => undefined,
      onFailure: (error: Error) => failures.push(error.message),
    })
    await expect(host.request('session/prompt', {})).resolves.toBeNull()
    // Without this signal the Harness turn waits on a completion that can never
    // arrive, and the agent stays `running` forever.
    await vi.waitFor(() => { expect(failures).toHaveLength(1) }, { timeout: 5_000 })
    expect(failures[0]).toContain('exited')
    await expect(host.request('catalog/list', {})).rejects.toThrow('exited')
    expect(failures).toHaveLength(1)
    await host.dispose()
    expect(failures).toHaveLength(1)
  })

  it('reports the first failure only, however many times the worker dies', async () => {
    const failures: string[] = []
    const host = new NativeRuntimeHost({
      // A duplicate sequence fails the host, which then kills the worker; the
      // close that follows is the same failure, not a second one.
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n'); for (const sequence of [1, 1]) process.stdout.write(JSON.stringify({method:'event',params:{runtimeSessionId:'r',harnessSessionId:'h',sequence}})+'\\n');"),
      onEvent: () => undefined,
      onFailure: (error: Error) => failures.push(error.message),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    await vi.waitFor(() => { expect(failures).toHaveLength(1) }, { timeout: 5_000 })
    expect(failures[0]).toContain('sequence')
    await host.dispose()
    expect(failures).toHaveLength(1)
  })

  it('does not report a dispose the caller asked for as a failure', async () => {
    const failures: string[] = []
    const host = new NativeRuntimeHost({
      command: node,
      args: worker("process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n');"),
      onEvent: () => undefined,
      onFailure: (error: Error) => failures.push(error.message),
    })
    await expect(host.request('initialize', {})).resolves.toBeNull()
    await host.dispose()
    expect(failures).toHaveLength(0)
  })
})
