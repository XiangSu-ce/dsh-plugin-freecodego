## Confirm Visual Direction with User (DO THIS FIRST)

Before you start designing cards or deciding bounds, **ask the user to
pick the output ratio, the layout, the style, and the card-density
preset**. Frames are auto-selected from the chosen layout × style
combination (see "Auto-pick frame" table below). Before sending the
question, **precompute two things**:

1. **`recommendedRatio`** from the source video's aspect ratio
   (`metadata.json` width / height):
   - `sourceAspect = width / height`
   - `sourceAspect ≥ 1.5` (≥ ~3:2 wide) → recommend **`16:9`**
   - `sourceAspect ≤ 0.7` (≤ ~9:13 tall) → recommend **`9:16`**
   - `0.7 < sourceAspect < 1.5` (near-square) → recommend **`4:5`**

   Mark the recommended option's label with " (recommended · matches source video X:Y)"
   so the user sees why it's recommended.

2. **`autoCount`** from Step 6 (`max(5, round(videoSec / (basePace ×
densityMultiplier)))`) so the "auto" option's label can show the
   concrete number.

**Environment compatibility — pick the best available question channel.**
Not every runtime exposes the same structured-question tool. Apply this
order:

1. **Native clarification tool** — use the structured 4-question call below.
2. **Other native clarification tool** (e.g. `ask_question`,
   `request_user_input`, IDE-specific prompt) — use that tool with the
   same 4 question texts and option lists. Preserve the recommendation
   markers and the precomputed values.
3. **No native tool** (Codex CLI, plain text-only runtimes) — **ask
   directly in normal conversation**. Use the plain-text template at the
   end of this section. Keep it to **one message, 4 numbered questions**
   (the global cap is 2–5 questions per round; we stay inside it).

Rules that apply to every channel:

- Ask **at most 2–5 questions per round**. Our 4 here fits.
- Even if missing info doesn't block rendering, **ask once to confirm
  the parameters that materially affect the final output** (ratio,
  layout, style, cardCount).
- If the user has already pre-approved defaults ("just use defaults",
  "no need to ask", "auto-pick everything"), asked you not to ask, or the
  run carries an ongoing autonomous signal ("surprise me" / "decide for me" —
  `../hyperframes/references/brief-contract.md` § 1) — **skip
  the question entirely** and use: `recommendedRatio`, `layout="stack"`
  (safest cross-ratio default), `style` chosen from transcript tone in
  the most neutral group (editorial/data), `autoCount`. Tell the user
  what you picked in one sentence and continue.

**Channel A — native `AskUserQuestion`:**

```
// Precompute before the call:
//   recommendedRatio = "16:9" | "9:16" | "4:5"
//   autoCount        = integer (from Step 6)

AskUserQuestion({
  questions: [
    {
      question: "Output video aspect ratio (canvas):",
      header: "Aspect ratio",
      multiSelect: false,
      // Reorder so the recommended option appears FIRST (per AskUserQuestion convention).
      // Append " (recommended · matches source video W×H)" to the recommended option's label.
      options: [
        { label: "16:9 (1920×1080) landscape", description: "TV / YouTube / desktop playback. Most natural when the source video is already landscape; widest canvas." },
        { label: "9:16 (1080×1920) portrait", description: "TikTok / Reels / short-form mobile. Most natural for portrait source; native mobile experience." },
        { label: "4:5 (1080×1350) near-portrait", description: "Instagram feed / WeChat Moments. Best when source is near-square or you want to cover both platforms." }
      ]
    },
    {
      question: "Choose the overall layout: how should the video and cards coexist on the canvas?",
      header: "Layout",
      multiSelect: false,
      options: [
        { label: "side-by-side (split)",  description: "Video and card each take half the canvas. Most stable for interview / data side-by-side; clear visual separation." },
        { label: "top-bottom (stack)",    description: "Video on top (~52%), card below. Classic combo of speaker face + summary card; works well in portrait too." },
        { label: "picture-in-picture (pip)", description: "Card fills the canvas, video shrinks to a rounded corner window. Use when content is primary and speaker is secondary." },
        { label: "full-screen overlay (overlay)", description: "Video plays full-bleed, card floats as a glass layer on top. Strong cinematic / emotional feel." }
      ]
    },
    {
      question: "Choose the card visual style (style):",
      header: "Style group",
      multiSelect: false,
      // NOTE: these 3 groups intentionally match the frame auto-pick matrix
      // rows below, so picking a group resolves both `style` group AND the
      // frame matrix column in one step. Memberships are mutually exclusive.
      options: [
        { label: "warm paper (warm-paper)", description: "academic notebook · editorial big-type · whiteboard hand-drawn · xhs social. Best for interview reflections, product launches, lifestyle, emotional stories." },
        { label: "clinical / cold (clinical)",   description: "audit magazine · swiss grid · terminal CLI · minimal modern. Best for financial analysis, investigative reports, technical tutorials, serious presentations." },
        { label: "experimental / avant-garde (experimental)", description: "geom color-clash geometry · spotlight dark-background. Best for short-form highlights, product launches, strong emotion, cinematic feel." }
      ]
    },
    {
      question: "Card count (takeaway pacing): how many cards to cut?",
      header: "Card count",
      multiSelect: false,
      options: [
        { label: "Auto (recommended) · approx N cards", description: "Inferred automatically from video duration and information density (see Step 6 rules). This run estimates approx N cards. Substitute the real N (your autoCount) into the label." },
        { label: "Fewer · approx round(N × 0.6) cards", description: "Sparser cuts, each card holds longer — suits reflective / slow-paced content." },
        { label: "More · approx round(N × 1.5) cards", description: "Tighter cuts, faster rhythm — suits staccato / data-dense / short-form highlight content." }
      ]
    }
  ]
})
```

