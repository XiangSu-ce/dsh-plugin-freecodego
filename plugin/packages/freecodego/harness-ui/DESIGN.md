# FreeCodeGo harness-ui design contract

Portable design system for this package. **Read this before generating or editing
any UI here.** It codifies the rules the package already follows; it does not
introduce a new visual language.

Ported in spirit from ZCode's `DESIGN.md`, minus everything that does not exist
here (no Tailwind, no `text-ui-*` scale). The one idea taken wholesale: a design
rule is a **defect**, not a preference, once it is written down here.

Enforced by `scripts/design/design-check.mjs` (run from the repository root):

```bash
node scripts/design/design-check.mjs --summary   # per-rule census
node scripts/design/design-check.mjs             # fail on anything new
```

## Token sources — there are four, and only four

A literal value is acceptable only where one of these cannot express it.

1. **Host platform** — `--dsw-alias-*` / `--dsw-static-*`, provided by
   `packages/client/ui-theme`. Light/dark switching happens **only** through the
   host's `body[data-ds-dark-theme]` remapping. Never hardcode a value that a
   host alias already carries.
2. **Plugin global** — `--fcg-*` in [`src/client/theme.css`](src/client/theme.css).
   `theme.css` owns the measurement scale the host does not provide (spacing,
   radius, type, elevation, motion) plus semantic aliases. **FreeCodeGo defines
   no colors of its own** — that sentence is `theme.css`'s own header, and it is
   the rule.
3. **Component-local** — a token declared inside the one CSS module that uses it,
   e.g. `--pixel-ink` / `--pixel-notch` in `settings-tab.module.css` (the pixel
   card language) or the `--fcg-chart-*` block inside `.tokenChartWrap`. Allowed
   **only** when the declaration sits in the consuming rule and carries a comment
   saying why the global scale cannot express it.
4. **Runtime-set** — a custom property written from JS, e.g. `--model-color`. Set
   it from a token, never from a literal (`colorOf(row.model)`, not `'#3b82f6'`).

## Measurements

- **Spacing is a strict 4/8 grid**: `--fcg-space-1` (4) through `--fcg-space-8`
  (32). No ad-hoc `padding: 11px`.
- **Radius has three tiers**: `--fcg-radius-sm` (6) / `md` (10) / `lg` (14), plus
  `--fcg-radius-full` for a deliberate pill or circle only. Choose by the nearest
  rounded container, not by how important the element looks.
- **Type roles, not sizes**: `--fcg-font-caption` / `body` / `body-lg` / `title` /
  `section` / `display`, with `--fcg-font-mono` for paths, hashes, commands and
  identifiers. Code, diff and terminal **content** may keep its own numeric size;
  the chrome around it must not.
- **Never** change `html` / `document.documentElement` font size, and never scale
  geometry with the type scale.

## Color

Use a token for anything that means something: `--fcg-bg-base` / `bg-layer-1..3`
/ `bg-hover` / `bg-active`, `--fcg-text-primary` / `secondary` / `tertiary` /
`on-brand`, `--fcg-line` / `line-subtle` / `line-strong`, `--fcg-brand` /
`brand-strong` / `brand-subtle`, and the semantic `--fcg-danger` / `success` /
`warn` families with their `-subtle` variants.

- Semantic colors are for real semantic states. Do not borrow `--fcg-danger`
  to make a block feel louder.
- Layer through background contrast and borders before reaching for
  `--fcg-shadow-1/2/pop`.

### Enumerated literal-color exceptions

These are palettes by nature and are declared here so the checker can tell them
from drift. **Every other literal color is debt**, not an exception.

| Location | Why a literal is correct |
|---|---|
| `src/client/sidebar-icons.ts` | brand icon art: SVG paths whose `fill` is the drawing |
| `src/client/native-model-menu-badges.ts` | provider identity colors (and it prefers a token with a hex fallback) |
| `src/client/token-usage-dashboard.tsx` | per-model series palette, matched by name pattern |
| `src/client/companion/engine/skins.ts` | companion skin palette |
| `src/client/companion/render.tsx` | companion render palette |
| `src/client/payment-dialog.tsx` | the third-party card form's own brand marks |

Adding a file to this list is a design decision. Adding a color to a file
already on it is not covered — extend the reason or make it a token.

## Interaction

- Every interactive surface needs hover, focus and disabled states expressed in
  tokens (`--fcg-bg-hover`, `--fcg-line-strong`, `--fcg-text-tertiary`).
- `--fcg-fast` / `--fcg-slow` with `--fcg-ease` are the only motion values.
  Motion clarifies a state change; it does not decorate.
- Inline `style={{ … }}` is for **computed geometry only** — a progress width
  (`width: \`${percent}%\``), a measured offset, a runtime custom property. Static
  layout, spacing, color and type belong in the CSS module.

## Light and dark

Both themes must be validated, and a theme branch may appear **only** in
`theme.css` (or as a host alias). A component that reads correctly in one theme
because of a literal is a defect.

## Accessibility

- Keyboard focus must keep the package's existing focus styling.
- Do not encode meaning in color alone; pair a semantic color with text.
- Tolerate long translations: prefer `min-width: 0` and truncation over fixed
  widths that only fit the English label.
