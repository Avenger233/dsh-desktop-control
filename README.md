# dsh-desktop-control

Real mouse, keyboard and screenshot control for DeepSeek Harness (dsh) sessions on Windows.

> Unofficial third-party plugin. Not affiliated with DeepSeek.
> Tested with dsh `0.2.2-rc.1` (desktop app) on Windows 10 22H2 (build 19045, Windows PowerShell 5.1), single 1920×1080 display at 100% scaling.

[中文说明](README.zh-CN.md)

## What you get

Four tools, visible to every session in the dsh profile where the bundle is installed:

| Tool | Capability |
|---|---|
| `desktop_mouse` | move, click (left/right/middle, single/double/multi), drag, scroll, press/release |
| `desktop_keyboard` | type Unicode text (Chinese, emoji, any symbol), press hotkeys, hold/release keys |
| `desktop_state` | cursor position, virtual-screen bounds, foreground window (process/title/rectangle), currently held keys |
| `desktop_screenshot` | capture the whole virtual desktop or a region and return it to the model as an image |

The four schemas cost roughly 1.3k tokens per request in every session of the profile, whether used or not; disable the bundle when you don't need it.

## Requirements

- **Windows 10/11**, interactive desktop session (not a service session). Windows 10 1703+ is recommended: it enables per-monitor DPI awareness so coordinates match the screen; older builds fall back to system DPI awareness.
- **DeepSeek Harness** with a Host process on that Windows machine — the dsh desktop app, or a dsh profile launched there. The plugin is a Host bundle, installed per profile.
- **Windows PowerShell 5.1** (`powershell.exe`, ships with Windows). PowerShell 7 is not required.
- No npm dependencies, no build step, no native modules.

> The tools control the desktop of the machine that runs the dsh Host — not the machine running the browser you view dsh in.

## Install

### From npm (recommended)

Ask the agent in that dsh profile to install the published bundle:

```
plugin_manager { action: "install_bundle", target: "@avengers233/dsh-desktop-control" }
```

### From source

```bash
git clone https://github.com/Avenger233/dsh-desktop-control.git
```

Then ask the agent in that dsh profile to install the directory as a bundle:

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\dsh-desktop-control" }
```

The bundle is installed per profile. A source install is linked to the checkout, so a later `git pull` (plus a dsh restart) picks up changes. The first install applies live; no restart needed.

Verify with a screenshot from a session, or run the manual self-test:

```bash
node scripts/selftest.mjs
```

It moves the cursor for a moment, presses F24 once, captures two screenshots and restores the cursor. Don't move the mouse while it runs.

## Example prompts

- "截图给我看看现在屏幕上是什么"
- "点一下任务栏第三个图标，然后把窗口拖到右边"
- "在记事本里输入这段话，然后 Ctrl+S 保存"
- "看看这个网页现在显示什么，再点那个蓝色的按钮"

Sessions only use the tools when the task calls for it; nothing runs in the background.

## How it works

- `index.js` — Cordis Host plugin. Registers the four tools, lazily starts one helper process, and kills it on unload.
- `helper.ps1` — a long-lived Windows PowerShell process that compiles a small P/Invoke wrapper around `user32.dll` (`SendInput`, `GetCursorPos`, ...) plus .NET `Graphics.CopyFromScreen`, then answers one command per line. Parent and child exchange one base64(UTF-8 JSON) line per message, so no console code page can corrupt non-ASCII text or window titles.
- Screenshots are downscaled when attachment limits require it, saved through dsh's `attachments` service and returned as an image content block; a PNG copy is also written to `%TEMP%\dsh-desktop-control`.

Coordinates are physical pixels on the virtual desktop. The helper enables per-monitor DPI awareness so positions match what is on screen.

## Security and privacy

This is a high-privilege plugin.

- Any session in the profile can move/click/type and read screenshots. On profiles configured with `danger-full-access` + `approval: never`, calls execute without asking.
- Screenshots become session attachments under `$DSH_HOME/attachments` and stay in the session log; treat them like screen recordings.
- Prompt injection is the main risk: a web page, a file or a chat message can try to make the model click or type. Install this in a profile you use for trusted desktop work, and disable the bundle when you don't need it.
- To stop it: Plugin Manager → disable or remove the `desktop-control` row. The helper process exits with the plugin.

## Limitations

- Elevated (administrator) windows, UAC prompts and the lock screen reject injected input (UIPI).
- Games that read the mouse through raw input may ignore injected movement; use `desktop_mouse` `down`/`up` together with `move`, or keyboard input.
- Exclusive-fullscreen games and DRM-protected surfaces can produce black screenshots; borderless-fullscreen and normal windows work.
- Multi-monitor layouts and non-100% DPI scaling are supported by design (virtual-screen coordinates + per-monitor DPI awareness) but have not been tested — please open an issue with your layout.
- Enterprise AppLocker / constrained-language policies or security software can block the PowerShell helper.
- Windows-only by design: on macOS and Linux the plugin registers no tools and logs one warning, so a shared profile does not break.

## Platform support

| Platform | Status |
|---|---|
| Windows 10 22H2 (19045) | ✅ tested |
| Windows 11 | ⚠️ not tested (same `user32.dll` APIs; expected to work) |
| Windows 8.1 | ⚠️ untested (per-monitor DPI falls back to system DPI awareness) |
| macOS | ❌ not implemented (CGEvent / cliclick or AppleScript would be needed) |
| Linux | ❌ not implemented (X11: XTest / xdotool; Wayland: ydotool) |

PRs for macOS/Linux are welcome — keep the tool surface identical and add one helper per platform.

## Development

```bash
node --check index.js
node --check scripts/selftest.mjs
node scripts/selftest.mjs   # Windows + interactive desktop
```

CI runs syntax checks on `windows-latest`. Runtime behavior needs a real desktop, so it is not covered by CI.

```
index.js              Host plugin: tools + helper lifecycle
helper.ps1            PowerShell input/screenshot server
cordis.patch.yml      bundle row (id: desktop-control, name: dsh-desktop-control)
locale/{en,zh}.json   Plugin Manager display metadata
icon.svg              icon
scripts/selftest.mjs  manual interactive test
```

## License

MIT — see [LICENSE](LICENSE).
