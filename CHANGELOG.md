# Changelog

Every release of this repository, newest first.

**This file is where a release takes its notes from.** The release workflow
(`.github/workflows/release-freecodego.yml`) reads the section whose heading
names the version it is publishing and refuses to build anything when there is
none, so a version with no section here cannot be released by accident — the run
stops in its first seconds instead of publishing a Release nobody can read.

The heading names the version the tag publishes (`freecodego-v<version>`), which
is this bundle's own version, not the Harness line it mounts on.

From `0.1.7-alpha.2.2` on, a section carries both languages: `### English`, then
`### 中文`, each holding its own category headings one level deeper (`#### Fixed`,
`#### 修复`). Reading the notes treats only level-2 headings as boundaries, so the
two language groups stay inside the version they belong to. Sections older than
that one are English only: they were published that way, and rewriting them would
change notes people have already read.

## 0.1.7-rc.2.3 — 2026-09-28

### English

A counter on the same Harness line: `freecodego.harnessBaseline`, `engines.dsh`
and the asset name still state `0.1.7-rc.2`, and only this bundle's own version
moved. Three things changed since `0.1.7-rc.2.2`, and one of them is the reason
this counter exists: every model answered 401, whether or not anyone had signed
in.

#### Fixed

- **Signing in no longer leaves every request unauthorized.** A request is
  authorized against a *device session*, not against the token alone, and this
  plugin never named its device: the gateway's session stage rejected every
  model and every route with `API_KEY_NOT_FOUND`, which the client reported as an
  invalid API key. The plugin now mints a device identity (`fcg-<uuid>`, named
  after the machine's hostname), keeps it in the credential vault, and sends it
  on login, registration, 2FA completion and refresh, so the session a token
  refers to exists from the first request. A session minted before the plugin
  knew its device is rotated once, best-effort, the first time it is used: an
  installation older than this version heals itself rather than asking its user
  to sign in again.

#### Changed

- **The conversation model picker offers conversation models.** Image- and
  video-generation routes were listed beside the chat models and did nothing
  when chosen. They are filtered out of the picker and stay where they work,
  `Settings → 生图模型`. An explicit per-model category override still moves a
  route into the picker, because that override is the user's decision while this
  filter is only a default.

#### Added

- **Announcements, published from the backend.** The plugin reads
  `GET /api/v1/announcements` on a 120-second poll and shows what it finds on a
  scrolling stripe above the conversation: fluorescent green for an announcement
  published as 静默, red for 弹窗. Closing one records the read on the *account*
  rather than in the browser, so the same notice stays closed on the account's
  other machines, and `Settings → 公告` lists the history with a switch that
  turns the stripe off and back on. The plugin opens no dialog of its own: a
  notice nobody asked for does not take the screen, and the full text is one
  click away.

### 中文

仍是同一条 Harness 线上的计数版本：`freecodego.harnessBaseline`、`engines.dsh`
与发布资产名都还写着 `0.1.7-rc.2`，只有这个 bundle 自己的版本号前进。自
`0.1.7-rc.2.2` 以来有三处变化，其中一处正是这次计数存在的理由：无论是否登录过，
每个模型都返回 401。

#### 修复

- **登录之后不再「所有请求都未授权」。** 一次请求的授权对象是**设备会话**，而不是
  令牌本身，而本插件此前从不声明自己是哪台设备：网关的会话阶段对**每个模型、每条
  路由**都以 `API_KEY_NOT_FOUND` 拒绝，客户端把它报成了「API 密钥无效」。插件现在
  生成一个设备身份（`fcg-<uuid>`，名字取机器的 hostname）、存入凭证库，并在登录、
  注册、完成两步验证与刷新时一并发送，因此令牌指向的会话从第一个请求起就存在。对于
  在插件知道自己的设备之前签发的会话，第一次使用时**尽力轮换一次**：早于本版本的
  安装会自行修复，而不必请用户重新登录。

#### 变更

- **会话模型选择器只列会话模型。** 生图与生视频路由原先混在对话模型里，选中后什么
  也不做。它们已从选择器里滤掉，留在真正生效的地方：`设置 → 生图模型`。显式的单模型
  分类覆盖仍能把一条路由放进选择器 —— 那是用户的决定，而这个过滤只是默认值。

#### 新增

- **由后端发布的公告。** 插件每 120 秒轮询一次 `GET /api/v1/announcements`，把读到的
  内容显示在会话上方的滚动横条里：管理员以「静默」发布的公告是荧光绿，「弹窗」是红
  色。关闭一条会把已读记在**账号**上而不是浏览器里，因此同一账号在其它设备上也不会
  再提示；`设置 → 公告` 列出历史，并有一个开关可以关掉或重新打开横条。插件自己不弹
  任何对话框：没人主动要看的通知不该占据屏幕，正文点一下就能看到。

## 0.1.7-rc.2.2 — 2026-09-28

### English

What changed since `0.1.7-alpha.2.2`, the last version that could be installed.
This release mounts the Harness `0.1.7-rc.2` line — the bundle version and
`freecodego.harnessBaseline` are both `0.1.7-rc.2`, and the release asset is
named after it. The `0.1.7-rc.2` and `0.1.7-rc.2.1` tags ahead of this version
produced no release and no registry version, so nothing was installable under
them. Three surfaces are either new or repaired since that last version: the
design pack, the companion character, and the speech card in the settings page.

#### Added

- **A design pack of its own.** A `Design` settings section (`designEnabled`,
  off) with six independent capabilities under it (`designFeaturesEnabled`).
  They differ in what they cost rather than in what they are, so they are armed
  separately: work that renders, knowledge that is read, and two upstream packs
  whose whole installation is prose.
  - **HyperFrames** — 17 Skills loaded on selection, plus five read-only tools.
    `freecodego_design_keyframes` and `freecodego_design_lint` answer without a
    browser (the second checks structure and determinism without rendering),
    `freecodego_design_preview` serves a composition on loopback together with
    its timeline listing, `freecodego_design_snapshot` photographs one seeked
    frame, and `freecodego_design_render` encodes an MP4 frame by frame —
    deterministic rather than a screen recording, at roughly a second per
    frame, driving a browser already on the machine.
  - **UI/UX catalogue** — `freecodego_uiux_search` over 34 curated tables and
    2,385 entries, with a calibrated confidence that refuses a low-confidence
    question rather than answering it with a rule that merely looks relevant.
  - **Craft** — eleven vendored rulebooks reached through
    `freecodego_design_craft` (`list`, `get`, `resolve`), including upstream's
    own composition rule for a design system that deliberately breaks one.
  - **Impeccable** — `freecodego_design_detect`: 61 deterministic rules,
    delegated whole to the engine when the machine already has one and answered
    from a built-in subset when it does not, with every result naming who
    answered, which rules ran and how many upstream has.
  - **React Bits** — `freecodego_reactbits` (`search`, `get`, `apply`) reads
    upstream on demand instead of bundling components, because the licence
    permits using them and forbids redistributing them; `apply` writes only into
    a directory the caller names with `confirm: true`, and lists the two
    mechanical edits it makes.
  - **Taste** — thirteen vendored design-direction Skills, published whole
    rather than trimmed, and loaded only when one is selected.
- **The companion character stopped being one expression.** It is drawn from the
  session's state rather than told what to show, and two pools now rotate *what
  is drawn* on the shared clock without moving that state: which pose illustrates
  the busy states, and which eyes the character wears (1.5s while busy, 4.2s at
  rest, never the same outline twice in a row). `freecodego_companion_face` lets
  the model ask for `neutral`, `happy`, `delighted`, `sad`, `focused`, `sleepy`
  or `surprised` for a few seconds; the tool writes nothing, so the request
  travels through the Session's own event window and is visible in the
  transcript. A tool result that came back a failure briefly puts the sad face
  on by itself, reading both shapes a result uses — the core's `isError` flag
  and the shell renderer's trailing `[exit code: N]`.
- **The speech card, and one question it had to be able to ask.** The
  recognizer's endpoint, model id and key are editable on the plugin's own
  settings page, and one button posts half a second of silence through the
  stored route to report what actually happened. Every configuration fact the
  card could previously show is true on a machine that cannot reach the
  endpoint at all — a process behind a proxy it does not know about is refused
  while the same browser reaches the provider fine — which is why the answer is
  now a code (`ok`, `unauthorized`, `forbidden`, `not-found`, `unreachable`,
  `provider-error`) rather than a restatement of the configuration.
- **Turning voice input on now elects this plugin's recognizer.** Registering a
  provider used to leave the selection with the bundled local model, so the
  switch read as "on" while the next dictation still asked to download one. The
  adoption happens on the registration edge, so a choice the user made in the
  picker is kept while this plugin stays registered, and withdrawing hands the
  selection back to a recognizer that can serve it.

#### Fixed

- **The speech card no longer reports a status that never existed.** A route
  with no key is refused before any request, so the probe's `unauthorized`
  outcome arrives without an HTTP status — and the sentence built from it said
  `HTTP undefined`. It now names the missing key and quotes the Host's own
  reason.
- **The card's save confirmation was Chinese on the English page.** Both
  branches of the label were `已保存`; the English surface says `Saved`.

### 中文

相对上一个可以安装的版本 `0.1.7-alpha.2.2` 的变化。本次 release 挂载 Harness
`0.1.7-rc.2` 这条线 —— bundle 版本与 `freecodego.harnessBaseline` 都写 `0.1.7-rc.2`，
release 资产名也按这条线命名。排在它前面的 `0.1.7-rc.2` 与 `0.1.7-rc.2.1` 两个 tag 既没有
产出 release，也没有 registry 版本，因此那两个版本号下没有任何可安装的东西。相对上一个
版本，三处新做或修好的面：设计包、伴侣角色，以及设置页里的语音卡片。

#### 新增

- **一个自己的设计包。** 一个 `Design` 设置区（`designEnabled`，默认关），下面挂
  六个相互独立的能力（`designFeaturesEnabled`）。它们的差别不在「是什么」而在
  「花什么」，所以分别装备：会渲染的工作、只被读的知识，以及两套「安装就是正文」的
  上游包。
  - **HyperFrames** —— 17 个 Skill 按需加载，加五个只读工具。`freecodego_design_keyframes`
    与 `freecodego_design_lint` 不需要浏览器即可作答（后者不渲染就检查结构与确定性），
    `freecodego_design_preview` 把 composition 伺服在回环地址上并给出时间轴清单，
    `freecodego_design_snapshot` 在指定时刻抓一帧，`freecodego_design_render` 逐帧
    编码 MP4 —— 它是确定性的而不是录屏，约每秒一帧，驱动的是本机已有的浏览器。
  - **UI/UX 目录** —— `freecodego_uiux_search` 检索 34 张精选表、2,385 条建议，
    置信度经过校准：低置信度会明确拒答，而不是硬凑一条看起来相关的规则。
  - **Craft** —— 11 篇随包发布的规则手册，经 `freecodego_design_craft`（`list`、
    `get`、`resolve`）查阅，包含上游自己那条「设计系统可以刻意破例」的组合规则。
  - **Impeccable** —— `freecodego_design_detect`：61 条确定性规则；本机已有引擎时
    全量委托给它，没有则用内置子集作答，且每次结果都写明是谁回答的、跑了哪些规则、
    上游总数是多少。
  - **React Bits** —— `freecodego_reactbits`（`search`、`get`、`apply`）按需读取上游
    而不是把组件打包进来，因为许可证允许使用、禁止再分发；`apply` 只写进调用者点名
    的目录（必须带 `confirm: true`），并逐条列出它做的两处机械修改。
  - **Taste** —— 13 篇随包发布的设计方向 Skill，整篇发布而不裁剪，只有被选中时才加载。
- **伴侣角色不再是一个表情。** 它是从会话状态画出来的，而不是被告知该显示什么；现在有
  两条池子按共享时钟轮换**画出来的东西**、从不移动那个状态：忙碌状态用哪个姿态来表现，
  以及角色戴哪个眼型（忙碌 1.5 秒、休息 4.2 秒，绝不让同一个眼型连着出现两次）。
  `freecodego_companion_face` 让模型可以点 `neutral`、`happy`、`delighted`、`sad`、
  `focused`、`sleepy`、`surprised` 中的一个并保持几秒；这个工具不写入任何东西，请求
  沿会话自己的事件窗口传递，因此实时出现在转录里。工具结果以失败返回时，角色会自己
  短暂换上难过的脸，并读会话使用的**两种**形状 —— 核心的 `isError` 标记，以及 shell
  渲染器那行 `[exit code: N]`。
- **语音卡片，以及它必须能问的那个问题。** 识别器的接口地址、模型 id 与密钥都可以在
  插件自己的设置页里改，另有一个按钮会向已保存的路由发半秒静音、并按实际发生的事作答。
  卡片原先能展示的每一项配置事实，在一台根本连不到该端点的机器上全都为真（一个进程
  不知道的代理后面会被拒绝，而同一个浏览器访问同一提供方却完全正常），所以答案现在是
  一个代码（`ok`、`unauthorized`、`forbidden`、`not-found`、`unreachable`、
  `provider-error`），而不是把配置再念一遍。
- **打开语音输入现在会选定本插件的识别器。** 以前注册一个 provider 会把这个选中项留给
  随包发布的本地模型，于是开关显示为「开」，而下一次听写仍然要求下载模型。接管发生在
  注册的边沿上，因此只要本插件仍在册，用户在识别服务里做过的选择就被保留；退出时选中项
  会被交还给一个确实能服务的识别器。

#### 修复

- **语音卡片不再报一个从未存在过的状态。** 没有密钥的路由在任何请求之前就被拒，因此
  探测的 `unauthorized` 结果不带 HTTP 状态 —— 而由它拼出的句子写成 `HTTP undefined`。
  现在它会点名缺失的密钥，并引用 Host 自己给出的理由。
- **卡片的「已保存」提示在英文页面上是中文。** 那个标签的两个分支都写成了 `已保存`；
  英文面现在显示 `Saved`。

## 0.1.7-alpha.2.2 — 2026-09-24

### English

A counter on the same Harness line: `freecodego.harnessBaseline`, `engines.dsh`
and the asset name still state `0.1.7-alpha.2`, and only this bundle's own
version moved — the hotfix form `packages/freecodego/AGENTS.md` documents.

#### Fixed

- **Creating an account no longer fails after the gateway has already created
  it.** The response reader required `user.username`, while the mobile
  registration channel writes an address and a password and nothing else: a
  *successful* registration was refused with `FreeCodeGo response user.username
  must be a non-empty string`, the account was taken from then on, and the next
  request for that address was answered `EMAIL_EXISTS` — which is what the resend
  control then reported, making a completed signup look like a broken form. An
  absent or empty username now falls back to the address's local part (the
  identity this card shows anyway), and every other field the profile needs is
  still required, so the tolerance is scoped to the one field the gateway may
  legitimately leave out.
