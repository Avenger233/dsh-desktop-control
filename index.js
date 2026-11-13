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
    grid: { type: 'boolean', description: 'Draw a labelled coordinate grid on the capture; labels are screen pixel coordinates. Defaults to false.' },
    cursor: { type: 'boolean', description: 'Stamp a red crosshair at the current cursor position. Defaults to false.' },
  },
};

const FIND_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text to locate on screen. Matching ignores spaces and case; OCR misreads are handled with fuzzy scoring. Required.' },
    window: { type: 'string', description: 'Restrict the capture to a window: title or process substring. Omit to capture the screen (optionally a region).' },
    click: { type: 'boolean', description: 'Click the best match after locating it; defaults to false.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click; defaults to left.' },
    threshold: { type: 'number', description: 'Minimum score from 0 to 1; defaults to 0.6. Lower it when OCR misreads characters.' },
    x: { type: 'number', description: 'Optional screen region left edge (ignored when window is set).' },
    y: { type: 'number', description: 'Optional screen region top edge.' },
    width: { type: 'number', description: 'Optional screen region width.' },
    height: { type: 'number', description: 'Optional screen region height.' },
  },
  required: ['text'],
};

const WINDOW_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'activate', 'elements', 'invoke'],
      description: 'list: visible windows with ids, process names and rectangles. activate: bring a window to the foreground. elements: UI Automation controls (role, name, centre point) of a window, no image needed. invoke: fire a control default action through UI Automation (InvokePattern), with window + filter required.',
    },
    window: { type: 'string', description: 'Window title or process name substring. Required for activate, elements and invoke.' },
    filter: { type: 'string', description: 'list: keep windows whose title or process contains this text. elements/invoke: control name or role substring.' },
    top: { type: 'integer', description: 'list: maximum rows; defaults to 30.' },
    depth: { type: 'integer', description: 'elements: UI Automation tree depth; defaults to 4 (max 10).' },
    max: { type: 'integer', description: 'elements: maximum rows; defaults to 120 (max 500).' },
  },
  required: ['action'],
};

const SEQUENCE_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'click', 'drag', 'scroll', 'mouse_down', 'mouse_up', 'type', 'press', 'key_down', 'key_up', 'find', 'activate', 'windows', 'elements', 'invoke', 'wait', 'screenshot'],
            description: 'Action for this step; the remaining fields are the same as the matching desktop_* tool.',
          },
          waitMs: { type: 'number', description: 'wait: milliseconds to pause; defaults to 300.' },
          text: { type: 'string', description: 'type/find: text to type or locate.' },
          x: { type: 'number' },
          y: { type: 'number' },
          toX: { type: 'number' },
          toY: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'integer' },
          delta: { type: 'number' },
          durationMs: { type: 'number' },
          keys: { type: 'array', items: { type: 'string' } },
          charDelayMs: { type: 'number' },
          holdMs: { type: 'number' },
          window: { type: 'string' },
          filter: { type: 'string' },
          click: { type: 'boolean' },
          threshold: { type: 'number' },
          depth: { type: 'integer' },
          top: { type: 'integer' },
          max: { type: 'integer' },
        },
        required: ['action'],
      },
      description: 'Ordered steps, at most 30. Each step is one action of the desktop_* tools; a failing step stops the sequence. screenshot steps save a PNG and return its path (no image).',
    },
  },
  required: ['steps'],
};

// ---------------------------------------------------------------- OCR matching
function normalizeForMatch(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/gu, '');
}

function charOverlap(query, candidate) {
  if (query === '') return 0;
  const counts = new Map();
  for (const ch of candidate) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hits = 0;
  for (const ch of query) {
    const remaining = counts.get(ch) ?? 0;
    if (remaining > 0) {
      counts.set(ch, remaining - 1);
      hits += 1;
    }
  }
  return hits / [...query].length;
}

function scoreOcrLine(query, text) {
  const candidate = normalizeForMatch(text);
  if (candidate === query) return 1;
  if (candidate.length > 0 && candidate.includes(query)) return 0.92;
  // Only let a shorter OCR line explain a longer query when it covers a real
  // share of it; otherwise "ZZZZQQQ" would "match" a stray "QQ".
  const reverseFloor = Math.max(2, Math.ceil([...query].length * 0.6));
  if ([...candidate].length >= reverseFloor && query.includes(candidate)) return 0.78;
  return Math.min(0.7, charOverlap(query, candidate) * 0.7);
}

