# Director → catalog block map (reuse-first)

<!-- registry-items: allow=geo-highlight,geo-flow,flag-borders,pin-rollout,stat-motion,data-composition-src -->
<!-- allow= entries above are deliberately NOT registry items: geo-*/flag-borders/pin-rollout and stat-motion are hand-authored gaps this file names in order to say they are gaps. -->

**Search the live catalog before you use this table, and again before any hand-authored effect.** Run
This plugin ships no hosted look registry, so the local materials this skill carries are the catalogue.
user asks for ("CRT scanlines", "glitch", "film grain", "shimmer sweep"), including effects asked for
mid-build. **The search needs nothing installed**: it ranks the whole hosted registry (~400 items) from any
directory, with no project, no prior `add`, and no account. The table below is a hand-maintained snapshot of
part of that registry and it under-covers by design — treat a miss here as unproven, and only the search's
own empty result as evidence the catalog lacks the move. When it does, say so with
This pack collects no telemetry.
before hand-authoring. Full flags and tiers: `/hyperframes-registry` → § Discovery.

This plugin ships no hosted block registry, so the effect is built from the local materials this skill carries.

After classifying intent → category, the **Director names the block(s) + what to customize** in the shot-plan IR:

```jsonc
"content": { "block": "data-chart", "customize": { "data": [...], "headline": "…", "palette": ["…"] } }
```

## Category → block(s)

| Category               | Borrow from catalog                                                                                                                                                                                                                                                                                                                                                                         | Customize                                                                                        | Gaps → hand-author                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **kinetic-typo**       | one of **17 `caption-*`** (kinetic-slam, editorial-emphasis, clip-wipe, gradient-fill, neon-glow, glitch-rgb, matrix-decode, particle-burst, weight-shift, pill-karaoke, highlight, blend-difference…)                                                                                                                                                                                      | words; `emphasis_words` → `word--emphasis`; palette; font; timing                                | a motif none of the 17 cover                                                                                   |
| **charts**             | `data-chart` (bar+line, staggered, value labels), `bar-chart-race` (a race)                                                                                                                                                                                                                                                                                                                 | edit the data array + headline/subtitle; `--bg`/`--text`                                         | pie/donut, ring/%                                                                                              |
| **stat**               | `apple-money-count` (finance: $ counter + burst + SFX) **or** hand-author a generic %/number + ring per `categories/stat/module.md` (there is no `stat-motion` block)                                                                                                                                                                                                                       | target, prefix/suffix, label, palette                                                            | —                                                                                                              |
| maps/geo               | **vector lane**: `us-map` (+bubble/hex/flow), `world-map`, `spain-map` + **hand-author** `geo-highlight`/`geo-flow`/`flag-borders`/`pin-rollout` (NOT in registry — build per `categories/maps/module.md`). **basemap lane** (real satellite/dark / zoom-to-place): bake via `categories/maps/bake-basemap.mjs` → `<video>` + geo-aligned SVG overlay (border draw-on + colour-block fills) | regions/data, palette, callouts/connectors, basemap style                                        | (basemap lane now covers real imagery + zoom-to-address — was the gap)                                         |
| diagram                | `flowchart` (SVG connectors + nodes)                                                                                                                                                                                                                                                                                                                                                        | nodes, edges, labels                                                                             | —                                                                                                              |
| **brand reveal**       | `logo-outro` (piece assembly + glow + tagline + URL pill)                                                                                                                                                                                                                                                                                                                                   | logo asset, tagline, URL, palette                                                                | —                                                                                                              |
| transitions            | 15+ shader transitions (domain-warp, whip-pan, sdf-iris, glitch…)                                                                                                                                                                                                                                                                                                                           | direction, timing                                                                                | —                                                                                                              |
| social overlay         | ig / tiktok / yt / x / reddit / spotify / macos cards                                                                                                                                                                                                                                                                                                                                       | handle, metrics, avatar                                                                          | —                                                                                                              |
| polish                 | grain-overlay, vignette, shimmer-sweep, texture-mask-text                                                                                                                                                                                                                                                                                                                                   | intensity                                                                                        | —                                                                                                              |
| **asset-fusion (RWA)** | **annotation kit from `north-korea-locked-down`** — scribble-circle draw-on, pop-up pill + pointer, red-wash, scanline, corners, camera push; + `us-map-bubble` callouts/connectors                                                                                                                                                                                                         | asset, annotation position (`element_positions`), label, palette **eyedropper'd from the asset** | **NET-NEW (not in catalog): the affordance binding — asset geometry _becomes_ the chart axis (straw → gauge)** |

## Reuse mechanics

This plugin ships no hosted block registry, so the effect is built from the local materials this skill carries.
- Blocks ship at fixed canvases (1920×1080 / 1080×1920 / 1080×1080) — match or adapt.
- Blocks already follow the HF contract (paused timeline, seek) — keep it.

## Asset-fusion: borrow + net-new (the only real net-new IP)

Borrow `north-korea-locked-down`'s annotation _language_; the net-new is the RWA fusion _logic_ (see the RWA study):

1. Classify the data type; read the asset's **geometric affordance** — linearity → timeline/gauge, volume/texture → pie, height → bar, container → exploded view.
2. **`element_positions`** — measure the asset's feature (center / extent / safe-zones / avoid-zones). This is the reverse-engineer step (vision); in the prototype it's hand-estimated.
3. **Eyedropper palette** from the asset (never generic #FFF/#000).
4. **Two layers** — asset (z0, full-bleed) + data graphics fused to its geometry (z1+), anchored by `element_positions`; connectors/scribble physically tie the data to the asset; the asset stays visible.
