/**
 * Chinese display layer for the capability surfaces (Skills library, MCP
 * presets, and the community marketplace).
 *
 * Skill frontmatter is English by construction: 11 Skills are authored here and
 * 21 are vendored byte-for-byte from `mattpocock/skills`, and the community
 * directories (skills.sh, mcp.so) publish English only. Translating them at
 * runtime is not possible offline, so the UI owns the Chinese layer:
 *
 * - Skills this plugin actually ships are translated in {@link BUILTIN_SKILL_ZH}.
 * - Everything else falls back to its upstream description, and the marketplace
 *   says so explicitly instead of presenting English as if it were localized.
 */

/** Chinese descriptions for the 41 Skills this package bundles across its three
 *  asset roots (`skills-starter`, `skills`, `skills-superpowers`). */
export const BUILTIN_SKILL_ZH: Readonly<Record<string, string>> = {
  // Authored for FreeCodeGo.
  'engineering-code-review': '审查改动代码的行为缺陷、回归风险、安全隐患与缺失测试。',
  'engineering-context-control': '在长任务中用有界摘要、检查点与定向检索保留高价值工程上下文。',
  'engineering-debug': '从最小可复现症状出发，诊断构建、运行时、集成与状态类故障，直到确认根因。',
  'engineering-plan': '改动前先给出范围、风险、阶段与验证方式，用于多文件复杂工程任务。',
  'engineering-release-readiness': '发布插件或运行时前校验产物、版本、兼容性、回滚、权限与平台覆盖。',
  'engineering-search-first': '在通读大范围源码或下结论之前，先选择最小可靠的导航手段。',
  'engineering-security-review': '启用改动前审查密钥、输入边界、权限、网络调用、第三方工具与能力安装。',
  'engineering-silent-failure': '检查异步任务、缓存、重试、空状态与错误路由中被隐藏的失败。',
  'engineering-spec-mining': '改遗留代码前，从调用方、测试、事件、数据格式与可观测行为中提取既有契约。',
  'engineering-tdd': '当行为可被确定性地描述与验证时，采用测试先行开发。',
  'engineering-verification': '宣布完成前，为构建、类型、Lint、测试、安全与改动范围提供证据；没有本轮新跑出的证据，就不能宣称「已完成」。',
  'prompt-techniques': '中文提示词技术速查：零样本、少样本、思考链、自一致性、RAG、ReAct、反思、思维树等，注明各自何时值得用、代价多大、最小形态是什么。',
  // Vendored from mattpocock/skills (MIT).
  'ask-matt': '不知道当前情况该用哪个技能或流程时，交给它来路由（用户可调用技能的总入口）。',
  'code-review': '以固定点（提交、分支、标签或 merge-base）为基准做双轴评审：规范（是否遵循本仓编码规范）与规格（是否符合原始 issue/spec），两路并行子代理后并排汇报。',
  'codebase-design': '设计「深模块」的共享词汇：模块、接口、深度、接缝、适配器、杠杆与局部性。',
  'domain-modeling': '持续构建并打磨项目领域模型：质疑术语、消除一词多义、把难逆转的决策记成 ADR。',
  'grill-me': '用不留情面的追问把方案或设计打磨清楚（无状态，不在仓库留文件）。',
  'grill-with-docs': '同样是追问式打磨，但会顺手产出文档（ADR 与术语表 CONTEXT.md）。',
  grilling: '面向方案、决策或想法的追问原语：事实由 Agent 查，决策由用户定。',
  handoff: '把当前对话压缩成一份交接文档，供另一个 Agent 接手继续。',
  implement: '依据 spec 或工单实现工作：尽量按测试先行推进，收尾跑一次双轴 code-review 再提交。',
  'improve-codebase-architecture': '扫描代码库中的「加深」机会，输出可视化 HTML 报告，再对选中的那项做追问式设计。',
  prototype: '用一次性原型回答一个设计问题：验证状态模型或逻辑是否顺手，或看看 UI 该长什么样。',
  'resolving-merge-conflicts': '逐 hunk 处理进行中的 git merge / rebase 冲突，按两侧意图溯源解决，绝不 --abort。',
  'setup-matt-pocock-skills': '为本仓库配置这套工程技能：issue tracker、triage 标签词表与领域文档布局。首次使用其它工程技能前跑一次。',
  'to-questionnaire': '把「你自己答不完」的决策转成一份问卷，交给唯一能回答的那个人填写。',
  'to-spec': '把当前对话直接整理成 spec 并发布到项目 issue tracker：不再提问，只做归纳。',
  'to-tickets': '把 plan、spec 或对话拆成一组「曳光弹」工单并标明彼此的阻塞边，发布到已配置的 tracker。',
  triage: '让 issue 与外部 PR 走一遍 triage 角色状态机：分类、验证、必要时追问，产出可直接交给 Agent 的 brief。',
  'wait-what': '上一段没讲明白时的纠偏：补上你缺的上下文，用 CONTEXT.md 里的词重新讲一遍。',
  wayfinder: '把「一个会话装不下」的大工程规划成 issue tracker 上的决策地图，逐个解决直到路径清晰。',
  wizard: '生成交互式 bash 向导，带人走完只有人能做的步骤（开基础设施、配凭据或 CI secrets、跑一次性迁移或割接）。',
  'writing-for-agents': '写给 Agent 看的文档：创建或编辑技能，或修改 AGENTS.md / CLAUDE.md。',
  // Vendored from obra/superpowers (MIT), mounted only when its own switch is on.
  brainstorming: '把想法打磨成方案：先判断任务档位（探针 / 小范围 / 架构级），逐条追问需求，分节呈现设计；未获你明确批准前不动手写代码。',
  'writing-plans': '把已定稿的方案写成实施计划：拆成 2–5 分钟一个的小任务，每个任务写清要改的文件、代码、验证步骤与提交。',
  'executing-plans': '在独立会话中执行写好的实施计划：加载计划、批判性复核、逐批执行，在检查点向你汇报。',
  'dispatching-parallel-agents': '把彼此独立的任务（不同测试文件、不同子系统、不同缺陷）并行派发给子 Agent，各自带独立上下文，最后汇总。',
  'subagent-driven-development': '逐任务派发子 Agent 实施并在每个任务后复核（先查是否符合规格、再查代码质量），最后做一次全分支总复核；进度写入文件账本以防上下文压缩后重做已完成的工作。',
  'using-git-worktrees': '开工前先确保工作区隔离：优先用平台的原生隔离能力，其次回退到 git worktree，不在主分支上直接改。',
  'finishing-a-development-branch': '收尾一个开发分支：确认测试、判断所处环境，然后给出合并 / 提 PR / 保留 / 丢弃的选项并执行清理。',
  'receiving-code-review': '收到评审意见后的处理纪律：先核实再实施，不清楚就先问；技术上正确优先于社交舒服，不做表演式赞同或盲从。',
} as const

