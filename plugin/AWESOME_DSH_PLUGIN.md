# Listing on awesome-dsh-plugin

How this repository gets its entry onto [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), which is not a plain README list: it is the data source the ecosystem reads. The site (`awesome-dsh-plugin.com/plugins.json`), the in-Harness **Plugin Market** (`dsh-market`) and the agent-side search plugin (`dsh-find-plugin`) all render their catalogs from that repository's `data/plugins/*.yml` files, usually within a day of a merge. Being listed is therefore how a user gets a one-click install; the entry itself is one YAML file and one pull request.

Maintainer document. Contributor-facing rules live in the list's own `contributing.md`; this file records only what that repository's scripts actually enforce and what this repository has to say for itself.

## What the gate checks

Read from the list's scripts rather than from prose, so the constraints below are the executed ones.

| Check | Where | What it means for us |
|---|---|---|
| `dsh.bundle` in a manifest | `scripts/check-submission.mjs` (`hasBundle`) | Required. An entry pointing at a repository root whose own `package.json` declares no bundle is **refused**, with the corrected subpackage URL in the message. |
| Repository age ≥ 1 day | same, `MIN_AGE_DAYS` | Measured from `created_at`. This is the only failure time clears by itself: the gate re-runs on it, so the pull request needs no resubmit, push, or reopen. |
| Repository exists, is not archived | same | — |
| Not DeepSeek Harness itself | same, `FIRST_PARTY_REPOS` / `FIRST_PARTY_PACKAGES` | We vendor no `@deepseek-ai/dsh-base`, `dsh-web-app`, or `dsh-headless`. |
| Entry filename matches the URL | `scripts/lib/entries.mjs` (`slugFor`) | `owner__repo--<subpath with / as ->`.yml. A mismatch is a hard failure. |
| Only `url`, `name`, `category`, `description`, `tarball` | same, `ENTRY_KEYS` | An `npm:` key is refused even though nothing reads it; the npm mapping is discovered from the registry instead. |
| `tarball` shape | same, `tarballProblem` | `https`, on GitHub release hosting, ending in `.tgz`. |
| `description.en` required, single line | same, `validateEntries` | A description containing `: ` must be quoted or the YAML is wrong. |
| At most 3 entries per pull request | `check-submission.mjs`, `MAX_ENTRIES_PER_PR` | We submit one. |
| `dsh-plugin` topic on the repository | `contributing.md` | Set in the repository's About panel. |
| The READMEs are generated | `contributing.md` | Never edit `README.md`/`README.zh.md` over there; the entry file is the whole submission. |

Two further rules are promises the maintainers keep rather than scripts: the description is read as a claim about this plugin and checked against the code (so no numbers we have not counted, no superlatives), and a repository may be delisted when it goes away or stops being maintained. Listing is explicitly **not** a security review.

## Why our entry points at a subdirectory

The gate accepts a bundle manifest in two places: the repository's own `package.json`, or the package.json of the subdirectory an entry URL names. This repository is a workspace whose installable member is the bundle, so the second form is the only one that can be true:

- the repository root has **no** `package.json` at all;
- the one manifest declaring `dsh.bundle` is `plugin/packages/freecodego/bundle-latest/package.json` (package name `freecodego`), which also declares `dsh.bootstrap` and `dsh.client` for the web half;
- the sibling packages (`harness-plugin`, `harness-ui`, `freecodego-api`, the three runtime packages, the router and the two protocol packages) declare no `dsh.bundle` — they are mounted by the bundle, not installed on their own — so "list the plugins, not the bundle" has nothing to name here. The bundle is the plugin, and it is also what composes the patch, mounts the settings surface, and owns the bootstrap.

Pointing at the root would fail the gate; the gate's own failure text asks for exactly the subpackage URL below.

## Why `tarball` is required, and why it is pinned

The gate cannot see it, but installability can: the list's storefronts prefer an npm package, then an author-supplied prebuilt release tarball, and only then a full-repository source install. For us the source install is the one that cannot work — this is a pnpm workspace member whose siblings are unpublished, so nothing installs from the repository root — which makes the prebuilt tarball the entry point rather than a nicety.

