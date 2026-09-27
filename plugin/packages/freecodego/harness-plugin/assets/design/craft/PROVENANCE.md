# OpenDesign craft provenance

The Markdown under this directory is vendored third-party prose from
[nexu-io/open-design](https://github.com/nexu-io/open-design). It is not covered by this package's
AGPL-3.0-only license; this directory's `LICENSE` carries the upstream terms,
and two of the sections carry a second, nested attribution they state
themselves (`color.md`, `anti-ai-slop.md`: adapted from `refero_skill`, MIT).

## Source and snapshot

| | |
|---|---|
| Project | OpenDesign |
| Repository | https://github.com/nexu-io/open-design |
| Upstream version | 0.23.1 |
| Snapshot commit | unrecorded (source tree carries no .git) |
| Snapshot date | 2026-09-26 |
| License | Apache-2.0 (no NOTICE file upstream) |
| Vendored files | 13 |
| Craft sections | 11 |

## What was adapted, and why

The text is upstream. One adaptation is applied by
`scripts/vendor-craft.mjs` as a rule, so a re-sync replays it rather than
requiring anyone to remember it:

- **Six glyphs are named rather than drawn.** `anti-ai-slop.md` forbids
  emoji as feature icons and therefore writes six of them down. Those are
  replaced by their code point and Unicode name, so the rule still says
  which glyphs it means while no emoji-presentation glyph ships. No other
  change was made to any file; the substitution is listed below.

| Glyph as named | In |
|---|---|
| `U+2728 SPARKLES` | `anti-ai-slop.md` |
| `U+1F680 ROCKET` | `anti-ai-slop.md` |
| `U+1F3AF DIRECT HIT` | `anti-ai-slop.md` |
| `U+26A1 HIGH VOLTAGE` | `anti-ai-slop.md` |
| `U+1F525 FIRE` | `anti-ai-slop.md` |
| `U+1F4A1 LIGHT BULB` | `anti-ai-slop.md` |

## References to upstream paths

Several sections cite upstream's own repository where a rule is auto-checked or a
sibling layer is described — `apps/daemon/src/lint-artifact.ts` for the rules the
linter enforces, `design-systems/` for the brand packages craft sits on top of.
Those paths do not exist in this package: they are kept because they say *where*
upstream enforces a rule, which is the difference between a hard rule and guidance
— and rewriting upstream prose to hide its own layout is the kind of edit that
makes a notice untrue.

## Forward references

FUTURE_SECTIONS.md lists slugs upstream has referenced but not yet shipped. The tool
reads that file rather than a copy of it, so an unknown slug and a *planned*
slug give different answers. Registered at this snapshot:

- `motion-discipline`
- `pixel-discipline`
- `typographic-rhythm`

| Vendored file | Bytes | SHA-256 |
|---|---|---|
| `accessibility-baseline.md` | 12894 | `ef6c5f670d114ceb4c347681bcf3be8637e5d1186165a9c79ca265f316c72d11` |
| `animation-discipline.md` | 9114 | `075273e8404f7931adfe196d508461efdd303b54e0d9a9ef3f642a682c12a760` |
| `anti-ai-slop.md` | 4004 | `9b4e07fff77c95e581719b5bd0c9658f637847b4591a7bc2ba0c8c8bbc6544f2` |
| `color.md` | 3117 | `fb45b59fa3055f13d6549f45ae52e88cd09d3facd0e5aaab63600e7fb024db6d` |
| `form-validation.md` | 17186 | `a31410ce6ba8b7a762c2975386f2e93ae97b59a8bc85169aa58457927b0a88e6` |
| `FUTURE_SECTIONS.md` | 291 | `e95ccf61e166cfc3dc7266bfaaabb3e8cec1dc9c8d134eb63ad064343aa7d9bc` |
| `laws-of-ux.md` | 17339 | `9a4db0fe294a240920921111d43a6af5ea0c4df1bf979f6e780610a36a9c6d1c` |
| `README.md` | 6309 | `7b18e690c995226706c7f8f50229a9f9e170ad3b6675bd031c8d8751682c3c46` |
| `rtl-and-bidi.md` | 12159 | `713abc3707eb056ed1d40ca8f3e91c04afc4003251b9ed266650fd267cbf4391` |
| `state-coverage.md` | 7084 | `79bda732b55b0f0e4a366ba934f4a01518d3576091422047690e269222f2b682` |
| `typography-hierarchy-editorial.md` | 8748 | `df5beddb8cd3c2b8f15e74f57ada607f7a89ce9112aaa8f8fad22d89e452bea4` |
| `typography-hierarchy.md` | 7414 | `e247ca0358dcbdc3921f2148cc44c6ddcc325429b8082f6ad033792b79e39e06` |
| `typography.md` | 4781 | `5f8e634b35c6b27a5e86f748825da17efe6a0d2e96f68dc35f57f406420049a6` |
