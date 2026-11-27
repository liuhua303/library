# 阅间

本地英语阅读器，已交付 Windows 版，正在准备 M 系列 Mac 版。阅读时快速收录词句，后台结合原文生成释义，按书籍保存在单词本中。

## 安装使用

当前源码预备版本为 0.4.0-dev.0，文档更新日期为 2026-11-28；Mac 准备范围与实际检查见 [0.4.0-dev.0 记录](./docs/verification/0.4.0-dev.0.md)。最后已交付并验证的 Windows 版本仍为 [0.3.3](./docs/verification/0.3.3.md)，安装包位于 `release/Yuejian-Setup-0.3.3.exe`。双击安装后从桌面打开“阅间”，无需安装 Node.js。`release` 是本地构建目录，源码仓库或源码压缩包可能不包含安装包。

Mac 本轮只面向 Apple Silicon（M 系列、arm64），要求 macOS 13 或更新版本，不提供 Intel 或通用包。目前尚无 Mac DMG，未在 Mac 实机完成运行、打包、签名或公证验证。可在目标 Mac 上用 Node.js 24 执行 `npm ci`、`npm run dev` 准备源码试运行；正式包与本机试用包的构建入口见 [开发说明的 Mac 准备](./docs/development.md#mac-准备与打包)。

没有 Mac 也可以把完整源码推送到 [GitHub 仓库](https://github.com/liuhua303/library)，再手动运行 [Build Mac arm64](https://github.com/liuhua303/library/actions/workflows/build-mac.yml)：默认 `trial` 生成不公证的试用包，`release` 需要正式签名及公证凭据。成功后从 Actions 的 Artifacts 下载并解压 DMG，再转发或手动上传 Release；不会自动发布。完整操作、下载权限和计费说明见 [GitHub Actions 构建流程](./docs/development.md#通过-github-actions-构建)。本次首次上传与云端运行结果尚待记录，源码 ZIP 不是软件安装包。

导入自己的 EPUB，或先使用 [自编测试读物](./samples/reading-demo.epub)。在书架的“设置”中填写自己的 DeepSeek API 密钥；未配置密钥或离线时仍可阅读和收录，解析任务等待配置与联网后继续。个人书架、书签、阅读设置、单词本和密钥保存在本机应用用户数据目录，卸载默认保留数据。

- 启动先显示有书本质感的真实封面，左下角显示阅读进度；点击封面继续阅读，左上角箭头返回书架。
- 右下角按钮打开阅读工具；“目录 · X%”进入同一导航面板的目录和书签标签。可保存当前页书签，在列表中跳转或删除。
- 阅读设置只提供小 A / 大 A 和原色、静谧、纸张、醒目、舒缓、专注六主题，不显示字号数字；字号和主题按书保存。API 配置只留在书架设置。
- `J` 切换右侧单词本浮层，开关不改变正文排版和当前位置。
- 点击阅读留白进入沉浸，只保留正文、居中书名与页数，隐藏指针和操作控件；移动鼠标、点击词句或拖选会恢复操作，`Esc` 也可退出。有选区、菜单或交互浮层时，点击留白先取消或关闭。
- 使用左右方向键、`PageUp` / `PageDown` 或鼠标滚轮翻页；底部不再显示左右箭头。操作浮层和拖动选区手柄时，不翻动背后书页。
- 单击单词立即收录；拖选词句后选择复制或收录。点击已有标记可查看或取消收录。
- 单词本优先显示中文释义，其他内容按需展开；“返回原文”会收起浮层并定位到对应语境。

完整操作与功能边界见 [功能需求](./docs/requirements.md)，界面细节见 [界面规范](./docs/ui-design.md)。源码准备及未验证范围见 [0.4.0-dev.0 记录](./docs/verification/0.4.0-dev.0.md)；已交付 Windows 版见 [0.3.3 验证报告](./docs/verification/0.3.3.md)。模拟模型测试不代表真实释义质量已通过，Windows 结果也不代表 Mac 已通过。

## 从源码快速启动

Windows x64 使用 Node.js 24（含 npm）；Mac 源码试运行目标为 M 系列、macOS 13+ 和原生 arm64 Node.js 24。在包含 `package.json` 的项目目录中打开终端，执行：

```powershell
node -v
npm ci
npm run dev
```

`node -v` 应显示 `v24.x`。首次安装依赖需要联网；Electron 在首次使用时按本机平台自动下载运行时。启动脚本会自动构建主进程、启动开发服务并打开桌面窗口；保持终端运行，按 `Ctrl+C` 停止。无需单独安装数据库或启动后端服务。Mac 运行结果仍需在实机记录。

开发、启动故障排查、测试、打包和源码分享见 [开发说明](./docs/development.md)。

## 文档导航

| 文档 | 负责的内容 |
| --- | --- |
| [功能需求](./docs/requirements.md) | 当前功能、使用边界、默认规则和待核对事项 |
| [界面规范](./docs/ui-design.md) | 当前视觉与交互规则，以及尚未逐项确认的建议 |
| [开发说明](./docs/development.md) | 文档维护规则、代码结构、开发、测试与打包 |
| [更新记录](./CHANGELOG.md) | 各版本的用户可感知变化 |
| [0.4.0-dev.0 记录](./docs/verification/0.4.0-dev.0.md) | 本轮源码准备的检查与未验证范围，非 Mac 通过证明 |
| [0.3.3 验证报告](./docs/verification/0.3.3.md) | 最后已交付 Windows 版的验证结果与产物 |
| [0.3.2 验证报告](./docs/verification/0.3.2.md) | 旧版历史验证结果、产物与限制 |
| [0.3.1 验证报告](./docs/verification/0.3.1.md) | 旧版历史验证结果、产物与限制 |
| [0.3.0 验证报告](./docs/verification/0.3.0.md) | 书架、书签与六主题的历史验证结果 |
| [0.2.0 验证报告](./docs/verification/0.2.0.md) | 旧版历史验证结果、产物与限制 |
| [0.1.1 验证报告](./docs/verification/0.1.1.md)、[0.1.0 验证报告](./docs/verification/0.1.0.md) | 旧版本的历史验证结果 |
| [首版讨论原稿](./docs/archive/initial-requirements.md)、[视觉改版原稿](./docs/archive/visual-redesign.md) | 当时的方案、确认范围、费用讨论和执行提示词 |

文档维护的四条规则统一写在 [开发说明](./docs/development.md#文档维护规则)，[AGENTS.md](./AGENTS.md) 为后续项目协作提供入口。当前规范持续更新；归档原稿只用于追溯。

## 当前本地交付

已交付安装包仍为 Windows 0.3.3；本轮 0.4.0-dev.0 未生成 Mac DMG：

- 安装包：`release/Yuejian-Setup-0.3.3.exe`。
- 已解包程序：`release/0.3.3/win-unpacked/阅间.exe`，运行时需要保留同目录其他文件。
- GitHub 构建用源码包：`release/Yuejian-0.4.0-dev.0-github-source.zip`，需先将完整源码提交到 GitHub，再运行工作流生成 Mac DMG。

安装包哈希和当次打包命令集中记录在对应版本的验证报告中。
