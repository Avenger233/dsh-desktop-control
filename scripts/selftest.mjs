#!/usr/bin/env node
/**
 * Manual self-test for dsh-desktop-control.
 *
 * Requires Windows and an interactive desktop. The test moves the real cursor,
 * briefly holds F24, takes two screenshots and finally restores the cursor.
 * Do not move the mouse while it runs.
 *
 * Usage (from the package root): node scripts/selftest.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELPER_PATH = join(ROOT, 'helper.ps1');
const READY_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (process.platform !== 'win32') {
  console.error(`desktop-control selftest: Windows only (current platform: ${process.platform})`);
  process.exit(1);
}

function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(absolute) ? absolute : 'powershell.exe';
}

const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let stderr = '';
const waiters = new Map();
let sequence = 0;
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
const readyTimer = setTimeout(() => readyReject(new Error('helper did not become ready in time')), READY_TIMEOUT_MS);

child.on('exit', (code) => {
  const error = new Error(`helper exited (${code ?? 'null'}): ${stderr.trim()}`);
  readyReject(error);
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  waiters.clear();
});
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    } catch {
      console.error(`unreadable helper output: ${line.slice(0, 80)}`);
      continue;
    }
    if (message.ready === true) {
      clearTimeout(readyTimer);
      readyResolve();
      continue;
    }
    const waiter = waiters.get(message.id);
    if (waiter === undefined) continue;
    waiters.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve(message);
    else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'helper rejected the command'));
  }
});

function call(command) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`command "${command.cmd}" timed out`));
    }, CALL_TIMEOUT_MS);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(`${Buffer.from(JSON.stringify({ ...command, id }), 'utf8').toString('base64')}\n`);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`);
}

async function main() {
  await ready;
  const initial = await call({ cmd: 'state' });
  const screen = initial.screen ?? {};
  check('helper starts and reports state', Number.isFinite(initial.x) && Number.isFinite(initial.y), `cursor (${initial.x}, ${initial.y}), screen ${screen.width}x${screen.height}`);

  const points = [
    [screen.left + Math.floor(screen.width / 2), screen.top + Math.floor(screen.height / 2)],
    [screen.left + 42, screen.top + 42],
    [screen.left + screen.width - 43, screen.top + screen.height - 44],
  ];
  let worst = 0;
  let movesOk = true;
  for (const [x, y] of points) {
    const moved = await call({ cmd: 'move', x, y, durationMs: 60 });
    const deviation = Math.max(Math.abs(moved.x - x), Math.abs(moved.y - y));
    worst = Math.max(worst, deviation);
    if (deviation > 2) movesOk = false;
  }
  check('absolute cursor positioning', movesOk, `max deviation ${worst}px`);

  await call({ cmd: 'keydown', keys: ['f24'] });
  const held = await call({ cmd: 'state', keys: ['f24'] });
  await call({ cmd: 'keyup', keys: ['f24'] });
  const released = await call({ cmd: 'state', keys: ['f24'] });
  check('keyboard down/up state', held.pressed?.f24 === true && released.pressed?.f24 === false, `down=${held.pressed?.f24}, up=${released.pressed?.f24}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-desktop-control-selftest-'));
  try {
    const fullPath = join(dir, 'full.png');
    const full = await call({ cmd: 'screenshot', path: fullPath, maxDimension: 2400 });
    const fullBytes = await readFile(fullPath);
    check(
      'full screenshot',
      fullBytes.subarray(0, 8).equals(PNG_SIGNATURE) && full.width === screen.width && full.height === screen.height,
      `${full.width}x${full.height}, ${fullBytes.length} bytes`,
    );

    const region = await call({ cmd: 'screenshot', x: screen.left + 10, y: screen.top + 10, width: 320, height: 200, path: join(dir, 'region.png'), maxDimension: 160 });
    check('region screenshot scaling', region.width === 160 && region.height === 100, `${region.width}x${region.height} from 320x200`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await call({ cmd: 'move', x: initial.x, y: initial.y, durationMs: 80 });
  await call({ cmd: 'quit' });

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nselftest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => child.kill(), 300);
});
