---
name: engineering-ui-design
description: Use when building or revising anything a user looks at — a screen, page, component, form, empty state, or error state — or when asked to make an interface look better.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 1
---

# Interface Design

A user interface change is finished when it has been **rendered and looked at** at more than one width, in more states than the happy path. Code that compiles reads well can still ship a screen with no hierarchy, a tap target too small to hit, and a paragraph that overflows at 320px. Design is judged in the render, not in the diff.

## Give the defaults instead of asking

These are the defaults. Use them, state that you used them, and move on — asking the user to pick a border radius is a round trip for a decision that a scale already made.

| Decision | Default | Why it is the default |
|---|---|---|
| Spacing | 4px base: 4, 8, 12, 16, 24, 32, 48, 64 | One reused scale is what makes a layout look intentional; a one-off `13px` is how it drifts |
| Body text | 16px, line-height 1.5, 45–75 characters per line | Under-sized body text and over-long lines are the two most common readability failures |
| Type roles | 12, 14, 16, 20, 24, 32, 48 | Ratio near 1.25; more than four sizes on one screen means hierarchy is missing, not fine-grained |
| Weight | 400 body, 600 headings | 300 and 700+ are display weights; in body text they read as accident |
| Radius | 6px controls, 10px cards, pill for tags | One radius per *role*, not per element |
| Borders | 1px at low contrast | Separators, not decoration |
| Elevation | Two levels: raised, overlay | Three levels are indistinguishable at the sizes these are drawn |
| Motion | 120ms for color and opacity, 200ms for layout, never over 300ms | Ease-out entering, ease-in leaving; over 300ms is felt as lag |
| Contrast | 4.5:1 body text, 3:1 large text and UI boundaries | A conformance floor, not a taste call |
| Focus | 2px ring, 2px offset, on `:focus-visible` | Keyboard focus must be visible; pointer clicks must not flash a ring |
| Target | 44x44 CSS px minimum | This is the number that makes a control usable with a thumb |
| Width | 640–760px for prose, 1200–1440px container for an app shell | Beyond that, prose measure fails and tables get lost |

## Hierarchy before decoration

- **One primary action per view.** A second action at equal weight means neither was chosen. Rank them.
- **The largest text is what the user came for.** If the screen title is the biggest thing on a screen whose purpose is a value, the title is stealing the hierarchy.
- **Group by proximity before you add a border or a card.** Space is the cheapest grouping device and the one that survives a theme change.
- **Align to one edge.** Centred mixed-length body text and centred forms cost scanability for symmetry.
- **Density is a decision, not a byproduct.** Pick the row height and hold it; one row that grows with its content breaks the rhythm of every row after it.
- **Decoration answers a question.** A gradient, a shadow, an icon, or a divider earns its place by making a boundary, a state, or a rank visible. If it answers nothing, it is noise competing with what does.

## The states a surface must have

A component is not the markup for its best case. Every interactive surface owes all of these:

- **default, hover, active, focus-visible, disabled** — five rendering states for every control, and disabled states must be legible rather than merely faded.
- **loading** — a skeleton or a spinner in the space the content will occupy, not a layout that jumps when it arrives.
- **empty** — what this is, why it is empty, and the one action that fills it. A new account sees this screen first.
- **error** — the failure, and what the user can do next. "Something went wrong" is a dead end.
- **overflow** — the long unbroken string, the 12-digit number, the missing image, the 40-item list, 200% zoom, and a 320px viewport. Long real data is the normal case; the mock string was the exception.

## Look at it before you describe it

1. **Run it and render it.** Screenshot at 375, 768, and 1440 CSS px, and once per state above that the change touches.
2. **Compare the render against the claim.** Name what you would change. "No hierarchy, the CTA competes with the delete link, the row wraps at 375" is the useful output; "looks clean" is not an observation.
3. **Fix and render again.** Two rounds is usually the distance between "passes lint" and "looks designed".
4. **If no browser tool is configured** (the MCP presets carry a `playwright-mcp` entry), then the visual claim is **unverified** — say so, report what you reasoned about instead, and do not describe a render you never saw. The `engineering-verification` discipline applies to pixels exactly as it applies to tests.

When you cannot render, the reviewable fallback is arithmetic on the source: the actual spacing values, the contrast ratios, the breakpoints in the stylesheet, the tap target sizes. Those are checkable claims. "It should look good" is not.

## Rationalization table

| The thought | The reality |
|---|---|
| "It looks fine to me" | You did not render it. Look, then speak |
| "The framework handles that" | A framework supplies a scale, not a hierarchy. The layout is still yours |
| "The user can resize the window" | Responsive is the claim being made, not the excuse for not testing it |
| "The empty state is unlikely" | Every new user is the empty state |
| "I will add spacing later" | Spacing is the layout. Later is a rewrite |
| "It matches the rest of the app" | The rest of the app is not evidence that it is right, and its scale may not be either |
| "Motion is polish" | A 400ms transition is felt by every user on every interaction |
| "The contrast is close enough" | 4.5:1 is a number. Measure it or stop claiming it |
| "One more colour makes it pop" | More colours means less meaning per colour |

## Red flags

Any of these means the design pass is not finished:

- The screen appears in no state other than default in the code you wrote.
- Two elements with the same visual weight claim to be the primary action.
- Spacing values outside the scale, or the same gap expressed two different ways in one file.
- A control under 44x44, or a disabled control indistinguishable from a read-only one.
- Text that can only fit because the sample data was short.
- A transition longer than 300ms, or a loading state that shifts the layout when it resolves.
- A visual claim reported without a render behind it.
