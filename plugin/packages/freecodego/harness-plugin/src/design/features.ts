/** The design capabilities this plugin ships, as data.
 *
 * Each entry is one row on the design page. Keeping them in a table rather than
 * in the class means the settings shape, the page, and the mount all read the
 * same list — a feature cannot be switchable on the page but absent from the
 * mount, which is the failure mode a hand-written per-feature surface produces
 * the moment a second feature is added.
 */

import { CRAFT_TOOL_NAME } from '../craft/tool.ts'
import { IMPECCABLE_BUILTIN_RULES } from '../impeccable/rules.ts'
import { IMPECCABLE_DETECT_TOOL_NAME } from '../impeccable/tool.ts'
import { REACTBITS_TOOL_NAME } from '../reactbits/tool.ts'
import { UIUX_SEARCH_TOOL_NAME } from '../uiux/tool.ts'
import type { FreeCodeGoDesignFeature } from './types.ts'

/**
 * The HyperFrames design pack: composition-shaped video/frame design.
 *
 * Skills are the whole capability. They carry the composition knowledge
 * (layouts, motion, timing, audio beds), and the five tools are only the seams
 * where a Skill hands work back to the runtime. That split is why the pack is
 * useful with the tools dark — a Skill explains a technique before anything is
 * rendered, and the token cost is paid on selection rather than at session
 * start.
 */
export const HYPERFRAMES_FEATURE: FreeCodeGoDesignFeature = {
  id: 'hyperframes',
  label: 'HyperFrames 设计',
  summary: [
    '按 composition 的方式设计视频与画面：分镜、版式、动效、时间轴与音轨。',
    '17 个设计 Skill 按需加载——未选中时不占用上下文，只有选中那一篇进对话。',
    '`keyframes` 与 `lint` 只读 composition 文件：一条列出它动画了什么、动了哪些变换属性，一条不渲染就检查结构与确定性。两者都不需要浏览器。',
    '`preview` 把 composition 伺服在 127.0.0.1 上，给出可打开的地址与时间轴清单（composition、轨道、每个 clip 声明的时间）；`snapshot` 在指定时刻抓一帧 PNG；`render` 逐帧 seek 后编成 MP4（约 1 秒/帧）。',
    '渲染用本机已有的浏览器（优先 Edge）：不下载引擎、不需要 ffmpeg、不装 CLI。',
  ].join('\n'),
  skillRoot: 'assets/design/skills',
  /**
   * What this capability provides.
   *
   * Registration skips a name with no implementation and reports what it did
   * register, so this list names the whole surface and the page shows the live
   * subset rather than a promise — a build that has not implemented one of them
   * must not answer as if it had.
   */
  // Cheapest first, which is also the order the implementation table registers
  // them in — one list order rather than two that a reader has to reconcile.
  tools: [
    'freecodego_design_keyframes',
    'freecodego_design_lint',
    'freecodego_design_preview',
    'freecodego_design_snapshot',
    'freecodego_design_render',
  ],
}

/**
 * The UI/UX catalogue: this plugin's curated design knowledge base.
 *
 * The opposite shape to the pack above — no Skills, no render engine, no asset
 * root to mount: 34 CSV tables of reviewed design guidance plus one search tool
 * that reads them. That is why the row needs no mount and no download to work,
 * and why `tools` below is also the capability's whole installation.
 *
 * The tool name is imported rather than spelled here, because this list and the
 * implementation are the two halves of one statement: a name written twice is a
 * row that can advertise a tool the build registers under a different id, and
 * the page would list nothing while nothing said why.
 */
export const UIUX_CATALOGUE_FEATURE: FreeCodeGoDesignFeature = {
  id: 'uiux-catalogue',
  label: 'UI/UX 设计目录',
  summary: [
    '按领域检索内置的设计知识库：风格、配色、字体、版式、落地页结构、图表、图标、无障碍、可用性、动效与实现规范。',
    '34 张精选表格、2,385 条建议：11 个设计领域，加上 22 张框架规范表（React、Next.js、Vue、SwiftUI 等）。',
    '`freecodego_uiux_search` 是唯一入口：可以点名 domain 或 stack，也可以只给一句描述让它自己路由到最相关的领域。',
    '结果带校准过的置信度——低置信度会明确拒答，而不是硬凑一条看起来像答案的建议；已废弃的风格会先解析到它声明的后继版本。',
    '目录随包发布，全部离线：只读内置数据，不读取也不写入你的工作区，不需要浏览器、不联网、不安装任何东西。',
  ].join('\n'),
  tools: [UIUX_SEARCH_TOOL_NAME],
}

