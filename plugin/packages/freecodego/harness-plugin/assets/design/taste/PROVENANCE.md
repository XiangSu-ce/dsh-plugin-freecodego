# Taste-Skill provenance

The Markdown under this directory is vendored third-party prose from
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill). It is not covered by this package's
AGPL-3.0-only license; this directory's `LICENSE` carries the upstream MIT terms.

## Source and snapshot

| | |
|---|---|
| Project | Taste-Skill |
| Repository | https://github.com/Leonxlnx/taste-skill |
| Snapshot commit | `ce26fc25c0e5e8cab638f883de62d9a86ee5e45b` |
| Snapshot commit date | 2026-09-26T09:01:50Z |
| License | MIT |
| Copyright | Copyright (c) 2026 Leonxlnx |
| Vendored files | 19 |

## What was adapted, and why

The text is upstream. Two adaptations are applied by
`scripts/vendor-taste-skills.mjs` as rules, so a re-sync replays them rather
than requiring anyone to remember them:

- **Emoji are removed.** A terminal may draw an emoji-presentation glyph at
  double width or as a box, and these bodies are rendered in the Skills page,
  copied into a workspace and read as prompt text. Verdict glyphs keep their
  meaning as words (`PASS` / `FAIL` / `UNVERIFIABLE`), matching the
  substitution the other vendored packs record; every other glyph is dropped,
  and only the whitespace immediately around it is collapsed, so indented
  examples and ASCII diagrams survive.
- **Bodies are split, never shortened.** `inspectSkillRoot()` reports a body
  over 64 KiB, and the remedy used here is the one the HyperFrames pack
  already uses: the widest section moves into the Skill's own `references/`
  directory and the body links it where it stood. No sentence is cut.

The 5,000-token budget this package enforces on Skills it publishes is **not**
applied to these bodies. They are opt-in per row and a body is paid for only
when its Skill is selected, which is the trade the design page states on the
row itself; the sizes are recorded below so the choice is visible.

| Body | Section moved to | Bytes moved |
|---|---|---|
| `skills/taste-skill/SKILL.md` | `taste-skill/references/9-f-production-test-tells-banned-outright.md` | 8107 |
| `skills/taste-skill/SKILL.md` | `taste-skill/references/4-7-layout-discipline-hard-rules-failing-any-of-.md` | 6124 |
| `skills/taste-skill/SKILL.md` | `taste-skill/references/4-8-image-visual-asset-strategy.md` | 3862 |
| `skills/taste-skill/SKILL.md` | `taste-skill/references/4-9-content-density.md` | 3507 |
| `skills/taste-skill/SKILL.md` | `taste-skill/references/4-2-color-calibration.md` | 3060 |

| Vendored file | Bytes | SHA-256 |
|---|---|---|
| `brandkit/SKILL.md` | 15992 | `b0c4837e1bd140ca816ae54948754ddd2ac1e2a4d3619363777a80caf00b2ede` |
| `brutalist-skill/SKILL.md` | 8456 | `fffbaac8597f07679e9d87145533567658aedba3b5eca6f16a7075a333048caa` |
| `gpt-tasteskill/SKILL.md` | 7857 | `2e64c269953f2656c21bf5a0fa6b4568e82fe0c72b36e8f84758e090349966a5` |
| `image-to-code-skill/SKILL.md` | 36442 | `4c060a8064a8b13380bc2ef3d6e6a1d0b1e316aa093cd9807d0ce9e4eeb037fa` |
| `imagegen-frontend-mobile/SKILL.md` | 40326 | `8a33389979f3074fa0926678e266ad2eb9234624472254469fc1ad916b9caa24` |
| `imagegen-frontend-web/SKILL.md` | 36854 | `6b5c2256522fdba1e3313eafa3d743b960a7b13ec029d3e6586e04b23327c1f8` |
| `minimalist-skill/SKILL.md` | 7901 | `36bc7328f085405f43b476938e62460fa573bf7e984e949e072bcf014831a44c` |
| `output-skill/SKILL.md` | 2592 | `e5bf48b1ae561511439cf71672209a10a88cee0968cc925909ff861dfa0a96a7` |
| `redesign-skill/SKILL.md` | 15060 | `98ad3e5b051bfb71b2795f7e8a6aa0d32b51ee095606c098a4b2822ac07926c9` |
| `soft-skill/SKILL.md` | 10561 | `e1e32f5e2d420872c6c7332b53d5ff7721946766b78c4822b424c2d512c8fdbc` |
| `stitch-skill/DESIGN.md` | 12053 | `0ab6740c4ebb1966dbceddb823a66d4bf027e960efbd73faca56cbf8370ae2ad` |
| `stitch-skill/SKILL.md` | 11851 | `46bdb08fee2dded38b6ba0a051230a502d6ac6e4044afd47592cb40c256028b5` |
| `taste-skill-v1/SKILL.md` | 21195 | `033d45af1ed23832730642f95f40ab49db7fb5222848489a6c5656144bfc6dae` |
| `taste-skill/references/4-2-color-calibration.md` | 3060 | `557d3df55f70eb7e8476a707283bb6b35c1561ce4501be811574e5d16c2f8525` |
| `taste-skill/references/4-7-layout-discipline-hard-rules-failing-any-of-.md` | 6123 | `89ca955ee832e4d654e1a46d69f70d65475bc3eb350c6b523aff7c54331aed16` |
| `taste-skill/references/4-8-image-visual-asset-strategy.md` | 3861 | `db06deee80ebaf1e88a93477d8712c88a4d7d00267c6327dfcb1f9bd53bd9b3a` |
| `taste-skill/references/4-9-content-density.md` | 3506 | `9c6b58ac9e534478aad68099707781957649bf2fe968ea87a555ea91e13aab0c` |
| `taste-skill/references/9-f-production-test-tells-banned-outright.md` | 8106 | `0990a1311abb14011a98dcddbcb7e58fbe3882b78e11b6ae3995fda2bd2c0a32` |
| `taste-skill/SKILL.md` | 63589 | `59be0b27c46ea066dbf82e0ba30e1be8608abb020fd2db7f3d079dde03e741af` |
