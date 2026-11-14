# dsh-desktop-control

[![npm](https://img.shields.io/npm/v/@avengers233/dsh-desktop-control.svg)](https://www.npmjs.com/package/@avengers233/dsh-desktop-control)
[![license](https://img.shields.io/github/license/Avenger233/dsh-desktop-control.svg)](https://github.com/Avenger233/dsh-desktop-control/blob/main/LICENSE)

让 DeepSeek Harness（dsh）的会话在 Windows 上真正操控鼠标、键盘、截图，并能用本地 OCR 与 UI Automation 理解界面。

> 非官方第三方插件，与 DeepSeek 无关。
> 已在 Windows 10 22H2（19045，Windows PowerShell 5.1）+ dsh `0.2.2-rc.1`（桌面端）、单屏 1920×1080 / 100% 缩放下实测。

[English](README.en.md) | 中文

## 提供什么

安装该 bundle 的 dsh profile 里，所有会话可见七个工具：

| 工具 | 能力 |
|---|---|
| `desktop_mouse` | 移动、点击（左/右/中、单击/双击/连击）、拖拽、滚轮、按下/抬起 |
| `desktop_keyboard` | 输入 Unicode 文本（中文、emoji、任意符号）、按快捷键、按住/松开按键 |
| `desktop_state` | 光标位置、虚拟屏幕范围、前台窗口（进程/标题/矩形）、当前按住的键 |
| `desktop_screenshot` | 截取整个虚拟桌面或指定区域，以图片形式返回给模型；可选叠加坐标网格和光标十字 |
| `desktop_find` | 用 Windows 自带 OCR 在屏幕上找文字并返回精确坐标，`click:true` 可顺手点击——不产生图片、不消耗视觉 token |
| `desktop_window` | 列出可见窗口、激活某个窗口、读取 UIA 控件（角色/名称/中心坐标），或用 UIA InvokePattern 直接触发控件默认动作 |
| `desktop_sequence` | 一次调用批量执行多个动作（点击、找字、等待、截图……） |

这些 schema 在每个会话的每次请求里都会占用 token（不用也占），不需要时建议禁用。

### 不截图找字

`desktop_find` 截取屏幕（或指定窗口），用 Windows 自带 OCR 识别后做模糊匹配，返回 `356,358 score=1.00 "保存"` 这样的行；`click:true` 会在同一次调用里点击最佳匹配；没命中时会返回最接近的几行，`threshold` 可调松紧。标着文字的菜单项、按钮、链接用它最省 token。

### 窗口与 UI Automation

`desktop_window` 可列窗口（hwnd/进程/标题/矩形）、激活窗口，或返回 `角色 | 名称 | x,y` 形式的 UIA 控件。`action=invoke` 用 UI Automation 的 InvokePattern（没有则退回 LegacyIAccessible）直接触发控件默认动作，不用移动鼠标，是点原生按钮最可靠的方式。UIA 原生的应用（WPF、UWP、资源管理器）效果好；Chromium/Electron/Qt 自绘界面只能拿到外壳，这类请用 `desktop_find` 或截图。

### 批量动作

`desktop_sequence` 一次调用最多 30 步（find/click/wait/screenshot 等），省掉多次工具往返。其中的 screenshot 只保存 PNG 并返回路径，不返回图片。

## 要求

- **Windows 10/11**，交互式桌面会话（不是服务会话）。建议 Windows 10 1703+：可启用 per-monitor DPI 感知，坐标与屏幕一致；更老的版本退化为系统级 DPI 感知。
- **DeepSeek Harness**，且 Host 进程跑在这台 Windows 机器上（dsh 桌面端，或在该机器启动的 dsh profile）。
- **Windows PowerShell 5.1**（`powershell.exe`，系统自带），不需要 PowerShell 7。
- 无 npm 依赖、无构建步骤、无原生模块。

> 工具控制的是**运行 dsh Host 的那台机器**的桌面，不是你浏览器所在机器的桌面。

## 安装

### 从 npm 安装（推荐）

在该 dsh profile 的会话里让 agent 安装已发布的 bundle：

```
plugin_manager { action: "install_bundle", target: "@avengers233/dsh-desktop-control" }
```

### 从源码安装

```bash
git clone https://github.com/Avenger233/dsh-desktop-control.git
```

然后在该 dsh profile 的会话里让 agent 把目录作为 bundle 安装：

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\dsh-desktop-control" }
```

bundle 按 profile 安装；源码安装会链接到 clone 目录，之后 `git pull` + 重启 dsh 即可更新，首次安装即时生效。

验证：会话里能看到 `desktop_state` 等工具，或手动跑自测：

```bash
node scripts/selftest.mjs
```

自测会短暂移动光标、按一次 F24、打开并关闭一个临时 WPF 窗口（验证窗口枚举/激活/UIA/InvokePattern/OCR）、截图（含网格和光标叠加），最后恢复光标位置；运行期间不要动鼠标。

## 使用示例

- “截图给我看看现在屏幕上是什么”
- “找到屏幕上的‘保存’并点击”
- “点一下任务栏第三个图标，然后把窗口拖到右边”
- “在记事本里输入这段话，然后 Ctrl+S 保存”
- “看看这个网页现在显示什么，再点那个蓝色的按钮”
- “把窗口切成两半：先激活记事本按 Win+左，再激活浏览器按 Win+右”

模型只在任务需要时调用工具，不会在后台自动操作。

## 工作原理

- `index.js` — Cordis Host 插件：注册七个工具，首次调用时启动一个 helper 进程，卸载时结束它。
- `helper.ps1` — 长驻 Windows PowerShell 进程，编译一次 `user32.dll` 的 P/Invoke 包装（`SendInput`、`GetCursorPos`、`EnumWindows`、`SetForegroundWindow`、`PrintWindow` 等），再加上 .NET `Graphics.CopyFromScreen`、`Windows.Media.Ocr` 和 UI Automation，之后逐行应答命令。父子进程之间每条消息是一行 base64(UTF-8 JSON)，因此控制台代码页不会破坏中文文本或窗口标题。
- 截图在超过附件限制时自动缩小，经 dsh 的 `attachments` 服务保存并以 image 内容块返回；同时在 `%TEMP%\dsh-desktop-control` 保留一份 PNG。

坐标是虚拟桌面的物理像素；helper 启用了 per-monitor DPI 感知，保证坐标与屏幕上看到的一致。

## 安全与隐私

这是高权限插件。

- profile 里的任何会话都能移动/点击/输入并截图。若 profile 是 `danger-full-access` + `approval: never`，调用不会弹确认框。
- 截图会作为会话附件存到 `$DSH_HOME/attachments` 并留在会话记录里，请当作屏幕录像对待。
- 主要风险是提示注入：网页、文件或聊天内容可能诱导模型点击/输入。建议只在可信的桌面操作 profile 里启用，不用时禁用。
- 停用方式：Plugin Manager 里禁用/移除 `desktop-control` 行，helper 进程会随插件退出。

## 限制

- 管理员权限窗口、UAC 弹窗、锁屏/安全桌面会拒绝注入输入（UIPI）。
- 使用 Raw Input 读取鼠标的游戏可能忽略注入的移动；可配合 `desktop_mouse` 的 `down`/`up` 和 `move`，或改用键盘。
- 独占全屏游戏、受 DRM 保护的画面可能截成黑屏；无边框全屏和普通窗口正常。
- 多屏和非 100% 缩放在设计上支持（虚拟桌面坐标 + per-monitor DPI 感知），但未实测，欢迎反馈。
- `desktop_find` 依赖 Windows OCR：短词、生僻字可能漏检或错字（所以它会返回分数和最接近的行）。需要安装 OCR 语言包，Windows 10/11 通常随显示语言自带。
- `desktop_window elements` 只能看到原生控件；Chromium/Electron/Qt 自绘界面只返回外壳（用 `desktop_find` 或截图）。
- `desktop_window invoke` 需要控件暴露 InvokePattern：UIA 原生应用（WPF、UWP、资源管理器）一般都有；部分经典 Win32/MSAA 控件只会暴露成通用 Pane 而没有该能力，这时改用坐标点击。
- 用 `PrintWindow` 抓窗口时，GPU 渲染的应用可能返回空白图；改用前台屏幕截图或先激活窗口。
- `desktop_sequence` 的各步连续执行、不等界面动画；需要等的地方插一条 `{"action":"wait","waitMs":...}`。
- 企业 AppLocker / ConstrainedLanguage 策略或安全软件可能拦截 PowerShell helper。
- 仅 Windows；macOS/Linux 上插件不注册工具，只记一条警告，不会影响共用 profile。

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows 10 22H2 (19045) | ✅ 已测试 |
| Windows 11 | ⚠️ 未测试（user32 API 相同，预期可用） |
| Windows 8.1 | ⚠️ 未测试（per-monitor DPI 会退化为系统级 DPI 感知） |
| macOS | ❌ 未实现（需 CGEvent / cliclick 或 AppleScript） |
| Linux | ❌ 未实现（X11: XTest / xdotool；Wayland: ydotool） |

欢迎 PR 增加 macOS/Linux 实现，保持工具面一致、每个平台一个 helper 即可。

## 与其他 computer-use 插件共存时的工具路由

同一个 profile 里还启用了 MCP computer-use 服务（例如 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)，暴露 `windows_computer_use_*` 工具）时，本插件会追加一条简短的路由规则（约 60 tokens，仅在两套工具同时可见时生效）：网页任务走 MCP 的浏览器通道（传 `browserTab`）；复杂 UIA / 窗口管理 / launch_app / wait_for 走 MCP 工具；其余继续用更快的 `desktop_*`。不要在同一次动作序列里混用两套工具，也不要把浏览器元素 id 当作桌面坐标。MCP 工具不存在时这段提示为空，不产生开销。

## 开发

```bash
node --check index.js
node --check scripts/selftest.mjs
node scripts/selftest.mjs   # 需要 Windows + 交互式桌面
npm run publish:npm         # 发布 npm：用 README.en.md 作为包页面（GitHub 主 README 保持中文）
```

CI 在 `windows-latest` 上做语法检查；真实行为需要桌面环境，CI 不覆盖。

```
index.js              Host 插件：工具 + helper 生命周期
helper.ps1            PowerShell 输入/截图/窗口/OCR/UIA 服务
cordis.patch.yml      bundle 行（id: desktop-control, name: dsh-desktop-control）
locale/{en,zh}.json   Plugin Manager 显示信息
icon.svg              图标
scripts/selftest.mjs  手动交互自测
```

## 许可证

MIT，见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