/**
 * Craft: the universal rules an interface obeys regardless of whose brand it is.
 *
 * A shape of its own, and the only row whose payload is *not* a capability of its own
 * — it is the layer that sits on top of whatever else is switched on. Upstream's
 * own catalog makes the distinction numerically: 152 design-system packages at
 * 40 MB, against eleven rulebooks at 104 KB that 22 of its Skills and 151 of those
 * manifests declare they need. Brand prose says which colours a brand uses;
 * this layer says that ALL CAPS always needs tracking, that at most two visible
 * uses of the accent belong on a screen, and that a form field without an error
 * state is unfinished — the rules a competent designer applies on top.
 *
 * One tool rather than a Skill root, because these are references consulted in
 * the middle of a task rather than a technique selected before one. The three
 * actions are the layer's own contract: `list` is the catalogue with each
 * section's price, `get` reads the bodies a caller picked, and `resolve` runs
 * upstream's composition rule so the *third* field of that contract — a design
 * system exempting itself from a rule it deliberately breaks — is executable
 * rather than a paragraph nobody reads.
 *
 * Two things the card has to say rather than leave to be discovered. The rules
 * assume a design system is supplying semantic tokens (`--bg`, `--accent`, …);
 * with none in play they still read, but their examples name tokens this project
 * may not define. And a slug that does not resolve is refused with the list of
 * what exists, because upstream's runtime drops it silently and a rule believed
 * to be in force is worse than one reported missing.
 *
 * It is listed beside the UI/UX catalogue because the two are the same shape —
 * one tool answering from package assets, no asset root to mount, no browser and
 * no workspace path. That shared shape is also why their order here and in the
 * implementation table agree: they are the cheapest rows to leave switched on.
 *
 * Vendored under Apache-2.0 (`THIRD_PARTY_NOTICES.md` carries the snapshot;
 * `assets/design/craft/PROVENANCE.md` carries a SHA-256 per file and the six
 * glyphs the pass named rather than drew).
 */
export const CRAFT_FEATURE: FreeCodeGoDesignFeature = {
  id: 'craft',
  label: 'Craft 工艺规则（上游 11 篇）',
  summary: [
    '上游 OpenDesign 的「工艺」层：11 篇与品牌无关的规则——排版与层级、配色纪律、动效纪律、无障碍基线、表单校验、UX 定律、RTL 与双向文本、状态覆盖、反 AI 味。它讲的是任何品牌之上都该成立的手艺，而不是某个品牌长什么样。',
    '`freecodego_design_craft` 三个动作：`list` 列出全部小节与各自大小（含上游「已登记未发布」的前向引用），`get` 取回指定小节原文，`resolve` 执行上游的三字段装配——`requires` 与 `applies` 强制加载、`exemptions` 豁免、`suggested` 仅建议。',
    '按篇付费：11 篇合计约 10.4 万字节（全部读完约 2.6 万 token），单篇 0.8k–4.3k token，所以 `get` 一次最多 4 篇并逐篇报出大小——不存在「一次把整层灌进上下文」的用法。请求里出现拼错的小节会直接拒绝并列出可用清单，而不是静默跳过。',
    '这些规则建立在「已有一份设计系统提供语义 token」之上（`--bg`、`--surface`、`--fg`、`--muted`、`--border`、`--accent`）；没有设计系统时它们仍然可读，只是示例引用的是那套标准 token，本页的其它行（例如 Taste 的 DESIGN.md 产出）正好是它的上游。',
    '随包发布、离线只读：不联网、不读也不写工作区、不需要浏览器；上游 Apache-2.0（其中两篇另含 MIT 的 refero_skill 归属），上游版本与逐文件 SHA-256 见 `assets/design/craft/PROVENANCE.md`。',
  ].join('\n'),
  tools: [CRAFT_TOOL_NAME],
}

/**
 * The Impeccable detector: upstream's design rules, answered on this machine.
 *
 * A third shape, and deliberately one row rather than two. It *delegates* to
 * upstream's own engine when the machine already has one and scans source itself
 * when it does not, but the user's question is the same either way — does this
 * interface carry a known tell, or a quality defect — so offering the two
 * backends as separate switches would be asking them to choose an implementation.
 * The answer names which one replied, which is where that distinction belongs.
 *
 * No `skillRoot`, and the row's last line says why rather than leaving the reader
 * to infer it from an empty mount: upstream's guidance is 24 command playbooks
 * and roughly forty reference documents, prose that has to be taken from upstream
 * and rewritten for this pack before it can be mounted. `scripts/vendor-
 * impeccable.mjs` is that pass — the row names the *state* rather than the script,
 * because a settings page is read by users rather than by people who can run it,
 * and the script is documented where its output would land
 * (`THIRD_PARTY_NOTICES.md`) and in its own usage text.
 */
