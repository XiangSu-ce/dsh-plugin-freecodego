# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### 安装 FreeCodeGo 插件

FreeCodeGo 安装在 Harness Profile 中，不是单独运行的命令；它来自 GitHub release 上附带的 tarball。普通终端先安装 Harness CLI 和 pnpm：

```sh
npm install --global @deepseek-ai/dsh pnpm
dsh plugin --profile web add --save-exact \
  https://github.com/XiangSu-ce/dsh-plugin-freecodego/releases/download/freecodego-v0.1.6-alpha.2/freecodego-0.1.6-alpha.2.tgz
```

每条 Harness 线对应一个 release，tag 为 `freecodego-v<version>`，并且只附带一个以其所挂载的 Harness 版本命名的 tarball，因此资产名本身就说明了该 release 面向哪条 Harness：上面的 URL 安装的是面向 Harness `0.1.6-alpha.2` 的插件。请把 tag 与资产名中的版本替换为你实际运行的 Harness 版本 —— 设置页会把该版本显示为已装插件版本旁的 `Harness <version>`。固定版本就是固定这个 URL：release 不会被复用，坏掉的 release 通过编辑它来撤回。之后请使用设置页的更新检查，它会为当前运行的 Harness 解析同一个 release，并用同一条命令安装。

桌面端必须是已支持该 Harness 版本的构建。桌面端内置的 `dsh` 和 `pnpm` 会使用当前 `DSH_HOME`；选择与 Web 端相同的 Harness Home 和 Profile，即可读取同一份插件数据。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md)与[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)。

## 许可证

[AGPL-3.0](LICENSE)

本项目采用 [GNU Affero 通用公共许可证第 3 版](LICENSE)（`AGPL-3.0-only`）授权。截至 0.1.3（含）的版本以 MIT 许可证发布；自 0.1.4 起，新增的源码变更以 AGPL-3.0 授权。如果你修改了本项目并通过网络提供服务，则必须向这些用户提供其 Corresponding Source（AGPL 第 13 条）。

`FreeCodeGo` 名称、标识及官方构建／分发渠道不在本许可证覆盖范围内——见 [TRADEMARK.md](TRADEMARK.md)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
