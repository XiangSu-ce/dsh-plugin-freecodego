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
