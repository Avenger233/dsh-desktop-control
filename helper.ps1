# Long-lived desktop-input helper for the dsh-desktop-control plugin.
#
# Protocol (one line per message, both directions):
#   stdin  : base64(UTF-8 JSON) + "\n"  -- a command from the plugin host
#   stdout : base64(UTF-8 JSON) + "\n"  -- either the ready handshake or one reply
# Base64 keeps every message pure ASCII, so no console code page or text encoding
# setting can corrupt non-ASCII text (typed characters, window titles).
#
# Commands: ping, state, move, click, down, up, drag, scroll, key, keydown,
# keyup, type, screenshot, invoke, windows, activate, elements, ocr, sleep, quit.
# See the switch in the main loop for fields.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DeskInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    static extern int MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    public static bool DpiAware = false;

    // Tell Windows this process wants true physical pixels, so GetSystemMetrics
    // and the normalized SendInput coordinates agree with on-screen pixels.
    public static bool Init()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { DpiAware = true; return true; }
        }
        catch (Exception) { }
        try
        {
            DpiAware = SetProcessDPIAware();
        }
        catch (Exception) { DpiAware = false; }
        return DpiAware;
    }

    static int Send(INPUT input)
    {
        INPUT[] data = new INPUT[] { input };
        uint sent = SendInput(1, data, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 1) return 1;
        return -Marshal.GetLastWin32Error();
    }

    public static int[] VirtualScreen()
    {
        int left = GetSystemMetrics(76);
        int top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78);
        int height = GetSystemMetrics(79);
        if (width <= 0) width = GetSystemMetrics(0);
        if (height <= 0) height = GetSystemMetrics(1);
        return new int[] { left, top, width, height };
    }

    public static int[] Cursor()
    {
        POINT p;
        if (!GetCursorPos(out p)) return new int[] { -1, -1 };
        return new int[] { p.X, p.Y };
    }

    static int[] Normalize(int x, int y)
    {
        int[] v = VirtualScreen();
        int vw = v[2] > 1 ? v[2] - 1 : 1;
        int vh = v[3] > 1 ? v[3] - 1 : 1;
        long nx = ((long)(x - v[0]) * 65535L + vw / 2) / vw;
        long ny = ((long)(y - v[1]) * 65535L + vh / 2) / vh;
        if (nx < 0) nx = 0;
        if (nx > 65535) nx = 65535;
        if (ny < 0) ny = 0;
        if (ny > 65535) ny = 65535;
        return new int[] { (int)nx, (int)ny };
    }

    public static int MouseTo(int x, int y)
    {
        int[] n = Normalize(x, y);
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = n[0];
        input.u.mi.dy = n[1];
        input.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        return Send(input);
    }

    public static int MouseButton(string button, bool down)
    {
        uint flag;
        if (button == "right") flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else if (button == "middle") flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flag;
        return Send(input);
    }

    public static int Wheel(int delta, bool horizontal)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.mouseData = unchecked((uint)delta);
        input.u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
        return Send(input);
    }

    public static int Key(int vk, bool down, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
        uint flags = down ? 0u : KEYEVENTF_KEYUP;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        input.u.ki.dwFlags = flags;
        return Send(input);
    }

    public static int TypeChar(char c)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.u.ki.wScan = (ushort)c;
        down.u.ki.dwFlags = KEYEVENTF_UNICODE;
        int first = Send(down);
        INPUT up = new INPUT();
        up.type = INPUT_KEYBOARD;
        up.u.ki.wScan = (ushort)c;
        up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        int second = Send(up);
        return first == 1 ? second : first;
    }

    public static bool Down(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    public static Dictionary<string, object> Foreground()
    {
        Dictionary<string, object> info = new Dictionary<string, object>();
        IntPtr hwnd = GetForegroundWindow();
        info["handle"] = hwnd.ToInt64();
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        info["pid"] = (long)pid;
        StringBuilder title = new StringBuilder(1024);
        int length = GetWindowText(hwnd, title, title.Capacity);
        info["title"] = length > 0 ? title.ToString() : "";
        string process = "";
        if (pid != 0)
        {
            try
            {
                using (Process p = Process.GetProcessById((int)pid)) process = p.ProcessName;
            }
            catch (Exception) { }
        }
        info["process"] = process;
        RECT rect;
        if (GetWindowRect(hwnd, out rect))
        {
            info["bounds"] = new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
        }
        else
        {
            info["bounds"] = new int[] { 0, 0, 0, 0 };
        }
        return info;
    }

    public static void Sleep(int ms)
    {
        if (ms > 0) Thread.Sleep(ms);
    }

    // ------------------------------------------------------------ window APIs
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    static string ProcessNameOf(uint pid)
    {
        if (pid == 0) return "";
        try
        {
            using (Process p = Process.GetProcessById((int)pid)) return p.ProcessName;
        }
        catch (Exception) { return ""; }
    }

    static Dictionary<string, object> DescribeWindow(IntPtr hwnd)
    {
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["handle"] = hwnd.ToInt64();
        StringBuilder title = new StringBuilder(1024);
        GetWindowText(hwnd, title, title.Capacity);
        info["title"] = title.ToString();
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        info["class"] = cls.ToString();
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        info["pid"] = (long)pid;
        info["process"] = ProcessNameOf(pid);
        RECT rect;
        if (GetWindowRect(hwnd, out rect)) info["bounds"] = new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
        else info["bounds"] = new int[] { 0, 0, 0, 0 };
        info["minimized"] = IsIconic(hwnd);
        return info;
    }

    public static List<Dictionary<string, object>> VisibleWindows()
    {
        List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hwnd)) return true;
            if (GetWindowTextLength(hwnd) <= 0) return true;
            Dictionary<string, object> info = DescribeWindow(hwnd);
            int[] bounds = (int[])info["bounds"];
            if (bounds[2] <= 0 || bounds[3] <= 0) return true;
            string cls = (string)info["class"];
            if (cls == "Progman" || cls == "WorkerW") return true;
            result.Add(info);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static Dictionary<string, object> WindowInfo(long handle)
    {
        return DescribeWindow(new IntPtr(handle));
    }

    public static int[] WindowRect(long handle)
    {
        RECT rect;
        if (GetWindowRect(new IntPtr(handle), out rect)) return new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
        return new int[] { 0, 0, 0, 0 };
    }

    public static bool PrintWindowTo(long handle, IntPtr hdc, uint flags)
    {
        return PrintWindow(new IntPtr(handle), hdc, flags);
    }

    public static bool ActivateWindow(long handle)
    {
        IntPtr hwnd = new IntPtr(handle);
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        bool ok = SetForegroundWindow(hwnd);
        if (!ok)
        {
            uint ignored;
            uint target = GetWindowThreadProcessId(hwnd, out ignored);
            uint self = GetCurrentThreadId();
            if (AttachThreadInput(self, target, true))
            {
                ShowWindow(hwnd, 5);
                ok = SetForegroundWindow(hwnd);
                AttachThreadInput(self, target, false);
            }
        }
        return ok;
    }
}
'@