- **A rejected sign-in or registration now says why, beside the button that sent
  it.** The reason travelled to the panel-wide alert above the page tabs, which is
  off screen by the time the reader is typing a code, so a refused click was
  indistinguishable from a button that does nothing — and what it showed was the
  Host's own transport line, `FreeCodeGo authentication request failed with HTTP
  400: …`, which is a log entry rather than a sentence. The card draws its own
  notice where the button is, the button names the work in flight and refuses a
  second press, and the failures the card can act on are stated in the card's
  language; anything else keeps the gateway's wording, framed so the reader can
  tell the click did something.
- **Password recovery is reachable.** The registration code channel refuses an
  address that already has an account by design, and the gateway's
  `/mobile/auth/forgot-password` (called with `method: 'code'`, so it mails a code
  instead of a link built for its browser flow) and `/mobile/auth/reset-password`
  were not wired at all — so a returning user who had forgotten the password had
  nowhere to go from the sign-up tab. Both now reach the Host through new
  remotes, and the account card offers the form from the sign-in side, sharing
  the address that was just rejected; a completed reset returns the reader to
  sign-in with the new password cleared, because the gateway issues no session
  for a reset. A Host predating those remotes hides the entry rather than
  offering a flow that can only fail. `remote-call-contract.spec.ts` moves with
  them, so a remote with no caller is still a failure rather than a discovery to
  make in the browser.

### 中文

同一条 Harness 线上的又一次计数发布：`freecodego.harnessBaseline`、`engines.dsh`
与资产名仍写 `0.1.7-alpha.2`，只有本 bundle 自身的版本号前进 —— 也就是
`packages/freecodego/AGENTS.md` 记录的那种 hotfix 形式。

#### 修复

- **注册不再在网关已经把账号建好之后才报错。** 响应读取器把 `user.username` 当作必填，
  而移动端注册通道只写邮箱与密码，别的什么都不写：一次**已经成功**的注册被拒，报的是
  `FreeCodeGo response user.username must be a non-empty string`。此后这个邮箱已被占用，
  下一次请求被回以 `EMAIL_EXISTS` —— 也就是「重新获取验证码」按钮当时显示的那句话，
  于是一次完成的注册看起来像表单坏了。现在 username 缺失或为空串时回退到邮箱 @ 之前
  那一段（这张卡片本来展示的就是它），而资料里其余字段仍然必填，所以这份宽容只覆盖
  网关确实可能省略的那一个字段。
- **登录或注册被拒时，理由显示在按钮旁边。** 原来理由被送到页面标签栏上方那块整屏提示
  里 —— 等你开始输验证码时它早就在屏幕外 —— 于是「被拒的点击」和「按钮没反应」无从区分；
  而且它渲染出的是 Host 自己的传输层原文（`FreeCodeGo authentication request failed with
  HTTP 400: …`），那是日志，不是给人读的句子。现在卡片在按钮所在位置画出自己的提示条，
  按钮会说明正在进行的操作并拒绝第二次点击；卡片能处理的失败用卡片自身语言陈述，其余
  保留网关原话但加一层框架，读者能看出这次点击确实发生了。
- **找回密码可以走通了。** 注册验证码通道按设计就拒绝已有账号的邮箱，而网关的
  `/mobile/auth/forgot-password`（以 `method: 'code'` 调用，寄的是验证码，而不是给它自家
  浏览器流程用的链接）与 `/mobile/auth/reset-password` 此前完全没有接线 —— 于是忘了密码的
  老用户在注册标签页里无路可走。现在两者都经新的 remote 抵达 Host，账号卡片在登录一侧
  提供该表单，并沿用刚刚被拒的那个邮箱；重置完成后回到登录，新密码被清空，因为网关不会
  为一次重置签发会话。没有这两个 remote 的旧 Host 会隐藏该入口，而不是提供一个必然失败的
  流程。`remote-call-contract.spec.ts` 随之更新，「有 remote 没有调用方」仍然是失败，而不是
  留给浏览器去发现。

## 0.1.7-alpha.2.1 — 2026-09-23

This is the first version published for Harness `0.1.7-alpha.2`, under a counter
rather than under the line's own version. The line's first attempt was tagged
`freecodego-v0.1.7-alpha.2`, and its pack job died on a file the published tree
never carried (`### Fixed` below); a tag is immutable here, so the correction is
republished one dotted segment deeper — the hotfix form `packages/freecodego/AGENTS.md`
documents — which leaves the tag naming the exact version and the asset naming
the Harness line. Everything below is what that version contains.

