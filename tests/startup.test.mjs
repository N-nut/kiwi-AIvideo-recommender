import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };

test('双击启动入口可从其他目录运行，保留命令行参数', windowsOnly, () => {
  const launcher = resolve(root, '启动产品.cmd');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `call "${launcher}" --help`], {
    cwd: dirname(root), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--baseline/);
  assert.match(result.stdout, /--port/);
});

test('限制 PowerShell 脚本执行时仍可通过 npm.cmd 启动产品', windowsOnly, () => {
  const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', '& npm.cmd start -- --help'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--baseline/);
  assert.match(result.stdout, /--port/);
});
