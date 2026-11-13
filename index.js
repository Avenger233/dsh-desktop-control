/**
 * dsh-desktop-control: real Windows mouse and keyboard input for a session.
 *
 * Each tool call talks to one long-lived PowerShell helper (`helper.ps1`) that
 * host a tiny SendInput/GetCursorPos wrapper. The helper starts on first use,
 * compiles the P/Invoke wrapper once, and then answers one base64 JSON command
 * per line, so repeated actions cost milliseconds instead of a cold start.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'desktop-control';
export const inject = ['tools'];

const HELPER_PATH = fileURLToPath(new URL('./helper.ps1', import.meta.url));
const READY_TIMEOUT_MS = 90_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const WINDOWS_ONLY = 'desktop control requires Windows';

/** Windows PowerShell candidates, absolute path first so a trimmed PATH cannot break it. */
function powershellPathCandidates() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
}
const SCREENSHOT_DIR = join(tmpdir(), 'dsh-desktop-control');
const SCREENSHOT_KEEP = 30;
const SCREENSHOT_MAX_DIMENSION = 2400;

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function pixel(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a screen pixel coordinate`);
  return Math.round(number);
}

/**
 * One helper process, started lazily. Calls are matched to replies by id; a
 * dead or silent helper is replaced on the next call.
 */
function createInputServer(logger) {
  let child;
  let launching;
  let readyResolve;
  let readyReject;
  let buffer = '';
  let stderr = '';
  let sequence = 0;
  let disposed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function settleReady(error) {
    const resolve = readyResolve;
    const reject = readyReject;
    readyResolve = undefined;
    readyReject = undefined;
    if (error !== undefined) reject?.(error);
    else resolve?.();
  }

  function onMessage(message) {
    if (message !== null && typeof message === 'object' && message.ready === true) {
      settleReady();
      logger?.info?.('desktop-control: input helper ready (dpi aware: %s, screen: %sx%s)', message.dpiAware, message.screen?.width, message.screen?.height);
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve(message);
    else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'the desktop input helper rejected the command'));
  }

  function onLine(line) {
    if (line === '') return;
    let message;
    try {
      message = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    } catch {
      logger?.warn?.('desktop-control: unreadable helper output');
      return;
    }
    onMessage(message);
  }

  function spawnHelper(executable) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`cannot start the desktop input helper: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      child = proc;
      buffer = '';
      stderr = '';
      const timer = setTimeout(() => {
        settleReady(new Error('the desktop input helper did not become ready in time'));
        if (child === proc) child = undefined;
        proc.kill();
      }, READY_TIMEOUT_MS);
      readyResolve = () => { clearTimeout(timer); resolve(); };
      readyReject = (error) => { clearTimeout(timer); reject(error); };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          onLine(line);
        }
      });
      proc.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      });
      proc.on('error', (error) => {
        if (child === proc) child = undefined;
        const message = new Error(`cannot start the desktop input helper: ${error.message}`);
        message.code = error.code;
        settleReady(message);
        rejectPending(message);
      });
      proc.on('exit', (code, signal) => {
        if (child === proc) child = undefined;
        const detail = stderr.trim() || `code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`}`;
        const message = new Error(`the desktop input helper exited (${detail})`);
        settleReady(message);
        rejectPending(message);
        logger?.info?.('desktop-control: input helper exited');
      });
    });
  }

  async function launch() {
    if (process.platform !== 'win32') throw new Error(WINDOWS_ONLY);
    let lastError;
    for (const executable of powershellPathCandidates()) {
      try {
        await spawnHelper(executable);
        return;
      } catch (error) {
        lastError = error;
        // Only a missing executable is worth retrying; a helper that started and
        // failed (compile error, policy block) would fail the same way again.
        if (error?.code !== 'ENOENT') throw error;
        logger?.info?.('desktop-control: %s not found, trying the next PowerShell path', executable);
      }
    }
    throw lastError;
  }

  function ensureStarted() {
    if (child !== undefined) return Promise.resolve();
    if (launching !== undefined) return launching;
    launching = launch().finally(() => { launching = undefined; });
    return launching;
  }

  async function call(command, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (disposed) throw new Error('desktop control is not active');
    await ensureStarted();
    if (!child || !child.stdin || !child.stdin.writable) throw new Error('the desktop input helper is not running');
    const target = child;
    const id = ++sequence;
    const encoded = Buffer.from(JSON.stringify({ ...command, id }), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the desktop input helper stopped responding'));
        if (child === target) child = undefined;
        try { target.kill(); } catch { /* already gone */ }
        rejectPending(new Error('the desktop input helper was stopped after a timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.stdin.write(`${encoded}\n`);
    });
  }

  function dispose() {
    disposed = true;
    const proc = child;
    child = undefined;
    rejectPending(new Error('desktop control is not active'));
    if (proc !== undefined) {
      try { proc.stdin.end(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  return { call, dispose };
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : String(value?.text ?? '') }],
};

const SCREENSHOT_OUTPUT = {
  schema: TEXT_OUTPUT.schema,
  render: (_args, value) => [
    { type: 'text', text: typeof value?.text === 'string' ? value.text : String(value?.text ?? '') },
    ...(value?.image === undefined ? [] : [{ type: 'image', attachment: { ...value.image } }]),
  ],
};

async function pruneScreenshots() {
  try {
    const names = await readdir(SCREENSHOT_DIR);
    const shots = [];
    for (const name of names) {
      if (!name.startsWith('shot-') || !name.endsWith('.png')) continue;
      const path = join(SCREENSHOT_DIR, name);
      shots.push({ path, mtime: (await stat(path)).mtimeMs });
    }
    if (shots.length <= SCREENSHOT_KEEP) return;
    shots.sort((left, right) => right.mtime - left.mtime);
    for (const stale of shots.slice(SCREENSHOT_KEEP)) await unlink(stale.path);
  } catch {
    // A missing directory or a file that vanished mid-scan is not an error.
  }
}

const MOUSE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['move', 'click', 'drag', 'scroll', 'down', 'up'],
      description: 'move: go to x,y. click: click at x,y (or the current position). drag: press at x,y and release at toX,toY. scroll: wheel at x,y or the current position. down/up: press or release the button without moving.',
    },
    x: { type: 'number', description: 'Screen x in pixels. Required for move and drag; optional for click and scroll (moves there first).' },
    y: { type: 'number', description: 'Screen y in pixels. Required for move and drag; optional for click and scroll (moves there first).' },
    toX: { type: 'number', description: 'Drag end x in pixels. Required for drag.' },
    toY: { type: 'number', description: 'Drag end y in pixels. Required for drag.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
    count: { type: 'integer', description: 'Number of clicks; defaults to 1 (2 = double-click, 3 = triple-click).' },
    delta: { type: 'number', description: 'Scroll amount in wheel units: 120 is one notch up, -120 one notch down. Required for scroll.' },
    durationMs: { type: 'number', description: 'Movement time in milliseconds for move and drag; omit or 0 to jump instantly. Slower drags are more reliable on drag-and-drop targets.' },
    horizontal: { type: 'boolean', description: 'Scroll horizontally instead of vertically.' },
  },
  required: ['action'],
};

const KEYBOARD_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['type', 'press', 'down', 'up'],
      description: 'type: type text. press: tap a key combination. down/up: hold or release keys without tapping, for games and held modifiers.',
    },
    text: { type: 'string', description: 'Text to type as Unicode, including non-ASCII. \\n starts a new line, \\t inserts a tab. Required for type.' },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Keys for press/down/up. Names: ctrl, shift, alt, win, enter, tab, esc, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, capslock, f1-f24, letters a-z, digits 0-9, and punctuation (minus, equal, comma, period, slash, backslash, semicolon, quote, backtick, lbracket, rbracket). For press, earlier items are held while the last is tapped: press Ctrl+Shift+T as ["ctrl", "shift", "t"]; each item may also be a plus-joined combo.',
    },
    charDelayMs: { type: 'number', description: 'Delay between typed characters in milliseconds; defaults to 12. Raise it for applications that drop fast keystrokes.' },
    holdMs: { type: 'number', description: 'How long the final key of a press stays down in milliseconds; defaults to 40.' },
  },
  required: ['action'],
};

const STATE_SCHEMA = {
  type: 'object',
  properties: {
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key names to report as held down or released, using the same names as desktop_keyboard.',
    },
  },
};

const SCREENSHOT_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Left edge of the region in screen pixels; defaults to the left edge of the virtual screen.' },
    y: { type: 'number', description: 'Top edge of the region in screen pixels; defaults to the top edge of the virtual screen.' },
    width: { type: 'number', description: 'Region width in pixels; defaults to the rest of the virtual screen from x.' },
    height: { type: 'number', description: 'Region height in pixels; defaults to the rest of the virtual screen from y.' },
  },
};

function requireKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('keys is required for this action');
  return keys.map((key) => String(key));
}

export function apply(ctx) {
  const logger = ctx.logger?.('desktop-control');
  // The helper injects input through user32.dll, so there is nothing useful to
  // register on macOS or Linux: keep those profiles clean instead of showing
  // four tools whose every call would fail.
  if (process.platform !== 'win32') {
    logger?.warn?.('desktop-control: Windows only (current platform: %s); no tools registered', process.platform);
    return;
  }
  const server = createInputServer(logger);
  ctx.effect(() => () => server.dispose(), 'desktop-control: input helper process');
  const publish = (definition, label) => ctx.effect(() => ctx.tools.register(definition), label);

  publish({
    name: 'desktop_mouse',
    description:
      'Move and click the real Windows mouse pointer. Coordinates are physical screen pixels on the virtual desktop; use desktop_state to read the cursor and screen bounds first. Input goes to the desktop immediately, so it lands on whatever window is under the pointer. Elevated (administrator) windows and UAC or lock-screen desktops reject this input, and games that capture the mouse through raw input may ignore it.',
    parameters: MOUSE_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      switch (args.action) {
        case 'move': {
          if (args.x === undefined || args.y === undefined) throw new Error('move requires x and y');
          const result = await server.call({
            cmd: 'move',
            x: pixel(args.x, 'x'),
            y: pixel(args.y, 'y'),
            durationMs: clampInt(args.durationMs, 0, 0, 15_000),
          });
          return { text: `cursor moved to (${result.x}, ${result.y})` };
        }
        case 'click': {
          const command = {
            cmd: 'click',
            button: args.button ?? 'left',
            count: clampInt(args.count, 1, 1, 10),
          };
          if (args.x !== undefined || args.y !== undefined) {
            if (args.x === undefined || args.y === undefined) throw new Error('click needs both x and y, or neither');
            command.x = pixel(args.x, 'x');
            command.y = pixel(args.y, 'y');
          }
          const result = await server.call(command);
          const times = result.count === 1 ? 'once' : `${result.count} times`;
          const at = args.x === undefined ? '' : ` at (${result.x}, ${result.y})`;
          return { text: `clicked ${result.button} button ${times}${at}` };
        }
        case 'drag': {
          if (args.x === undefined || args.y === undefined || args.toX === undefined || args.toY === undefined) {
            throw new Error('drag requires x, y, toX and toY');
          }
          const result = await server.call({
            cmd: 'drag',
            x: pixel(args.x, 'x'),
            y: pixel(args.y, 'y'),
            toX: pixel(args.toX, 'toX'),
            toY: pixel(args.toY, 'toY'),
            button: args.button ?? 'left',
            durationMs: clampInt(args.durationMs, 400, 50, 15_000),
          });
          return { text: `dragged ${result.button} button from (${args.x}, ${args.y}) to (${result.x}, ${result.y})` };
        }
        case 'scroll': {
          if (args.delta === undefined) throw new Error('scroll requires delta');
          const command = { cmd: 'scroll', delta: clampInt(args.delta, 0, -12_000, 12_000), horizontal: args.horizontal === true };
          if (args.x !== undefined || args.y !== undefined) {
            if (args.x === undefined || args.y === undefined) throw new Error('scroll needs both x and y, or neither');
            command.x = pixel(args.x, 'x');
            command.y = pixel(args.y, 'y');
          }
          const result = await server.call(command);
          const notches = Math.abs(result.delta) / 120;
          return { text: `scrolled ${notches} notch${notches === 1 ? '' : 'es'} ${result.delta < 0 ? 'down' : 'up'}${result.horizontal ? ' horizontally' : ''} at (${result.x}, ${result.y})` };
        }
        case 'down':
        case 'up': {
          const result = await server.call({ cmd: args.action, button: args.button ?? 'left' });
          return { text: `${result.button} button ${args.action === 'down' ? 'held down' : 'released'} at (${result.x}, ${result.y})` };
        }
        default:
          throw new Error(`unsupported mouse action: ${String(args.action)}`);
      }
    },
  }, 'desktop-control: desktop_mouse');

  publish({
    name: 'desktop_keyboard',
    description:
      'Send real keyboard input to the foreground window: type text, press key combinations, or hold and release keys. Keystrokes go to whatever window has focus when the tool runs, so focus the target first and confirm it with desktop_state. Elevated (administrator) windows and UAC or lock-screen desktops reject this input, and anti-cheat software may ignore it.',
    parameters: KEYBOARD_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      switch (args.action) {
        case 'type': {
          if (typeof args.text !== 'string' || args.text === '') throw new Error('type requires text');
          if (args.text.length > 20_000) throw new Error('text is limited to 20000 characters per call');
          const result = await server.call({
            cmd: 'type',
            text: args.text,
            charDelayMs: clampInt(args.charDelayMs, 12, 0, 500),
          }, 120_000);
          return { text: `typed ${result.chars} characters` };
        }
        case 'press': {
          const keys = requireKeys(args.keys);
          const result = await server.call({
            cmd: 'key',
            keys,
            holdMs: clampInt(args.holdMs, 40, 10, 5_000),
          });
          return { text: `pressed ${result.keys.join('+')}` };
        }
        case 'down':
        case 'up': {
          const keys = requireKeys(args.keys);
          await server.call({ cmd: args.action === 'down' ? 'keydown' : 'keyup', keys });
          return { text: args.action === 'down' ? `keys held down: ${keys.join(', ')}` : `keys released: ${keys.join(', ')}` };
        }
        default:
          throw new Error(`unsupported keyboard action: ${String(args.action)}`);
      }
    },
  }, 'desktop-control: desktop_keyboard');

  publish({
    name: 'desktop_screenshot',
    description:
      'Capture the Windows desktop (the whole virtual screen or a region) and return the frame as an image so you can see the screen. Coordinates are screen pixels; omit x, y, width and height for the full virtual desktop. The frame is what Windows composes for the desktop, so a true exclusive-fullscreen game or a DRM-protected surface can appear black. The mouse pointer is not drawn. Use it before clicking or typing to locate targets, and after actions to confirm the result.',
    parameters: SCREENSHOT_SCHEMA,
    output: SCREENSHOT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const region = {};
      if (args.x !== undefined) region.x = pixel(args.x, 'x');
      if (args.y !== undefined) region.y = pixel(args.y, 'y');
      if (args.width !== undefined) region.width = pixel(args.width, 'width');
      if (args.height !== undefined) region.height = pixel(args.height, 'height');
      const attachments = ctx.get('attachments');
      const limits = attachments?.imageLimits;
      let maxDimension = Math.min(Number(limits?.maxImageDimension) || SCREENSHOT_MAX_DIMENSION, SCREENSHOT_MAX_DIMENSION);
      await pruneScreenshots();
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      let shot;
      let image;
      for (let attempt = 0; ; attempt++) {
        const path = join(SCREENSHOT_DIR, `shot-${Date.now()}-${attempt}.png`);
        shot = await server.call({ cmd: 'screenshot', ...region, path, maxDimension }, 60_000);
        if (attachments === undefined) break;
        const data = await readFile(shot.path);
        try {
          const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: 'desktop screenshot' });
          image = {
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          };
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          maxDimension = Math.max(480, Math.round(maxDimension / 2));
        }
      }
      const source = `${shot.sourceWidth}x${shot.sourceHeight}`;
      const scaled = image !== undefined && (image.width !== shot.sourceWidth || image.height !== shot.sourceHeight)
        ? `, stored ${image.width}x${image.height}`
        : '';
      const fallback = image === undefined ? `\nfile: ${shot.path}\nCall read_image on this path to view the frame.` : '';
      return {
        text: `screenshot ${source} at (${shot.left}, ${shot.top})${scaled}${fallback}`,
        ...(image === undefined ? {} : { image }),
      };
    },
  }, 'desktop-control: desktop_screenshot');

  publish({
    name: 'desktop_state',
    description:
      'Report the desktop state: cursor position, virtual screen bounds, the foreground window (title, process, rectangle), and whether keys are currently held down. Use it to compute screen coordinates, confirm where input will land, and diagnose stuck modifier keys.',
    parameters: STATE_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const keys = Array.isArray(args.keys) ? args.keys.map((key) => String(key)) : [];
      const state = await server.call({ cmd: 'state', keys });
      const screen = state.screen ?? {};
      const foreground = state.foreground ?? {};
      const bounds = Array.isArray(foreground.bounds) ? foreground.bounds : undefined;
      const lines = [
        `cursor: (${state.x}, ${state.y})`,
        `screen: ${screen.width}x${screen.height} at (${screen.left}, ${screen.top})`,
        `foreground: ${foreground.process || 'unknown'}${foreground.pid ? ` (pid ${foreground.pid})` : ''}${foreground.title ? ` "${foreground.title}"` : ''}${bounds ? ` at (${bounds[0]}, ${bounds[1]}) ${bounds[2]}x${bounds[3]}` : ''}`,
      ];
      if (keys.length > 0) {
        const pressed = state.pressed ?? {};
        lines.push(`keys: ${keys.map((key) => `${key}=${pressed[key] === null ? 'unknown' : pressed[key] === true ? 'down' : 'up'}`).join(', ')}`);
      }
      return { text: lines.join('\n') };
    },
  }, 'desktop-control: desktop_state');
}