### Changed

- This release targets Harness `0.1.7-alpha.2`, and everything that names the
  line moves together: this bundle's version is the line with a counter on it,
  while `freecodego.harnessBaseline`, `engines.dsh`, the release tag and the name
  of the asset it attaches all state the line itself. The
  checked-in source has been the `0.1.7-alpha.2` tree since that commit was
  recorded as the candidate in `harness.lock.json`; this release is the one that
  promotes it, in that file and in `harness.config.json` and `COMPATIBILITY.md`
  alike. A Host still on `0.1.6-alpha.2` is no longer offered an update, because
  a bundle mounts one Harness line and this is the line it is built against.
- Every peer a Host supplies now declares `>=0.1.7-alpha.2` instead of `*`. An
  open `*` admits no prerelease version at all: node-semver lets a prerelease
  satisfy a range only when a comparator carries the same `major.minor.patch`
  tuple and a prerelease tag of its own, and this Harness line publishes
  prereleases only — so the range named a Host that does not exist, which is the
  shape the plugin list documents as the usual cause of an install-time
  `ERESOLVE`. The floor is the value `engines.dsh` already carried, so the two
  cannot state different lines, and `react` keeps `*` because no Host supplies
  it. `scripts/check-workspace-constraints.ts` accepts the floor in place of `*`
  for this subtree alone.
