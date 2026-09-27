/**
 * The companion's colour identity, declared once.
 *
 * Why one module
 * --------------
 * The same two colours used to be written down in three places that never read
 * each other — `bar.tsx` held named constants, `companion.tsx` spelled the same
 * two `var(...)` strings inline, and `store-face.tsx` had a third pair. Each was
 * a claim about the same fact (what colour the character is) and nothing tied
 * them together, so the rail could show a different character than the strip.
 * That is the failure this module makes impossible: the seats name a value, and
 * the value is declared here.
 *
 * **The palette is fixed, and that is the decision.**
 *
 * The character is black-bodied with light eyes in both themes. It used to follow
 * the theme — the body took `--fcg-text-primary` and the eyes showed
 * `--fcg-bg-base` through the mask — which made it a *different character* under
 * `body[data-ds-dark-theme]`: dark-on-light inverted to light-on-dark, so the pose
 * a session spends most of its time in was drawn in the opposite material. An
 * identity that changes with the page is not an identity.
 *
 * The cost is real and is paid deliberately: a black body on a dark surface is
 * the one combination that does not read on its own. That is what
 * {@link COMPANION_HALO} is for, and it is why the halo exists rather than being
 * decoration.
 *
 * Both values are the vendored engine's own, from its colour table in
 * `engine/skins.ts` — the palette the drawing was authored against, rather than
 * two values picked here. Anything else would be a second palette to keep in step
 * with the poses that were measured against that one.
 *
 * @module client/companion/palette
 */

/**
 * The body: the engine's own `encre`.
 *
 * A literal rather than a token, for exactly the reason above — a token would put
 * the identity back under the theme's control, which is the thing being fixed.
 */
export const COMPANION_BODY = '#0a0a0c'

/**
 * The eyes: the engine's own `creme`, the light end of its colour table.
 *
 * Deliberately the off-white and not pure white. These are also the opaque
 * backing the renderer paints at the silhouette, because the eyes are punched out
 * of the body with a mask and what shows through them is whatever is behind it —
 * so this one value is both "the character's eye colour" and "the material behind
 * the body". The ceramic white keeps that backing a material rather than letting
 * the eyes read as holes straight through to the page.
 */
export const COMPANION_EYES = '#f1efe9'

/**
 * The surface a particle recedes into — the depth haze of a burst or an orbit's
 * particles.
 *
 * This one **does** follow the theme, and it has to: the haze is not an eye
 * colour, it is the page a particle falls back into. The two facts were only ever
 * one value because both were spelled through the renderer's single `paper` prop.
 * They are separated here so the eyes can stay fixed while the haze stays honest,
 * which is the whole reason the renderer gained a colour of its own below.
 */
export const COMPANION_SURFACE = 'var(--fcg-bg-base, #f9f9f9)'

/**
 * The halo that separates a black body from a dark surface.
 *
 * A token, not a literal, because the value is theme-dependent while the
 * character is not: `none` on a light surface, where a black body needs no help,
 * and a soft light rim under `body[data-ds-dark-theme]`. Keeping it in the token
 * layer is what lets the value be tuned by eye without this module or a seat
 * changing, and what keeps the dark-theme compensation in the one file that
 * already owns light and dark.
 *
 * Applied to the drawn body only, never to the particles: a halo around a burst
 * would outline every speck of confetti.
 */
export const COMPANION_HALO = 'var(--fcg-companion-halo, none)'