The list's own guide states the rule in the same terms: publishing to npm is *"recommended for a better install experience"* because prebuilt installs skip the `allowBuilds` approval, and an author who does not publish *"can attach a prebuilt tarball to a GitHub Release and point at it with an optional `tarball:` field — storefronts will offer it instead of the build-from-source command"*, which it marks as **required** for a repository that cannot be installed from source at all. That is this repository, and for two independent reasons: no `dist/` is tracked in either tree (0 files under `packages/freecodego/*/dist`), and the bundle's only build hook is `prepack`, which runs `pnpm pack` inside this monorepo — a `github:` install runs `prepare` instead, so what a source install produces is a manifest pointing at files that were never built.

It is pinned to a **tag**, not `releases/latest/download/`, for a reason the list's own documentation calls out: `latest/download/` resolves `latest` at request time but takes the filename literally, so an asset name carrying a version works on the day it is submitted and 404s after the next release. Our asset name **is** the Harness version (`freecodego-0.1.6-alpha.2.tgz`, the naming contract in `packages/freecodego/AGENTS.md`), which is precisely that case. Pinning also keeps a stale link harmless: the pinned tarball installs once, and the plugin's own update check takes over from there, offering releases for the Harness actually running.

## The entry

One file, named after the URL it contains:

```
data/plugins/XiangSu-ce__dsh-plugin-freecodego--plugin-packages-freecodego-bundle-latest.yml
```

```yaml
url: https://github.com/XiangSu-ce/dsh-plugin-freecodego/tree/main/plugin/packages/freecodego/bundle-latest
name: XiangSu-ce/dsh-plugin-freecodego#bundle-latest
category: model
description:
  en: 'FreeCodeGo for DeepSeek Harness: a managed free-model gateway and provider catalogs, DeepSeek/Codex/Claude engine routing, an independent advisor reviewer, code review, code graphs, project memory, and an engineering team toolchain.'
  zh: '面向 DeepSeek Harness 的 FreeCodeGo：可托管的免费模型网关与供应商目录、DeepSeek/Codex/Claude 引擎路由、独立 Advisor 评审、代码审查、代码图谱、工程记忆与工程团队工具链。'
tarball: https://github.com/XiangSu-ce/dsh-plugin-freecodego/releases/download/freecodego-v0.1.6-alpha.2.4/freecodego-0.1.6-alpha.2.tgz
```

Notes on the fields, each of which follows from a rule above:

- **`name`** carries the subpackage (`#bundle-latest`) because the URL does. The gate only requires it to be non-empty; the convention is what the list displays.
- **`category`** is `model` ("Models & Providers"), the closest single fit for a family whose distinguishing work is the gateway, the free-provider catalogs and per-provider accounts. `tools`, `usage`, `memory` and `workflow` each describe a part of it as well; the list's maintainers move an entry they think fits better rather than refusing it, so this is a choice, not a judgement call to agonise over.
- **`description`** is quoted on both lines. English is required and is one line ending in a period; Chinese is optional (a maintainer fills it in if missing), and neither may contain a newline. It names no counts, because every number in it is read as a claim and counted.
- **`tarball`** must be refreshed whenever the release for the *current* Harness baseline is superseded — see below.

The npm name is claimed as well, for a reason that is not the listing: an unpublished name is released to other accounts, so leaving `freecodego` unpublished would let anyone take the name the Harness CLI resolves on its own. `freecodego@0.1.6-alpha.2` is published, which also makes the bare-name install work — `dsh plugin --profile web add freecodego` — resolved by the CLI through `pnpm view freecodego versions` against each version's `freecodego.harnessBaseline`. The release workflow publishes both halves from one packed file and verifies each against it, so the two cannot name different versions; the contract is in `packages/freecodego/AGENTS.md`.

## How the card learns the Harness we need