- Engineering enhancement is on by default. An installation that never opened
  the setting keeps it, and turning it off explicitly still turns it off.
- A model a curated provider offers is no longer hidden from the picker by its
  price, and the default visible set gains `claude-sonnet-4-6`: a user who chose
  a provider can see what that provider offers.
- An OpenCode free-tier refusal now says what it is. The hint is claimed only by
  a 403 carrying the provider's own free-tier marker, and Kilo's rate-limit
  message no longer answers for a status it never described.

### Added

- A switch for image and video generation (`mediaGenerationEnabled`, on by
  default) in the FreeCodeGo settings tab. Turning it off unregisters
  `freecodego_generate_image` and `freecodego_generate_video` — and the legacy
  `agnes_generate_*` aliases — rather than refusing them at call time, so their
  schemas leave the model's tool list with them and no tool is left visible but
  uncallable. Audio generation and transcription stay outside the switch: one
  writes into the workspace, the other reads from it. The panel reports what the
  switch governs and what this installation actually mounts as two separate
  facts, so an installation without an Agnes account is not described as missing
  tools.
- The model that answers web search is selectable. The page over
  `web-search-deepseek` edits the key, the endpoint and the search budget, and
  leaves the model at the schema default; the new section lists the models this
  plugin routes, takes the endpoint and the credential from the Host, and writes
  the choice into the same `web-search-deepseek` namespace, so the two surfaces
  cannot disagree.