$script:dpiAware = $false
try { $script:dpiAware = [DeskInput]::Init() } catch { $script:dpiAware = $false }
$script:drawingLoaded = $false
$script:uiaLoaded = $false
$script:ocrLoaded = $false
$script:asTaskGeneric = $null
$script:ocrEngine = $null

# ------------------------------------------------------------------ key names
$script:VK = @{
    'ctrl' = 17; 'control' = 17; 'lctrl' = 162; 'rctrl' = 163;
    'shift' = 16; 'lshift' = 160; 'rshift' = 161;
    'alt' = 18; 'menu' = 18; 'lalt' = 164; 'ralt' = 165;
    'win' = 91; 'lwin' = 91; 'super' = 91; 'rwin' = 92;
    'enter' = 13; 'return' = 13; 'tab' = 9; 'space' = 32;
    'esc' = 27; 'escape' = 27; 'backspace' = 8; 'bs' = 8;
    'delete' = 46; 'del' = 46; 'insert' = 45; 'ins' = 45;
    'home' = 36; 'end' = 35; 'pageup' = 33; 'pgup' = 33;
    'pagedown' = 34; 'pgdn' = 34; 'up' = 38; 'down' = 40; 'left' = 37; 'right' = 39;
    'capslock' = 20; 'numlock' = 144; 'scrolllock' = 145;
    'printscreen' = 44; 'prtsc' = 44; 'pause' = 19; 'apps' = 93;
    'minus' = 189; 'hyphen' = 189; 'equal' = 187; 'plus' = 187;
    'comma' = 188; 'period' = 190; 'dot' = 190; 'slash' = 191; 'backslash' = 220;
    'semicolon' = 186; 'quote' = 222; 'backtick' = 192; 'grave' = 192;
    'lbracket' = 219; 'rbracket' = 221;
    'lbutton' = 1; 'rbutton' = 2; 'mbutton' = 4;
}
for ($i = 1; $i -le 24; $i++) { $script:VK["f$i"] = 111 + $i }
$script:EXTENDED = @(33, 34, 35, 36, 37, 38, 39, 40, 44, 45, 46, 91, 92, 93, 111, 144, 163, 165)

function Resolve-Key([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return 0 }
    $key = $name.Trim().ToLowerInvariant()
    if ($script:VK.ContainsKey($key)) { return [int]$script:VK[$key] }
    if ($key.Length -eq 1) {
        $ch = $key[0]
        if ($ch -ge 'a' -and $ch -le 'z') { return [int][char]::ToUpperInvariant($ch) }
        if ($ch -ge '0' -and $ch -le '9') { return [int]$ch }
    }
    return 0
}

function Test-Extended([int]$vk) {
    return ($script:EXTENDED -contains $vk)
}

function Flatten-Keys($value) {
    $out = New-Object System.Collections.ArrayList
    foreach ($entry in @($value)) {
        if ($null -eq $entry) { continue }
        foreach ($part in ([string]$entry) -split '\+') {
            $trimmed = $part.Trim()
            if ($trimmed.Length -gt 0) { [void]$out.Add($trimmed) }
        }
    }
    return ,$out.ToArray()
}

