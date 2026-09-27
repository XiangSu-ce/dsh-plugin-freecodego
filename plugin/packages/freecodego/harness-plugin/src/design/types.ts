/**
 * Shapes for the FreeCodeGo design pack: a plugin-owned page that holds several
 * independent, opt-in design capabilities.
 *
 * The pack is deliberately a *container*: each capability is one row on the
 * page with its own switch, its own asset root, and its own description. Adding
 * the next one is a line in `registry.ts`, not a new settings surface — which is
 * why the page and the settings shape are keyed by feature id rather than
 * spelling out today's features.
 *
 * What is not a row, and why
 * --------------------------
 * A row is a *capability*: something the model can reach after the switch that it
 * could not reach before, through a tool or through a bundled Skill. A behaviour
 * document — prose that tells the model how to work rather than what it can reach
 * — is the other category, and it is not one of these. Such a row would register
 * no tool and mount no asset root, so its switch would report 已启用 while
 * changing nothing; and carried as a Skill, its description would sit in context
 * on every turn, spending attention whether or not it ever fired — the cost
 * `assets/engineering/skills/writing-for-agents/SKILL.md` names as context load.
 * The invariant that keeps the category out is asserted in
 * `tests/design-registry.spec.ts`, which is where a future row of this kind fails.
 *
 * `multica-ai/andrej-karpathy-skills` is the document that raised the question,
 * and it is left out for that reason rather than a licence one: it is MIT, and it
 * ships one text — four principles — three ways (`CLAUDE.md`, a Skill, a Cursor
 * rule). Those four are already carried in this repository, in the packs that own
 * behaviour, attached to a check rather than to a stance:
 *
 * - *think before coding* — a vague interface request is answered with defaults
 *   that are **stated** rather than silently chosen, and a visual claim is never
 *   reported without a render behind it
 *   (`assets/engineering/skills-starter/engineering-ui-design/SKILL.md`);
 * - *simplicity first* — speculative generality is a review finding with one
 *   remedy, delete it, and inline back until the need is real
 *   (`assets/engineering/skills/code-review/SKILL.md`);
 * - *surgical changes* — a brief states what is out of scope, because that is what
 *   stops an agent gold-plating the adjacent feature
 *   (`assets/engineering/skills/triage/AGENT-BRIEF.md`);
 * - *goal-driven execution* — every brief owes independently verifiable
 *   acceptance criteria, and clarifying questions come before the build
 *   (`assets/engineering/skills-superpowers/brainstorming/SKILL.md`).
 *
 * Three of the four also hold on this page *structurally*, because they are the
 * write path: `apply` refuses a call without a destination and a confirmation and
 * lists every path it would have written, the two alterations it makes are the
 * only two and each is reported, and this is the row Plan Mode refuses. A row that
 * asked for those behaviours in prose, with nothing enforcing them, would be the
 * weaker version of the same claim.
 */

/** A capability the design page can offer. */
export interface FreeCodeGoDesignFeature {
  /** Stable id. This is what the persisted switch list stores, so renaming it
   *  resets the user's choice — treat it as a wire format, not a label. */
  readonly id: string
  /** Shown on the page. */
  readonly label: string
  /** One paragraph on what the capability does and what it costs. */
  readonly summary: string
  /** Relative asset root holding this feature's Skills, when it ships any. */
  readonly skillRoot?: string
  /** Tool names this feature registers. They carry the `freecodego_` prefix, so
   *  they land in the deferred set and cost nothing until the model selects
   *  them. Listed here so the page can say what enabling the row actually adds. */
  readonly tools: readonly string[]
}

/** A feature plus the two things the page needs to render its row. */
export interface FreeCodeGoDesignFeatureState {
  readonly id: string
  readonly label: string
  readonly summary: string
  readonly tools: readonly string[]
  /** What the user chose. */
  readonly enabled: boolean
  /** Whether the row can be turned on at all. A feature whose assets are
   *  missing stays listed and explains itself, rather than disappearing and
   *  leaving the user wondering whether they imagined the row. */
  readonly available: boolean
  /** Why `available` is what it is. */
  readonly detail: string
}

/** Everything the design page renders. */
export interface FreeCodeGoDesignStatus {
  /** Master switch. Off leaves every feature unmounted. */
  readonly designEnabled: boolean
  /** The Skills provider is live and serving the feature roots. */
  readonly skillsReady: boolean
  /** Set only when a mount failed, so a failure is reported as a reason. */
  readonly skillsError?: string
  readonly features: readonly FreeCodeGoDesignFeatureState[]
}