- Deleting a conversation is reachable from the session row's menu, after
  Archive. The hover control exists only while a pointer is over the row; the
  named row is the same action for touch and keyboard, reports its failure
  through the overlay that outlives the menu, and hides itself under the same
  `sessionDeleteEnabled` switch.

### Fixed

- The published tree now carries the two files `build:freecodego` names and did
  not have. `scripts/gen-preset-patches.mjs` is the module its
  `verify-preset-patches` gate runs, and `scripts/freecodego-service-facades.spec.ts`
  is the spec `verify-service-facades` runs; the published repository ignores
  `scripts/*` wholesale, so both were present only in the working copy the
  release was cut from. The pack job reached the first of them and stopped on
  `Cannot find module`, which is why this version exists under a counter. A
  release run is the first time anyone asks whether a clone receives every file
  the release path names, so that question is now a gate:
  `scripts/published-release-inputs.spec.ts` reads the workflow's own steps,
  follows them through the published manifests and the files they open, and
  fails on a fork-owned file that is on a dependency path and would not be in a
  clone.

## 0.1.6-alpha.2.4 — 2026-09-23

Nothing in the bundle itself changes in this version either: it carries the
release pipeline fixes the version before it exposed, so that a release which
fails in the registry half can be retired or repaired instead of leaving a tag
whose two halves disagree.

