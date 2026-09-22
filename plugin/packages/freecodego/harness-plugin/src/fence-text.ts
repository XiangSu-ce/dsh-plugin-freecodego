/**
 * Escaping for text that is interpolated into a tagged block.
 *
 * Several injected blocks are found again by matching their delimiters: the
 * readers in `agent-progress.ts` and `engineering.ts` strip them, and
 * `prompt-composition-collect.ts` classifies them by tag. The text inside such a
 * block is not always ours — Skill descriptions come off disk (including packs a
 * user installed), memory bodies are model-written — so a value that carries the
 * closing tag ends the block on a line it chooses, and everything after it is
 * read as the surrounding conversation, or as the agent's own words.
 *
 * Escape, do not drop: the value still reads as text, it just cannot be mistaken
 * for a delimiter. A block built this way contains exactly one opening and one
 * closing tag, which is what lets a reader stay simple.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/fence-text
 */

/** A tag name is used as a pattern, so anything special in it is escaped. */
function tagSource(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Escape the delimiters of `tag` in `value`, before it is interpolated into a
 *  block fenced by that tag.
 * @param value - the text to neutralize.
 * @param tag - the tag whose delimiters to escape.
 * @returns the text with any delimiters of that tag escaped.
 */
export function neutralizeFenceTags(value: string, tag: string): string {
  return value.replace(new RegExp(`<(/?)(${tagSource(tag)})`, 'gi'), '&lt;$1$2')
}
