# Packaging the FreeCodeGo plugin

Instructions for any agent that builds, packs, or publishes this plugin. It covers one contract — the name a release carries — and the commands that produce it. Where this file and the code disagree, the code is right and this file is the bug.

## The naming rule

A release asset is named after the package and the **Harness version the bundle mounts on**, never after the bundle's own version:

    freecodego-0.1.6-alpha.2.tgz     # the bundle built for Harness 0.1.6-alpha.2

Spelled out: `<package name>-<Harness version>.tgz`, with a scope flattened the way a packed tarball is named (`@scope/name` is `scope-name`). Three consequences worth holding before changing anything:

- **The tag names the exact version; the asset names the line.** A release is tagged `freecodego-v<version>`, where the version is the bundle's own, read from `packages/freecodego/bundle-latest/package.json`. A hotfix on the same Harness line publishes a version one dotted segment deeper (`0.1.6-alpha.2.1`), so its tag and its asset name differ on purpose: the tag says exactly which version it is, and the asset says which Harness line it belongs to, which is the compatibility answer a user reads off a release.
- **A bundle names the file through `freecodego.harnessBaseline`.** The pack step reads it from the bundle manifest and fails a bundle that does not declare it, because a bundle that cannot say which Harness line it belongs to has no published name.
- **Both spellings stay reachable.** The update checker looks for the Harness name first, then the bundle-version name, and settles for a release's only tarball. A release published under the older convention still updates; renaming an asset at upload time is the one way to publish a release no check finds.

## Who implements it

- Publishes: `scripts/release/families.ts` — `harnessAssetName`, returned by the `freecodego` family's `assetNameFor`.
- Re-packs: `scripts/release/pack.ts` — renames what `pnpm pack` wrote to the asset name, inside the pack directory, so every later step reads the published name.
- Looks it up: `packages/freecodego/harness-plugin/src/plugin-update.ts` — `releaseAssetNames` is the ordering above.
- Pins it: `scripts/release/freecodego-family.spec.ts` and `packages/freecodego/harness-plugin/tests/plugin-update.spec.ts`, one side each.

The two implementations cannot import each other: the checker ships inside the published package, and a relative import out of a project reference is one TypeScript refuses to rewrite. Writing the rule down twice is deliberate, and the two specs are what make a change on one side fail the other.

## Commands

    pnpm run sync:harness                                  # only when the harness checkout is absent
    pnpm install --frozen-lockfile
    pnpm run release:verify --family freecodego            # versions, tag, client-build record
    pnpm run build:official                                # bind the client build to this release
    pnpm run release:pack --family freecodego --out dist/freecodego
    pnpm run release:verify-packed-install --family freecodego --from dist/freecodego
    pnpm run release:publish --family freecodego --from dist/freecodego          # the registry half
    pnpm run release:verify-published --family freecodego \
      --tarball dist/freecodego/freecodego-<Harness version>.tgz                  # both halves, re-read

`release:pack` writes `dist/freecodego/freecodego-<Harness version>.tgz`, so the file is already named as the release asset when it lands. Upload it under that name.

The `pack` job of `.github/workflows/release-freecodego.yml` runs these build steps in this order and uploads the packed directory. Its `publish` job authenticates to the registry through **trusted publishing** (an OIDC token it requests per run), so the pipeline stores no long-lived publish credential: the job asks for `id-token: write` and installs `npm@^11.5.1`, the floor the CLI needs to exchange that token. Two things live outside the repository and must exist before a release can publish: a trusted publisher registered on npm for this package (owner, repository, and the workflow filename `release-freecodego.yml`), and a **public** repository — npm generates a provenance attestation for a trusted publish, and refuses to when the repository is private. Setting `NPM_TOKEN` instead is possible but is not the configured path: it needs an `.npmrc` reading `NODE_AUTH_TOKEN`, which is why nothing here sets `registry-url`. The job then publishes **both halves of one version out of that one file**. It refuses to continue unless the file already carries the asset name an update check looks for, publishes it to the registry — `release:publish` skips a version whose published bytes already match and retries a registry write that did not settle, which is what makes a re-run safe — creates the release, and finally re-reads both places: the release from the API, the version from the registry, each through the lookup its own consumer uses. So a release no check can select, a registry version carrying different bytes, a Harness baseline the registry disagrees with, and a version published under the wrong channel tag each fail the run instead of shipping quietly.