### Fixed

- A publish the registry acknowledges is no longer treated as a published
  version. The registry accepts an upload before the version it accepted can be
  installed, and npm reports that acceptance as success — in its own words,
  "Your package is being processed and may take a few minutes to become
  available" — so the publish step confirmed nothing, the release step built the
  release on top of it, and the final step found no version to verify. The
  publish step now waits until the registry carries this release's bytes, and
  says what happened when it never does.
- A release whose registry half failed can be repaired by re-running it. The
  release step refused any tag that already carried a release, so a run that had
  published its release asset while the registry half was still arriving could
  not be retried at all — which is the one situation the step order (registry
  first, release second) exists to make re-runnable. It now continues when the
  existing release already carries this run's asset, and still refuses one
  carrying anything else, because that is what a withdrawn release looks like.
- The verification step reads the registry until it settles instead of once, so
  a slow registry is no longer reported as a failed release.
- A refused publish explains itself. npm answers every way the
  trusted-publishing exchange can fail with one opaque `ENEEDAUTH`, and prints
  its own reason only at a raised log level — which is what the previous
  version's release spent its attempts discovering. The publish step now names
  the trusted-publisher fields the run has to match, read from the run itself,
  or the permission that never reached npm; and a manually dispatched run can
  raise npm's log level to read the registry's own words.

