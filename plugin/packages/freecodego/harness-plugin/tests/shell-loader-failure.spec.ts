import { describe, expect, it, vi } from 'vitest'
import {
  diagnoseShellLoaderFailure,
  isLoaderFailureExitCode,
  reportedExitCode,
  SHELL_LOADER_FAILURE_PREFIX,
  STATUS_DLL_INIT_FAILED,
  withShellLoaderFailureNote,
  type ShellLoaderFailureDecision,
} from '../src/shell-loader-failure.ts'

/**
 * The case this module exists for is a desktop result that reads
 *
 *     (no output)
 *     [exit code: 3221225794]
 *
 * and nothing else. Every test below is about the part the transcript cannot
 * show — that this is the loader failing, not the command — and about the two
 * ways a note like this one goes wrong: firing on a result that ran fine (so the
 * model learns the wrong cause and stops trusting the marker), and arriving
 * twice for one call (so a single failure reads as two).
 */
const loaderFailureResult = [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }] as const

describe('withShellLoaderFailureNote', () => {
  it('appends the diagnosis to the shell result that carries the loader failure', () => {
    const diagnosed = withShellLoaderFailureNote('pwsh', loaderFailureResult)
    expect(diagnosed).toHaveLength(2)
    // The result the call produced is preserved in place: this adds to the
    // transcript rather than replacing what happened.
    expect(diagnosed?.[0]).toEqual(loaderFailureResult[0])
    const note = diagnosed?.[1]
    expect(note?.type).toBe('text')
    if (note?.type !== 'text') throw new Error('expected a text block')
    expect(note.text.startsWith(SHELL_LOADER_FAILURE_PREFIX)).toBe(true)
    // The code has to be named in the form a reader can search for, in both
    // spellings: the decimal the result shows and the NTSTATUS it means.
    expect(note.text).toContain('0xC0000142')
    expect(note.text).toContain('STATUS_DLL_INIT_FAILED')
    // And it has to say the thing the exit code cannot: the command did not run.
    expect(note.text).toContain('never ran')
  })

  it('reads the signed rendering of the same NTSTATUS', () => {
    // Node reports a Windows exit code unsigned; a POSIX-shaped reporter (and a
    // reader doing arithmetic in 32-bit) produces -1073741502 for the same value.
    const diagnosed = withShellLoaderFailureNote('bash', [{ type: 'text', text: '[exit code: -1073741502]' }])
    expect(diagnosed).toHaveLength(2)
  })

  it('covers every shell spelling the guard vocabulary carries', () => {
    for (const name of ['pwsh', 'bash', 'shell', 'exec_command', 'local_shell']) {
      expect(withShellLoaderFailureNote(name, loaderFailureResult), name).toHaveLength(2)
    }
  })

  it('leaves a normal nonzero exit alone', () => {
    // The marker is the shell's own, so it carries every failure — and a failing
    // command is exactly the result that must NOT be explained away as a loader
    // problem.
    expect(withShellLoaderFailureNote('pwsh', [{ type: 'text', text: 'boom\n[exit code: 1]' }])).toBeUndefined()
    expect(withShellLoaderFailureNote('pwsh', [{ type: 'text', text: 'done\n[exit code: 0]' }])).toBeUndefined()
  })

  it('does not diagnose a non-shell tool', () => {
    // A file whose contents quote the signature is a reading, not a failure.
    expect(withShellLoaderFailureNote('read_file', loaderFailureResult)).toBeUndefined()
  })

  it('does not fire on text that merely mentions the code', () => {
    // The false positive that matters: this agent reads, writes and quotes this
    // code, and a note appended to a document that discusses it would attribute
    // a loader failure to a call that succeeded.
    const prose = [{ type: 'text', text: 'exit code 3221225794 is 0xC0000142 STATUS_DLL_INIT_FAILED, from the docs.' }] as const
    expect(withShellLoaderFailureNote('pwsh', prose)).toBeUndefined()
  })

  it('appends the note once per result', () => {
    const diagnosed = withShellLoaderFailureNote('pwsh', loaderFailureResult)
    if (diagnosed === undefined) throw new Error('expected a diagnosis')
    // The second pass is what a replayed or re-rendered dispatch does; a second
    // copy would report one failure as two.
    expect(withShellLoaderFailureNote('pwsh', diagnosed)).toBeUndefined()
  })

  it('keeps non-text blocks in place', () => {
    const content = [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '[exit code: 3221225794]' },
    ] as never
    const diagnosed = withShellLoaderFailureNote('pwsh', content)
    expect(diagnosed).toHaveLength(3)
    expect(diagnosed?.[0]).toEqual(content[0])
    expect(diagnosed?.[1]).toEqual(content[1])
  })

  it('says nothing about a result with no exit marker at all', () => {
    expect(withShellLoaderFailureNote('pwsh', [{ type: 'text', text: '' }])).toBeUndefined()
    expect(withShellLoaderFailureNote('pwsh', [])).toBeUndefined()
  })
})