/**
 * Localize one discovered Skill for display.
 * @param name - skill identifier, matched against the built-in catalog.
 * @param description - upstream (English) description used as the fallback.
 * @param language - active UI language.
 * @returns the Chinese description when one is known and Chinese is active.
 */
export function localizedSkillDescription(name: string, description: string, language: 'zh' | 'en'): string {
  if (language !== 'zh') return description
  return BUILTIN_SKILL_ZH[name] ?? description
}

/**
 * Whether this Skill name has an authored Chinese description.
 * @param name - skill identifier, matched against the built-in catalog.
 * @returns whether a Chinese description is authored for this name.
 */
export function hasLocalizedSkillDescription(name: string): boolean {
  return BUILTIN_SKILL_ZH[name] !== undefined
}

/**
 * Third-party directory entries carry English only. The UI states that plainly
 * rather than letting a Chinese page present untranslated text as finished.
 * @param language - locale the returned labels are written in.
 * @returns the hint text in the active language.
 */
export function upstreamEnglishHint(language: 'zh' | 'en'): string {
  return language === 'zh' ? '上游目录只提供英文简介，以下保留原文。' : 'The upstream directory publishes this entry in English only.'
}

/** Copy shared by the capability marketplace cards and their detail dialog. */
export interface CapabilityText {
  readonly details: string
  readonly close: string
  readonly kickerMcp: string
  readonly kickerSkill: string
  readonly author: string
  readonly category: string
  readonly popularity: string
  readonly source: string
  readonly openInBrowser: string
  readonly summary: string
  readonly readme: string
  readonly readmeLoading: string
  readonly readmeEmpty: string
  readonly readmeError: string
  readonly readmeChinese: string
  readonly install: string
  readonly installed: string
  readonly manual: string
  readonly installing: string
  readonly requiresConfiguration: string
}

/**
 * Build the marketplace copy for one language.
 * @param language - active UI language.
 * @returns the dictionary used by the cards and the detail dialog.
 */