The market's host-aware cards render the requirement declared by `engines.dsh`, or by lockstep `@deepseek-ai/dsh-*` peers. The bundle declares `engines.dsh: ">=<harnessBaseline>"` — a floor rather than a pin, the form other plugins ship and the one that fails safe: a host below the floor is hidden from discovery, and a host above it stays visible instead of being guessed incompatible. One narrow exception looks like a bug and is not: node-semver lets a prerelease satisfy a range only when a comparator shares its exact `major.minor.patch` tuple and itself carries a prerelease tag, so `>=0.1.6-alpha.2` admits `0.1.6-alpha.3` and `0.1.7` but not `0.1.7-alpha.1`. That is the behaviour we want here — a bundle built for one Harness line is not offered on the next line's prereleases — and the floor moves with `freecodego.harnessBaseline` anyway, so the next line declares its own. Our peers are all `*` on purpose, so the peer half of that rule declares nothing and this field is the whole declaration.

Harness itself never reads `engines`: a profile installs with `autoInstallPeers: false` and a hoisted linker, resolving the host's own packages through the shared `profiles/node_modules`, so this field cannot change whether the plugin installs — verified by packing the bundle and installing it through `dsh plugin add`. `freecodego.harnessBaseline` remains the field Harness reads to choose a release for the running version. Because the two must describe one fact, `scripts/release/freecodego-family.spec.ts` asserts that `engines.dsh` is `>=` that baseline: a Harness bump that moved one and not the other would offer the bundle on a line it was no longer built for.

## Order of operations

1. **Create the public repository** — public, no README, no `.gitignore`, no license, so the existing history pushes without an initial commit to merge.
2. **Push** the tree and **publish the release**: tag `freecodego-v<version>`, one asset named `<package name>-<Harness version>.tgz`. The tarball must exist before the entry is submitted, since the storefront follows the URL. The workflow that produces it is `.github/workflows/release-freecodego.yml` at the repository root — dispatched from the tag, it packs and verifies the bundle, publishes the registry half, creates the release with that one asset, and then re-reads both halves to confirm one artifact in two places. It sits at the root rather than under `plugin/` because GitHub resolves workflows against the repository root only; its steps run in `plugin/` through `defaults.run.working-directory`, and the two artifact paths name `plugin/` explicitly because an action input is not a `run:` step.
3. **Add the `dsh-plugin` topic** in the repository's About panel.
4. **Wait until the repository is at least one day old** (and only then open the pull request; the gate will also clear itself if submitted early).
5. **Open the pull request** against `awesome-dsh-plugin/awesome-dsh-plugin` adding the single file above. English description alone is enough; include the Chinese if it is at hand.
6. **Expect a human read.** CI verifies the shape (manifest, age, formatting, README regeneration); a maintainer then opens this repository and checks the description against it. Feedback arrives as a pull request comment naming what to change.

`screenshots.json` sits next to the bundle's `package.json` and lists five images in `screenshots/` (1–8 paths, relative to the file, inside this repository). Storefronts show those images on the plugin's card instead of extracting whatever the README happens to contain, and changing them later needs a push here rather than a pull request over there. The list is in display order, and the first entry is the one the card and our own marketplace tab use as the plugin image, so it is deliberately the widest shot.

The images are not part of the release tarball — the bundle's `files` field does not name `screenshots/`. They only need to exist in the repository, which is what keeps a release asset small.

## Maintenance after listing

- **A new Harness line** means a new release and a one-file pull request to refresh `tarball` (the entry is pinned; nothing follows `latest` automatically). This is ordinary maintenance, not a correction. The pin is not free to name whichever release is newest: `check-entry.mjs` refuses a tag that is not the version this bundle releases as, so the snippet above and the staged entry move together with every release.
- **Moving the bundle** out of `plugin/packages/freecodego/bundle-latest` changes both the URL and the filename, so the entry has to be re-pointed in the same pull request that moves it.
- **The listing is not permanent**: an entry whose repository goes away, is archived, or stops being maintained is collected and removed after review — and a fork that is better kept can take the slot. Nothing here is tenure.