function Move-Smooth([int]$fromX, [int]$fromY, [int]$toX, [int]$toY, [int]$durationMs) {
    if ($durationMs -le 0) {
        [void][DeskInput]::MouseTo($toX, $toY)
        return
    }
    $steps = [int][Math]::Ceiling($durationMs / 12.0)
    if ($steps -lt 2) { $steps = 2 }
    if ($steps -gt 240) { $steps = 240 }
    $sleep = [int][Math]::Max(1, [Math]::Floor($durationMs / $steps))
    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / [double]$steps
        $x = [int][Math]::Round($fromX + ($toX - $fromX) * $t)
        $y = [int][Math]::Round($fromY + ($toY - $fromY) * $t)
        [void][DeskInput]::MouseTo($x, $y)
        [DeskInput]::Sleep($sleep)
    }
}

function Clamp-Int($value, [int]$default, [int]$min, [int]$max) {
    if ($null -eq $value) { return $default }
    $n = 0
    if (-not [int]::TryParse([string]$value, [ref]$n)) { return $default }
    if ($n -lt $min) { return $min }
    if ($n -gt $max) { return $max }
    return $n
}

function Get-Button([string]$value) {
    if ($value -eq 'right' -or $value -eq 'middle') { return $value }
    return 'left'
}

# ------------------------------------------------------- windows / UIA / OCR
function Ensure-Drawing {
    if (-not $script:drawingLoaded) {
        Add-Type -AssemblyName System.Drawing
        $script:drawingLoaded = $true
    }
}

function Get-WindowHandle($query, $handle) {
    $candidate = 0
    if ($null -ne $handle) {
        if ([int64]::TryParse([string]$handle, [ref]$candidate) -and $candidate -gt 0) { return [long]$candidate }
    }
    if ([string]::IsNullOrWhiteSpace([string]$query)) { throw 'provide a window title/process substring or an hwnd' }
    $needle = ([string]$query).Trim().ToLowerInvariant()
    foreach ($entry in [DeskInput]::VisibleWindows()) {
        $title = ([string]$entry['title']).ToLowerInvariant()
        $process = ([string]$entry['process']).ToLowerInvariant()
        if (($title.Length -gt 0 -and $title.Contains($needle)) -or ($process.Length -gt 0 -and $process.Contains($needle))) {
            return [long]$entry['handle']
        }
    }
    throw "no visible window matches '$query'"
}

function Resize-Bitmap($bitmap, [double]$scale) {
    $width = [int][Math]::Max(1, [Math]::Round($bitmap.Width * $scale))
    $height = [int][Math]::Max(1, [Math]::Round($bitmap.Height * $scale))
    $resized = New-Object System.Drawing.Bitmap -ArgumentList @($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($resized)
    try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($bitmap, 0, 0, $width, $height)
    }
    finally { $graphics.Dispose() }
    return $resized
}

function Get-ScreenRegionBitmap([int]$left, [int]$top, [int]$width, [int]$height, [double]$scale) {
    Ensure-Drawing
    $native = New-Object System.Drawing.Bitmap -ArgumentList @($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($native)
    try {
        $size = New-Object System.Drawing.Size -ArgumentList @($width, $height)
        $graphics.CopyFromScreen($left, $top, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    }
    finally { $graphics.Dispose() }
    if ($scale -eq 1.0) { return $native }
    try { return (Resize-Bitmap $native $scale) }
    finally { $native.Dispose() }
}

function Test-BitmapBlank($bitmap) {
    $stepX = [int][Math]::Max(1, [Math]::Floor($bitmap.Width / 8.0))
    $stepY = [int][Math]::Max(1, [Math]::Floor($bitmap.Height / 8.0))
    $colored = 0
    for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
        for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
            $pixel = $bitmap.GetPixel($x, $y)
            if ($pixel.A -ne 0 -or $pixel.R -ne 0 -or $pixel.G -ne 0 -or $pixel.B -ne 0) {
                $colored++
                if ($colored -gt 3) { return $false }
            }
        }
    }
    return $true
}

function Draw-ScreenshotOverlay($bitmap, [int]$left, [int]$top, [bool]$grid, [bool]$cursor) {
    Ensure-Drawing
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        if ($grid) {
            $step = 120
            $longest = [Math]::Max($bitmap.Width, $bitmap.Height)
            while (($longest / $step) -gt 14) { $step *= 2 }
            $pen = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(110, 80, 200, 255), 1)
            $font = New-Object System.Drawing.Font -ArgumentList @('Segoe UI', 9)
            $labelBackground = New-Object System.Drawing.SolidBrush -ArgumentList @([System.Drawing.Color]::FromArgb(170, 0, 0, 0))
            try {
                $startX = [int]([Math]::Ceiling($left / [double]$step) * $step)
                for ($x = $startX; $x -le ($left + $bitmap.Width); $x += $step) {
                    $pixelX = $x - $left
                    if ($pixelX -lt 0) { continue }
                    $graphics.DrawLine($pen, $pixelX, 0, $pixelX, $bitmap.Height)
                    $label = [string]$x
                    $size = $graphics.MeasureString($label, $font)
                    $graphics.FillRectangle($labelBackground, $pixelX + 1, 1, $size.Width + 2, $size.Height)
                    $graphics.DrawString($label, $font, [System.Drawing.Brushes]::White, $pixelX + 2, 1)
                }
                $startY = [int]([Math]::Ceiling($top / [double]$step) * $step)
                for ($y = $startY; $y -le ($top + $bitmap.Height); $y += $step) {
                    $pixelY = $y - $top
                    if ($pixelY -lt 0) { continue }
                    $graphics.DrawLine($pen, 0, $pixelY, $bitmap.Width, $pixelY)
                    $label = [string]$y
                    $size = $graphics.MeasureString($label, $font)
                    $graphics.FillRectangle($labelBackground, 1, $pixelY + 1, $size.Width + 2, $size.Height)
                    $graphics.DrawString($label, $font, [System.Drawing.Brushes]::White, 2, $pixelY + 1)
                }
            }
            finally {
                $pen.Dispose()
                $font.Dispose()
                $labelBackground.Dispose()
            }
        }
        if ($cursor) {
            $position = [DeskInput]::Cursor()
            $cursorX = $position[0] - $left
            $cursorY = $position[1] - $top
            if ($cursorX -ge 0 -and $cursorY -ge 0 -and $cursorX -lt $bitmap.Width -and $cursorY -lt $bitmap.Height) {
                $crossPen = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(220, 255, 40, 40), 2)
                try {
                    $graphics.DrawLine($crossPen, $cursorX - 20, $cursorY, $cursorX + 20, $cursorY)
                    $graphics.DrawLine($crossPen, $cursorX, $cursorY - 20, $cursorX, $cursorY + 20)
                    $graphics.DrawEllipse($crossPen, $cursorX - 7, $cursorY - 7, 14, 14)
                }
                finally { $crossPen.Dispose() }
            }
        }
    }
    finally { $graphics.Dispose() }
}