export function capabilityText(language: 'zh' | 'en'): CapabilityText {
  return language === 'zh'
    ? {
      details: '详情',
      close: '关闭',
      kickerMcp: 'MCP 详情',
      kickerSkill: '技能详情',
      author: '作者',
      category: '分类',
      popularity: '热度',
      source: '来源',
      openInBrowser: '在浏览器打开',
      summary: '简介',
      readme: '完整说明',
      readmeLoading: '正在读取上游说明…',
      readmeEmpty: '上游没有可显示的说明文档。',
      readmeError: '暂时无法读取上游说明，可用“在浏览器打开”查看。',
      readmeChinese: '已优先显示上游中文说明。',
      install: '一键添加',
      installed: '已添加',
      manual: '需手动配置',
      installing: '添加中…',
      requiresConfiguration: '该条目需要填写凭据，请在添加后于配置表单中补齐。',
    }
    : {
      details: 'Details',
      close: 'Close',
      kickerMcp: 'MCP DETAILS',
      kickerSkill: 'SKILL DETAILS',
      author: 'Author',
      category: 'Category',
      popularity: 'Popularity',
      source: 'Source',
      openInBrowser: 'Open in browser',
      summary: 'Summary',
      readme: 'Full description',
      readmeLoading: 'Loading the upstream description…',
      readmeEmpty: 'The upstream entry has no description document to show.',
      readmeError: 'The upstream description could not be read. Use “Open in browser” instead.',
      readmeChinese: 'Upstream Chinese description preferred and shown.',
      install: 'Add',
      installed: 'Added',
      manual: 'Manual setup',
      installing: 'Adding…',
      requiresConfiguration: 'This entry needs credentials; fill them in the configuration form after adding.',
    }
}

/** Copy for the Skill library page, so the library follows the language switch. */
export interface SkillPageText {
  readonly running: string
  readonly off: string
  readonly sectionName: string
  readonly meta: string
  readonly extraRoots: string
  readonly discovered: string
  readonly engines: string
  readonly rootsTitle: string
  readonly rootsHint: string
  readonly rootEnabled: string
  readonly rootPaused: string
  readonly rootScan: string
  readonly remove: string
  readonly rootsEmptyTitle: string
  readonly rootsEmptyHint: string
  readonly addDirectory: string
  readonly formTitle: string
  readonly formPath: string
  readonly cancel: string
  readonly saving: string
  readonly addAndScan: string
  readonly skillsTitle: string
  /** Label of the per-Skill switch that hands a Skill to the model. */
  readonly autoInvoke: string
  /** Tooltip explaining what that switch does and what its default is. */
  readonly autoInvokeHint: string
  /** Clears the override so the Skill's own file decides again. */
  readonly followFile: string
  /** One-line reminder that the switch never removes the manual path. */
  readonly autoInvokeScope: string
  readonly skillsHint: string
  readonly skillsEmptyTitle: string
  readonly skillsEmptyHint: string
  readonly englishOnly: string
  // Invocation markers. The library lists user-invoked Skills too, so every row
  // says whether the model can fire it on its own.
  readonly invocationAuto: string
  readonly invocationManual: string
  readonly invocationNone: string
  readonly invocationHint: string
  // Skill detail dialog.
  readonly openDetail: string
  readonly detailTitle: string
  readonly detailLoading: string
  readonly detailError: string
  readonly detailBody: string
  readonly detailCompanion: string
  readonly detailCompanionEmpty: string
  readonly detailFileLoading: string
  readonly detailFileError: string
  /** Heading for a thin alias Skill's resolved target body. */
  readonly forwardedTitle: (name: string) => string
  readonly detailClose: string
  // Bundled packs that are currently unmounted.
  readonly packsOffLabel: string
  readonly packsOffTitle: (count: number, label: string) => string
  readonly packsOffHint: string
  readonly packEnable: string
  readonly packEnabling: string
}

/**
 * Build the Skill library copy for one language.
 * @param language - active UI language.
 * @returns the dictionary used by the Skill library page.
 */
