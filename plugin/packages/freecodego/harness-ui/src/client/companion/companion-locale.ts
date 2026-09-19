/**
 * Locale namespace for the companion's label.
 *
 * The keys are the engine's own state ids, which makes the dictionary **total
 * over the state table**: adding a state to the vendored engine stops compiling
 * here until it is named in both languages. That is the point of keying it this
 * way rather than listing only the states the ladder can currently reach — a
 * label that is missing because the engine grew is a bug this file cannot have.
 *
 * The namespace is what keeps a bare `idle` from colliding with another
 * surface's key of the same name.
 */
import type { StateId } from './engine/states.ts'

/** Locale namespace owning every string below. */
export const NS = 'freecodego.companion'

/** One key per engine state: the label asked for is the state that is showing. */
export type CompanionKey = StateId

/**
 * What each pose means, in the words the rest of this plugin's Chinese UI uses.
 * The states the ladder never calls for are named too: they are reachable from
 * the engine, and an unnamed one would be a hole in the table rather than a
 * state that cannot happen.
 */
export const zh: Record<CompanionKey, string> = {
  idle: '空闲',
  wink: '眨眼',
  wide: '注视',
  notify: '有新消息',
  exclaim: '出错了',
  sleep: '已休眠',
  egg: '就绪',
  hexagon: '处理中',
  play: '开始',
  orbit: '执行中',
  burst: '已完成',
  comet: '输出中',
  thinking: '思考中',
  swirl: '切换中',
  alert: '等待你的确认',
}

/** {@link zh}, in English. */
export const en: Record<CompanionKey, string> = {
  idle: 'Idle',
  wink: 'Wink',
  wide: 'Watching',
  notify: 'New message',
  exclaim: 'Failed',
  sleep: 'Asleep',
  egg: 'Ready',
  hexagon: 'Processing',
  play: 'Starting',
  orbit: 'Working',
  burst: 'Done',
  comet: 'Responding',
  thinking: 'Thinking',
  swirl: 'Switching',
  alert: 'Waiting for you',
}