function Get-WindowBitmap([long]$handle) {
    Ensure-Drawing
    $rect = [DeskInput]::WindowRect($handle)
    if ($rect[2] -le 0 -or $rect[3] -le 0) { throw 'window has no visible area (minimized?)' }
    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList @($rect[2], $rect[3], [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try { $ok = [DeskInput]::PrintWindowTo($handle, $hdc, 2) }
    finally { [void]$graphics.ReleaseHdc($hdc); $graphics.Dispose() }
    if (-not $ok) {
        $bitmap.Dispose()
        throw 'PrintWindow failed for this window; activate it and capture the screen instead'
    }
    if (Test-BitmapBlank $bitmap) {
        $bitmap.Dispose()
        throw 'the captured window is blank (the app does not support PrintWindow); activate it and capture the screen instead'
    }
    return $bitmap
}

function Ensure-Uia {
    if ($script:uiaLoaded) { return }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    $script:uiaLoaded = $true
}

function Get-UiaRows([long]$handle, [int]$maxDepth, [int]$maxNodes, [string]$filter) {
    Ensure-Uia
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    if ($null -eq $root) { throw 'UI Automation could not attach to this window' }
    $needle = ''
    if (-not [string]::IsNullOrWhiteSpace($filter)) { $needle = $filter.Trim().ToLowerInvariant() }
    $rows = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($root, 0))
    while ($queue.Count -gt 0 -and $rows.Count -lt $maxNodes) {
        $item = $queue.Dequeue()
        $element = $item[0]
        $depth = [int]$item[1]
        if ($depth -gt 0) {
            try {
                $name = [string]$element.Current.Name
                $border = $element.Current.BoundingRectangle
                $role = [string]$element.Current.ControlType.ProgrammaticName
                if ($role.StartsWith('ControlType.')) { $role = $role.Substring(12) }
                if ($name.Length -gt 0 -and $border.Width -gt 0 -and $border.Height -gt 0) {
                    if ($needle.Length -eq 0 -or $name.ToLowerInvariant().Contains($needle) -or $role.ToLowerInvariant().Contains($needle)) {
                        [void]$rows.Add(@{
                            role = $role
                            name = $name
                            x = [int][Math]::Round($border.X + $border.Width / 2)
                            y = [int][Math]::Round($border.Y + $border.Height / 2)
                            width = [int][Math]::Round($border.Width)
                            height = [int][Math]::Round($border.Height)
                            depth = $depth
                        })
                    }
                }
            }
            catch { }
        }
        if ($depth -lt $maxDepth) {
            try {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child) {
                    $queue.Enqueue(@($child, ($depth + 1)))
                    $child = $walker.GetNextSibling($child)
                }
            }
            catch { }
        }
    }
    return ,$rows.ToArray()
}

function Ensure-Ocr {
    if ($script:ocrLoaded) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Ensure-Drawing
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    foreach ($method in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
        if ($method.Name -ne 'AsTask') { continue }
        $parameters = $method.GetParameters()
        if ($parameters.Count -ne 1) { continue }
        if ($parameters[0].ParameterType.Name -eq 'IAsyncOperation`1') { $script:asTaskGeneric = $method; break }
    }
    if ($null -eq $script:asTaskGeneric) { throw 'the Windows Runtime AsTask bridge is unavailable' }
    $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $script:ocrEngine) {
        foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
            $candidate = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($null -ne $candidate) { $script:ocrEngine = $candidate; break }
        }
    }
    if ($null -eq $script:ocrEngine) {
        throw 'Windows OCR is not available; install an OCR language pack (Settings > Time & Language > Language > optional features) or use desktop_screenshot'
    }
    $script:ocrLoaded = $true
}

function Await-WinRtOperation($operation, $resultType) {
    $task = $script:asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    return $task.Result
}

