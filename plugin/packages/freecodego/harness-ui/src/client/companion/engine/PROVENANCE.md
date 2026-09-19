# Vendored engine provenance

The files in this directory are third-party code, copied verbatim. They are **not**
covered by this repository's AGPL-3.0-only license; see `LICENSE` in this directory.

## Source

| | |
|---|---|
| Project | `bloub` — "SVG recreation of the x.ai bot avatar. One shape morphing through 14 states, measured off the reference video frame by frame." |
| Repository | https://github.com/jeremy-prt/bloub |
| Version | 0.1.1 (as downloaded) |
| Copyright | © 2026 Jérémy Perret |
| License | MIT |

## What was copied

Eleven of the upstream `src/bot/**` modules — the pure engine layer, which has no
framework, no DOM, and no clock.

Each local copy carries one prepended block that upstream does not have: the MIT notice,
and a file-level coverage-ignore directive (this repository gates coverage per file at
100%, and upstream's own suite is this code's correctness signal). **Below that block the
files are byte-identical to upstream**, which is what the hashes below check. The block is
exactly its first five lines, so a copy verifies by dropping them:

```sh
tail -n +6 engine.ts | sha256sum
```

The table lists the SHA-256 of the **upstream** file, so a re-sync can be checked against
it directly.

| File | Upstream SHA-256 |
|---|---|
| `decor.ts` | `6c300f8aaa7d2f95c13b35993753b0542779528d16bd8e1d01507e467fe52d04` |
| `engine.ts` | `d824c715b6ec38b241fc61ae2ac516d7c1623f9603f88942b4585cdd9307e638` |
| `expressions.ts` | `66c5562afcf376c7fde0c83b6c9cc953f1313d9e2f910e2b94fd24098aa52ae5` |
| `eyefit.ts` | `8da411d7643c24f383d2d994a4668e43292c9810a6f63c257dbfd13f61284e9b` |
| `face.ts` | `f9ddf7f750b101dbf6fa29acc95fe5fbdeec41c96b2873b1a844df2b5c1bd8c8` |
| `math.ts` | `736be559b961109c3ca2a4c88d7992e99ceaff46450a522d47e596c1def99c0f` |
| `profiles.ts` | `62dc55bc860b9e2b1f7a43168cee8738b68b42bf4d07f668d32984ee886f02d3` |
| `repere.ts` | `2f74419387868a13c2f887a714c7442b130753d938732d91f39905f39ab2030e` |
| `shape.ts` | `72020197e3ff117487ed670d915dfb3297b8034f7e9a803f573f15b3dd41d44e` |
| `skins.ts` | `2fa0f296e8a49b7b81458eebb98b6ecb44d1073bdc815a46e7846819b743b3c3` |
| `states.ts` | `7b67bfc4ee95011225a2cef542866dacde0a1c044a56f174bee4173b82cec207` |

This is the transitive import closure of `engine.ts` plus `repere.ts`. No file was
modified; the upstream author's TypeScript strictness (`strict`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) is at least as tight
as this repository's, so the copy compiles here unchanged.

## What was deliberately left out

| Upstream file | Why not here |
|---|---|
| `eyefit.ts`'s consumers | kept — the engine imports it, and it is what makes the shape × state × expression space solvable |
| `cycles.ts` (225 lines) | the montage editor's block sequencer; this companion is event-driven, not a playlist player |
| `*.test.ts` (4 files, ~900 lines) | upstream's own suite, written against its fixtures; this repository asserts the behaviours it depends on in its own tests instead |
| `export.ts`, `capture.ts`, the Vue layer | the browser-only raster/serialization surfaces; this companion renders its own SVG |

## What this repository adds around it

The engine is a pure function of time: `sample(t) → BotFrame`. Everything below is ours,
not upstream's:

- `../render.tsx` — the frame → SVG renderer.
- `../arbiter.ts` — the session-event → state machine.
- `../signals.ts` — the session-facts → arbiter-signals projection.
- `../driver.ts` — the shared animation clock.
- `../view.ts` — the half both seats share: the facts, the clock subscription, and the
  reduced-motion freeze.
- `../companion.tsx` — the sidebar rail's brand-mark seat and the single entry point that
  seats both surfaces.
- `../bar.tsx` — the composer-strip seat: its column measurement and slot registration.
- `../companion-locale.ts` — the label namespace, one key per engine state.

## Licensing note for redistributors

MIT covers this engine code, the measured radial profiles, and the curve tables. It does
**not** grant any right in the character design: upstream describes itself as a recreation
of the x.ai bot avatar, so the silhouette is a third-party brand likeness. Upstream's own
`README` frames the project that way. Replacing `profiles.ts` with your own measured
silhouette is the supported path for a redistribution that does not want to lean on that
likeness — `repere.ts` and `shape.ts` are written so that the shape is pure data.
