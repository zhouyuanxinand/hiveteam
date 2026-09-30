# npm 安装与发布

HiveTeam 的 npm 包名是 `hiveteam`，安装后提供 `hive` 命令。安装包包含编译后的
Runtime、Web UI、内部 `team` 命令和运行资源；用户无需克隆仓库或自行构建。
本说明描述发布流程，包是否已发布及远端验收结果以 npm 和 GitHub Actions 实际结果为准。

## 用户安装

直接下载已发布的 npm 包并运行：

```bash
npx --yes hiveteam@latest
```

需要经常使用时，全局安装：

```bash
npm install -g hiveteam@latest
hive
```

需要 Node.js 22.x（至少 22.18）或 Node.js 24.x。运行真实任务还需要用户自行安装、
登录至少一个受支持的 Agent CLI，并确保启动 HiveTeam 的 shell 能在 `PATH` 中找到它。
默认 Skill Packs 的首次下载仍需要 Git 和 GitHub 网络；可选择「基础模式」跳过下载。
保留 optional dependencies，让 npm 安装对应系统与架构的 PTY 二进制。

升级前停止 HiveTeam，再执行同一安装或 `npx` 命令。将 `@latest` 换成 `@next` 可以运行
已发布的预发布版，换成 `@<version>` 可以选择具体版本。源码启动和 Git 更新方式保留在
[README](../README.zh.md#开发) 中。

## 首次本地发布

首次发布需要能发布 `hiveteam` 的 npm 账号。在未创建该包的情况下，先通过本地发布
建立包，再配置可信发布。登录账号需启用 npm 要求的双因素认证，并在发布时完成认证。
账号和包权限要求见 [npm 官方发布说明](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)。

从准备发布的源码提交执行完整预演，再生成并验收要上传的归档：

```bash
pnpm install --frozen-lockfile
pnpm release:dry
node scripts/create-release-artifact.mjs --output ../hiveteam-release
node scripts/pack-smoke.mjs --artifact ../hiveteam-release/release-manifest.json --report ../hiveteam-release/smoke-report.json
node scripts/publish-release-artifact.mjs --artifact ../hiveteam-release/release-manifest.json --dry-run
```

`release:dry` 包含代码检查、类型检查、CLI 兼容性报告、构建、完整测试和包验收。
随后创建的 `release-manifest.json` 记录源码提交、工作树状态、锁文件哈希、打包环境、
归档文件名、大小和 SHA-256。`--artifact` 指定同一份归档进行验收，发布脚本会再次
检查归档大小和 SHA-256。未提供 Playwright 模块时，浏览器检查标为未运行。

验收通过后登录并发布该归档：

```bash
npm login
node scripts/publish-release-artifact.mjs --artifact ../hiveteam-release/release-manifest.json
```

也可以直接执行以下 npm 命令；将示例文件名替换为 manifest 中的
`tarball.filename`，稳定版使用 `latest`，预发布版使用 `next`：

```bash
npm publish ../hiveteam-release/hiveteam-2.1.19.tgz --access public --tag latest --ignore-scripts
```

上传已验收的 `.tgz`，不要在发布时重新打包源码目录。普通 `npm pack` 和从源码目录
执行的 `npm publish` 会通过 `prepack` 执行 `pnpm build`；归档创建与归档发布显式
跳过生命周期脚本，保留验收过的构建。

## 配置 GitHub Actions 可信发布

首次发布完成后，在 npm 的 `hiveteam` 包设置中添加 GitHub Actions Trusted Publisher：

| npm 设置项 | 值 |
| --- | --- |
| Organization or user | `zhouyuanxinand` |
| Repository | `hiveteam` |
| Workflow filename | `release.yml` |
| Environment name | 留空，与当前工作流一致 |
| Allowed actions | 允许直接 `npm publish` |

2026 年 9 月 3 日以后创建的绑定默认允许 `npm stage publish`；本工作流使用直接
发布，因此还要允许 `npm publish`。npm 可信发布要求 npm CLI 至少 11.5.1、Node
至少 22.14.0，并使用受支持的托管 runner。详见
[npm 可信发布文档](https://docs.npmjs.com/trusted-publishers/)。

仓库的 [release.yml](../.github/workflows/release.yml) 使用 GitHub 托管 Ubuntu
runner、Node 24.14.0 和 npm 11。发布 job 拥有 `id-token: write`，使用 OIDC 获取
发布凭据，无需配置长期 npm token。包的 `repository.url` 须继续与实际仓库对应。

## 后续版本发布

先更新 `package.json` 版本和发布说明，提交待发布代码，再推送与包版本一致的
`v<version>` 标签。例如包版本为 `2.1.20` 时：

```bash
git tag v2.1.20
git push origin v2.1.20
```

每次发布使用尚未发布过的版本。预发布版可以使用 `2.1.20-beta.1` 这样的版本号，
对应标签为 `v2.1.20-beta.1`。

工作流只构建一次，源码验证和安装包验收复用同一归档。所有 `build-artifact`、
`verify` 和 `installed-package` job 通过后，标签推送才会触发 `publish`；普通
分支推送和 pull request 只运行验证。

发布 job 下载已验收的归档，并执行：

```bash
node scripts/publish-release-artifact.mjs --artifact <manifest-path> --release-tag v<version>
```

脚本核对标签与 manifest 版本，稳定版自动发布到 `latest`，预发布版自动发布到
`next`。也可以通过 pnpm 调用，添加 `--dry-run` 预演归档发布：

```bash
pnpm publish:artifact --artifact ../hiveteam-release/release-manifest.json --dry-run
```

首次配置可信发布及每次发布后，都应查看 Actions 的发布结果和 npm 包版本。
本地验收通过不能代表未运行的平台矩阵或远端发布已经成功。
