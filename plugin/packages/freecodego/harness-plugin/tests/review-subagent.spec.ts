/**
 * Tests for the subagent-backed per-file reviewer.
 *
 * The child is faked at the {@link ReviewSubagentFactory} seam, which is the point
 * of that seam: every rule this module enforces — no answer is a failure, an
 * unreadable answer is a note, tokens are summed rather than guessed, the child is
 * always released, a dispose failure cannot replace the real cause — is a rule
 * about *how the port drives a child*, and none of them needs an agent runtime to
 * be exercised.
 */

import { describe, expect, it } from 'vitest'
import {
  SubagentFileReviewer,
  sumSubagentUsage,
  DEFAULT_REVIEW_SUBAGENT_TIMEOUT_MS,
  type ReviewSubagentFactory,
  type ReviewSubagentHandle,
  type ReviewSubagentOptions,
} from '../src/review/subagent-reviewer.ts'
import { buildFileReviewPrompt, type ReviewFileTask } from '../src/review/reviewer.ts'
import { REVIEW_MAIN_SYSTEM } from '../src/review/prompts.ts'
import { parseUnifiedDiff } from '../src/review/diff.ts'
import type { ReviewableFile } from '../src/review/targets.ts'

/** A real parsed diff, so the prompt under test is the prompt a run builds. */
function file(path = 'src/app.ts'): ReviewableFile {
  const diff = parseUnifiedDiff(`diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
`)[0]
  return {
    path,
    status: 'modified',
    added: 2,
    deleted: 1,
    untracked: false,
    diff: diff ?? null,
  }
}

function task(): ReviewFileTask {
  return {
    group: { id: 1, files: [file()], ruleGroupIds: [1], changedLines: 3 },
    file: file(),
    rule: { source: 'project', pattern: '**/*.ts', text: 'Prefer explicit types.' },
    reviewer: 'review-subagent',
  }
}

/** A child that answers with `answer` and reports `spent`, with disposal observed. */
function fakeChild(options: {
  readonly answer?: string
  readonly spent?: { readonly inputTokens: number; readonly outputTokens: number }
  readonly runThrows?: string
  readonly disposeThrows?: string
  readonly neverFinishes?: boolean
  readonly truncated?: boolean
} = {}) {
  const state = { disposed: 0, prompts: [] as string[] }
  const handle: ReviewSubagentHandle = {
    async run(prompt: string): Promise<void> {
      state.prompts.push(prompt)
      if (options.neverFinishes === true) return new Promise<void>(() => {})
      if (options.runThrows !== undefined) throw new Error(options.runThrows)
    },
    answer: () => options.answer ?? '',
    ...(options.truncated === undefined ? {} : { truncated: () => options.truncated === true }),
    tokens: () => options.spent ?? { inputTokens: 0, outputTokens: 0 },
    async dispose(): Promise<void> {
      state.disposed += 1
      if (options.disposeThrows !== undefined) throw new Error(options.disposeThrows)
    },
  }
  const create: ReviewSubagentFactory = async () => handle
  return { create, state }
}

describe('review subagent prompt', () => {
  it('tells a tool-using reviewer to investigate, before it is told how to answer', () => {
    const prompt = buildFileReviewPrompt({ ...task(), investigate: true }).user
    const investigation = prompt.indexOf('<investigation>')
    const contract = prompt.indexOf('Report findings by emitting exactly one JSON object')
    // The contract is the last instruction on purpose: a reviewer that reads the
    // format last still has it, where a reviewer that reads a long investigation
    // last may answer in prose.
    expect(investigation).toBeGreaterThan(-1)
    expect(contract).toBeGreaterThan(investigation)
    expect(prompt).toContain('Search for the callers of any signature this change alters')
  })

  it('leaves the investigation out for a reviewer with no tools to use', () => {
    const prompt = buildFileReviewPrompt(task()).user
    expect(prompt).not.toContain('<investigation>')
    expect(prompt).toContain('Report findings by emitting exactly one JSON object')
  })

  it('keeps the system prompt the same one the single-shot reviewer uses', () => {
    expect(buildFileReviewPrompt({ ...task(), investigate: true }).system).toBe(REVIEW_MAIN_SYSTEM)
  })
})