A re-run depends on the packed bytes: `release:pack` is reproducible from a fixed checkout — two packs of one commit produce the same tarball — so a run repeated after a failure publishes the registry half by skipping it, rather than refusing it as changed content.

Withdrawing a version therefore takes two edits, not one: the release is withdrawn by editing it, and the registry version by `npm deprecate` or `npm unpublish`. Dropping only the release leaves the CLI's bare-name install path able to select that version, because that path resolves through the registry rather than through releases.

## The export-doc gate and what it still covers

`pnpm run verify-export-jsdoc` is the one hygiene gate that used to have work left in this subtree. It requires, for every package that exports `./src/*` — which is every package here, upstream included — that each exported declaration carry description prose, each parameter a non-empty `@param`, and a non-empty `@returns` whenever the result is not void.

The wildcard decides the scope, and this is the part worth knowing before reading the gate's output as a defect list: with `exports['./src/*']` present the gate requires *every* export in `src`, not the package's public API. The public API is the smaller, reader-facing surface. Measured on 2026-09-20, the views stand at:

- **public API — 0 violations.** Every name reachable from the package entry points is documented.
- **internal exports in this subtree — 0 open.** Every module-level helper under `packages/freecodego/**`, reachable from an entry point or not, now carries prose, its `@param`s and its `@returns`; this view stood at 890 open before the sweep that closed it.
- **remaining 5 — upstream packages, deliberately untouched.** `fs/tool-fs`'s `applyReadTool` (no JSDoc), `session/session-persistence-jsonl`'s `JsonlSessionPersistence.delete` (missing `@param id` and `@returns`) and `util/timeout`'s `remainingTimeoutMs` (missing `@param signal` and `@returns`). All three sit outside `packages/freecodego/**`; documenting them would make this fork's copy of upstream source differ for a reason that has nothing to do with the plugin.

The gate skips an in-package vendored copy: a directory carrying a `PROVENANCE.md` marker is upstream source compiled verbatim, and documenting it would edit vendored code and invalidate the per-file hashes the marker records. `packages/freecodego/harness-ui/src/client/companion/engine/` is the one such copy in this subtree, and the ten files under it depend on that exclusion.

To measure the public-API view yourself, copy the gate, delete the `exports['./src/*']` early-continue in `restrictedPublicNames`, and count what is left — the narrowed set is exactly the names the entry points reach.

Two conventions keep the writing cheap and the diff honest: insert documentation by anchoring on the declaration (extend an existing block just above its `*/`, otherwise add a block above the declaration), and never rewrite the file — comments are inserted into the text as it stands, so a file's line endings and untouched bytes survive. Parameter and result wording has a fixed table for the names whose meaning the signature certifies (`sessionId`, `signal`, a `*Host`, a `*Request`, `workspaceRoot`, and so on); everything else is written by reading the declaration.

## Related

- `AGENTS.zh.md` — this contract in Chinese, for a reader who works in it.
- `harness-plugin/README.md` — the user-facing description of what an update check does, in the same terms.
- `bundle-latest/README.md` — what the bundle carries and what it declares.
- `harness-ui/DESIGN.md` — the UI token contract, with the reasoning a change there has to respect.

## Gates that apply to this subtree

Two checks constrain this subtree and neither is part of the release pipeline, so a release can pass while a gate is red. Both are pure scripts under the repository root and carry a baseline of accepted debt rather than a zero-violation bar:

- `node scripts/architecture/architecture-check.mjs --changed` — package boundaries, import cycles, file-size and public-contract budgets. Policy in `architecture-policy.yaml`, baseline in `.architecture-baseline.json`.
- `node scripts/design/design-check.mjs --changed` — the UI token contract above. Baseline in `packages/freecodego/harness-ui/.design-baseline.json`.

Each reads only git-touched files with `--changed`, so a red gate on an untouched package is pre-existing debt, not a regression you caused; run it without the flag before concluding either way. Updating a baseline is a deliberate act — it hides a violation from CI — so run `baseline:update` only after the change that caused it is understood. See `scripts/architecture/README.md` and `scripts/design/README.md`.
