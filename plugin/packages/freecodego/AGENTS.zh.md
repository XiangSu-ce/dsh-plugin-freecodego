# FreeCodeGo 插件打包说明

这份文件写给任何构建、打包或发布本插件的 agent（以及人）。它只讲一个约定 —— 一个 release 携带的名字 —— 以及产出它的命令。本文件与代码不一致时，以代码为准，本文件即为缺陷。

## 命名规则

release 资产以「包名 + **bundle 所挂载的 Harness 版本**」命名，绝不使用 bundle 自身声明的版本：

    freecodego-0.1.7-alpha.2.tgz     # 为 Harness 0.1.7-alpha.2 构建的 bundle

写成形式：`<包名>-<Harness 版本>.tgz`，作用域按打包 tarball 的写法压平（`@scope/name` 即 `scope-name`）。改动前需要记住三点：

- **tag 记精确版本，资产名记 Harness 线。** release tag 为 `freecodego-v<version>`，其中 version 取自 `packages/freecodego/bundle-latest/package.json`。同一条 Harness 线上的 hotfix 会发布深一个点段的版本（`0.1.7-alpha.2.1`），因此它的 tag 与资产名有意不同：tag 说明具体是哪个版本，资产名说明它属于哪条 Harness 线 —— 后者正是用户从 release 上读到的兼容性答案。
- **bundle 通过 `freecodego.harnessBaseline` 决定文件名。** 打包步骤从 bundle manifest 读取它；没有声明的 bundle 直接报错停止，因为说不出自己属于哪条 Harness 线的 bundle 没有发布名。
- **两种拼法都仍然可达。** 更新检查先找 Harness 名，再找 bundle 版本名，最后接受「该 release 只有一个 tarball」。用旧约定发布的 release 依然能更新；**在上传时改名**是唯一能发出「谁也找不到的 release」的做法。

## 规则落在哪里

- 生产：`scripts/release/families.ts` 的 `harnessAssetName`，由 `freecodego` 家族的 `assetNameFor` 返回。
- 改名：`scripts/release/pack.ts` 在打包目录内把 `pnpm pack` 的输出改名为资产名，因此后续每一步读到的都是发布名。
- 查找：`packages/freecodego/harness-plugin/src/plugin-update.ts` 的 `releaseAssetNames`，即上面的顺序。
- 钉住：`scripts/release/freecodego-family.spec.ts` 与 `packages/freecodego/harness-plugin/tests/plugin-update.spec.ts`，各守一侧。

两侧实现无法互相 import：更新检查器随发布包一起分发，而从项目引用里相对 import 是 TypeScript 拒绝重写的形式。规则因此写了两遍，两个 spec 就是让一侧的改动在另一侧失败的东西。

## 命令

    pnpm run sync:harness                                  # 仅在缺少 harness 检出时
    pnpm install --frozen-lockfile
    pnpm run release:verify --family freecodego            # 版本、tag、客户端构建记录
    pnpm run build:official                                # 把客户端构建绑定到本次 release
    pnpm run release:pack --family freecodego --out dist/freecodego
    pnpm run release:verify-packed-install --family freecodego --from dist/freecodego
    pnpm run release:publish --family freecodego --from dist/freecodego          # registry 那一半
    pnpm run release:verify-published --family freecodego \
      --tarball dist/freecodego/freecodego-<Harness 版本>.tgz                     # 两半都复验

`release:pack` 产出的文件就是 `dist/freecodego/freecodego-<Harness 版本>.tgz`：落盘时已经带着发布资产的名字，按该名上传即可。