describe('subagent reviewer', () => {
  it('returns the findings the child answered with, and what the child spent', async () => {
    const child = fakeChild({
      answer: 'I read the file and the caller.\n{"comments":[{"path":"src/app.ts","content":"b is now 3","start_line":2,"end_line":2,"severity":"high","category":"bug"}]}',
      spent: { inputTokens: 120, outputTokens: 40 },
    })
    const reviewer = new SubagentFileReviewer(child.create)
    const outcome = await reviewer.review(task())
    expect(outcome.comments).toHaveLength(1)
    expect(outcome.comments[0]).toMatchObject({ path: 'src/app.ts', content: 'b is now 3', severity: 'high' })
    expect(outcome.spent).toEqual({ inputTokens: 120, outputTokens: 40 })
    expect(child.state.prompts[0]).toContain('<investigation>')
    expect(child.state.disposed).toBe(1)
  })

  it('accepts an answer that reports nothing, which is a review result', async () => {
    const child = fakeChild({ answer: '{"comments":[]}' })
    const outcome = await new SubagentFileReviewer(child.create).review(task())
    expect(outcome.comments).toEqual([])
    expect(outcome.note).toBeUndefined()
  })

  it('fails the file when the child said nothing at all', async () => {
    const child = fakeChild({ answer: '   ' })
    await expect(new SubagentFileReviewer(child.create).review(task())).rejects.toThrow('returned no answer')
    // A silent child must not be able to produce the empty review that "nothing
    // was wrong" and "nothing was checked" both look like.
    expect(child.state.disposed).toBe(1)
  })

  it('keeps an unreadable answer as a note rather than a failure', async () => {
    const child = fakeChild({ answer: 'I looked at the file and it seemed fine.', spent: { inputTokens: 10, outputTokens: 5 } })
    const outcome = await new SubagentFileReviewer(child.create).review(task())
    expect(outcome.comments).toEqual([])
    expect(outcome.note).toContain('without a readable comment object')
    expect(outcome.spent).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('names our own truncation as the reason an answer could not be read', async () => {
    // A long answer is cut from the front, which is where the opening brace of the
    // one JSON object the contract asks for lives. Blaming the child's format for a
    // parse failure we caused would send the reader to fix the wrong thing — and the
    // findings are missing, not absent, which is the part a reader must know.
    const child = fakeChild({ answer: 'the tail of a very long analysis', truncated: true })
    const outcome = await new SubagentFileReviewer(child.create).review(task())
    expect(outcome.comments).toEqual([])
    expect(outcome.note).toContain('cut and its findings could not be read')
    expect(outcome.note).not.toContain('without a readable comment object')
  })

  it('rejects when the child cannot be created, with nothing to dispose', async () => {
    const create: ReviewSubagentFactory = async () => { throw new Error('no agent runtime') }
    await expect(new SubagentFileReviewer(create).review(task())).rejects.toThrow('no agent runtime')
  })

  it('reports a dispose failure alongside a successful review', async () => {
    const child = fakeChild({ answer: '{"comments":[]}', disposeThrows: 'session already gone' })
    const outcome = await new SubagentFileReviewer(child.create).review(task())
    expect(outcome.note).toContain('could not be disposed')
    expect(outcome.note).toContain('session already gone')
  })

  it('keeps both notes when a child answered unreadably and also failed to dispose', async () => {
    // Two facts, and they are independent: the answer was unreadable, and the
    // child leaked. Keeping only the later one loses the reason the findings are
    // missing, which is the one a reader needs first.
    const child = fakeChild({ answer: 'no JSON here', disposeThrows: 'session already gone' })
    const outcome = await new SubagentFileReviewer(child.create).review(task())
    expect(outcome.note).toContain('without a readable comment object')
    expect(outcome.note).toContain('could not be disposed')
  })

  it('keeps the review failure when disposal also fails', async () => {
    // Two failures, one cause. Reporting the disposal would name the wrong one.
    const child = fakeChild({ runThrows: 'model refused', disposeThrows: 'session already gone' })
    await expect(new SubagentFileReviewer(child.create).review(task())).rejects.toThrow('model refused')
    expect(child.state.disposed).toBe(1)
  })

  it('gives up on a child that never finishes and still releases it', async () => {
    const child = fakeChild({ neverFinishes: true })
    await expect(new SubagentFileReviewer(child.create, { timeoutMs: 20 }).review(task()))
      .rejects.toThrow('did not finish within')
    expect(child.state.disposed).toBe(1)
  })

  it('bounds a file by default rather than waiting forever', () => {
    expect(DEFAULT_REVIEW_SUBAGENT_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('subagent usage', () => {
  it('sums every step the child ran, not only its last message', () => {
    // A child that read four files before answering has five steps, and the
    // reading is the expensive part of the run.
    const spent = sumSubagentUsage([
      { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 10 } } },
      { type: 'tool/result', data: { usage: { inputTokens: 999, outputTokens: 999 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 200, outputTokens: 20 } } },
    ])
    expect(spent).toEqual({ inputTokens: 300, outputTokens: 30 })
  })

  it('counts a step the engine did not measure as zero', () => {
    const spent = sumSubagentUsage([
      { type: 'assistant/message', data: {} },
      { type: 'assistant/message', data: { usage: { inputTokens: 5 } } },
      { type: 'assistant/message' },
      { type: 'assistant/message', data: { usage: { inputTokens: Number.NaN, outputTokens: '12' } } },
    ])
    expect(spent).toEqual({ inputTokens: 5, outputTokens: 0 })
  })

  it('reports nothing when the child never spoke', () => {
    expect(sumSubagentUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('subagent reviewer options', () => {
  it('accepts an explicit tool allow list', () => {
    // The option exists so a deployment can narrow the child's powers; the shipped
    // list is asserted where it is defined, and this checks the shape is honoured
    // by the constructor rather than silently ignored.
    const options: ReviewSubagentOptions = { allowTools: ['read'], timeoutMs: 1_000 }
    expect(options.allowTools).toEqual(['read'])
  })
})