function Invoke-OcrOnBitmap($bitmap) {
    Ensure-Ocr
    $stream = New-Object System.IO.MemoryStream
    try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $stream.Position = 0
        $randomAccess = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
        $decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($randomAccess)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $softwareBitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await-WinRtOperation ($script:ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        $rows = New-Object System.Collections.ArrayList
        foreach ($line in $result.Lines) {
            $minX = [double]::MaxValue
            $minY = [double]::MaxValue
            $maxX = [double]::MinValue
            $maxY = [double]::MinValue
            foreach ($word in $line.Words) {
                $box = $word.BoundingRect
                if ($box.Width -le 0 -or $box.Height -le 0) { continue }
                if ($box.X -lt $minX) { $minX = $box.X }
                if ($box.Y -lt $minY) { $minY = $box.Y }
                if (($box.X + $box.Width) -gt $maxX) { $maxX = $box.X + $box.Width }
                if (($box.Y + $box.Height) -gt $maxY) { $maxY = $box.Y + $box.Height }
            }
            if ($minX -eq [double]::MaxValue) { continue }
            [void]$rows.Add(@{ text = [string]$line.Text; x = $minX; y = $minY; width = ($maxX - $minX); height = ($maxY - $minY) })
        }
        return ,$rows.ToArray()
    }
    finally { $stream.Dispose() }
}

function Write-Reply($payload) {
    $json = $payload | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
    [Console]::Out.Flush()
}

