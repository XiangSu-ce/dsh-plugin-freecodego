# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Install the FreeCodeGo bundle

The FreeCodeGo bundle is installed into a Harness Profile rather than invoked as a command. For a normal terminal, install the CLI and package manager first:

```sh
npm install --global @deepseek-ai/dsh pnpm
dsh plugin --profile web add --save-exact freecodego@next
```

`freecodego@next` reads the active Harness version and selects the newest published FreeCodeGo release declaring the same `freecodego.harnessBaseline`, so a Harness baseline always resolves to the release built and tested against it. For a reproducible install, pin an exact version instead: `npm view freecodego versions` lists the published versions, and every release declares the Harness version it requires.

Desktop must be a build that includes that Harness version. Its private `dsh` and `pnpm` shims use the active `DSH_HOME`; selecting the same Harness home and Profile lets Web and Desktop read the same plugin data.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md).

## Development

Start with the [development guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md) and [architecture documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).

For agents, follow [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md).

## License

[AGPL-3.0](LICENSE)

This project is licensed under the [GNU Affero General Public License v3](LICENSE) (`AGPL-3.0-only`). Versions up to and including 0.1.3 were released under the MIT License; starting with 0.1.4, new source changes are licensed under AGPL-3.0. If you modify this project and make it available over a network, you must offer its Corresponding Source to those users (AGPL §13).

The `FreeCodeGo` name, logo, and official build/distribution channels are not covered by this license — see [TRADEMARK.md](TRADEMARK.md). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
