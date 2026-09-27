# tweet — category module (search-driven)

**Search a tweet → animate the tweet card.** Grounded in a real post (RWA). ~4–8s.

## Source (Step 2)

RWA `search_tweets` (specific query, or a given tweet URL/id) → tweet: author, handle, avatar, text, timestamp, metrics (likes/reposts). `asset_needs`: `{ kind: tweet, query|source, treatment: none }`. Freeze the avatar + any embedded media.

## Vocabulary / leans on

- Block: registry **`x-post`** (animated X/Twitter post card overlay with engagement metrics) — reuse it directly.
- Primitives: card slide/scale-in · text type-on / line reveal · avatar pop · metrics **count-up** · optional emphasis on a keyword.

## Build (reuse-first)

This plugin ships no hosted block registry, so the effect is built from the local materials this skill carries.
