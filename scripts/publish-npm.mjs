#!/usr/bin/env node
/**
 * Publish this package to npm with the English README.
 *
 * GitHub keeps README.md in Chinese for the repository landing page; npm renders
 * whatever README.md is inside the tarball. This script stages the package files
 * (README.en.md renamed to README.md) in a temporary directory and publishes from
 * there, so the npm page is English while GitHub stays Chinese.
 *
 * Usage: npm run publish:npm -- [extra npm publish arguments, e.g. --dry-run]
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = mkdtempSync(join(tmpdir(), 'dsh-desktop-control-npm-'));

const FILES = ['package.json', 'index.js', 'helper.ps1', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'scripts'];
for (const name of FILES) cpSync(join(ROOT, name), join(stage, name), { recursive: true });
cpSync(join(ROOT, 'locale'), join(stage, 'locale'), { recursive: true });
cpSync(join(ROOT, 'README.en.md'), join(stage, 'README.md'));

// npm.cmd cannot be spawned without a shell; prefer the npm CLI entrypoint
// (npm_execpath is set when this runs through "npm run publish:npm").
const extra = process.argv.slice(2);
const cli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const command = existsSync(cli) ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const args = existsSync(cli) ? [cli, 'publish', ...extra] : ['publish', ...extra];
const result = spawnSync(command, args, { cwd: stage, stdio: 'inherit', shell: !existsSync(cli) && process.platform === 'win32' });

rmSync(stage, { recursive: true, force: true });
if (result.error) {
  console.error('npm publish failed:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
