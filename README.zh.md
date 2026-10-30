# dsh-pi-mode

中文 | [English](README.md)

受 Pi 启发的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区编程模式：精简提示词，先使用基础工具，再按需发现其他工具。

## 最低要求

最低版本：**DSH v0.2.0-rc.1**、**Node.js 24.9**。DSH 仅设置最低版本，不限定固定版本或版本上限。

插件包自带渐进式执行器，不依赖尚未发布的 `@deepseek-ai/dsh-tool-executor-progressive` 包，也不需要修改 Harness 源码。

## 安装

```sh
dsh plugin --profile web add github:elves-ai/dsh-pi-mode
```

**新建任务**，选择 **Pi mode (plugin)**。如果 DSH 提示需要重启，请先重启。已有任务保留原来的预设版本。安装不会修改默认模式或 Standard 模式。

也可以通过绝对路径安装本地仓库：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-pi-mode
```

卸载：

```sh
dsh plugin --profile web remove @elves-ai/dsh-pi-mode
```

仓库已包含 [dist](dist) 中可直接执行的 JavaScript。通过 Git 或本地路径安装无需编译器、`prepare` 钩子或安装构建脚本审批。该仓库本身即可用于分发，不要求先发布 npm 包。

## 行为

首次模型请求声明九个工具：

- `read`、`read_image`、`edit`、`write`
- POSIX 系统使用 `bash`，Windows 使用 `pwsh`
- `skill`、`working_directory`、`ask_user_question`、`tool_search`

`ask_user_question` 从首轮即可调用，提示词要求通过它澄清问题、做出选择或确认操作。在 Web 中会使用现有提问界面，而不是仅发文字提问。

其他已注册工具，包括文件检索、网页访问和文件交付，通过 `tool_search({ query })` 发现。搜索仅返回名称和简短描述，不返回参数定义。命中的工具声明在**下一次模型请求**加入。未发现的工具，以及当前回复中刚搜到的工具，都会被执行器拒绝。重复搜索可继续发现更多匹配项。

项目指令仍然启用。技能描述最多 160 个 Unicode 码点，正文按需加载。省略可选运行时上下文，但保留当前工作目录。支持自动压缩和 `/compact`。Shell 命令以前台运行；此预设不添加后台任务工具。

发现工具仍受当前作用域、工具条件、限制、守卫、沙箱和审批策略控制，不授予额外权限。恢复或分叉时，从成功且已记录的搜索结果重建已发现名称；一个任务的发现不会让其他任务自动启用工具。

## 配置

[组合补丁](cordis.patch.yml)定义预设 `pi-mode`、Loader 条目 `preset-pi-mode` 及其子条目 `progressive-tools`。独立预设 ID 允许它与内置 Pi 预设共存，而不覆盖内置模式。

| 执行器选项 | 插件配置值 | 含义 |
| --- | --- | --- |
| `eagerTools` | 八个显式名称，加上隐式的 `tool_search` | 首轮声明的工具 |
| `maxSearchResults` | `5` | 每次搜索最多激活的匹配项 |
| `descriptionMaxLength` | `160` | 描述最多码点数，包含截断省略号 |
| `maxParallelToolCalls` | `10` | 并发安全调用上限，宿主可用批次配置覆盖 |

Shell 名称随操作系统变化。不存在的首轮工具名称会在首次组装声明时报错。执行器也可通过包的根导出单独挂载，但同一作用域只能使用一个执行器。

## 上下文开销与限制

首次请求省略延迟工具的参数定义；首次使用某个延迟工具前需要增加一次发现请求，工具声明增长也可能降低提供方的提示词缓存复用率。精简 persona 保持固定；已加载技能追加到历史中。项目指令和技能目录仍占用上下文。

搜索采用确定性的关键词匹配，不是语义检索。激活状态记录工具名称，因此同名替换工具仍处于已发现状态，但仍须通过当前调用检查。未记录的搜索不会产生可恢复的激活状态。模型仍可能不遵循指令；测试验证工具与问答链路，不保证任何模型每次都选择正确操作。

Cordis、工具执行、作用域、会话投影、Schemastery 和 Zod 由宿主提供，并声明为可选 peer。运行时仍需要它们；“可选”用于防止包管理器安装冲突副本。本插件不修改这些库。请更新宿主及其 schema 库，并关注[上游安全公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

## 开发与测试

准备满足最低版本要求且已经构建的 DSH 源码仓库。请先按该仓库的说明完成依赖安装和构建。

```sh
npm ci --ignore-scripts --omit=peer
npm run dev:link -- /absolute/path/to/deepseek-harness
npm run check
```

`dev:link` 将源码仓库的宿主包链接为本项目的开发依赖，并将本机路径记录到忽略的 `.dsh-dev.json` 中，不修改任何 DSH profile。Zod 从宿主的 session-projection 包解析并链接，确保运行时 schema 和 TypeScript 使用同一版本。清洁安装依赖后须重新链接。

`check` 编译执行器、检查源码和测试类型、运行测试，并核对打包文件清单。运行 `npm run test:install`，可将打包产物和链接仓库分别安装到临时 DSH home，通过构建后的 CLI 验证提问 → 发现 → 文件检索链路，然后卸载插件。测试使用真实的 Harness 注册表、执行流水线、循环和 Loader，仅使用脚本化模型回复及人类回答替代不确定输入。修改源码后请重新构建并提交 `dist`，保持 Git 安装无需执行构建脚本。

独立投影键为 `elves-ai/dsh-pi-mode/activation`。激活元数据保留 `progressiveToolActivation`，复用成功搜索结果的格式，但不与内置执行器共用投影注册。

## 许可与致谢

[MIT](LICENSE)。DeepSeek Harness 署名、原创图标许可和 Pi 设计启发见 [NOTICE](NOTICE)。本项目是 elves-ai 社区插件，并非 DeepSeek 或 Pi 官方发行版。