export const IMPECCABLE_FEATURE: FreeCodeGoDesignFeature = {
  id: 'impeccable',
  label: 'Impeccable 设计检测',
  summary: [
    '上游 Impeccable 的确定性检测：61 条规则，分「生成感」（slop）与「工艺质量」（quality）两类，规则 id 与上游文档、`impeccable ignores` 一致。',
    `已接入：\`freecodego_design_detect\`。本机已经装了引擎时全量委托给它——包含必须真实渲染才能判定的对比度、内边距、文本遮挡等，以及项目 DESIGN.md 的校验；没有引擎时用内置子集回答：${String(IMPECCABLE_BUILTIN_RULES.length)} 条规则，只读源码即可判定。`,
    '每次结果都写明是谁回答的、跑了哪些规则、上游总数是多少，所以「没查出问题」不会被读成「已经全部检查过」。',
    '只读且不下载：引擎只会被查找（`IMPECCABLE_ENGINE`、`PATH`、`~/.impeccable/bin`），找不到就退回内置子集；扫描通过文件服务读取，不写工作区、不联网、不安装任何东西。',
    '未接入：上游 24 个命令的设计 playbook（SKILL.md 与约 40 篇 reference）尚未随包发布，所以这一行目前提供的只有上面的检测工具。',
  ].join('\n'),
  tools: [IMPECCABLE_DETECT_TOOL_NAME],
}

/**
 * React Bits components: animated React components, fetched on demand.
 *
 * The fourth shape, and the one row whose knowledge cannot be bundled at all —
 * not for a technical reason but for a licence one. React Bits ships under MIT
 * **plus the Commons Clause**, which permits using the components in an
 * application and forbids redistributing them, alone or in a bundle or as a port.
 * A copy inside this package's assets would be exactly that redistribution, so
 * this row ships a Skill this repository wrote and a tool that reads upstream on
 * demand; the components' own source is never carried here.
 *
 * Because of that, this is also the only row that needs the network, and the
 * summary says so in the place a user reads before switching it on — rather than
 * leaving it to be discovered when a call fails on a machine behind a proxy.
 *
 * It is also the only design row whose tool writes the workspace at all, which is
 * why its `apply` action asks for a destination and a confirmation rather than
 * defaulting to somewhere plausible: the files land in a project whose layout this
 * pack cannot see, and the row's own summary has to say what a write does before
 * a user switches it on.
 */
export const REACTBITS_FEATURE: FreeCodeGoDesignFeature = {
  id: 'react-bits',
  label: 'React Bits 动效组件',
  summary: [
    '上游 React Bits 的 200+ 个动画 React 组件（文字动效、背景、卡片、微交互），每个有四种变体：TS/JS × CSS/Tailwind。',
    '`freecodego_reactbits` 三步：`search` 按关键词或依赖在登记表里找组件（只有名称、描述、精确依赖区间与文件路径，不含源码），`get` 取回一个变体的源码、依赖与集成体检，`apply` 把它写进你指定的目录（必须带 `directory` 与 `confirm: true`；默认不覆盖已存在的文件）。',
    '这一行按需联网读取上游登记表；组件源码只落在你的项目里，本包不内置、不缓存、不再分发任何组件源码——上游许可证允许在应用里使用，禁止把组件再分发（随包、单独或作为改写后的移植版都算）。',
    '写入的只有上游登记的文件，且只改两处机械的地方：服务端渲染下补 `\'use client\'` 首行，以及给未处理系统设置的样式表追加 `prefers-reduced-motion` 限制（改时长而非删除动画，避免入场动画一删就永久不可见）；两处都会在结果里逐条列出，其余与上游逐字一致。',
    '每次取回都附体检：缺 `\'use client\'`、需要一起落盘的样式文件、用了浏览器全局对象、没处理 `prefers-reduced-motion`、依赖 WebGL，以及会触发本包哪些设计检测；依赖只报精确区间，安装交给你的包管理器，不替你安装、也不从上游下载到包内。',
    'Skill 是本包自己写的（标识符映射、变体矩阵、集成约定与取舍），不含上游任何文本。',
  ].join('\n'),
  skillRoot: 'assets/design/react-bits',
  tools: [REACTBITS_TOOL_NAME],
}