function rankOcrLines(lines, text) {
  const query = normalizeForMatch(text);
  const scored = [];
  for (const line of lines) {
    const score = scoreOcrLine(query, line.text);
    if (score > 0) scored.push({ ...line, score });
  }
  scored.sort((left, right) => right.score - left.score || left.y - right.y || left.x - right.x);
  return scored;
}

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

  // ---------------------------------------------------------------- runners
  function regionOf(args) {
    const region = {};
    if (args.x !== undefined) region.x = pixel(args.x, 'x');
    if (args.y !== undefined) region.y = pixel(args.y, 'y');
    if (args.width !== undefined) region.width = pixel(args.width, 'width');
    if (args.height !== undefined) region.height = pixel(args.height, 'height');
    return region;
  }

  function windowArg(args) {
    return typeof args.window === 'string' && args.window.trim() !== '' ? args.window.trim() : '';
  }

  async function runMouse(args) {
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
  }

  async function runKeyboard(args) {
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
  }

  async function runScreenshot(args) {
    const region = regionOf(args);
    const attachments = ctx.get('attachments');
    const limits = attachments?.imageLimits;
    let maxDimension = Math.min(Number(limits?.maxImageDimension) || SCREENSHOT_MAX_DIMENSION, SCREENSHOT_MAX_DIMENSION);
    await pruneScreenshots();
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    let shot;
    let image;
    for (let attempt = 0; ; attempt++) {
      const path = join(SCREENSHOT_DIR, `shot-${Date.now()}-${attempt}.png`);
      shot = await server.call({
        cmd: 'screenshot',
        ...region,
        path,
        maxDimension,
        grid: args.grid === true,
        cursor: args.cursor === true,
      }, 60_000);
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
  }

  async function runState(args) {
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
  }

  async function runFind(args) {
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required');
    const command = { cmd: 'ocr' };
    const target = windowArg(args);
    if (target !== '') command.window = target;
    else Object.assign(command, regionOf(args));
    const scale = Number(args.scale);
    if (Number.isFinite(scale)) command.scale = Math.min(4, Math.max(0.5, scale));
    const result = await server.call(command, 90_000);
    const lines = Array.isArray(result.lines) ? result.lines : [];
    let threshold = 0.6;
    const requested = Number(args.threshold);
    if (Number.isFinite(requested)) threshold = Math.min(1, Math.max(0, requested));
    const ranked = rankOcrLines(lines, args.text);
    const matches = ranked.filter((line) => line.score >= threshold);
    const header = `find ${JSON.stringify(args.text)} | capture=${result.capture} ${result.width}x${result.height} at (${result.left}, ${result.top}) | ${lines.length} lines | matches=${matches.length}`;
    if (matches.length === 0) {
      const closest = ranked.slice(0, 3).map((line) => `${line.x},${line.y} score=${line.score.toFixed(2)} ${JSON.stringify(line.text)}`);
      const suggestions = closest.length === 0 ? '' : `\nclosest:\n${closest.join('\n')}`;
      return { text: `${header}\nnothing matched; try another word or lower threshold${suggestions}` };
    }
    const best = matches[0];
    const shown = matches.slice(0, 5).map((line) => `${line.x},${line.y} score=${line.score.toFixed(2)} ${JSON.stringify(line.text)}`).join('\n');
    if (args.click === true) {
      const button = args.button ?? 'left';
      await server.call({ cmd: 'click', x: best.x, y: best.y, button });
      return { text: `${header}\n${shown}\nclicked ${button} at (${best.x}, ${best.y})` };
    }
    return { text: `${header}\n${shown}` };
  }

  async function runWindow(args) {
    switch (args.action) {
      case 'list': {
        const command = { cmd: 'windows', top: clampInt(args.top, 30, 1, 200) };
        const filter = typeof args.filter === 'string' && args.filter.trim() !== '' ? args.filter.trim() : '';
        if (filter !== '') command.filter = filter;
        const result = await server.call(command);
        const windows = Array.isArray(result.windows) ? result.windows : [];
        const lines = windows.map((w) => `${w.handle} ${w.pid} ${w.process} | ${w.title} | ${w.bounds.join(',')}${w.minimized ? ' (minimized)' : ''}`);
        return { text: `windows: ${windows.length} shown of ${result.total}\n${lines.join('\n')}` };
      }
      case 'activate': {
        const target = windowArg(args);
        if (target === '') throw new Error('activate requires window (title or process substring)');
        const result = await server.call({ cmd: 'activate', window: target });
        const window = result.window ?? {};
        const foreground = result.foreground ?? {};
        const bounds = Array.isArray(window.bounds) ? window.bounds : [0, 0, 0, 0];
        const lines = [
          `activated ${result.activated ? 'yes' : 'no'}: ${window.process} "${window.title}" at (${bounds[0]}, ${bounds[1]}) ${bounds[2]}x${bounds[3]}`,
          `foreground: ${foreground.process} "${foreground.title}"`,
        ];
        return { text: lines.join('\n') };
      }
      case 'elements': {
        const target = windowArg(args);
        if (target === '') throw new Error('elements requires window (title or process substring)');
        const command = {
          cmd: 'elements',
          window: target,
          depth: clampInt(args.depth, 4, 1, 10),
          max: clampInt(args.max, 120, 1, 500),
        };
        const filter = typeof args.filter === 'string' && args.filter.trim() !== '' ? args.filter.trim() : '';
        if (filter !== '') command.filter = filter;
        const result = await server.call(command, 60_000);
        const rows = Array.isArray(result.elements) ? result.elements : [];
        const window = result.window ?? {};
        const lines = rows.map((row) => `${row.role} | ${row.name} | ${row.x},${row.y}`);
        return { text: `elements of ${window.process} "${window.title}": ${rows.length}\n${lines.join('\n')}` };
      }
      case 'invoke': {
        const target = windowArg(args);
        const control = typeof args.filter === 'string' ? args.filter.trim() : '';
        if (target === '') throw new Error('invoke requires window (title or process substring)');
        if (control === '') throw new Error('invoke requires filter (control name or role substring)');
        const result = await server.call({ cmd: 'invoke', window: target, filter: control }, 60_000);
        const window = result.window ?? {};
        const role = String(result.role ?? '').replace(/^ControlType\./u, '');
        return { text: `invoked "${result.name}" (${role || 'control'}) via ${result.method} in ${window.process} "${window.title}"` };
      }
      default:
        throw new Error(`unsupported window action: ${String(args.action)}`);
    }
  }

  async function runSequence(args) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (steps.length === 0) throw new Error('steps is required');
    if (steps.length > 30) throw new Error('a sequence is limited to 30 steps');
    const results = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] !== null && typeof steps[index] === 'object' ? steps[index] : {};
      const action = typeof step.action === 'string' ? step.action : '';
      try {
        let line;
        switch (action) {
          case 'move':
          case 'click':
          case 'drag':
          case 'scroll':
            line = (await runMouse(step)).text.split('\n')[0];
            break;
          case 'mouse_down':
          case 'mouse_up':
            line = (await runMouse({ ...step, action: action === 'mouse_down' ? 'down' : 'up' })).text.split('\n')[0];
            break;
          case 'type':
          case 'press':
            line = (await runKeyboard(step)).text.split('\n')[0];
            break;
          case 'key_down':
          case 'key_up':
            line = (await runKeyboard({ ...step, action: action === 'key_down' ? 'down' : 'up' })).text.split('\n')[0];
            break;
          case 'find':
            line = (await runFind(step)).text.split('\n')[0];
            break;
          case 'activate':
          case 'elements':
          case 'invoke':
            line = (await runWindow(step)).text.split('\n')[0];
            break;
          case 'windows':
            line = (await runWindow({ ...step, action: 'list' })).text.split('\n')[0];
            break;
          case 'wait': {
            const ms = clampInt(step.waitMs ?? step.ms, 300, 0, 30_000);
            await server.call({ cmd: 'sleep', ms });
            line = `waited ${ms}ms`;
            break;
          }
          case 'screenshot': {
            await mkdir(SCREENSHOT_DIR, { recursive: true });
            const path = join(SCREENSHOT_DIR, `shot-${Date.now()}-seq${index}.png`);
            const shot = await server.call({
              cmd: 'screenshot',
              ...regionOf(step),
              path,
              maxDimension: 1600,
              grid: step.grid === true,
              cursor: step.cursor === true,
            }, 60_000);
            line = `screenshot ${shot.width}x${shot.height} -> ${shot.path}`;
            break;
          }
          default:
            throw new Error(`unknown action "${action}"`);
        }
        results.push(`${index + 1}. ${action}: ${line}`);
      } catch (error) {
        const completed = results.length === 0 ? '(none)' : `\n${results.join('\n')}`;
        throw new Error(`step ${index + 1} (${action || 'unknown'}) failed: ${error instanceof Error ? error.message : String(error)}\ncompleted:${completed}`);
      }
    }
    await pruneScreenshots();
    return { text: `sequence: ${steps.length} steps\n${results.join('\n')}` };
  }

  publish({
    name: 'desktop_mouse',
    description:
      'Move and click the real Windows mouse pointer. Coordinates are physical screen pixels on the virtual desktop; use desktop_state to read the cursor and screen bounds first. Input goes to the desktop immediately, so it lands on whatever window is under the pointer. Elevated (administrator) windows and UAC or lock-screen desktops reject this input, and games that capture the mouse through raw input may ignore it.',
    parameters: MOUSE_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    execute: (args) => runMouse(args),
  }, 'desktop-control: desktop_mouse');

  publish({
    name: 'desktop_keyboard',
    description:
      'Send real keyboard input to the foreground window: type text, press key combinations, or hold and release keys. Keystrokes go to whatever window has focus when the tool runs, so focus the target first and confirm it with desktop_state. Elevated (administrator) windows and UAC or lock-screen desktops reject this input, and anti-cheat software may ignore it.',
    parameters: KEYBOARD_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    execute: (args) => runKeyboard(args),
  }, 'desktop-control: desktop_keyboard');

  publish({
    name: 'desktop_screenshot',
    description:
      'Capture the Windows desktop (the whole virtual screen or a region) and return the frame as an image so you can see the screen. Coordinates are screen pixels; omit x, y, width and height for the full virtual desktop. Set grid:true for labelled coordinate grid lines and cursor:true to stamp the current pointer. The frame is what Windows composes for the desktop, so a true exclusive-fullscreen game or a DRM-protected surface can appear black. Use it before clicking or typing to locate targets, and after actions to confirm the result.',
    parameters: SCREENSHOT_SCHEMA,
    output: SCREENSHOT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: (args) => runScreenshot(args),
  }, 'desktop-control: desktop_screenshot');

  publish({
    name: 'desktop_state',
    description:
      'Report the desktop state: cursor position, virtual screen bounds, the foreground window (title, process, rectangle), and whether keys are currently held down. Use it to compute screen coordinates, confirm where input will land, and diagnose stuck modifier keys.',
    parameters: STATE_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: (args) => runState(args),
  }, 'desktop-control: desktop_state');

  publish({
    name: 'desktop_find',
    description:
      'Locate text on the Windows desktop with local Windows OCR and return its exact screen coordinates — no screenshot and no vision tokens. Matching ignores spaces and case and tolerates OCR misreads. Set click:true to click the best match in the same call. Cheapest way to hit a labelled menu item, button or link; when nothing matches it lists the closest OCR lines so the model can retry. Requires a Windows OCR language pack (normally present).',
    parameters: FIND_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    execute: (args) => runFind(args),
  }, 'desktop-control: desktop_find');

  publish({
    name: 'desktop_window',
    description:
      'Windows of the real desktop: action=list lists visible windows (hwnd, process, title, rectangle), action=activate brings one to the foreground, action=elements returns UI Automation controls (role, name, centre point) of a window without a screenshot, and action=invoke fires a control default action through UI Automation. UI Automation only sees native controls; Chromium/Electron/Qt custom-drawn surfaces need desktop_find or desktop_screenshot.',
    parameters: WINDOW_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    execute: (args) => runWindow(args),
  }, 'desktop-control: desktop_window');

  publish({
    name: 'desktop_sequence',
    description:
      'Run several desktop actions in one call: each step is one action of the desktop_* tools plus its fields (for example [{"action":"find","text":"Save","click":true},{"action":"wait","waitMs":400},{"action":"screenshot"}]). Much cheaper than one tool round-trip per action. A failing step stops the sequence and reports what completed. screenshot steps only save a PNG and return its path.',
    parameters: SEQUENCE_SCHEMA,
    output: TEXT_OUTPUT,
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: (args) => runSequence(args),
  }, 'desktop-control: desktop_sequence');
}