describe('diagnoseShellLoaderFailure', () => {
  /** The seam's logger, as the plugin hands it over. */
  const logger = { warn: vi.fn() }

  it('edits the dispatched content and reports the diagnosis once', () => {
    logger.warn.mockClear()
    // Annotated rather than inferred: the generic returns the decision the
    // caller passed, and this literal carries no `content` for the seam to have
    // preserved — the appended blocks are the assertion, so the type the seam
    // declares is the one to read them through.
    const decision: ShellLoaderFailureDecision = diagnoseShellLoaderFailure('pwsh', loaderFailureResult, { kind: 'accept' }, logger)
    expect(decision.content).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    // The log line names the tool, because the host log has no result to read.
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('pwsh')
  })

  it('edits content a later hook already replaced, not the dispatched content', () => {
    // The waterfall means a downstream hook's content is the surface the caller
    // reads; diagnosing the pre-hook copy would annotate a result nobody sees.
    const replacement = [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }] as const
    const decision = diagnoseShellLoaderFailure(
      'pwsh',
      [{ type: 'text', text: 'stale' }],
      { kind: 'accept', content: replacement },
      logger,
    )
    expect(decision.content).toHaveLength(2)
    expect(decision.content?.[0]).toEqual(replacement[0])
  })

  it('leaves a blocked call alone', () => {
    // `block` is corrective feedback that is already the answer to the call.
    const decision = { kind: 'block', feedback: [{ type: 'text', text: 'refused' }] }
    expect(diagnoseShellLoaderFailure('pwsh', loaderFailureResult, decision, logger)).toBe(decision)
  })

  it('leaves a value replacement alone', () => {
    // When a hook replaced the structured value, the rendered content is not what
    // the caller reads — and the harness refuses a decision carrying both.
    const decision = { kind: 'accept', value: { ok: true } }
    expect(diagnoseShellLoaderFailure('pwsh', loaderFailureResult, decision, logger)).toBe(decision)
  })

  it('returns the decision untouched when there is nothing to diagnose', () => {
    logger.warn.mockClear()
    const decision = { kind: 'accept' }
    expect(diagnoseShellLoaderFailure('pwsh', [{ type: 'text', text: '[exit code: 1]' }], decision, logger)).toBe(decision)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not repeat a diagnosis the seam already appended', () => {
    const diagnosed = withShellLoaderFailureNote('pwsh', loaderFailureResult)
    if (diagnosed === undefined) throw new Error('expected a diagnosis')
    expect(diagnoseShellLoaderFailure('pwsh', diagnosed, { kind: 'accept' }, logger)).toEqual({ kind: 'accept' })
  })
})

describe('reportedExitCode', () => {
  it('reads the last marker, because that is the command the result ends on', () => {
    const text = 'cmd one\n[exit code: 2]\ncmd two\n[exit code: 3221225794]'
    expect(reportedExitCode(text)).toBe(STATUS_DLL_INIT_FAILED)
  })

  it('ignores anything that is not the shell marker', () => {
    expect(reportedExitCode('exit code: 3221225794')).toBeUndefined()
    expect(reportedExitCode('[exit code: 1.5]')).toBeUndefined()
  })
})

describe('isLoaderFailureExitCode', () => {
  it('accepts both widths of the NTSTATUS and nothing else', () => {
    expect(isLoaderFailureExitCode(STATUS_DLL_INIT_FAILED)).toBe(true)
    expect(isLoaderFailureExitCode(-1073741502)).toBe(true)
    expect(isLoaderFailureExitCode(1)).toBe(false)
    expect(isLoaderFailureExitCode(Number.NaN)).toBe(false)
  })
})