/**
 * Taste-Skill: upstream's design-direction pack, vendored whole.
 *
 * The fifth shape, and the first row that is *only* prose: no tool, no render
 * engine, no network, no write. Its whole installation is a Skill root, which is
 * what makes it the cheapest row on the page at rest — nothing is loaded until a
 * skill is selected, so the pack's 72,540 tokens cost nothing to a session that
 * never reaches for one, and a session that does pays for one body rather than
 * thirteen. That is also why the 5,000-token publish budget is deliberately not
 * applied here: it is the ceiling this package enforces on skills it *publishes*,
 * where the alternative to a trim is a smaller skill, and these are vendored
 * upstream bodies where the alternative would be a rewrite. The sizes are stated
 * on the card and per file in `PROVENANCE.md` instead, so the trade is visible.
 *
 * One body did have to answer a limit this package does enforce: upstream's
 * flagship is 87 KB, and `inspectSkillRoot()` reports a body over 64 KiB. The
 * remedy is the one the HyperFrames pack already uses — the widest section moves
 * into the skill's own `references/` and the body links it where it stood — so
 * five sections moved and not one sentence was cut. The move is recorded here
 * rather than left to be discovered in a diff, because a reader who finds a link
 * where a hard-rules section used to be should know why it is a link.
 *
 * Vendored under MIT, which permits exactly this; the card says so, and
 * `assets/design/taste/PROVENANCE.md` carries the snapshot commit and a SHA-256
 * per file, with `scripts/vendor-taste-skills.mjs` as the pass that reproduces
 * them.
 */
export const TASTE_FEATURE: FreeCodeGoDesignFeature = {
  id: 'taste',
  label: 'Taste 设计品味（上游 13 篇）',
  summary: [
    '上游 Leonxlnx/taste-skill 的 13 篇设计 Skill，纯文本、随包发布：读题并推断设计方向、风格语言、既有项目改版、出参考图与图转代码。',
    '方向与风格：旗舰 `design-taste-frontend` 先给出一句 Design Read（页面类型/受众/审美），再调三个旋钮（VARIANCE / MOTION / DENSITY），并把 brief 映射到真实设计系统（Fluent、Material 3、Carbon、Polaris、Primer、GOV.UK、USWDS、Radix、shadcn…）；`minimalist-ui`、`industrial-brutalist-ui`、`high-end-visual-design`、`gpt-taste` 是四种风格语言，`stitch-design-taste` 产出项目 DESIGN.md，`redesign-existing-projects` 先审计再改。',
    '出图与图转代码：`imagegen-frontend-web` / `imagegen-frontend-mobile` / `brandkit` 只出参考图（配合本插件已有的图像生成工具），`image-to-code` 先出图再照着实现。',
    '整篇发布，不删节也不缩身：这些正文合计约 7.3 万 token，远超本包对「要发布的」Skill 设的 5,000 预算，但这一行是按需加载的——没选中的正文不进上下文，选中只进那一篇，所以这里不做裁剪，尺寸写在卡片和 PROVENANCE 里。',
    '唯一受本包 64 KiB 正文审计影响的是旗舰篇（87 KB）：它最宽的 5 个小节移到了同目录 `references/` 并在原处留下链接，一字未删；其余 12 篇与上游逐字一致。',
    'MIT，离线、只读、不联网、不写工作区，也不需要浏览器；快照 commit 与逐文件 SHA-256 见 `assets/design/taste/PROVENANCE.md`。',
  ].join('\n'),
  skillRoot: 'assets/design/taste',
  /**
   * No tools, and that is the row rather than an omission: every part of this
   * capability is the prose a selected Skill puts in context. The empty list is
   * also what the page reports, because `status()` answers from what registered.
   */
  tools: [],
}

/** Every design capability, in page order. */
export const DESIGN_FEATURES: readonly FreeCodeGoDesignFeature[] = [
  HYPERFRAMES_FEATURE,
  UIUX_CATALOGUE_FEATURE,
  CRAFT_FEATURE,
  IMPECCABLE_FEATURE,
  REACTBITS_FEATURE,
  TASTE_FEATURE,
]

/** The feature ids, for validating a persisted switch list. */
export const DESIGN_FEATURE_IDS: readonly string[] = DESIGN_FEATURES.map(feature => feature.id)
