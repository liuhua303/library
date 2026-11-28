# 阅间

本地阅读器，提供 Windows 版和 M 系列 Mac 试用包。阅读时快速收录词句，后台结合原文生成释义，按书籍保存在单词本中。

当前源码在 `codex/japanese-support` 分支修复 0.5.0-dev.1 的旧日文书语言识别与失败解析重试，尚未合并进 `main`。用户已确认日语适配流程，本轮修复已完成 Windows 自动检查并生成试用包，Mac 检查待运行；实际状态见 [0.5.0-dev.1 验证报告](./docs/verification/0.5.0-dev.1.md)。`main` 和标签 `v0.4.0-dev.1` 保留用户已检查的版本。

本轮 Windows 修复包位于 `release/0.5.0-dev.1/Yuejian-Setup-0.5.0-dev.1.exe`。

上一版日语分支 0.5.0-dev.0 的 Windows、Mac 自动检查与包记录保留在 [历史报告](./docs/verification/0.5.0-dev.0.md)。Windows 包位于 `release/0.5.0-dev.0/Yuejian-Setup-0.5.0-dev.0.exe`；Mac 的[历史试用包 artifact](https://github.com/liuhua303/library/actions/runs/46121112223/artifacts/15253397529)解压后为 `Yuejian-0.5.0-dev.0-mac-arm64-local.dmg`，ad-hoc 签名、未公证，登录 GitHub 后可下载，保留至北京时间 2026-12-12 15:27。这些包不含本轮旧书修复。下方“安装使用”和“当前交付”保留 0.4.0-dev.1 稳定试用包入口，0.4.0-dev.1 不含日语适配。

当前修复会在启动时为旧导入书籍从本机 EPUB 重新识别可靠语言；仍未确定或误判时，可在“主题与设置 → 书籍语言”手动选择。旧释义不自动重译；旧失败记录与当前书籍语言不同时，手动点“重新解析”会从原位置重建选文和上下文，再按当前语言处理。完整保护范围见 [旧书语言修正与失败重试](./docs/requirements.md#旧书语言修正与失败重试)。

## 安装使用

当前 Windows 和 Mac 试用版本均为 0.4.0-dev.1，包含单词本主题配色修复，文档更新日期为 2026-11-28。构建、打包程序检查与未验证范围见 [0.4.0-dev.1 验证报告](./docs/verification/0.4.0-dev.1.md)。Windows 安装包位于 `release/0.4.0-dev.1/Yuejian-Setup-0.4.0-dev.1.exe`；安装包无需 Node.js。`release` 是本地构建目录，源码仓库或源码压缩包可能不包含安装包。

0.4.0-dev.1 已收到用户检查后未发现问题的反馈，以 Git 标签 [v0.4.0-dev.1](https://github.com/liuhua303/library/tree/v0.4.0-dev.1) 保留版本记录；反馈范围见对应验证报告。

Mac 只面向 Apple Silicon（M 系列、arm64），要求 macOS 13 或更新版本，不提供 Intel 或通用包。本版已通过云端构建、包内程序启动及六主题等自动化检查，试用 DMG 采用 ad-hoc 签名、未公证。正式 Developer ID 签名和公证尚未配置；Windows 安装向导、Mac DMG 安装、真实 Keychain 和原生菜单等人工验收尚未完成。

源码已上传到 [GitHub 仓库](https://github.com/liuhua303/library)。登录 GitHub 后下载 [当前 Mac 试用包 artifact](https://github.com/liuhua303/library/actions/runs/46111866028/artifacts/15250640003)，解压取得 `Yuejian-0.4.0-dev.1-mac-arm64-local.dmg`，可转发 DMG；artifact 保留至北京时间 2026-12-12 13:25。本版 [成功运行记录](https://github.com/liuhua303/library/actions/runs/46111866028)可查看构建过程。后续构建和手动发布步骤见 [GitHub Actions 构建流程](./docs/development.md#通过-github-actions-构建)，源码 ZIP 不是软件安装包。

导入自己的 EPUB，或先使用 [自编测试读物](./samples/reading-demo.epub)。在书架的“设置”中填写自己的 DeepSeek API 密钥；未配置密钥或离线时仍可阅读和收录，解析任务等待配置与联网后继续。个人书架、书签、阅读设置、单词本和密钥保存在本机应用用户数据目录，卸载默认保留数据。

- 启动先显示有书本质感的真实封面，左下角显示阅读进度；点击封面继续阅读，左上角箭头返回书架。
- 右下角按钮打开阅读工具；“目录 · X%”进入同一导航面板的目录和书签标签。可保存当前页书签，在列表中跳转或删除。
- 阅读设置提供小 A / 大 A 和原色、静谧、纸张、醒目、舒缓、专注六主题，不显示字号数字；字号和主题按书保存。日语开发分支另提供按书保存的英语 / 日语选择，已有释义保留。API 配置只留在书架设置。
- `J` 切换右侧单词本浮层，开关不改变正文排版和当前位置。
- 点击阅读留白进入沉浸，只保留正文、居中书名与页数，隐藏指针和操作控件；移动鼠标、点击词句或拖选会恢复操作，`Esc` 也可退出。有选区、菜单或交互浮层时，点击留白先取消或关闭。
- 使用左右方向键、`PageUp` / `PageDown` 或鼠标滚轮翻页；底部不再显示左右箭头。操作浮层和拖动选区手柄时，不翻动背后书页。
- 单击单词立即收录；拖选词句后选择复制或收录。点击已有标记可查看或取消收录。
- 单词本优先显示中文释义，其他内容按需展开；“返回原文”会收起浮层并定位到对应语境。

日语分支支持导入时识别书籍语言并在阅读设置中手动纠正，单击日语分词、拖选词句后先在本机保存，再后台解析。日语词语与短语展示中文义、假名读音、用法及日文例句，整句只提供中文翻译。英文解析路径和已有收录保留，切换语言不自动重译。固定版式 EPUB 仍不在本轮范围，竖排与真实模型质量尚待核对；完整规则见 [功能需求](./docs/requirements.md#日语适配与语言选择)。

完整操作与功能边界见 [功能需求](./docs/requirements.md)，界面细节见 [界面规范](./docs/ui-design.md)。本轮检查与未验证范围见 [0.5.0-dev.1 验证报告](./docs/verification/0.5.0-dev.1.md)；上一版日语包见 [0.5.0-dev.0 历史报告](./docs/verification/0.5.0-dev.0.md)，稳定主题修复版见 [0.4.0-dev.1 验证报告](./docs/verification/0.4.0-dev.1.md)。模拟模型测试不代表真实释义质量已通过，Mac 云端启动检查也不替代人工验收。

## 从源码快速启动

Windows x64 使用 Node.js 24（含 npm）；Mac 源码试运行目标为 M 系列、macOS 13+ 和原生 arm64 Node.js 24。在包含 `package.json` 的项目目录中打开终端，执行：

```powershell
node -v
npm ci
npm run dev
```

`node -v` 应显示 `v24.x`。首次安装依赖需要联网；Electron 在首次使用时按本机平台自动下载运行时。启动脚本会自动构建主进程、启动开发服务并打开桌面窗口；保持终端运行，按 `Ctrl+C` 停止。无需单独安装数据库或启动后端服务。Mac 源码交互试运行与人工验收结果仍需另外记录。

开发、启动故障排查、测试、打包和源码分享见 [开发说明](./docs/development.md)。

## 文档导航

| 文档 | 负责的内容 |
| --- | --- |
| [功能需求](./docs/requirements.md) | 当前功能、使用边界、默认规则和待核对事项 |
| [界面规范](./docs/ui-design.md) | 当前视觉与交互规则，以及尚未逐项确认的建议 |
| [开发说明](./docs/development.md) | 文档维护规则、代码结构、开发、测试与打包 |
| [更新记录](./CHANGELOG.md) | 各版本的用户可感知变化 |
| [0.5.0-dev.1 验证报告](./docs/verification/0.5.0-dev.1.md) | 本轮旧书语言与失败重试修复的检查及交付状态 |
| [0.5.0-dev.0 验证报告](./docs/verification/0.5.0-dev.0.md) | 上一版日语分支的实际检查、试用包与未验证范围 |
| [0.4.0-dev.1 验证报告](./docs/verification/0.4.0-dev.1.md) | 已交付单词本主题修复版的实际检查与用户反馈 |
| [0.4.0-dev.0 记录](./docs/verification/0.4.0-dev.0.md) | 上一版 Mac 云端试用包构建、启动检查及未验证范围 |
| [0.3.3 验证报告](./docs/verification/0.3.3.md) | 旧版 Windows 的历史验证结果与产物 |
| [0.3.2 验证报告](./docs/verification/0.3.2.md) | 旧版历史验证结果、产物与限制 |
| [0.3.1 验证报告](./docs/verification/0.3.1.md) | 旧版历史验证结果、产物与限制 |
| [0.3.0 验证报告](./docs/verification/0.3.0.md) | 书架、书签与六主题的历史验证结果 |
| [0.2.0 验证报告](./docs/verification/0.2.0.md) | 旧版历史验证结果、产物与限制 |
| [0.1.1 验证报告](./docs/verification/0.1.1.md)、[0.1.0 验证报告](./docs/verification/0.1.0.md) | 旧版本的历史验证结果 |
| [首版讨论原稿](./docs/archive/initial-requirements.md)、[视觉改版原稿](./docs/archive/visual-redesign.md) | 当时的方案、确认范围、费用讨论和执行提示词 |

文档维护的四条规则统一写在 [开发说明](./docs/development.md#文档维护规则)，[AGENTS.md](./AGENTS.md) 为后续项目协作提供入口。当前规范持续更新；归档原稿只用于追溯。

## 当前交付

以下均为包含主题配色修复的 0.4.0-dev.1 稳定试用包，不含日语适配；日语分支历史包见上方记录，本轮 0.5.0-dev.1 Windows 包见版本报告：

- Windows 安装包：`release/0.4.0-dev.1/Yuejian-Setup-0.4.0-dev.1.exe`。
- Windows 已解包程序：`release/0.4.0-dev.1/win-unpacked/阅间.exe`，运行时需要保留同目录其他文件。
- Mac 试用包：[下载 artifact](https://github.com/liuhua303/library/actions/runs/46111866028/artifacts/15250640003)，登录后下载并解压为 `Yuejian-0.4.0-dev.1-mac-arm64-local.dmg`；ad-hoc 签名、未公证。

安装包哈希和当次打包命令集中记录在对应版本的验证报告中。