function Handle-Command($cmd) {
    $action = [string]$cmd.cmd
    switch ($action) {
        'ping' {
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1] }
        }
        'state' {
            $pos = [DeskInput]::Cursor()
            $vs = [DeskInput]::VirtualScreen()
            $fg = [DeskInput]::Foreground()
            $pressed = @{}
            $check = Flatten-Keys $cmd.keys
            foreach ($name in @($check)) {
                $vk = Resolve-Key $name
                if ($vk -gt 0) { $pressed[$name] = [DeskInput]::Down($vk) }
                else { $pressed[$name] = $null }
            }
            return @{
                ok = $true
                x = $pos[0]; y = $pos[1]
                screen = @{ left = $vs[0]; top = $vs[1]; width = $vs[2]; height = $vs[3] }
                foreground = $fg
                pressed = $pressed
                dpiAware = $script:dpiAware
            }
        }
        'move' {
            $x = Clamp-Int $cmd.x 0 -100000 100000
            $y = Clamp-Int $cmd.y 0 -100000 100000
            $duration = Clamp-Int $cmd.durationMs 0 0 15000
            $from = [DeskInput]::Cursor()
            Move-Smooth $from[0] $from[1] $x $y $duration
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1] }
        }
        'click' {
            if ($null -ne $cmd.x -and $null -ne $cmd.y) {
                [void][DeskInput]::MouseTo((Clamp-Int $cmd.x 0 -100000 100000), (Clamp-Int $cmd.y 0 -100000 100000))
                [DeskInput]::Sleep(40)
            }
            $button = Get-Button ([string]$cmd.button)
            $count = Clamp-Int $cmd.count 1 1 10
            $interval = Clamp-Int $cmd.intervalMs 90 10 2000
            for ($i = 0; $i -lt $count; $i++) {
                if ($i -gt 0) { [DeskInput]::Sleep($interval) }
                [void][DeskInput]::MouseButton($button, $true)
                [DeskInput]::Sleep(30)
                [void][DeskInput]::MouseButton($button, $false)
            }
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1]; button = $button; count = $count }
        }
        'down' {
            $button = Get-Button ([string]$cmd.button)
            [void][DeskInput]::MouseButton($button, $true)
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1]; button = $button }
        }
        'up' {
            $button = Get-Button ([string]$cmd.button)
            [void][DeskInput]::MouseButton($button, $false)
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1]; button = $button }
        }
        'drag' {
            $button = Get-Button ([string]$cmd.button)
            $toX = Clamp-Int $cmd.toX 0 -100000 100000
            $toY = Clamp-Int $cmd.toY 0 -100000 100000
            $duration = Clamp-Int $cmd.durationMs 400 50 15000
            $from = [DeskInput]::Cursor()
            if ($null -ne $cmd.x -and $null -ne $cmd.y) {
                $from = @((Clamp-Int $cmd.x 0 -100000 100000), (Clamp-Int $cmd.y 0 -100000 100000))
                [void][DeskInput]::MouseTo($from[0], $from[1])
                [DeskInput]::Sleep(60)
            }
            [void][DeskInput]::MouseButton($button, $true)
            [DeskInput]::Sleep(70)
            Move-Smooth $from[0] $from[1] $toX $toY $duration
            [DeskInput]::Sleep(60)
            [void][DeskInput]::MouseButton($button, $false)
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1]; button = $button }
        }
        'scroll' {
            if ($null -ne $cmd.x -and $null -ne $cmd.y) {
                [void][DeskInput]::MouseTo((Clamp-Int $cmd.x 0 -100000 100000), (Clamp-Int $cmd.y 0 -100000 100000))
                [DeskInput]::Sleep(30)
            }
            $delta = Clamp-Int $cmd.delta 0 -12000 12000
            $horizontal = [bool]$cmd.horizontal
            if ($delta -ne 0 -and [Math]::Abs($delta) -lt 120) { $delta = [Math]::Sign($delta) * 120 }
            $notches = [int][Math]::Ceiling([Math]::Abs($delta) / 120.0)
            $sign = 1
            if ($delta -lt 0) { $sign = -1 }
            for ($i = 0; $i -lt $notches; $i++) {
                [void][DeskInput]::Wheel(120 * $sign, $horizontal)
                [DeskInput]::Sleep(15)
            }
            $pos = [DeskInput]::Cursor()
            return @{ ok = $true; x = $pos[0]; y = $pos[1]; delta = 120 * $sign * $notches; horizontal = $horizontal }
        }
        'key' {
            $names = Flatten-Keys $cmd.keys
            if (@($names).Count -eq 0) { throw 'keys is required' }
            $vks = New-Object System.Collections.ArrayList
            foreach ($name in @($names)) {
                $vk = Resolve-Key $name
                if ($vk -le 0) { throw "unknown key: $name" }
                [void]$vks.Add($vk)
            }
            $hold = Clamp-Int $cmd.holdMs 40 10 5000
            for ($i = 0; $i -lt $vks.Count - 1; $i++) {
                [void][DeskInput]::Key($vks[$i], $true, (Test-Extended $vks[$i]))
                [DeskInput]::Sleep(25)
            }
            $last = $vks[$vks.Count - 1]
            [void][DeskInput]::Key($last, $true, (Test-Extended $last))
            [DeskInput]::Sleep($hold)
            [void][DeskInput]::Key($last, $false, (Test-Extended $last))
            for ($i = $vks.Count - 2; $i -ge 0; $i--) {
                [DeskInput]::Sleep(15)
                [void][DeskInput]::Key($vks[$i], $false, (Test-Extended $vks[$i]))
            }
            return @{ ok = $true; keys = @($names); holdMs = $hold }
        }
        'keydown' {
            $names = Flatten-Keys $cmd.keys
            if (@($names).Count -eq 0) { throw 'keys is required' }
            foreach ($name in @($names)) {
                $vk = Resolve-Key $name
                if ($vk -le 0) { throw "unknown key: $name" }
                [void][DeskInput]::Key($vk, $true, (Test-Extended $vk))
            }
            return @{ ok = $true; keys = @($names) }
        }
        'keyup' {
            $names = Flatten-Keys $cmd.keys
            if (@($names).Count -eq 0) { throw 'keys is required' }
            $reversed = @($names)
            [array]::Reverse($reversed)
            foreach ($name in $reversed) {
                $vk = Resolve-Key $name
                if ($vk -le 0) { throw "unknown key: $name" }
                [void][DeskInput]::Key($vk, $false, (Test-Extended $vk))
            }
            return @{ ok = $true; keys = @($names) }
        }
        'type' {
            $text = [string]$cmd.text
            if ([string]::IsNullOrEmpty($text)) { return @{ ok = $true; chars = 0 } }
            $delay = Clamp-Int $cmd.charDelayMs 12 0 500
            $count = 0
            foreach ($ch in $text.ToCharArray()) {
                $code = [int]$ch
                if ($code -eq 13) { continue }
                if ($code -eq 10) {
                    [void][DeskInput]::Key(13, $true, $false)
                    [DeskInput]::Sleep(20)
                    [void][DeskInput]::Key(13, $false, $false)
                }
                elseif ($code -eq 9) {
                    [void][DeskInput]::Key(9, $true, $false)
                    [DeskInput]::Sleep(20)
                    [void][DeskInput]::Key(9, $false, $false)
                }
                else {
                    [void][DeskInput]::TypeChar($ch)
                }
                $count++
                if ($delay -gt 0) { [DeskInput]::Sleep($delay) }
            }
            return @{ ok = $true; chars = $count }
        }
        'screenshot' {
            if (-not $script:drawingLoaded) {
                Add-Type -AssemblyName System.Drawing
                $script:drawingLoaded = $true
            }
            $vs = [DeskInput]::VirtualScreen()
            $left = $vs[0]
            $top = $vs[1]
            if ($null -ne $cmd.x) { $left = Clamp-Int $cmd.x $vs[0] -100000 100000 }
            if ($null -ne $cmd.y) { $top = Clamp-Int $cmd.y $vs[1] -100000 100000 }
            $width = $vs[0] + $vs[2] - $left
            $height = $vs[1] + $vs[3] - $top
            if ($null -ne $cmd.width) { $width = Clamp-Int $cmd.width $width 1 20000 }
            if ($null -ne $cmd.height) { $height = Clamp-Int $cmd.height $height 1 20000 }
            $right = [Math]::Min($left + $width, $vs[0] + $vs[2])
            $bottom = [Math]::Min($top + $height, $vs[1] + $vs[3])
            if ($left -lt $vs[0]) { $left = $vs[0] }
            if ($top -lt $vs[1]) { $top = $vs[1] }
            $width = $right - $left
            $height = $bottom - $top
            if ($width -le 0 -or $height -le 0) { throw 'the requested region is outside the screen' }

            $path = [string]$cmd.path
            if ([string]::IsNullOrWhiteSpace($path)) { throw 'path is required' }
            $directory = [System.IO.Path]::GetDirectoryName($path)
            if (-not [string]::IsNullOrEmpty($directory)) { [void][System.IO.Directory]::CreateDirectory($directory) }

            $bitmap = New-Object System.Drawing.Bitmap -ArgumentList @($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $size = New-Object System.Drawing.Size -ArgumentList @($width, $height)
                $graphics.CopyFromScreen($left, $top, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
            }
            finally {
                $graphics.Dispose()
            }

            $drawGrid = $cmd.grid -eq $true
            $drawCursor = $cmd.cursor -eq $true
            if ($drawGrid -or $drawCursor) { Draw-ScreenshotOverlay $bitmap $left $top $drawGrid $drawCursor }

            $maxDimension = Clamp-Int $cmd.maxDimension 0 0 10000
            $sourceWidth = $width
            $sourceHeight = $height
            if ($maxDimension -gt 0 -and ($width -gt $maxDimension -or $height -gt $maxDimension)) {
                $scale = $maxDimension / [double][Math]::Max($width, $height)
                $scaledWidth = [int][Math]::Max(1, [Math]::Round($width * $scale))
                $scaledHeight = [int][Math]::Max(1, [Math]::Round($height * $scale))
                $scaled = New-Object System.Drawing.Bitmap -ArgumentList @($scaledWidth, $scaledHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
                $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
                try {
                    $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $scaledGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $scaledGraphics.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
                }
                finally {
                    $scaledGraphics.Dispose()
                }
                $bitmap.Dispose()
                $bitmap = $scaled
                $width = $scaledWidth
                $height = $scaledHeight
            }

            try {
                $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            }
            finally {
                $bitmap.Dispose()
            }
            $file = New-Object System.IO.FileInfo -ArgumentList @($path)
            return @{ ok = $true; path = $path; width = $width; height = $height; sourceWidth = $sourceWidth; sourceHeight = $sourceHeight; bytes = $file.Length; left = $left; top = $top; grid = $drawGrid; cursor = $drawCursor }
        }
        'invoke' {
            $handle = Get-WindowHandle $cmd.window $cmd.hwnd
            if ($null -eq $cmd.filter -or ([string]$cmd.filter).Trim().Length -eq 0) {
                throw 'invoke requires filter (control name or role substring)'
            }
            $needle = ([string]$cmd.filter).Trim().ToLowerInvariant()
            Ensure-Uia
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
            if ($null -eq $root) { throw 'UI Automation could not attach to the window' }
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $queue = New-Object System.Collections.Queue
            $queue.Enqueue($root)
            $candidates = New-Object System.Collections.ArrayList
            $visited = 0
            while ($queue.Count -gt 0 -and $visited -lt 800) {
                $element = $queue.Dequeue()
                $visited++
                try {
                    $name = [string]$element.Current.Name
                    if ($name.Length -gt 0 -and $name.ToLowerInvariant().Contains($needle)) { [void]$candidates.Add($element) }
                }
                catch { }
                try {
                    $child = $walker.GetFirstChild($element)
                    while ($null -ne $child) {
                        $queue.Enqueue($child)
                        $child = $walker.GetNextSibling($child)
                    }
                }
                catch { }
            }
            if ($candidates.Count -eq 0) { throw "no UI Automation control matches '$($cmd.filter)'" }
            $matched = $null
            $method = ''
            foreach ($candidate in $candidates) {
                try {
                    $invokePattern = $null
                    if ($candidate.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
                        $invokePattern.Invoke()
                        $matched = $candidate
                        $method = 'InvokePattern'
                        break
                    }
                }
                catch { }
            }
            if ($null -eq $matched) {
                foreach ($candidate in $candidates) {
                    try {
                        $legacyPattern = $null
                        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacyPattern)) {
                            $legacyPattern.DoDefaultAction()
                            $matched = $candidate
                            $method = 'LegacyIAccessible'
                            break
                        }
                    }
                    catch { }
                }
            }
            if ($null -eq $matched) {
                $summary = @($candidates | Select-Object -First 5 | ForEach-Object {
                    try { "$([string]$_.Current.ControlType.ProgrammaticName):$([string]$_.Current.Name)" } catch { '?' }
                }) -join ', '
                throw "matched control(s) but none exposes an invoke pattern ($summary); click by coordinates instead"
            }
            [DeskInput]::Sleep(150)
            return @{ ok = $true; name = [string]$matched.Current.Name; role = [string]$matched.Current.ControlType.ProgrammaticName; method = $method; window = [DeskInput]::WindowInfo($handle) }
        }
        'windows' {
            $needle = ''
            if ($null -ne $cmd.filter) { $needle = ([string]$cmd.filter).Trim().ToLowerInvariant() }
            $top = Clamp-Int $cmd.top 30 1 200
            $all = [DeskInput]::VisibleWindows()
            $list = New-Object System.Collections.ArrayList
            foreach ($entry in $all) {
                if ($needle.Length -gt 0) {
                    $title = ([string]$entry['title']).ToLowerInvariant()
                    $process = ([string]$entry['process']).ToLowerInvariant()
                    if (-not ($title.Contains($needle) -or $process.Contains($needle))) { continue }
                }
                [void]$list.Add($entry)
                if ($list.Count -ge $top) { break }
            }
            return @{ ok = $true; total = $all.Count; windows = @($list) }
        }
        'activate' {
            $handle = Get-WindowHandle $cmd.window $cmd.hwnd
            $activated = [DeskInput]::ActivateWindow($handle)
            [DeskInput]::Sleep(180)
            return @{ ok = $true; activated = $activated; window = [DeskInput]::WindowInfo($handle); foreground = [DeskInput]::Foreground() }
        }
        'elements' {
            $handle = Get-WindowHandle $cmd.window $cmd.hwnd
            $depth = Clamp-Int $cmd.depth 4 1 10
            $max = Clamp-Int $cmd.max 120 1 500
            $needle = ''
            if ($null -ne $cmd.filter) { $needle = [string]$cmd.filter }
            $rows = Get-UiaRows $handle $depth $max $needle
            return @{ ok = $true; window = [DeskInput]::WindowInfo($handle); count = @($rows).Count; elements = @($rows) }
        }
        'ocr' {
            $scaleValue = 2.0
            if ($null -ne $cmd.scale) {
                $parsed = 0.0
                if ([double]::TryParse([string]$cmd.scale, [ref]$parsed)) { $scaleValue = $parsed }
            }
            if ($scaleValue -lt 0.5) { $scaleValue = 0.5 }
            if ($scaleValue -gt 4.0) { $scaleValue = 4.0 }
            $vs = [DeskInput]::VirtualScreen()
            $left = $vs[0]
            $top = $vs[1]
            $width = $vs[2]
            $height = $vs[3]
            $capture = 'screen'
            $bitmap = $null
            if ($null -ne $cmd.window -and ([string]$cmd.window).Trim().Length -gt 0) {
                $handle = Get-WindowHandle $cmd.window $null
                $rect = [DeskInput]::WindowRect($handle)
                $left = $rect[0]
                $top = $rect[1]
                $width = $rect[2]
                $height = $rect[3]
                $bitmap = Get-WindowBitmap $handle
                if ($scaleValue -ne 1.0) {
                    $resized = Resize-Bitmap $bitmap $scaleValue
                    $bitmap.Dispose()
                    $bitmap = $resized
                }
                $capture = 'window'
            }
            else {
                if ($null -ne $cmd.x -and $null -ne $cmd.y) {
                    $left = Clamp-Int $cmd.x $vs[0] -100000 100000
                    $top = Clamp-Int $cmd.y $vs[1] -100000 100000
                }
                if ($null -ne $cmd.width) { $width = Clamp-Int $cmd.width $vs[2] 1 20000 }
                if ($null -ne $cmd.height) { $height = Clamp-Int $cmd.height $vs[3] 1 20000 }
                $right = [Math]::Min($left + $width, $vs[0] + $vs[2])
                $bottom = [Math]::Min($top + $height, $vs[1] + $vs[3])
                if ($left -lt $vs[0]) { $left = $vs[0] }
                if ($top -lt $vs[1]) { $top = $vs[1] }
                $width = $right - $left
                $height = $bottom - $top
                if ($width -le 0 -or $height -le 0) { throw 'the requested OCR region is outside the screen' }
                $bitmap = Get-ScreenRegionBitmap $left $top $width $height $scaleValue
            }
            try { $lines = Invoke-OcrOnBitmap $bitmap }
            finally { if ($null -ne $bitmap) { $bitmap.Dispose() } }
            $mapped = New-Object System.Collections.ArrayList
            foreach ($line in @($lines)) {
                [void]$mapped.Add(@{
                    text = [string]$line['text']
                    x = [int][Math]::Round($left + ([double]$line['x']) / $scaleValue)
                    y = [int][Math]::Round($top + ([double]$line['y']) / $scaleValue)
                    width = [int][Math]::Round(([double]$line['width']) / $scaleValue)
                    height = [int][Math]::Round(([double]$line['height']) / $scaleValue)
                })
            }
            return @{ ok = $true; capture = $capture; left = $left; top = $top; width = $width; height = $height; scale = $scaleValue; lines = @($mapped) }
        }
        'sleep' {
            $ms = Clamp-Int $cmd.ms 100 0 60000
            [DeskInput]::Sleep($ms)
            return @{ ok = $true; sleptMs = $ms }
        }
        'quit' { return @{ ok = $true; goodbye = $true } }
        default { throw "unknown command: $action" }
    }
}

# Ready handshake: the host waits for this before sending any command.
$readyScreen = [DeskInput]::VirtualScreen()
Write-Reply @{ ok = $true; ready = $true; pid = $PID; dpiAware = $script:dpiAware; screen = @{
    left = $readyScreen[0]; top = $readyScreen[1]
    width = $readyScreen[2]; height = $readyScreen[3] } }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $cmd = $null
    $id = 0
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $cmd = $json | ConvertFrom-Json
        if ($null -ne $cmd.id) { $id = $cmd.id }
        $reply = Handle-Command $cmd
        if ($null -eq $reply) { $reply = @{ ok = $true } }
        $reply['id'] = $id
        Write-Reply $reply
        if ([string]$cmd.cmd -eq 'quit') { break }
    }
    catch {
        $failure = $_
        $message = $failure.Exception.Message
        $inner = $failure.Exception
        while ($null -ne $inner.InnerException) {
            $inner = $inner.InnerException
            if (-not [string]::IsNullOrWhiteSpace($inner.Message)) { $message = $inner.Message }
        }
        Write-Reply @{ ok = $false; id = $id; error = $message }
    }
}
