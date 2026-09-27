---
name: react-bits
description: >
  Use when a React interface needs an animated component — a text reveal, a shader-like background, an
  interactive card, a marquee or a counter — and the work should be taken from React Bits rather than
  written from scratch. Covers the two-step fetch through the reactbits tool, the components' licence
  boundary (use in an application is permitted, redistribution of the components is not), the four
  variants and how to name them, the integration contract (the missing `'use client'` directive, extra
  stylesheets, exact dependency ranges, WebGL and SSR hazards) and the quality bar for motion
  (`prefers-reduced-motion`, layout properties, listener and frame-loop cleanup). Also use it when
  reviewing a component that was already added, or when deciding whether an effect earns its bundle
  cost at all.
---

# React Bits components

React Bits is an upstream library of animated React components — text animations, backgrounds, cards,
and micro-interactions — published as a shadcn-style registry rather than as a package. This skill
covers how to get one into a project correctly, and when not to.

## 1. Licence first, because it decides the shape of everything else

Upstream's `LICENSE.md` is MIT **plus the Commons Clause**. The two sentences that matter:

- **Use is permitted.** Putting a component in your application — including a commercial one — and
  modifying it there is what the licence is for.
- **Redistribution is not.** Selling, sublicensing, or redistributing the components themselves —
  alone, in a bundle, or as a ported version — is forbidden.

So: the component's source **belongs in the user's project, never in this package.** Nothing in this
pack vendors it, caches it to disk, or re-spells it as a local port. `THIRD_PARTY_NOTICES.md` records
this position. If a request is effectively "add React Bits to our product so users get these
components", that is redistribution, and the answer is no — the components have to be pulled into the
consumer's own project, by the consumer.

## 2. Three steps, one tool

`freecodego_reactbits` has three actions, and they are meant to be used in order.

1. `search` — a keyword (a component name, an effect like `blur`, a dependency like `gsap`) matched
   against upstream's index. Returns names, descriptions, exact dependency ranges and file paths. No
   source. Variants of one component are folded into one row, so four near-identical rows do not bury
   the description you are deciding on.
2. `get` — one variant's files **with their contents**, plus the integration review described below.
   Takes a component name, a registry variant name, or a docs slug; `language` defaults to `ts` and
   `style` to `tailwind`, and every other published variant is listed in the result so you can ask
   for a different one. Use this when the caller wants to read the code, place it by hand, or review it
   before deciding.
3. `apply` — write that variant into a directory the caller names. **Requires both `directory` (relative
   to the session working directory) and `confirm: true`**; without the confirmation the call is refused
   and the refusal lists every path it would have written, which is the moment to check the destination
   and the variant. It writes only the files upstream publishes, never overwrites an existing file unless
   `if_exists: "replace"` was asked for, and reports every file it wrote, skipped or failed on.

Two mechanical alterations, and nothing else, are made by `apply`, and both are listed per file in the
result so a diff can be audited:

- **A leading `'use client'`.** Off under `client_directive: "never"`, forced on with `"always"`, and on
  by default (`"auto"`) exactly where the review calls it blocking — a server-rendering framework, or one
  the caller did not name. It cannot change what the component renders.
- **A bounded-motion block** appended to a stylesheet that animates and ignores the system setting, unless
  `reduced_motion: false`. It sets `animation-duration`/`transition-duration` to `0.01ms` rather than
  removing the animation, because an entrance animation that starts at `opacity: 0` would otherwise leave
  content permanently invisible — the patch would hide the page it was meant to make calmer.

Nothing is installed. Dependencies come back as exact ranges for the project's own package manager, and
any motion the JavaScript drives is left to the caller: the result's `followUps` says so rather than
pretending a stylesheet rule could reach it.

## 3. Names, and how the registry spells them

| Surface | Spelling | Example |
| --- | --- | --- |
| Registry variant | `<Component>-<LANG>-<STYLE>` | `CountUp-TS-TW` |
| Registry index | the same, one row per variant | `CountUp-TS-TW`, `CountUp-TS-CSS`, … |
| Docs page slug | kebab-case, not mechanical | `ascii-text` for `ASCIIText` |

A component has four variants: `JS`/`TS` × `CSS`/`TW`. `TW` means Tailwind classes; `CSS` means the
component carries its own stylesheet, which `apply` writes beside the component and `get` reports as a
second file. Prefer `TS`/`TW` when the project already uses Tailwind and shadcn, which is the ecosystem this
registry is built for; prefer `CSS` when it uses plain CSS or CSS modules.

## 4. The integration contract

The `get` result carries a review — findings with a `severity` — and these are the ones that decide
whether the copy works at all:

- **`'use client'`.** Upstream's components do not carry the directive, and most of them need it:
  they register animation plugins, read layout in an effect, attach pointer listeners, or observe
  elements. Under a server-rendering framework this is a build or first-render failure. Add it as the
  file's first line.
- **Extra files.** A `CSS` variant's stylesheet has to be written and imported, or the component
  renders unstyled.
- **Local imports.** The review lists specifiers that are neither React nor a package. Those are files
  you place — fetch the sibling component with the same tool rather than inventing a path.
- **Dependencies.** Install the exact ranges the result reports (`motion@^12.23.12`,
  `gsap@^3.13.0`, …) with the project's own package manager — and use the project's, because a tool
  that picked one would be guessing. Some manifests are heavy (`three`, `@react-three/fiber`,
  `postprocessing`, `matter-js`); that cost is a design decision, not a detail.

## 5. Motion quality bar

These are the things that make a component a liability rather than an asset:

- **Honour the system setting.** Many upstream components have no `prefers-reduced-motion` branch.
  Add one, or the effect cannot be turned off by the people who need it off.
- **Do not animate layout properties.** `transform` and `opacity` are what the compositor can handle;
  animating `height`, `top`, or `margin` forces layout every frame. This package's own detector has a
  rule for it (`layout-transition`), and a component that trips it will be flagged in review.
- **Clean up.** Remove listeners, cancel frame loops, and disconnect observers on unmount. A leaked
  loop keeps running in a background tab and shows up as a fan that never stops.
- **WebGL renders blank, not broken.** Shader and canvas components produce an empty area when the
  context is unavailable, with no error. Verify on the target machine rather than trusting it, and
  keep content that matters outside the canvas.
- **One effect, not three.** A page with an animated background, an animated heading, and an animated
  card has three competing focal points and none. Pick the one that serves the message.

## 6. When not to use it

React Bits is the wrong tool for content-first products, dense data interfaces, and flows where the
user is completing a task rather than being impressed — an animated background behind a settings
screen costs a bundle and buys nothing. If the interface's job is reading, arguing, or transacting,
plain typography and spacing do more than any shader.

## 7. Cross-check before you ship

Run the fetched code past this pack's own rules — `freecodego_design_detect` on the file after it has
been placed — and look for the standing conflicts: bounce easings, gradient-clipped text, and layout
animation. The `get` result already names which of them the source would trip, so the cheap moment to
decide is before the code is written.