export function skillPageText(language: 'zh' | 'en'): SkillPageText {
  return language === 'zh'
    ? {
      running: '运行中',
      off: '已关闭',
      sectionName: 'Skill 技能库',
      meta: '所有 `SKILL.md` 会被 DeepSeek catalog、Claude bridge 和 Codex app-server 统一发现。内置技能默认关闭，需要时在上方工程增强里开启。',
      extraRoots: '额外目录',
      discovered: '已发现 Skills',
      engines: 'Agent 引擎',
      rootsTitle: 'Skill 根目录',
      rootsHint: '目录修改后会自动刷新发现结果。',
      rootEnabled: '已启用',
      rootPaused: '已暂停',
      rootScan: '扫描该目录下的 Skill 包与 `SKILL.md` 文件。',
      remove: '移除',
      rootsEmptyTitle: '使用默认 Skill 发现规则',
      rootsEmptyHint: '可添加团队共享目录，或从社区精选一键安装推荐 Skill。',
      addDirectory: '添加目录',
      formTitle: '添加 Skill 根目录',
      formPath: 'Skill 根目录',
      cancel: '取消',
      saving: '保存中…',
      addAndScan: '添加并扫描',
      skillsTitle: '已发现 Skills',
      autoInvoke: '允许模型自动调用',
      autoInvokeHint: '打开后模型可以自己选到这个技能；关闭则只有你手动 /调用 它。开关只存在设置里，不会改写技能文件，技能更新也不会覆盖你的选择。',
      followFile: '跟随文件',
      autoInvokeScope: '只影响模型是否自动选用它；你随时都能手动调用。',
      skillsHint: '模型仅在需要时加载 Skill 正文；标有「英文原文」的技能上游未提供中文。',
      skillsEmptyTitle: '暂未发现 Skill',
      skillsEmptyHint: '添加目录、创建 `SKILL.md`，或从社区精选安装推荐项。',
      englishOnly: '英文原文',
      invocationAuto: '模型可自动调用',
      invocationManual: '仅手动调用',
      invocationNone: '不可调用',
      invocationHint: '标有「仅手动调用」的技能模型不会自动触发，只有你亲自点名才会运行：在输入框敲 `/` 从列表里选，或直接输入 `/技能名 你的补充说明` 后发送。点击任意技能可查看它的完整内容。',
      openDetail: '查看内容',
      detailTitle: 'Skill 内容',
      detailLoading: '正在读取该 Skill 的内容…',
      detailError: '无法读取该 Skill 的内容。',
      detailBody: 'SKILL.md 正文',
      detailCompanion: '附带文件',
      detailCompanionEmpty: '该 Skill 目录下没有其他文件。',
      detailFileLoading: '正在读取文件…',
      detailFileError: '该文件无法以文本显示。',
      forwardedTitle: (name: string) => `该技能转发到 \`${name}\` 的正文`,
      detailClose: '关闭',
      packsOffLabel: '内置技能包',
      packsOffTitle: (count: number, label: string) => `还有 ${count} 个内置技能未启用（${label}）`,
      packsOffHint: '这部分技能已随插件一起安装，打开开关即可立即出现在上面的列表中。',
      packEnable: '立即启用',
      packEnabling: '启用中…',
    }
    : {
      running: 'Active',
      off: 'Off',
      sectionName: 'Skills library',
      meta: 'Every `SKILL.md` is discovered by the DeepSeek catalog, the Claude bridge, and the Codex app-server. The bundled library is off by default; enable it under Engineering above.',
      extraRoots: 'Extra roots',
      discovered: 'Discovered Skills',
      engines: 'Agent engines',
      rootsTitle: 'Skill roots',
      rootsHint: 'Discovery refreshes automatically after a directory change.',
      rootEnabled: 'Enabled',
      rootPaused: 'Paused',
      rootScan: 'Scans this directory for Skill packages and `SKILL.md` files.',
      remove: 'Remove',
      rootsEmptyTitle: 'Using the default Skill discovery rules',
      rootsEmptyHint: 'Add a shared team directory, or install a recommended Skill from Community.',
      addDirectory: 'Add root',
      formTitle: 'Add a Skill root',
      formPath: 'Skill root',
      cancel: 'Cancel',
      saving: 'Saving…',
      addAndScan: 'Add and scan',
      skillsTitle: 'Discovered Skills',
      autoInvoke: 'Model may invoke',
      autoInvokeHint: 'On: the model can pick this Skill on its own. Off: only your manual `/name` call runs it. The choice lives in settings, never in the Skill file, so updating a Skill never resets it.',
      followFile: 'Follow file',
      autoInvokeScope: 'Affects only automatic use; you can always call it yourself.',
      skillsHint: 'The model loads a Skill body only when needed; “English only” means upstream ships no Chinese text.',
      skillsEmptyTitle: 'No Skills discovered yet',
      skillsEmptyHint: 'Add a directory, create a `SKILL.md`, or install a recommended entry from Community.',
      englishOnly: 'English only',
      invocationAuto: 'Model can invoke',
      invocationManual: 'Manual only',
      invocationNone: 'Not invocable',
      invocationHint: 'A Skill marked “Manual only” is never triggered by the model — it runs only when you call it by name: type `/` in the composer and pick it, or send `/skill-name your note`. Select any Skill to read its full contents.',
      openDetail: 'View contents',
      detailTitle: 'Skill contents',
      detailLoading: 'Loading this Skill…',
      detailError: 'This Skill’s contents could not be read.',
      detailBody: 'SKILL.md body',
      detailCompanion: 'Companion files',
      detailCompanionEmpty: 'This Skill has no other files.',
      detailFileLoading: 'Loading file…',
      detailFileError: 'This file cannot be shown as text.',
      forwardedTitle: (name: string) => `Body forwarded to \`${name}\``,
      detailClose: 'Close',
      packsOffLabel: 'Bundled Skill packs',
      packsOffTitle: (count: number, label: string) => `${count} bundled Skills are still off (${label})`,
      packsOffHint: 'These Skills ship with the plugin; turning the switch on lists them above right away.',
      packEnable: 'Enable now',
      packEnabling: 'Enabling…',
    }
}