`.github/workflows/release-freecodego.yml` 的 `pack` 作业按同样顺序执行这些构建步骤并上传打包目录；它的 `publish` 作业通过 **trusted publishing**（每次运行申请一枚 OIDC token）向 registry 认证，因此这条流水线不保存任何长期发布凭据：作业声明 `id-token: write`，并安装 `npm@^11.5.1` —— 这是 CLI 换取该 token 所需的下界。有两件事在仓库之外、且必须在发布前就绪：在 npm 上为本包登记 trusted publisher（owner、仓库名、工作流文件名 `release-freecodego.yml`），以及仓库必须是**公开**的 —— trusted publishing 会自动生成 provenance 证明，而私有仓库会被拒绝。改用 `NPM_TOKEN` 也是可行的，但不是当前配置的路径：它需要一条读 `NODE_AUTH_TOKEN` 的 `.npmrc`，这也是这里不设 `registry-url` 的原因。之后它**用那一份文件发布同一个版本的两半**。它会先确认该文件已经带着更新检查要找的资产名，再把它发布到 registry（`release:publish` 对字节已一致的版本直接跳过、对没落地的 registry 写入重试，重跑因此是安全的），然后创建 release，最后把两处都读回来复验：release 走 API，版本走 registry，各按各自消费者的读法。因此「没有检查能选中的 release」「registry 上字节不同的版本」「registry 与包声明不一致的 Harness 基线」「发布到错误频道 tag 的版本」都会让这次运行失败，而不是静默发布出去。

重跑是否安全取决于打包字节：`release:pack` 在固定检出上是可复现的 —— 同一个 commit 打两次包会得到同一个 tarball —— 所以失败后重跑时，registry 那一半是被跳过、而不是被判为内容变了而拒绝。

撤回一个版本因此是两处改动而非一处：release 靠编辑它撤回，registry 上的版本靠 `npm deprecate` 或 `npm unpublish`。只撤掉 release，CLI 的裸名安装路径仍可能选到那个版本——因为那条路径读的是 registry，不是 release。

## 导出文档门禁与它目前的覆盖范围

`pnpm run verify-export-jsdoc` 是唯一曾经还有活儿落在这棵子树里的卫生门禁。对每个导出了 `./src/*` 的包（这里每个包都如此，上游也一样），它要求：每个导出声明都有描述性散文、每个参数都有非空 `@param`、非 void 结果都要有非空 `@returns`。

作用域由那个通配决定，这一点是读门禁输出前需要知道的：只要 manifest 里有 `exports['./src/*']`，门禁要求的是 `src` 里的**每一个**导出，而不是该包的公开 API。公开 API 是更小、也是真正面向读者的那一面。2026-09-20 实测各视角：

- **公开 API —— 0 条违规。** 从包入口可达的每个名字都已文档化。
- **本子树的内部导出 —— 0 条未完成。** `packages/freecodego/**` 下每个模块级 helper（无论入口可不可达）现在都有散文、各自的 `@param` 与 `@returns`；这一视角在收尾那次清扫前为 890 条。
- **剩余 5 条 —— 上游包，刻意不动。** `fs/tool-fs` 的 `applyReadTool`（无 JSDoc）、`session/session-persistence-jsonl` 的 `JsonlSessionPersistence.delete`（缺 `@param id` 与 `@returns`）、`util/timeout` 的 `remainingTimeoutMs`（缺 `@param signal` 与 `@returns`）。三者都在 `packages/freecodego/**` 之外；给它们写文档会让本 fork 携带的上游源码因一个与插件无关的理由产生分歧。

门禁会跳过**包内 vendored 副本**：带 `PROVENANCE.md` 标记的目录是逐字编译进来的上游源码，给它写文档等于改动 vendored 代码、并让标记里记录的单文件哈希失效。本子树里这样的副本只有 `packages/freecodego/harness-ui/src/client/companion/engine/` 一处，它下面十个文件正依赖这条豁免。

想自己量公开 API 视图：复制该门禁，删掉 `restrictedPublicNames` 里 `exports['./src/*']` 的提前 `continue`，剩下的就是入口可达的名字。

两条约定让写作便宜、让 diff 诚实：按声明锚点插入文档（有 JSDoc 就在它的 `*/` 上方扩展，没有就在声明上方新增一块），并且**绝不重写整个文件** —— 注释是插进原文里的，所以文件的行尾与未触碰的字节都能保住。参数与结果措辞对「签名本身能证明含义」的名字有固定表（`sessionId`、`signal`、`*Host`、`*Request`、`workspaceRoot` 等），其余一律靠读声明来写。

## 相关

- `harness-plugin/README.md` —— 面向用户的更新检查说明，用词一致。
- `AGENTS.md` —— 本文件对应的英文版。