**About "Other"** — `AskUserQuestion` automatically adds an "Other" option to the card count question. The user can type a number directly (e.g. "8", "20") as the cardCount target. Parse the input as an integer: if parsing succeeds → use that value (minimum 5 as a floor); if parsing fails → fall back to "auto".

**Channel B — plain-text fallback** (Codex CLI, runtimes without a
native question tool). Post this as one normal message, then wait for
the reply. Bullet-style 1/2/3/4 keeps the reply parseable:

```
I need to confirm four visual decisions with you before I start cutting cards:

1) Output aspect ratio (canvas):
   A. 16:9 landscape (1920×1080) — TV / YouTube / desktop playback
   B. 9:16 portrait (1080×1920) — TikTok / Reels / short-form mobile
   C. 4:5 near-portrait (1080×1350) — Instagram feed / works for both platforms
   ▸ My recommendation:  <recommendedRatio>  (matches source video W×H = <sourceW>×<sourceH>)

2) Overall layout (how video & card coexist):
   A. split   side-by-side (50/50)
   B. stack   top-bottom (video top, card bottom)
   C. pip     picture-in-picture (card full canvas, video rounded corner window)
   D. overlay full-screen glass overlay (video full-bleed, card glass layer)

3) Card style group (maps to frame auto-pick matrix, pick 1 of 3):
   A. warm paper (warm-paper)      (academic / editorial / whiteboard / xhs)
   B. clinical / cold (clinical)   (audit / swiss / terminal / minimal)
   C. experimental (experimental)  (geom / spotlight)

4) Card count (takeaway pacing):
   A. Auto (recommended) — approx <autoCount> cards
   B. Fewer — approx round(<autoCount> × 0.6) cards
   C. More — approx round(<autoCount> × 1.5) cards
   D. Give me a specific number (e.g. "8", "20")

Reply format: "1A 2C 3B 4A" or natural language is fine.
If you want all recommended defaults, reply "default" / "auto" / "use all recommendations".
```

Parsing the plain-text reply:

- Accept loose formats: `"1A 2C 3B 4A"`, `"A C B A"`, `"16:9 / pip /
data / auto"`, full sentences, or `default`.
- If any answer is ambiguous → re-ask only the ambiguous ones (still
  inside the 2–5 cap).
- If the user says "default / auto / use all recommendations" → skip without re-asking.

After the user answers (any channel):

1. **Resolve the output canvas** from the ratio answer — these are the
   exact `storyboard.composition.width / height` values to write:

   | user choice | composition.width × height | storyboard.layout field                                       |
   | ----------- | -------------------------- | ------------------------------------------------------------- |
   | `16:9`      | **1920 × 1080**            | `"landscape"`                                                 |
   | `9:16`      | **1080 × 1920**            | `"portrait"`                                                  |
   | `4:5`       | **1080 × 1350**            | `"portrait"` (schema treats 4:5 as portrait — height > width) |

   For **4:5 bounds inside `references/layouts/*.html`** — those files
   only document landscape (1920×1080) and portrait (1080×1920). For
   4:5 (1080×1350) derive bounds by **proportional scaling from
   portrait**: keep horizontal values, scale vertical values by
   `1350/1920 ≈ 0.703`. Example: `overlay` portrait card =
   `{ x: 24, y: 1280, w: 1032, h: 564 }` → 4:5 card =
   `{ x: 24, y: round(1280 × 0.703), w: 1032, h: round(564 × 0.703) }`
   = `{ x: 24, y: 900, w: 1032, h: 397 }`.

2. **Map the style group to a specific style** by looking at the
   transcript tone — pick the one that best fits, but stay inside the
   user's chosen group. If you're unsure between two specific styles
   inside the group, send a second `AskUserQuestion` with those 2–4
   specific style options.

3. **Resolve final cardCount** from the density answer:

   | user choice             | final cardCount                           |
   | ----------------------- | ----------------------------------------- |
   | Auto (recommended)      | the `autoCount` you already computed      |
   | Fewer                   | `max(5, round(autoCount × 0.6))`          |
   | More                    | `round(autoCount × 1.5)` (no upper clamp) |
   | Other = "<n>" (integer) | `max(5, parseInt(n))`                     |
   | Other = anything else   | fall back to `autoCount`                  |

4. **Auto-pick the video frame** from this table (frames don't ask the
   user — they follow from layout × style):

   | layout    | warm-paper styles (academic / whiteboard / editorial / xhs) | clinical styles (audit / swiss / terminal / minimal) | experimental styles (geom / spotlight) |
   | --------- | ----------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
   | `split`   | `polaroid`                                                  | `hairline`                                           | `clean`                                |
   | `stack`   | `polaroid`                                                  | `hairline`                                           | `clean`                                |
   | `pip`     | `clean` (pip pill already has chrome)                       | `clean`                                              | `clean`                                |
   | `overlay` | `clean` (full-bleed forbids deco frames)                    | `clean`                                              | `clean`                                |

5. **Tell the user what you chose** in one sentence — ratio (+ canvas
   size), layout, specific style, frame, and final cardCount — then
   proceed with the rest of Step 7 (per-card layouts, motion patterns).
6. Record the five values (ratio / layout / style / frame / cardCount)
   in working memory (no schema field needed); you'll reference them
   while writing each card's HTML in Step 8 and while reading the
   matching `references/<dim>/<key>.html` for tokens and structure.

If the user picks an answer via "Other" with a free-text style name not
in the 10-style library, treat it as a hint to design a fresh card
visual yourself, but still anchor on the chosen layout's bounds.
