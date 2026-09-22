/**
 * The real model port: the review stages over the harness's own LLM stream.
 *
 * Why the seam is structural
 * -------------------------
 * This module needs exactly one method — `stream` — so it declares exactly that,
 * rather than importing the Host's LLM service type. The plugin's host layer is
 * hand-typed structurally everywhere else for the same reason: a review engine
 * that hard-depends on the whole LLM service cannot be loaded in a composition
 * that mounts a different one, and none of the four stages uses anything beyond
 * `stream`.
 *
 * Why a failed finish is an exception, not empty text
 * --------------------------------------------------
 * `BlockAssembler.finish` distinguishes a completed answer from one cut off by an
 * error, an abort, or the output ceiling. Folding those into "the model said
 * nothing" is the failure mode this whole module exists to avoid: an empty
 * grouping proposal would look like a valid grouping, and an empty filter verdict
 * list would silently approve every comment — which is *almost* right, and wrong
 * in exactly the case where the provider was down and every comment should have
 * been kept *and the run should say why*. So each non-success finish rejects, and
 * the stage above decides: grouping falls back, filtering fails open, the reviewer
 * marks the file failed.
 *
 * Token accounting falls back to an estimate only when the provider reported
 * nothing, so the budget bound is never absent — it is at worst approximate, and
 * the direction of the approximation is stated.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/llm-port
 */

import { BlockAssembler, createUserMessage, type GenerateOptions, type Message, type MessageSource, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Provenance recorded on every review prompt, so the transcript says who asked. */
const REVIEW_MESSAGE_SOURCE: MessageSource = { kind: 'plugin', plugin: 'freecodego/review' }
import { approximateTokens, type ReviewModelPort, type ReviewModelRequest, type ReviewModelResult } from './model.ts'
import { redactCredentialShapes } from '../secret-scan.ts'

/** The single LLM method the review stages need. */
export interface ReviewLlmSeam {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** The provider and model a run's calls are made with. */
export interface ReviewModelRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Build a model port over one LLM seam.
 *
 * The route is a *function* rather than a value because settings are readable at
 * any time and the plugin's own settings scope can change under a running
 * composition; binding a route at construction would freeze the first answer for
 * the life of the plugin, so a user who fixes a mistyped model would keep getting
 * the old one until reload. An undefined route rejects, which the stages above
 * already handle in the direction each of them should (grouping falls back,
 * filtering fails open, a file review fails that file).
 */
export function createReviewModelPort(
  llm: ReviewLlmSeam,
  resolveRoute: () => ReviewModelRoute | undefined,
  sessionId?: GenerateOptions['sessionId'],
): ReviewModelPort {
  return {
    async generate(request: ReviewModelRequest): Promise<ReviewModelResult> {
      const route = resolveRoute()
      if (route === undefined) {
        throw new Error('no review model route is configured: set a provider and model in the plugin settings')
      }
      const assembler = new BlockAssembler()
      // `source` is required and is a plugin provenance claim, not decoration:
      // it is how the transcript distinguishes a review's own prompt from
      // something a user or a tool wrote, which the auto-review path in the
      // harness's own reviewer already depends on.
      const messages: Message[] = [
        createUserMessage({ content: [{ type: 'text', text: request.user }], source: REVIEW_MESSAGE_SOURCE }),
      ]
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages,
        system: request.system,
        ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }

      for await (const chunk of llm.stream(options)) assembler.push(chunk)

      const finish = assembler.finish
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        // Masked, because a provider's failure message is upstream text that can
        // quote the request back — including the credential in the header it
        // rejected. This is the boundary `upstream-text-masking.spec.ts` exists to
        // keep: the message leaves this process as an error a user reads.
        throw new Error(`the review model call failed: ${redactCredentialShapes(finish.failure.message)}`)
      }
      if (finish?.kind === 'max-tokens') {
        throw new Error('the review model response exceeded its output limit')
      }

      const text = assembler.blocks()
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      const usage = assembler.usage
      return {
        text,
        inputTokens: usage?.inputTokens ?? approximateTokens(`${request.system}\n${request.user}`),
        outputTokens: usage?.outputTokens ?? approximateTokens(text),
      }
    },
  }
}