## 0.1.6-alpha.2.3 — 2026-09-23

Nothing in the bundle itself changes in this version: it is about being able to
build and publish the bundle from this repository alone. A reader who only mounts
it can skip it.

### Changed

- The published tree now carries every helper its own release run reads. The
  workspace synchronization reads a few of them directly, and without them the
  release stopped in its first minute — before anything was built, with the
  publish half skipped behind it. That is why the three versions before this one
  exist as tags and releases on GitHub but never reached the registry.
- The synchronization also materializes the upstream entries under `scripts/`
  that a fresh clone does not start with, and the workspace manifest names the
  bundler those steps use. Both are what the build stopped on once the
  synchronization itself could run.
- Release notes are written per version, in this file, and a release takes them
  from the section naming its version. The fixed sentence they replace described
  the artifact rather than the version, so a reader learned nothing about what
  changed — and a version with no section here is now refused before the build
  starts rather than published under notes about some other version.

## 0.1.6-alpha.2.2 — 2026-09-23

### Added

- The free-model tables in this repository's READMEs are **generated** from each
  provider's own directory rather than maintained by hand. Three providers are
  read live (OpenCode, Kilo, Logfare); NVIDIA and SenseNova publish a roster and
  expose a directory that needs a key, so their rows are cross-checked when the
  environment has one. The generator and its check ship in the package:
  `pnpm run generate-free-model-tables` and `pnpm run verify-free-model-tables`.
  A route upstream retires now leaves the table on the next read, which is how
  `gpt-image-2` and `hy3-free` were found still listed after they were withdrawn.
- The lefthook installer the workspace's `postinstall` names is part of the
  published tree, so a clone can install without a missing-module failure.

### Fixed

- Regenerating the tables without network access dated them to the previous day
  whenever the recorded reading happened between local midnight and the UTC
  offset. The recording now carries the date the reading had, which is the date
  the table states, and a recording without one is refused instead of guessed.

## 0.1.6-alpha.2.1 — 2026-09-23

### Changed

- Pushing the family's tag (`freecodego-v*`) now starts the release workflow by
  itself, so publishing a version needs no second action after the push. A
  manual dispatch remains for a re-run that has to start without a new tag.
- The workflow's pnpm setup reads `plugin/package.json`: the workspace manifest is
  where this repository declares its pnpm version, and a run that looked for it at
  the repository root failed before the first step.

## 0.1.6-alpha.2 — 2026-09-23

### Added

- First public release: FreeCodeGo for DeepSeek Harness, published as the
  standalone `freecodego` bundle — the engine inventory, a managed free-model
  gateway, per-provider accounts, media generation, and the engineering
  (code-graph + memory) toolchain — together with this repository's root face.
