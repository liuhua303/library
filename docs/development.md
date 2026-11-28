# 开发说明

状态：当前开发与维护约定；`codex/japanese-support` 分支源码为 0.5.0-dev.1，尚未合并进 `main`。本轮 Windows 和 Mac 自动检查及试用包已完成；`main` 保留 0.4.0-dev.1，0.5.0-dev.0 日语试用包保留历史归属。更新日期：2026-11-28。

源码仓库为 [liuhua303/library](https://github.com/liuhua303/library)。用户已确认日语适配流程，当前在独立分支修复旧书仍按英文解析的问题，本轮实现与验证状态见 [0.5.0-dev.1 验证报告](./verification/0.5.0-dev.1.md)。上一版日语包的自动检查与产物见 [0.5.0-dev.0 历史报告](./verification/0.5.0-dev.0.md)，不作为本轮修复通过证明。`main` 和标签 `v0.4.0-dev.1` 保留用户已检查的版本，产物见 [历史报告](./verification/0.4.0-dev.1.md)。Mac 试用包为 ad-hoc 签名、未公证；正式 Developer ID 签名和公证尚未配置，安装及原生交互的人工验收仍未完成，真实模型质量单独验收。

## 文档维护规则

以下四条是本项目统一的文档维护规则，README 与 AGENTS 仅链接到这里。

1. **一个主题只有一份完整的维护正文。** 功能与边界写在 [功能需求](./requirements.md)，视觉与交互细节写在 [界面规范](./ui-design.md)，技术与操作流程写在本文；其他地方提供必要摘要并链接，避免复制整套规则。
2. **行为变化时直接更新当前规范。** 功能或界面调整同步修订对应文档；新一轮开发不再创建内容重复的“最终方案”或“需求 v2”。需要保留的已完成方案、讨论背景与执行提示词放进 `docs/archive/`，注明历史日期和当前规范入口。尚未决定的事项集中列在当前规范中。
3. **验证事实集中写入对应版本报告。** `docs/verification/<版本>.md` 记录日期、代码版本、环境、实际命令、结果、限制及证据位置；测试数量、样本性能值、安装包哈希统一放这里。目标、建议、已实现和已验证分别表述，已实现不等于用户已逐项确认；历史结果不当作本次新运行结果。
4. **文档与相关代码一起提交 Git。** 修改行为时同批提交对应规范；发布版本时更新 [CHANGELOG](../CHANGELOG.md) 的用户可感知变化，并整理版本验证报告。归档方案保留原有确认范围，后续改动更新当前规范；纯文档整理无需更改应用版本号。

本次迁移时仓库尚无首个提交，迁移的历史报告没有可追溯的提交哈希，应如实注明未记录。首次提交后，新验证报告记录实际提交哈希及工作区是否有未提交改动；未做的检查写“未运行”或“未验证”，不要补造结果。

### 目录与写入位置

```text
README.md                    项目入口、安装、快速启动、文档导航
CHANGELOG.md                 按版本记录用户可感知变化
AGENTS.md                    项目协作入口，引用本节规则
docs/
  requirements.md            当前功能、边界、默认规则与待核对事项
  ui-design.md               当前视觉与交互规范
  development.md             文档规则、技术结构与开发操作
  verification/<版本>.md     该版本的验证结果与限制
  archive/                   历史方案、讨论背景与执行提示词
```

整理或移动文档后，检查相对链接、旧路径残留、状态和版本归属；纯文档改动通常无需启动应用测试。涉及程序行为时，根据下文选择相关检查，并把实际结果写入报告。

### 验证报告与证据保留

每份新报告至少写明：应用版本、验证日期和时区、代码提交及工作区状态、操作系统与运行环境、实际命令、结果、未验证范围、产物位置。相同应用版本再次验证时增加注明日期与代码版本的独立小节，保留原结果。

`artifacts/` 是被 Git 忽略的本地测试输出目录。现有脚本使用固定文件名，重新运行可能覆盖 JSON 和截图；它们适合检查当次结果，不能单靠路径证明历史版本。

需要长期保留的证据，在当次运行后复制到不会覆盖的位置，并与版本、日期、提交信息一同保存。少量可公开的 JSON 或截图可放 `docs/verification/evidence/<版本>/<运行标识>/` 并随报告提交；较大安装包或证据包放版本发布附件，在报告中记录可访问位置及校验值。只有确认属于该次运行的产物才能归入该报告，不根据文件修改时间推断旧版本归属。本次整理保留旧报告中的原始路径，不追认其当前文件就是当时证据。

## 技术结构

项目沿用 Electron、React、TypeScript、EPUB.js 和本机 SQLite，不需要独立数据库服务器或远程业务后端。依赖与脚本的准确版本以 [package.json](../package.json) 和 [package-lock.json](../package-lock.json) 为准。

| 位置 | 职责 |
| --- | --- |
| [src/main/index.ts](../src/main/index.ts) | 桌面窗口、应用生命周期、IPC 注册及关闭保存流程 |
| [src/main/preload.ts](../src/main/preload.ts)、[book-write-buffer.ts](../src/main/book-write-buffer.ts) | 向界面暴露受控 API，合并书籍位置、字号、主题与语言写入 |
| [src/main/store.ts](../src/main/store.ts) | 使用 Node 内置 SQLite 保存书籍、每书设置、书签、语境及语言快照和持久任务状态 |
| [src/main/queue.ts](../src/main/queue.ts)、[analysis.ts](../src/main/analysis.ts) | 后台队列、超时重试、DeepSeek 请求、字段和原文匹配校验 |
| [src/main/vault.ts](../src/main/vault.ts) | 使用 Electron safeStorage 保护本机 API 密钥 |
| [src/main/epub.ts](../src/main/epub.ts)、[validation.ts](../src/main/validation.ts) | EPUB 元数据与封面提取、IPC 输入校验 |
| [src/main/book-language.ts](../src/main/book-language.ts)、[book-language-upgrade.ts](../src/main/book-language-upgrade.ts) | EPUB 语言探测，以及启动时旧书语言识别升级 |
| [src/main/book-language-upgrade.ts](../src/main/book-language-upgrade.ts) | 启动时读取本机 EPUB 修正 legacy 旧书语言，隔离单本识别失败 |
| [src/shared/types.ts](../src/shared/types.ts) | 前后端共享数据结构、主题与语言标识、书签及 ReaderApi 接口 |
| [src/renderer/App.tsx](../src/renderer/App.tsx) | 书架、书架 API 设置、单词本和每书阅读设置状态 |
| [src/renderer/components/EpubReader.tsx](../src/renderer/components/EpubReader.tsx)、[reader](../src/renderer/reader) | EPUB 阅读、目录/书签导航、阅读设置、选区、内容定位、标记几何与主题样式 |
| [src/renderer/reader/themes.ts](../src/renderer/reader/themes.ts)、[styles.ts](../src/renderer/reader/styles.ts) | 六主题的名称、近似配色及正文字体，以及应用到 EPUB iframe 的阅读样式 |
| [src/renderer/reader/text.ts](../src/renderer/reader/text.ts) | 文本偏移与选区索引、语言分词、句子判断及短语定位 |
| [tests](../tests)、[scripts](../scripts) | 单元测试、构建、桌面回归、打包验证及自编样本工具 |
| [package.json](../package.json)、[build/entitlements.mac.plist](../build/entitlements.mac.plist) | 平台构建入口与配置，以及 Mac JIT 签名所需权限声明 |
| [src/main/platform.ts](../src/main/platform.ts) | Mac 系统菜单、按窗口保存握手、Dock 重开及真正退出的生命周期 |
| [scripts/build-mac.mjs](../scripts/build-mac.mjs)、[mac-build-options.mjs](../scripts/mac-build-options.mjs) | Mac 构建入口、arm64 目标、正式/本机试用模式与公证凭据校验 |
| [scripts/check-package.mjs](../scripts/check-package.mjs)、[package-paths.mjs](../scripts/package-paths.mjs) | 将 `.app` 解析到包内程序并进行隔离启动检查 |
| [.github/workflows/build-mac.yml](../.github/workflows/build-mac.yml) | 手动调用现有 Mac 构建与隔离检查，成功后上传 DMG artifact，不自动发布 |

收录先经 IPC 保存到本机，再由持久任务队列生成解析并通知界面更新。原文定位保存内容位置标识和文本偏移，续读不依赖随字号变化的屏幕页号。单词本覆盖正文，开关不改变阅读容器尺寸。

书签按书保存内容位置及可读摘要，读取、添加和删除经受控 IPC 接口完成。调整字号或主题后仍按内容位置跳转。阅读进度按书保存并用于书架百分比和阅读工具的“目录 · X%”，不用显示百分比替代精确定位。

每书阅读主题使用 `original`、`quiet`、`paper`、`bold`、`calm`、`focus` 六个稳定标识；旧书缺少主题记录时回退 `original`，保留已有字号和位置。字号仍保存 14–34px、每次调整 2px，界面只显示小 A / 大 A。主题需同时覆盖正文 iframe 和外层工具、导航、单词本；深色的标记与交互状态不能固定使用黑色。新增阅读字段时同步维护校验、持久化、写入合并及迟到快照保护。

单词本主题样式统一归组件的 `src/renderer/styles.css`，`reader.css` 不重复声明其背景，避免依赖导入顺序；面板使用已有 `--reader-panel` 不透明色，文字与次要文案使用对应主题前景和实色 `--reader-muted`。

当前请求默认使用 `deepseek-flash`，非思考、非流式 JSON 输出；模型与密钥只在书架 API 设置中配置，阅读设置提供字号、主题和每书语言。阅读中的配置问题保留简短状态与返回书架的引导，不直接打开 API 表单。每次请求进行字段完整性及原文匹配校验，技术失败有限重试；密钥错误和余额不足暂停相关请求，等待配置或用户处理。具体参数以队列和解析模块为准。历史选型理由和当时的费用估算见 [首版讨论归档](./archive/initial-requirements.md)，归档价格不作为当前报价。

### 语言识别与解析隔离

`SourceLanguage` 当前只含 `en` 与 `ja`。导入从 OPF 主语言及正文抽样判断，识别 `en` / `eng`、`ja` / `jpn` 及其区域标签；只有正文证据充分且与元数据冲突时采用正文，否则保留主语言声明。日语覆盖英语声明需在抽样中明显占优，英语覆盖日语声明需至少两份充分的英语正文样本。无可用主语言时再按正文及章节语言标记判断。正文探测结合假名、汉字、拉丁字母及英语常见词，不凭汉字或拉丁字母单独断言语言。抽样排除脚本、样式、导航、ruby 注音和可识别的封面、标题、版权等非正文；目前最多取四个有效正文样本，缺失或损坏的样本不阻断导入。仍无法判断时保存 `languageSource: 'unknown'` 并暂用 `en`，由阅读设置提示用户选择。

语言与来源按书保存；手动变更来源记为 `manual`。语言变更只随当前请求发送，等待主进程保存成功后才切换界面；失败时继续使用原语言，不能被后续位置保存或关闭重试偷偷应用。位置、字号、主题保留原有写入缓冲与失败重试机制，语言字段不进入其待重试快照。每次收录由主进程根据已保存书籍语言生成 `Occurrence.language` 快照，后台任务按此快照处理，词条归并加入语言维度。旧收录缺失语言时迁移为 `en`，旧书初始来源记为 `legacy`；迁移不重译已有结果，不改写已有位置。书籍语言切换本身不回写旧语境及任务，迟到的书籍响应也不能覆盖已确认的本地状态。

启动在队列建立前运行 `upgradeLegacyBookLanguages`，只读取来源为 `legacy` 的本机书籍 EPUB。`reconcileBookLanguage` 仅允许 `legacy` / `unknown` 记录接受 `metadata` / `content` 的可靠检测结果；同 hash 重导复用此规则，返回原书籍 ID，保护 `manual` 和已有可靠来源。仅更新语言及来源，保留位置、字号、主题、导入日期和已有收录结果。缺失、损坏或不支持的旧文件按单本捕获并跳过，不阻断其他书籍启动；无法可靠判断时不强行覆盖，仍可手动选择。整个重新识别流程不发模型请求，也不自动重译旧任务。

用户手动重试 `failed` 记录且语言快照与书籍当前已保存语言不同时，阅读器通过 `originalAnchor.cfi` 从 EPUB DOM 重新取 Range，再按当前语言的文本索引重建 `selectedText`、`context`、偏移锚点和 `kind`；日语索引排除 `rt` / `rp`。IPC 传入重建数据后，存储层校验同书、同原 CFI 且状态为 `failed`，保留语境 ID 和收录日期，采用书籍已保存语言替换失败任务并重新排队。不能只改语言后沿用旧英文偏移；重建失败保留原任务，`completed` / `processing` 不改写。普通重试和既有排队任务继续使用各自语言快照。上述跨语言纠正仅由用户手动重试触发，后续模型请求仍由原有队列执行。

英文 system prompt、请求 payload 和字段校验继续使用原路径；仅 `Occurrence.language === 'ja'` 进入独立日文 prompt，并在数据中声明 `sourceLanguage: 'ja'`。两者仍各用一次完整模型请求，技术重试沿用队列，不增加第二轮模型审查。日语词语/短语必须返回 `meaningZh`、`reading`、`usage`、`example`，不要求 `definitionEn`；不确定读音允许明确返回“读音待确认”。整句只保留原始选文和中文翻译。字段校验不能证明翻译或读音正确，真实模型质量单独验收。

日语 `targetText` 必须在上下文中逐字匹配并覆盖原选偏移，保留原文活用与字符形态；不套用英文空格词界，也不能跳到重复词的另一处。DOM 与后台均使用 UTF-16 偏移。日语文本索引排除 `rt` / `rp`，显示层保留 ruby；英文索引规则不变。日语单击通过 `Intl.Segmenter('ja')` 取词界，拖选分类支持日文句末标点，正文主题使用日文字体回退。固定版式、中文收录及竖排专门适配不属于本轮范围，复杂注音与竖排实际兼容性列入待核对。

### 本机数据与隔离运行

应用使用 Electron 的 `userData` 目录保存 `reader.sqlite`、`books/` 下的 EPUB 副本和加密的 `deepseek-key.bin`；具体绝对路径由当前运行账户和应用环境决定。日常数据位于项目目录外，卸载默认保留。

API 密钥使用 Electron safeStorage 调用当前系统的保护能力；Mac 对应 Keychain。Mac 的首次授权、保存及重启读取仍待实机验证。不要将 Windows 生成的 `deepseek-key.bin` 当作可直接在 Mac 解密的文件，目标机器需重新配置自己的密钥。

自动化桌面脚本设置独立的 `READER_USER_DATA` 和 `APP_TEST_MODE=1`，并使用临时样本与模拟模型响应。不要用日常书架或真实密钥替代这些隔离测试数据。真实付费模型与真实书籍的人工验收单独记录，不能用模拟响应测试代替。

## 开发运行

Windows 开发使用 x64 Node.js 24（包含 npm）；Mac 试运行目标为 M 系列、macOS 13+ 和原生 arm64 Node.js 24。当前 Electron 45 的系统下限依据 [Electron 移除 macOS 12 支持说明](https://www.electronjs.org/docs/latest/breaking-changes/#removed-macos-12-support)。不提供 Intel 或 universal 目标。

在项目根目录的终端执行相同的源码启动命令：

```powershell
node -v
npm ci
npm run dev
```

`node -v` 应显示 `v24.x`。`npm ci` 根据锁文件安装依赖；首次安装依赖需要联网，Electron 在首次使用时按本机平台自动下载运行时，不保证下载一定发生在 `npm ci` 阶段。不要复制 Windows 的 `node_modules` 到 Mac 使用。

`npm run dev` 自动构建桌面主进程、启动 Vite 服务并打开窗口，无需先运行生产构建；保持终端运行，按 `Ctrl+C` 停止。上述 Mac 流程是待实机执行的入口，不代表目前已跑通。

渲染界面的修改可热更新；主进程、preload 或封面接口修改后，需要退出应用并重新执行 `npm run dev`。

常见启动问题：

- 找不到 `node` 或 `npm`：安装 Node.js 后关闭并重新打开终端。
- PowerShell 不允许运行 `npm.ps1`：改用 `npm.cmd ci` 和 `npm.cmd run dev`。
- 依赖或 Electron 下载失败：检查网络是否可访问 npm 与 Electron 下载源，安装成功后重试。
- 旧程序仍在运行：先退出旧窗口再启动；开发日志出现“阅间桌面窗口已打开”表示窗口已打开。

### Mac 窗口与菜单约定

Mac 使用标准应用、编辑和窗口菜单，提供 Cmd 编辑/退出快捷键。关闭最后一个窗口时先完成保存，再保留应用供 Dock 重开；真正退出时完成阅读位置刷新和本机数据关闭。Windows 仍沿用关最后窗口退出的流程。平台分支需同时覆盖关闭窗口、Dock 重开、Cmd+Q 和退出保存失败的处理；这些人工交互流程尚未验收，不将包内程序启动检查视为它们全部通过。

## 构建、测试与打包

以下命令从项目根目录执行。选择与改动相关的检查，记录实际运行结果：

```powershell
npm test
npm run build
npm run test:e2e
npm run dist
```

| 命令 | 用途与前置条件 |
| --- | --- |
| `npm test` | Vitest 单元与后台测试 |
| `npm run build` | TypeScript 检查、Vite 生产资源及主进程构建，输出到 `app/` |
| `npm run test:e2e` | 运行 `package.json` 中串联的桌面回归；先构建最新 `app/`，避免测到旧产物 |
| `npm run dist` | 先构建，再生成 Windows x64 NSIS 安装包，输出到 `release/` |
| `npm run dist:mac` | 仅在 macOS 上构建固定 arm64 的正式包，要求 Developer ID 签名和公证凭据 |
| `npm run dist:mac:local` | 仅在 macOS 上构建固定 arm64 的本机 ad-hoc 试用包，不公证 |

`test:e2e` 的具体脚本以 [package.json](../package.json) 为准。阅读或主题改动除相关单元检查外，还应覆盖书架进度、目录/书签切换与持久化、每书字号与六主题、非空单词本的面板及内容可读性、API 入口分工，以及原有选区、收录和回跳。语言改动还应覆盖元数据与正文探测、未确定提示、手动切换持久化、旧数据迁移、任务语言快照、英日词条隔离、日语分词与 ruby 偏移、日文输出校验，以及英文请求和输出的回归。本轮旧书修复还需检查启动 legacy 识别、同 hash 重导、手动/可靠来源保护、缺失文件隔离、failed 跨语言原 CFI 重建，以及 completed/processing、ID、收录日期和阅读设置保持。本轮实际运行范围与结果只写入 [0.5.0-dev.1 验证报告](./verification/0.5.0-dev.1.md)，不因本文列出检查场景就视为已通过。Windows 结果不替代 Mac 验证。

xmldom 的覆盖按使用方区分：EPUB.js 使用 0.9 安全修补分支，Mac 构建链的 plist 使用兼容的 0.8 安全修补分支，准确版本以锁文件为准；不要将构建链强制覆盖到不兼容 API。更新依赖后需保留其他平台可选包的完整锁记录，并通过干净的 `npm ci` 检查，不能只验证已有 `node_modules`。Mac 构建入口在发生错误或缺少实际 DMG 时必须失败。

结果与截图写入 `artifacts/`；失败截图可能在后续成功运行后仍然存在，应结合当次结果判断，不按文件名推断当前状态。

打包后可使用隔离启动脚本检查产物；参数必须指向本次实际打包的程序。例如使用默认打包目录时：

```powershell
New-Item -ItemType Directory -Path artifacts -Force | Out-Null
node scripts/check-package.mjs "release/win-unpacked/阅间.exe"
```

若采用独立版本输出目录，传入对应的实际路径。历史 0.2.0 的特殊打包命令与安装包哈希见 [0.2.0 验证报告](./verification/0.2.0.md)，不要求所有后续版本沿用该次环境处理方式。

[samples/reading-demo.epub](../samples/reading-demo.epub) 是自编测试读物，可用于分页、选词和跨页选句。应用日常运行中尚未完成的任务显示真实状态，不提供模拟 AI 释义。

## Mac 准备与打包

当前 Mac 构建目标固定 Apple Silicon arm64，不扩展 Intel 或 universal。以下命令需在 macOS 上执行，可使用本地 Mac 或下述 GitHub macOS runner，不能直接在 Windows 主机执行。版本号以 [package.json](../package.json) 为准，当前分支源码为 `0.5.0-dev.1`，本轮已生成修复试用 DMG；`0.5.0-dev.0` DMG 保留为历史产物，`main` 的 `0.4.0-dev.1` 包仍作为用户已检查版本保留。各版实际结果分别写入对应验证报告。

### 本机试用包

在目标 M 系列 Mac 上完成 Node.js 24、`npm ci` 和源码试运行后，执行：

```bash
npm run dist:mac:local
```

该入口使用 ad-hoc 签名，不提交 Apple 公证，供本机验证；不等同于正式签名公证交付，实际启动可能受系统安全策略限制，需在实机记录结果。

### 正式签名公证包

正式入口强制签名（`forceCodeSigning: true`），不会在缺少凭据时静默退回未签名包。需要本机可用的 Developer ID Application 证书，或由 Electron-builder 识别的 `CSC_*` 证书配置；公证凭据从以下方式选择一组：

| 公证方式 | 环境配置 |
| --- | --- |
| 已保存的钥匙串配置 | `APPLE_KEYCHAIN_PROFILE`；需要指定钥匙串时加 `APPLE_KEYCHAIN` |
| Apple ID | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |
| App Store Connect API | `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` |

同时设置多组变量时，脚本优先匹配 Apple ID，其次 API 密钥，最后钥匙串配置；高优先级组不完整时会报错，切换方式时需清理残留的不完整配置。

凭据通过本机环境提供，不写入项目文件。配置后执行：

```bash
npm run dist:mac
```

正式入口缺少有效签名或公证配置时应明确失败，不将失败产物作为可分发正式包。Mac 的签名权限与 JIT 声明集中在 [build/entitlements.mac.plist](../build/entitlements.mac.plist)，实际签名、公证及 Gatekeeper 启动仍待 Mac 实机验证。

### 输出与打包后检查

| 构建方式 | 输出目录 | 应用路径 | DMG 名称 |
| --- | --- | --- | --- |
| 正式 | `release/mac-arm64/` | `release/mac-arm64/mac-arm64/阅间.app` | `Yuejian-${version}-mac-arm64.dmg` |
| 本机试用 | `release/mac-arm64-local/` | `release/mac-arm64-local/mac-arm64/阅间.app` | `Yuejian-${version}-mac-arm64-local.dmg` |

`${version}` 为实际源码版本。`scripts/check-package.mjs` 支持 `.app` 路径，并自动定位其中的 `Contents/MacOS/阅间`；在同一台 Mac 上为本次实际构建选择对应路径，例如：

```bash
mkdir -p artifacts
node scripts/check-package.mjs "release/mac-arm64-local/mac-arm64/阅间.app"
```

正式构建后改传 `release/mac-arm64/mac-arm64/阅间.app`。脚本使用独立测试数据目录检查包内程序，不代替 DMG 安装、公证状态和真实阅读验收。Mac 后续至少核对导入与数据库、续读与书签、主题、沉浸及触控板翻页、Cmd 菜单、关窗/Dock 重开/退出保存，以及 Keychain 授权和重启读回。云端试用包启动检查已通过，实际结果见版本报告；目前没有 Mac 人工验收记录。

### 通过 GitHub Actions 构建

没有本地 Mac 时，可将完整源码托管到 GitHub，手动使用 [.github/workflows/build-mac.yml](../.github/workflows/build-mac.yml)。该配置仅支持 `workflow_dispatch`，不会因推送自动构建，也不会创建 Release 或自动发布。源码和工作流已进入 [liuhua303/library](https://github.com/liuhua303/library)，入口为 [Build Mac arm64](https://github.com/liuhua303/library/actions/workflows/build-mac.yml)。[0.5.0-dev.0 日语分支运行已成功](https://github.com/liuhua303/library/actions/runs/46121112223)，实际结果集中在[版本报告](./verification/0.5.0-dev.0.md)；上一版运行及包的结果保留在 [0.4.0-dev.1 历史报告](./verification/0.4.0-dev.1.md)。

1. 确保默认分支 `main` 已有工作流配置，目标构建分支含完整源码、`.github/`、`build/`、`scripts/`、`src/`、锁文件及其他必要文件；在运行菜单选择实际需要构建的分支。日语开发使用 `codex/japanese-support`，完成验证并决定合并前保留 `main` 的已检查版本，不为试构建提前合并。若在其他仓库使用，先创建仓库并确认其默认分支。工作流配置必须先存在于默认分支，Actions 页面才可手动触发；操作人需有仓库写权限。[GitHub 手动运行说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
2. 需要正式包时，先按下表配置仓库 Secrets；首次尝试可直接使用不需要 Apple 分发凭据的 `trial`。
3. 打开仓库 **Actions → Build Mac arm64 → Run workflow**，选择包含完整配置的分支和 `mode`，再点击 **Run workflow**。
4. 等待构建及检查成功。在本次运行页面的 **Artifacts** 下载 `Yuejian-mac-arm64-<mode>-<运行号>`，解压后取得 `.dmg`、`SHA256SUMS.txt` 和 `build-info.json`。`Mac-check-results-...` 是检查证据，不是安装包。下载 Actions artifact 需要登录 GitHub 并拥有仓库读取权限，公开仓库也不能将此入口当作免登录的安装下载页。[GitHub artifact 下载说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
5. 将解压得到的 DMG 转发给使用者，或由维护者手动上传到 GitHub Release。源码 ZIP，包括 GitHub 自动生成的 Source code 压缩包，只包含源码，不能代替 DMG 安装包。

| `mode` | 调用入口与用途 | 凭据 |
| --- | --- | --- |
| `trial`（默认） | `npm run dist:mac:local`，ad-hoc 签名、不公证的试用包 | 不需要正式分发凭据；实际启动仍可能受系统安全策略限制 |
| `release` | `npm run dist:mac`，Developer ID 签名并公证的正式构建 | 需配置下述完整 Secrets，缺少或无效时失败，不回退为试用包 |

正式模式在仓库 **Settings → Secrets and variables → Actions → New repository secret** 配置：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | Developer ID Application 证书导出的 `.p12` 文件的 base64 内容 |
| `CSC_KEY_PASSWORD` | `.p12` 的导出密码 |
| `APPLE_ID` | 用于公证的 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | 对应的 App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer 团队 ID |

本地构建还支持上一节的其他公证配置；当前云端工作流使用此固定的 Secrets 组合。DeepSeek API 密钥属于应用使用者，不需要放到构建 Secrets。

工作流使用 `macos-26` runner 和 Node.js 24，先断言实际环境为 `darwin/arm64`，再执行 `npm ci`、`npm test`、对应构建命令、`check-package.mjs` 隔离启动，以及针对打包程序的 `reading-preferences-smoke.mjs` 六主题、非空单词本、书签和重启回归；日语分支还运行 `japanese-smoke.mjs` 与 `language-recovery-smoke.mjs`，覆盖日语/英语及旧书失败项恢复。准确步骤以工作流正文为准，实际结果见本版验证报告。当前 GitHub 标准 runner 的该标签为 Apple Silicon；标签和供应情况以 [GitHub runner 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 为准。只有所有检查成功才上传 DMG artifact；`Mac-check-results-...` 保留启动、主题与日语回归结果及 `preferences-notebook-*.png`、`japanese-*.png`、`language-recovery-*.png` 等当次证据，两类 artifact 均保留 14 天。失败时通过运行日志及已有证据定位问题，不把失败产物作为交付。过期前需要自行下载保留，artifact 不是永久发布地址。

本轮 [0.5.0-dev.1 Mac 运行](https://github.com/liuhua303/library/actions/runs/46123016387)已成功，[修复试用包 artifact](https://github.com/liuhua303/library/actions/runs/46123016387/artifacts/15255055158)解压后为 `Yuejian-0.5.0-dev.1-mac-arm64-local.dmg`，保留至北京时间 2026-12-12 15:53。

上一版日语分支产物为 [Yuejian-mac-arm64-trial-6](https://github.com/liuhua303/library/actions/runs/46121112223/artifacts/15253397529)，包含 `Yuejian-0.5.0-dev.0-mac-arm64-local.dmg`，保留至北京时间 2026-12-12 15:27。登录并具备仓库读取权限后可按上述步骤下载并解压；该历史包不含 0.5.0-dev.1 旧书修复。`main` 尚未合并日语适配，稳定版包仍可从历史报告查找。

云端成功仅证明该次 runner 环境中实际完成的检查，不替代 DMG 安装、真实 Keychain、原生菜单和阅读体验人工验收。运行环境、提交、实际结果与未验证项见 [版本报告](./verification/0.5.0-dev.0.md)；正式 Developer ID 签名和公证尚未配置。

### 仓库可见性与费用

公开仓库会公开源码；若要按开源方式分发，应明确项目许可证，不能仅凭仓库公开推定所有使用授权。[GitHub 许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) 私有仓库则需授予合作者相应权限；下载其 Actions 产物至少需要仓库读取权限。普通使用者可以接收维护者转发的 DMG，或下载维护者另行发布的 Release 附件，无需从源码开始。

不要将 GitHub Actions 一概描述为免费：标准 GitHub-hosted runner 在公开仓库中的计算使用免费，私有仓库受账户包含额度和超额计费影响；artifact 存储、保留及其他 runner 的费用按仓库与账户方案核对。触发工作流产生的费用归仓库所有者，运行前应查看当前账户的用量和预算。[GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## 分享源码与交付

源码压缩包保留 `.github/`、`src/`、`scripts/`、`tests/`、`samples/`、`docs/`、`build/`，以及根目录的 `package.json`、`package-lock.json`、`index.html`、配置文件、`.gitignore`、README、CHANGELOG 和 AGENTS。`.github/` 的工作流及 `build/` 的 Mac 签名权限声明属于源码配置，不是可排除的构建产物。当前交付入口以 README 为准，源码包不是软件安装包。

可排除 `node_modules/`、`app/`、`release/`、`artifacts/` 和 `.git/`。依赖由 `npm ci` 安装，`app/` 由脚本构建；手动压缩整个文件夹时，`.gitignore` 不会自动排除这些目录。保存在应用用户数据目录的个人书架、单词本和密钥不属于源码包，对方首次运行会看到空书架。

只使用软件的人接收安装包即可。安装包路径和当前本地交付入口见 [README](../README.md)，验证范围与校验值见对应版本报告。
